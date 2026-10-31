'use strict';

// Room access and room messages. Every path — REST and Socket.IO — goes
// through assertAccess(), so the rules live in exactly one place.

const db = require('../db');
const settings = require('./settings');
const members = require('./members');
const xp = require('./xp');
const hub = require('../realtime/hub');
const v = require('../lib/validate');
const { notFound, forbidden } = require('../lib/errors');

const ROOM_COLS = 'r.id, r.slug, r.name, r.description, r.color, r.icon, r.is_restricted, r.sort_order, r.archived_at';

function shapeRoom(r) {
  return {
    id: r.id, slug: r.slug, name: r.name, description: r.description, color: r.color, icon: r.icon,
    restricted: r.is_restricted, archived: !!r.archived_at, sortOrder: r.sort_order,
  };
}

/**
 * Throws unless `user` may read and post in the room.
 * Rules: room exists and isn't archived; open rooms admit every active member;
 * restricted rooms need a room_memberships row (admins manage rooms and may
 * open any of them; they cannot read DMs — there is no such code path).
 */
async function assertAccess(user, roomId, client = db) {
  const { rows } = await client.query(
    `SELECT ${ROOM_COLS},
            EXISTS (SELECT 1 FROM room_memberships m WHERE m.room_id = r.id AND m.user_id = $2) AS is_member
       FROM rooms r WHERE r.id = $1`,
    [roomId, user.id],
  );
  const r = rows[0];
  if (!r || r.archived_at) throw notFound('Room not found.');
  if (r.is_restricted && !r.is_member && user.role !== 'admin') throw notFound('Room not found.');
  return r;
}

/** Rooms visible to this user, with real (not invented) activity data. */
async function listFor(user) {
  const { rows } = await db.query(
    `SELECT ${ROOM_COLS},
            (SELECT max(m.created_at) FROM messages m WHERE m.room_id = r.id AND m.deleted_at IS NULL) AS last_message_at,
            (SELECT count(*) FROM messages m WHERE m.room_id = r.id AND m.deleted_at IS NULL
                AND m.created_at > now() - interval '24 hours')::int AS messages_24h
       FROM rooms r
      WHERE r.archived_at IS NULL
        AND (NOT r.is_restricted OR $2 = 'admin'
             OR EXISTS (SELECT 1 FROM room_memberships rm WHERE rm.room_id = r.id AND rm.user_id = $1))
      ORDER BY r.sort_order, r.id`,
    [user.id, user.role],
  );
  const out = [];
  for (const r of rows) {
    const viewers = await hub.roomViewers(r.id);
    const visible = require('./presence').snapshot(viewers);
    out.push({
      ...shapeRoom(r),
      lastMessageAt: r.last_message_at,
      messages24h: r.messages_24h,
      hereNow: Object.values(visible).filter((s) => s !== 'offline').length,
    });
  }
  return out;
}

const MSG_SELECT = `
  SELECT m.id, m.room_id, m.user_id, m.body, m.client_id, m.created_at, m.deleted_at,
         u.username AS author_username, u.avatar_seed AS author_avatar, u.xp AS author_xp, u.status AS author_status
    FROM messages m JOIN users u ON u.id = m.user_id`;

async function attachReactions(msgs, viewerId, client = db) {
  if (!msgs.length) return msgs;
  const ids = msgs.map((m) => m.id);
  const { rows } = await client.query(
    `SELECT message_id, emoji, count(*)::int AS n, bool_or(user_id = $2) AS mine
       FROM message_reactions WHERE message_id = ANY($1::bigint[])
      GROUP BY message_id, emoji`,
    [ids, viewerId],
  );
  const byMsg = new Map();
  for (const r of rows) {
    if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, []);
    byMsg.get(r.message_id).push({ emoji: r.emoji, count: r.n, mine: r.mine });
  }
  for (const m of msgs) m.reactions = byMsg.get(m.id) || [];
  return msgs;
}

function shapeMessage(row, thresholds) {
  const deleted = !!row.deleted_at;
  return {
    id: row.id,
    roomId: row.room_id,
    clientId: row.client_id,
    author: members.author(row, thresholds),
    body: deleted ? '' : row.body,
    deleted,
    createdAt: row.created_at,
    reactions: [],
  };
}

/**
 * Page through history. `before` = load older than this id (scroll-up);
 * `after` = fill a gap after reconnecting. Max 50 per page.
 */
async function history(user, roomId, { before = null, after = null, limit = 40 } = {}) {
  await assertAccess(user, roomId);
  limit = Math.min(Math.max(limit, 1), 50);
  const { rows } = await db.query(
    `${MSG_SELECT}
      WHERE m.room_id = $1
        AND ($2::bigint IS NULL OR m.id < $2)
        AND ($3::bigint IS NULL OR m.id > $3)
      ORDER BY m.id ${after ? 'ASC' : 'DESC'}
      LIMIT $4`,
    [roomId, before, after, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (!after) page.reverse();
  const thresholds = await settings.get('rank_thresholds');
  const msgs = page.map((r) => shapeMessage(r, thresholds));
  await attachReactions(msgs, user.id);
  return { messages: msgs, hasMore };
}

/**
 * Validate → authorise → persist → (after commit) broadcast.
 * Idempotent on (user, clientId): a retried send returns the stored message
 * instead of creating a duplicate.
 */
async function send(user, input) {
  const roomId = v.id(input.roomId, 'room');
  const body = v.messageBody(input.body);
  const clientId = v.clientId(input.clientId);
  const c = xp.ctx();

  const result = await db.tx(async (client) => {
    await assertAccess(user, roomId, client);
    const ins = await client.query(
      `INSERT INTO messages (room_id, user_id, body, client_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, client_id) DO NOTHING RETURNING id`,
      [roomId, user.id, body, clientId],
    );
    let id; let duplicate = false;
    if (ins.rowCount) {
      id = ins.rows[0].id;
      await xp.onRoomMessage(client, c, user.id);
      await xp.checkExplorer(client, c, user.id);
    } else {
      const ex = await client.query('SELECT id, room_id FROM messages WHERE user_id = $1 AND client_id = $2', [user.id, clientId]);
      if (ex.rows[0].room_id !== roomId) throw forbidden('Duplicate message id.');
      id = ex.rows[0].id; duplicate = true;
    }
    const { rows } = await client.query(`${MSG_SELECT} WHERE m.id = $1`, [id]);
    const thresholds = await settings.get('rank_thresholds', client);
    const msg = shapeMessage(rows[0], thresholds);
    await attachReactions([msg], user.id, client);
    return { msg, duplicate };
  });

  if (!result.duplicate) hub.toRoom(roomId, 'room:message', result.msg);
  c.flush();
  return result.msg;
}

/** Toggle one reaction. Returns the message's updated reaction summary. */
async function react(user, input) {
  const messageId = v.id(input.messageId, 'message');
  const emoji = v.oneOf(input.emoji, v.REACTIONS, 'reaction');
  const c = xp.ctx();

  const out = await db.tx(async (client) => {
    const { rows } = await client.query('SELECT id, room_id, user_id, deleted_at FROM messages WHERE id = $1', [messageId]);
    const m = rows[0];
    if (!m || m.deleted_at) throw notFound('Message not found.');
    await assertAccess(user, m.room_id, client);
    const del = await client.query(
      'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, user.id, emoji],
    );
    if (!del.rowCount) {
      await client.query('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)', [messageId, user.id, emoji]);
      await xp.onReaction(client, c, { messageId, authorId: m.user_id, reactorId: user.id });
    }
    const agg = await client.query(
      `SELECT emoji, count(*)::int AS n, array_agg(user_id::int) AS users FROM message_reactions
        WHERE message_id = $1 GROUP BY emoji ORDER BY min(created_at)`,
      [messageId],
    );
    return { roomId: m.room_id, summary: agg.rows.map((r) => ({ emoji: r.emoji, count: r.n, users: r.users })) };
  });

  // Each client works out "mine" from the user list.
  hub.toRoom(out.roomId, 'room:reactions', { messageId, reactions: out.summary });
  c.flush();
  return { messageId, reactions: out.summary.map((r) => ({ emoji: r.emoji, count: r.count, mine: r.users.includes(user.id) })) };
}

/** Authors may delete their own messages; admins may remove any (audited). */
async function remove(user, messageId) {
  messageId = v.id(messageId, 'message');
  const roomId = await db.tx(async (client) => {
    const { rows } = await client.query('SELECT id, room_id, user_id, deleted_at FROM messages WHERE id = $1 FOR UPDATE', [messageId]);
    const m = rows[0];
    if (!m) throw notFound('Message not found.');
    await assertAccess(user, m.room_id, client);
    const isAuthor = m.user_id === user.id;
    if (!isAuthor && user.role !== 'admin') throw forbidden('You can only delete your own messages.');
    if (m.deleted_at) return m.room_id;
    await client.query(`UPDATE messages SET body = '', deleted_at = now(), deleted_by = $2 WHERE id = $1`, [messageId, user.id]);
    await client.query('DELETE FROM message_reactions WHERE message_id = $1', [messageId]);
    if (!isAuthor) {
      await require('./audit').record(client, {
        actorId: user.id, action: 'message.moderate_delete', targetType: 'message', targetId: messageId,
        details: { roomId: m.room_id, authorId: m.user_id },
      });
    }
    return m.room_id;
  });
  hub.toRoom(roomId, 'room:deleted', { messageId });
  return { ok: true };
}

module.exports = { ROOM_COLS, shapeRoom, assertAccess, listFor, history, send, react, remove };
