'use strict';

// One-to-one direct messages. Every read and write joins dm_participants on
// the authenticated user's id, so a conversation you are not part of behaves
// exactly like one that doesn't exist (404, never 403, to avoid confirming it).
// DM events are sent only to the two participants' personal channels.

const db = require('../db');
const settings = require('./settings');
const members = require('./members');
const presence = require('./presence');
const hub = require('../realtime/hub');
const v = require('../lib/validate');
const { notFound, bad } = require('../lib/errors');

async function participant(client, userId, conversationId) {
  const { rows } = await client.query(
    `SELECT c.id, c.user_low, c.user_high, p.last_read_message_id,
            CASE WHEN c.user_low = $1 THEN c.user_high ELSE c.user_low END AS other_id
       FROM dm_conversations c
       JOIN dm_participants p ON p.conversation_id = c.id AND p.user_id = $1
      WHERE c.id = $2`,
    [userId, conversationId],
  );
  if (!rows[0]) throw notFound('Conversation not found.');
  return rows[0];
}

async function readReceiptsOn(client, userId) {
  const { rows } = await client.query('SELECT read_receipts FROM user_preferences WHERE user_id = $1', [userId]);
  return rows[0] ? rows[0].read_receipts : true;
}

/** Find or create the conversation between the caller and another active member. */
async function open(user, otherId) {
  otherId = v.id(otherId, 'member');
  if (otherId === user.id) throw bad("You can't message yourself.");
  const [low, high] = user.id < otherId ? [user.id, otherId] : [otherId, user.id];
  return db.tx(async (client) => {
    const other = await client.query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [otherId]);
    if (!other.rowCount) throw notFound('Member not found.');
    const ins = await client.query(
      `INSERT INTO dm_conversations (user_low, user_high) VALUES ($1, $2)
       ON CONFLICT (user_low, user_high) DO UPDATE SET user_low = EXCLUDED.user_low
       RETURNING id`,
      [low, high],
    );
    const id = ins.rows[0].id;
    await client.query(
      `INSERT INTO dm_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`,
      [id, low, high],
    );
    return { id };
  });
}

async function list(user) {
  const { rows } = await db.query(
    `SELECT c.id, c.last_message_at, p.last_read_message_id,
            o.id AS other_id, o.username, o.avatar_seed, o.xp, o.status, o.status_message, o.role, o.created_at,
            lm.id AS lm_id, lm.body AS lm_body, lm.sender_id AS lm_sender, lm.created_at AS lm_at, lm.deleted_at AS lm_deleted,
            (SELECT count(*) FROM dm_messages x
              WHERE x.conversation_id = c.id AND x.id > p.last_read_message_id
                AND x.sender_id <> $1 AND x.deleted_at IS NULL)::int AS unread
       FROM dm_participants p
       JOIN dm_conversations c ON c.id = p.conversation_id
       JOIN users o ON o.id = CASE WHEN c.user_low = $1 THEN c.user_high ELSE c.user_low END
       LEFT JOIN LATERAL (
         SELECT id, body, sender_id, created_at, deleted_at FROM dm_messages
          WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1
       ) lm ON true
      WHERE p.user_id = $1 AND c.last_message_at IS NOT NULL
      ORDER BY c.last_message_at DESC`,
    [user.id],
  );
  const thresholds = await settings.get('rank_thresholds');
  const p = presence.snapshot(rows.map((r) => r.other_id));
  return rows.map((r) => ({
    id: r.id,
    other: members.shape({ id: r.other_id, username: r.username, avatar_seed: r.avatar_seed, xp: r.xp, status: r.status, status_message: r.status_message, role: r.role }, thresholds, p),
    lastMessage: r.lm_id ? {
      id: r.lm_id, mine: r.lm_sender === user.id, createdAt: r.lm_at,
      preview: r.lm_deleted ? '' : r.lm_body.slice(0, 80), deleted: !!r.lm_deleted,
    } : null,
    unread: r.unread,
  }));
}

function shapeDm(row, thresholds) {
  const deleted = !!row.deleted_at;
  return {
    id: row.id, conversationId: row.conversation_id, clientId: row.client_id,
    author: members.author(row, thresholds),
    body: deleted ? '' : row.body, deleted, createdAt: row.created_at,
  };
}

const DM_SELECT = `
  SELECT m.id, m.conversation_id, m.sender_id, m.body, m.client_id, m.created_at, m.deleted_at,
         u.username AS author_username, u.avatar_seed AS author_avatar, u.xp AS author_xp, u.status AS author_status
    FROM dm_messages m JOIN users u ON u.id = m.sender_id`;

async function history(user, conversationId, { before = null, after = null, limit = 40 } = {}) {
  conversationId = v.id(conversationId, 'conversation');
  const conv = await participant(db, user.id, conversationId);
  limit = Math.min(Math.max(limit, 1), 50);
  const { rows } = await db.query(
    `${DM_SELECT}
      WHERE m.conversation_id = $1
        AND ($2::bigint IS NULL OR m.id < $2)
        AND ($3::bigint IS NULL OR m.id > $3)
      ORDER BY m.id ${after ? 'ASC' : 'DESC'} LIMIT $4`,
    [conversationId, before, after, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (!after) page.reverse();
  const thresholds = await settings.get('rank_thresholds');

  // The other side's read position is only revealed if BOTH members share
  // read receipts (reciprocal, like most messengers).
  let otherReadId = null;
  if ((await readReceiptsOn(db, user.id)) && (await readReceiptsOn(db, conv.other_id))) {
    const r = await db.query('SELECT last_read_message_id FROM dm_participants WHERE conversation_id = $1 AND user_id = $2', [conversationId, conv.other_id]);
    otherReadId = r.rows[0]?.last_read_message_id ?? null;
  }
  const otherRow = await db.query(`SELECT ${members.MEMBER_COLS} FROM users u WHERE u.id = $1`, [conv.other_id]);
  return {
    conversation: {
      id: conversationId,
      other: members.shape(otherRow.rows[0], thresholds, presence.snapshot([conv.other_id])),
      otherReadId,
    },
    messages: page.map((r) => shapeDm(r, thresholds)),
    hasMore,
  };
}

async function send(user, input) {
  const conversationId = v.id(input.conversationId, 'conversation');
  const body = v.messageBody(input.body);
  const clientId = v.clientId(input.clientId);

  const out = await db.tx(async (client) => {
    const conv = await participant(client, user.id, conversationId);
    const other = await client.query(`SELECT status FROM users WHERE id = $1`, [conv.other_id]);
    if (other.rows[0]?.status !== 'active') throw bad('This member is no longer available.');
    const ins = await client.query(
      `INSERT INTO dm_messages (conversation_id, sender_id, body, client_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sender_id, client_id) DO NOTHING RETURNING id`,
      [conversationId, user.id, body, clientId],
    );
    let id; let duplicate = false;
    if (ins.rowCount) {
      id = ins.rows[0].id;
      await client.query('UPDATE dm_conversations SET last_message_at = now() WHERE id = $1', [conversationId]);
      // Sending implies you've read everything before it.
      await client.query(
        'UPDATE dm_participants SET last_read_message_id = $3 WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, user.id, id],
      );
    } else {
      const ex = await client.query('SELECT id, conversation_id FROM dm_messages WHERE sender_id = $1 AND client_id = $2', [user.id, clientId]);
      if (ex.rows[0].conversation_id !== conversationId) throw bad('Duplicate message id.');
      id = ex.rows[0].id; duplicate = true;
    }
    const { rows } = await client.query(`${DM_SELECT} WHERE m.id = $1`, [id]);
    return { msg: shapeDm(rows[0], await settings.get('rank_thresholds', client)), otherId: conv.other_id, duplicate };
  });

  if (!out.duplicate) hub.toUsers([user.id, out.otherId], 'dm:message', out.msg);
  return out.msg;
}

/** Advance the caller's read pointer (never backwards). */
async function markRead(user, input) {
  const conversationId = v.id(input.conversationId, 'conversation');
  const messageId = v.id(input.messageId, 'message');
  const conv = await participant(db, user.id, conversationId);
  const { rowCount } = await db.query(
    `UPDATE dm_participants SET last_read_message_id = $3
      WHERE conversation_id = $1 AND user_id = $2 AND last_read_message_id < $3
        AND EXISTS (SELECT 1 FROM dm_messages WHERE id = $3 AND conversation_id = $1)`,
    [conversationId, user.id, messageId],
  );
  if (rowCount) {
    hub.toUser(user.id, 'dm:unread', { conversationId, unread: 0 });
    if ((await readReceiptsOn(db, user.id)) && (await readReceiptsOn(db, conv.other_id))) {
      hub.toUser(conv.other_id, 'dm:read', { conversationId, messageId });
    }
  }
  return { ok: true };
}

async function remove(user, messageId) {
  messageId = v.id(messageId, 'message');
  const out = await db.tx(async (client) => {
    const { rows } = await client.query('SELECT id, conversation_id, sender_id FROM dm_messages WHERE id = $1 FOR UPDATE', [messageId]);
    const m = rows[0];
    if (!m) throw notFound('Message not found.');
    const conv = await participant(client, user.id, m.conversation_id); // 404 for outsiders
    if (m.sender_id !== user.id) throw notFound('Message not found.');
    await client.query(`UPDATE dm_messages SET body = '', deleted_at = now() WHERE id = $1`, [messageId]);
    return { conversationId: m.conversation_id, otherId: conv.other_id };
  });
  hub.toUsers([user.id, out.otherId], 'dm:deleted', { conversationId: out.conversationId, messageId });
  return { ok: true };
}

/** For the typing indicator: who else is in this conversation? (null if not a participant) */
async function otherParticipant(user, conversationId) {
  try { return (await participant(db, user.id, v.id(conversationId, 'conversation'))).other_id; } catch { return null; }
}

async function unreadTotal(user) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM dm_participants p JOIN dm_messages m ON m.conversation_id = p.conversation_id
      WHERE p.user_id = $1 AND m.id > p.last_read_message_id AND m.sender_id <> $1 AND m.deleted_at IS NULL`,
    [user.id],
  );
  return rows[0].n;
}

module.exports = { open, list, history, send, markRead, remove, otherParticipant, unreadTotal };
