'use strict';

const crypto = require('node:crypto');
const db = require('../db');
const settings = require('./settings');
const audit = require('./audit');
const xp = require('./xp');
const presence = require('./presence');
const hub = require('../realtime/hub');
const sessions = require('../security/sessions');
const { hashPassword, verifyPassword, burnTime } = require('../security/passwords');
const { newInviteCode, sha256 } = require('../lib/tokens');
const v = require('../lib/validate');
const { bad, conflict, notFound, unauthorized, AppError } = require('../lib/errors');

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function newAvatarSeed() { return crypto.randomBytes(8).toString('hex'); }

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/** Active members + open invites, counted under a lock so concurrent requests can't overshoot. */
async function seatsInUse(client) {
  // Serialise all seat-changing operations on one row lock.
  await client.query(`SELECT 1 FROM app_settings WHERE key = 'member_limit' FOR UPDATE`);
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM users WHERE status IN ('active', 'suspended'))::int AS members,
            (SELECT count(*) FROM invites WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now())::int AS open_invites`,
  );
  return rows[0];
}

async function createInvite(admin, input) {
  const intended = v.username(input.username);
  const note = v.text(input.note ?? '', { field: 'Note', max: 120 });
  return db.tx(async (client) => {
    const limit = await settings.get('member_limit', client);
    const ttlDays = await settings.get('invite_ttl_days', client);
    const seats = await seatsInUse(client);
    if (seats.members + seats.open_invites >= limit) {
      throw conflict(`All ${limit} seats are taken or reserved by open invites. Revoke an invite or remove a member first.`, 'member_limit');
    }
    const taken = await client.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [intended]);
    if (taken.rowCount) throw conflict('That username is already a member.', 'username_taken');
    const code = newInviteCode();
    let row;
    try {
      ({ rows: [row] } = await client.query(
        `INSERT INTO invites (code_hash, intended_username, note, created_by, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id, expires_at`,
        [sha256(code.raw), intended, note, admin.id, ttlDays],
      ));
    } catch (err) {
      if (err.code === '23505') throw conflict('There is already an open invite for that username.', 'invite_exists');
      throw err;
    }
    await audit.record(client, { actorId: admin.id, action: 'invite.create', targetType: 'invite', targetId: row.id, details: { intendedUsername: intended } });
    // The plain code is returned exactly once and never stored or logged.
    return { id: row.id, code: code.display, intendedUsername: intended, expiresAt: row.expires_at };
  });
}

async function listInvites() {
  const { rows } = await db.query(
    `SELECT i.id, i.intended_username, i.note, i.created_at, i.expires_at, i.revoked_at, i.used_at, u.username AS used_by
       FROM invites i LEFT JOIN users u ON u.id = i.used_by
      ORDER BY i.id DESC LIMIT 200`,
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id, intendedUsername: r.intended_username, note: r.note, createdAt: r.created_at, expiresAt: r.expires_at,
    usedBy: r.used_by,
    state: r.used_at ? 'used' : r.revoked_at ? 'revoked' : r.expires_at.getTime() < now ? 'expired' : 'open',
  }));
}

async function revokeInvite(admin, inviteId) {
  inviteId = v.id(inviteId, 'invite');
  await db.tx(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE invites SET revoked_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [inviteId],
    );
    if (!rowCount) throw notFound('No open invite with that id.');
    await audit.record(client, { actorId: admin.id, action: 'invite.revoke', targetType: 'invite', targetId: inviteId });
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Registration and login
// ---------------------------------------------------------------------------

async function register(input, userAgent) {
  const code = v.inviteCode(input.inviteCode);
  const username = v.username(input.username);
  const password = v.password(input.password);
  const hash = await hashPassword(password); // outside the transaction: it's slow on purpose

  const c = xp.ctx();
  const result = await db.tx(async (client) => {
    const { rows } = await client.query(
      `SELECT id, intended_username FROM invites
        WHERE code_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [sha256(code)],
    );
    const invite = rows[0];
    // One generic message for unknown, used, revoked, expired or mismatched codes.
    const invalid = () => new AppError(400, 'invalid_invite', "That invite code and username don't match an open invite.");
    if (!invite) throw invalid();
    if (invite.intended_username.toLowerCase() !== username.toLowerCase()) throw invalid();

    const limit = await settings.get('member_limit', client);
    const seats = await seatsInUse(client);
    // This invite is one of the open ones, so it already holds a seat.
    if (seats.members >= limit) throw conflict('2WaY is full right now. Ask the admin.', 'member_limit');

    let user;
    try {
      ({ rows: [user] } = await client.query(
        `INSERT INTO users (username, password_hash, avatar_seed) VALUES ($1, $2, $3)
         RETURNING id, username, role, avatar_seed, status_message, xp`,
        [invite.intended_username, hash, newAvatarSeed()],
      ));
    } catch (err) {
      if (err.code === '23505') throw conflict('That username is already taken.', 'username_taken');
      throw err;
    }
    await client.query('INSERT INTO user_preferences (user_id) VALUES ($1)', [user.id]);
    await client.query('UPDATE invites SET used_at = now(), used_by = $2 WHERE id = $1', [invite.id, user.id]);
    await audit.record(client, { actorId: user.id, action: 'invite.use', targetType: 'invite', targetId: invite.id });
    await xp.addActivity(client, c, { kind: 'member_joined', userId: user.id });
    await xp.grantAchievement(client, c, user.id, 'welcome');
    const s = await sessions.createSession(client, user.id, userAgent);
    return { user, cookie: s.cookie };
  });
  c.flush();
  hub.toMembers('members:changed', {});
  return result;
}

async function login(input, userAgent) {
  const username = typeof input.username === 'string' ? input.username.trim().slice(0, 40) : '';
  const password = typeof input.password === 'string' ? input.password.slice(0, 256) : '';
  const generic = () => unauthorized('Wrong username or password.');
  if (!username || !password) throw generic();

  const { rows } = await db.query(
    `SELECT id, username, role, status, password_hash, failed_logins, locked_until FROM users WHERE lower(username) = lower($1)`,
    [username],
  );
  const u = rows[0];
  if (!u || u.status === 'deleted' || !u.password_hash) {
    await burnTime(password);
    throw generic();
  }
  if (u.locked_until && u.locked_until.getTime() > Date.now()) {
    await burnTime(password);
    throw new AppError(429, 'locked', 'Too many failed attempts. Try again in a few minutes.');
  }
  const ok = await verifyPassword(u.password_hash, password);
  if (!ok) {
    const failed = u.failed_logins + 1;
    const lock = failed >= MAX_FAILED;
    await db.query(
      `UPDATE users SET failed_logins = $2::smallint,
              locked_until = CASE WHEN $3::boolean THEN now() + make_interval(mins => $4::int) ELSE locked_until END
        WHERE id = $1`,
      [u.id, lock ? 0 : failed, lock, LOCK_MINUTES],
    );
    if (failed >= MAX_FAILED) await audit.record(null, { actorId: u.id, action: 'auth.locked', targetType: 'user', targetId: u.id });
    throw generic();
  }
  if (u.status === 'suspended') throw new AppError(403, 'suspended', 'This account is suspended. Talk to the admin.');
  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
  const s = await sessions.createSession(null, u.id, userAgent);
  return { cookie: s.cookie };
}

async function changePassword(user, sessionHash, input) {
  const current = typeof input.currentPassword === 'string' ? input.currentPassword : '';
  const next = v.password(input.newPassword);
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!(await verifyPassword(rows[0].password_hash, current))) throw bad('Your current password is not right.', 'wrong_password');
  const hash = await hashPassword(next);
  await db.tx(async (client) => {
    await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, hash]);
    await sessions.revokeAllForUser(client, user.id, sessionHash); // sign out other devices
    await audit.record(client, { actorId: user.id, action: 'auth.password_change', targetType: 'user', targetId: user.id });
  });
  await hub.kick(user.id, sessionHash);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Profile and preferences
// ---------------------------------------------------------------------------

async function me(user) {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.role, u.avatar_seed, u.status_message, u.xp, u.created_at,
            p.theme, p.show_presence, p.read_receipts, p.show_in_activity
       FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id WHERE u.id = $1`,
    [user.id],
  );
  const r = rows[0];
  const s = await settings.all();
  const { rankFor } = require('../lib/ranks');
  const ach = await db.query(
    `SELECT a.code, a.name, a.description, a.icon, ma.earned_at
       FROM achievements a LEFT JOIN member_achievements ma ON ma.achievement_code = a.code AND ma.user_id = $1
      ORDER BY a.sort_order`,
    [user.id],
  );
  return {
    id: r.id, username: r.username, isAdmin: r.role === 'admin', avatar: r.avatar_seed, status: r.status_message,
    xp: r.xp, rank: rankFor(r.xp, s.rank_thresholds), ranks: s.rank_thresholds, joinedAt: r.created_at,
    prefs: {
      theme: r.theme || 'dark', showPresence: r.show_presence ?? true,
      readReceipts: r.read_receipts ?? true, showInActivity: r.show_in_activity ?? true,
    },
    achievements: ach.rows.map((a) => ({ code: a.code, name: a.name, description: a.description, icon: a.icon, earnedAt: a.earned_at })),
    policy: { roomRetentionDays: s.room_retention_days, dmRetentionDays: s.dm_retention_days },
  };
}

async function updateProfile(user, input) {
  v.payload(input);
  const c = xp.ctx();
  await db.tx(async (client) => {
    if (input.status !== undefined) {
      const status = v.text(input.status, { field: 'Status', max: 80 });
      await client.query('UPDATE users SET status_message = $2 WHERE id = $1', [user.id, status]);
      if (status) await xp.grantAchievement(client, c, user.id, 'profile_complete');
    }
    if (input.newAvatar === true) {
      await client.query('UPDATE users SET avatar_seed = $2 WHERE id = $1', [user.id, newAvatarSeed()]);
    }
  });
  c.flush();
  hub.toMembers('members:changed', { userId: user.id });
  return me(user);
}

async function updatePrefs(user, input) {
  v.payload(input);
  const map = { theme: 'theme', showPresence: 'show_presence', readReceipts: 'read_receipts', showInActivity: 'show_in_activity' };
  const sets = []; const vals = [user.id];
  for (const [k, col] of Object.entries(map)) {
    if (input[k] === undefined) continue;
    const val = k === 'theme' ? v.oneOf(input[k], ['dark', 'light'], 'theme') : v.bool(input[k], k);
    vals.push(val); sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) throw bad('Nothing to update.');
  await db.query(
    `INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [user.id],
  );
  await db.query(`UPDATE user_preferences SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`, vals);
  if (input.showPresence !== undefined) presence.setHidden(user.id, !input.showPresence);
  return me(user);
}

// ---------------------------------------------------------------------------
// Account deletion (self-service, or admin removal)
// ---------------------------------------------------------------------------

/**
 * Deleting an account:
 *  - removes the password, sessions, preferences, XP history, achievements,
 *    reactions and activity entries;
 *  - blanks every room and DM message the member sent (the rows remain as
 *    "message removed" placeholders so conversations keep their shape);
 *  - renames the account to deleted-<id> and frees the membership seat;
 *  - keeps audit_events rows (they hold ids and actions, not content).
 * Backups taken before deletion still contain the data until they rotate out
 * (BACKUP_RETENTION_DAYS, 14 by default).
 */
async function deleteAccount(actor, targetId, { password = null, reason = 'self' } = {}) {
  const self = actor.id === targetId;
  if (self) {
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [targetId]);
    if (!(await verifyPassword(rows[0]?.password_hash, password || ''))) throw bad('Your password is not right.', 'wrong_password');
  }
  await db.tx(async (client) => {
    const { rows } = await client.query(`SELECT id, role, status FROM users WHERE id = $1 FOR UPDATE`, [targetId]);
    const u = rows[0];
    if (!u || u.status === 'deleted') throw notFound('Member not found.');
    if (u.role === 'admin') {
      const admins = await client.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'`);
      if (admins.rows[0].n <= 1) throw conflict('The last admin cannot be deleted. Make someone else admin first.', 'last_admin');
    }
    await client.query(`UPDATE messages SET body = '', deleted_at = COALESCE(deleted_at, now()) WHERE user_id = $1`, [targetId]);
    await client.query(`UPDATE dm_messages SET body = '', deleted_at = COALESCE(deleted_at, now()) WHERE sender_id = $1`, [targetId]);
    await client.query('DELETE FROM message_reactions WHERE user_id = $1', [targetId]);
    await client.query('DELETE FROM xp_events WHERE user_id = $1', [targetId]);
    await client.query('DELETE FROM member_achievements WHERE user_id = $1', [targetId]);
    await client.query('DELETE FROM member_active_days WHERE user_id = $1', [targetId]);
    await client.query('DELETE FROM activity WHERE user_id = $1', [targetId]);
    await client.query('DELETE FROM room_memberships WHERE user_id = $1', [targetId]);
    await client.query('DELETE FROM user_preferences WHERE user_id = $1', [targetId]);
    await client.query('DELETE FROM sessions WHERE user_id = $1', [targetId]);
    await client.query(
      `UPDATE users SET username = 'deleted-' || id, password_hash = NULL, status = 'deleted', role = 'member',
              status_message = '', xp = 0, avatar_seed = 'deleted', last_seen_at = NULL, deleted_at = now()
        WHERE id = $1`,
      [targetId],
    );
    await audit.record(client, { actorId: actor.id, action: self ? 'account.delete_self' : 'account.delete_by_admin', targetType: 'user', targetId, details: { reason } });
  });
  await hub.kick(targetId);
  presence.forget(targetId);
  hub.toMembers('members:changed', {});
  return { ok: true };
}

module.exports = {
  createInvite, listInvites, revokeInvite, register, login, changePassword, me, updateProfile, updatePrefs, deleteAccount,
  newAvatarSeed, seatsInUse,
};
