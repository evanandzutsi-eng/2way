'use strict';

const db = require('../db');
const settings = require('./settings');
const audit = require('./audit');
const xp = require('./xp');
const hub = require('../realtime/hub');
const sessions = require('../security/sessions');
const rooms = require('./rooms');
const v = require('../lib/validate');
const { bad, conflict, notFound } = require('../lib/errors');

async function listMembers() {
  const { rows } = await db.query(
    `SELECT id, username, role, status, xp, created_at FROM users WHERE status <> 'deleted' ORDER BY lower(username)`,
  );
  const s = await settings.all();
  const { rankFor } = require('../lib/ranks');
  const seats = await db.query(
    `SELECT (SELECT count(*) FROM users WHERE status IN ('active','suspended'))::int AS members,
            (SELECT count(*) FROM invites WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now())::int AS open_invites`,
  );
  return {
    limit: s.member_limit,
    seats: seats.rows[0],
    members: rows.map((r) => ({ id: r.id, username: r.username, role: r.role, status: r.status, xp: r.xp, rank: rankFor(r.xp, s.rank_thresholds).name, joinedAt: r.created_at })),
  };
}

async function setMemberStatus(admin, userId, input) {
  userId = v.id(userId, 'member');
  if (userId === admin.id) throw bad("You can't change your own account here.");
  const status = input.status !== undefined ? v.oneOf(input.status, ['active', 'suspended'], 'status') : undefined;
  const role = input.role !== undefined ? v.oneOf(input.role, ['member', 'admin'], 'role') : undefined;
  if (status === undefined && role === undefined) throw bad('Nothing to update.');
  await db.tx(async (client) => {
    const { rows } = await client.query(`SELECT id, status, role FROM users WHERE id = $1 AND status <> 'deleted' FOR UPDATE`, [userId]);
    if (!rows[0]) throw notFound('Member not found.');
    if (status) await client.query('UPDATE users SET status = $2 WHERE id = $1', [userId, status]);
    if (role) await client.query('UPDATE users SET role = $2 WHERE id = $1', [userId, role]);
    if (status === 'suspended') await sessions.revokeAllForUser(client, userId);
    await audit.record(client, { actorId: admin.id, action: 'member.update', targetType: 'user', targetId: userId, details: { status, role } });
  });
  if (status === 'suspended' || role) await hub.kick(userId); // role change: reconnect with fresh permissions
  hub.toMembers('members:changed', {});
  return { ok: true };
}

/** Admin XP grants are for community events and challenges; every one is audited. */
async function grantXp(admin, input) {
  v.payload(input);
  const userId = v.id(input.userId, 'member');
  const amount = v.int(input.amount, { field: 'Amount', min: -500, max: 500 });
  if (amount === 0) throw bad('Amount cannot be zero.');
  const note = v.text(input.note, { field: 'Reason', min: 3, max: 120 });
  const c = xp.ctx();
  const res = await db.tx(async (client) => {
    const u = await client.query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [userId]);
    if (!u.rowCount) throw notFound('Member not found.');
    const r = await xp.award(client, c, { userId, amount, reason: 'admin_grant', refKey: null, grantedBy: admin.id, note });
    await audit.record(client, { actorId: admin.id, action: 'xp.grant', targetType: 'user', targetId: userId, details: { amount, note } });
    return r;
  });
  c.flush();
  hub.toMembers('members:changed', { userId });
  return { ok: true, xp: res.xp };
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

function roomInput(input, partial) {
  v.payload(input);
  const out = {};
  if (!partial || input.name !== undefined) out.name = v.text(input.name, { field: 'Name', min: 2, max: 32 });
  if (!partial || input.description !== undefined) out.description = v.text(input.description ?? '', { field: 'Description', max: 120 });
  if (!partial || input.color !== undefined) out.color = v.oneOf(input.color ?? 'violet', v.ROOM_COLORS, 'colour');
  if (!partial || input.icon !== undefined) out.icon = v.oneOf(input.icon ?? 'chat', v.ROOM_ICONS, 'icon');
  if (!partial || input.restricted !== undefined) out.is_restricted = v.bool(input.restricted ?? false, 'restricted');
  if (input.sortOrder !== undefined) out.sort_order = v.int(input.sortOrder, { field: 'Order', min: 0, max: 10000 });
  if (!partial) out.slug = v.slug(input.slug ?? out.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32));
  return out;
}

async function listRooms() {
  const { rows } = await db.query(
    `SELECT ${rooms.ROOM_COLS}, (SELECT count(*) FROM room_memberships m WHERE m.room_id = r.id)::int AS member_count
       FROM rooms r ORDER BY r.archived_at NULLS FIRST, r.sort_order, r.id`,
  );
  return rows.map((r) => ({ ...rooms.shapeRoom(r), memberCount: r.member_count }));
}

async function createRoom(admin, input) {
  const r = roomInput(input, false);
  const c = xp.ctx();
  const room = await db.tx(async (client) => {
    let row;
    try {
      ({ rows: [row] } = await client.query(
        `INSERT INTO rooms (slug, name, description, color, icon, is_restricted, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 100)) RETURNING id`,
        [r.slug, r.name, r.description, r.color, r.icon, r.is_restricted, r.sort_order ?? null],
      ));
    } catch (err) {
      if (err.code === '23505') throw conflict('A room with that slug already exists.');
      throw err;
    }
    if (!r.is_restricted) await xp.addActivity(client, c, { kind: 'room_created', roomId: row.id, data: { name: r.name } });
    await audit.record(client, { actorId: admin.id, action: 'room.create', targetType: 'room', targetId: row.id, details: { name: r.name, restricted: r.is_restricted } });
    return row;
  });
  c.flush();
  hub.toMembers('rooms:changed', {});
  return { id: room.id };
}

async function updateRoom(admin, roomId, input) {
  roomId = v.id(roomId, 'room');
  const r = roomInput(input, true);
  const archive = input.archived !== undefined ? v.bool(input.archived, 'archived') : undefined;
  const cols = Object.keys(r);
  if (!cols.length && archive === undefined) throw bad('Nothing to update.');
  await db.tx(async (client) => {
    const vals = [roomId, ...cols.map((k) => r[k])];
    const sets = cols.map((k, i) => `${k} = $${i + 2}`);
    if (archive !== undefined) sets.push(archive ? 'archived_at = COALESCE(archived_at, now())' : 'archived_at = NULL');
    const { rowCount } = await client.query(`UPDATE rooms SET ${sets.join(', ')} WHERE id = $1`, vals);
    if (!rowCount) throw notFound('Room not found.');
    await audit.record(client, { actorId: admin.id, action: 'room.update', targetType: 'room', targetId: roomId, details: { fields: cols, archived: archive } });
  });
  hub.toMembers('rooms:changed', {});
  return { ok: true };
}

async function roomMembers(roomId) {
  roomId = v.id(roomId, 'room');
  const { rows } = await db.query(
    `SELECT u.id, u.username FROM room_memberships m JOIN users u ON u.id = m.user_id WHERE m.room_id = $1 ORDER BY lower(u.username)`,
    [roomId],
  );
  return rows;
}

async function setRoomMember(admin, roomId, userId, add) {
  roomId = v.id(roomId, 'room');
  userId = v.id(userId, 'member');
  await db.tx(async (client) => {
    const room = await client.query('SELECT id FROM rooms WHERE id = $1', [roomId]);
    if (!room.rowCount) throw notFound('Room not found.');
    if (add) {
      const u = await client.query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [userId]);
      if (!u.rowCount) throw notFound('Member not found.');
      await client.query('INSERT INTO room_memberships (room_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [roomId, userId, admin.id]);
    } else {
      await client.query('DELETE FROM room_memberships WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
    }
    await audit.record(client, { actorId: admin.id, action: add ? 'room.member_add' : 'room.member_remove', targetType: 'room', targetId: roomId, details: { userId } });
  });
  if (!add) await hub.evictFromRoom(userId, roomId);
  hub.toUser(userId, 'rooms:changed', {});
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Settings and audit log
// ---------------------------------------------------------------------------

async function getSettings() {
  const s = await settings.all();
  return {
    memberLimit: s.member_limit, roomRetentionDays: s.room_retention_days, dmRetentionDays: s.dm_retention_days,
    inviteTtlDays: s.invite_ttl_days, rankThresholds: s.rank_thresholds,
  };
}

async function updateSettings(admin, input) {
  v.payload(input);
  const map = { roomRetentionDays: 'room_retention_days', dmRetentionDays: 'dm_retention_days', inviteTtlDays: 'invite_ttl_days', rankThresholds: 'rank_thresholds' };
  const changed = [];
  await db.tx(async (client) => {
    for (const [k, key] of Object.entries(map)) {
      if (input[k] === undefined) continue;
      try { await settings.set(client, key, input[k], admin.id); } catch (err) { throw bad(`${k}: ${err.message}`); }
      changed.push(key);
    }
    if (!changed.length) throw bad('Nothing to update.');
    await audit.record(client, { actorId: admin.id, action: 'settings.update', details: { keys: changed, values: Object.fromEntries(changed.map((c) => [c, input[Object.keys(map).find((k) => map[k] === c)]])) } });
  });
  hub.toMembers('members:changed', {});
  return getSettings();
}

async function auditLog({ before = null } = {}) {
  const { rows } = await db.query(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.details, a.created_at, u.username AS actor
       FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
      WHERE ($1::bigint IS NULL OR a.id < $1)
      ORDER BY a.id DESC LIMIT 50`,
    [before],
  );
  return rows.map((r) => ({ id: r.id, action: r.action, actor: r.actor, targetType: r.target_type, targetId: r.target_id, details: r.details, createdAt: r.created_at }));
}

module.exports = {
  listMembers, setMemberStatus, grantXp, listRooms, createRoom, updateRoom, roomMembers, setRoomMember,
  getSettings, updateSettings, auditLog,
};
