'use strict';

// Service-level integration tests against a real PostgreSQL database.
// They exercise every SQL path: registration and the member cap, sessions,
// access control on rooms and DMs, idempotent sends, XP anti-abuse, account
// deletion and retention.
//
//   DATABASE_URL=postgres://user:pass@localhost:5432/twoway_test npm run test:integration
//
// The database name MUST end in _test: the schema is dropped and recreated.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const url = process.env.DATABASE_URL || '';
if (!/_test(\?|$)/.test(url)) {
  console.error('Refusing to run: DATABASE_URL must point at a database whose name ends in _test.');
  process.exit(1);
}

const db = require('../../server/db');
const { migrate } = require('../../server/db/migrate');
const accounts = require('../../server/services/accounts');
const rooms = require('../../server/services/rooms');
const dms = require('../../server/services/dms');
const admin = require('../../server/services/admin');
const members = require('../../server/services/members');
const activity = require('../../server/services/activity');
const maintenance = require('../../server/services/maintenance');
const sessions = require('../../server/security/sessions');
const settings = require('../../server/services/settings');
const { hashPassword } = require('../../server/security/passwords');

const quiet = { info: () => {} };
const uuid = () => crypto.randomUUID();
const PW = 'correct horse battery';
let A; let B; let C; let ADMIN; let square;

async function reset() {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

async function makeAdmin(username) {
  const hash = await hashPassword(PW);
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash, role, avatar_seed) VALUES ($1, $2, 'admin', $3) RETURNING id, username, role`,
    [username, hash, accounts.newAvatarSeed()],
  );
  await db.query('INSERT INTO user_preferences (user_id) VALUES ($1)', [rows[0].id]);
  return rows[0];
}

async function join(username) {
  const inv = await accounts.createInvite(ADMIN, { username });
  await accounts.register({ inviteCode: inv.code, username, password: PW }, 'test');
  const { rows } = await db.query(`SELECT id, username, role FROM users WHERE username = $1`, [username]);
  return rows[0];
}

async function xpOf(user) {
  return (await db.query('SELECT xp FROM users WHERE id = $1', [user.id])).rows[0].xp;
}

test.before(async () => {
  await reset();
  assert.ok((await migrate(db.pool, quiet)) >= 2);
  ADMIN = await makeAdmin('boss');
  A = await join('ada');
  B = await join('bayo');
  C = await join('chidi');
  square = (await db.query(`SELECT id FROM rooms WHERE slug = 'the-square'`)).rows[0].id;
});

test.after(async () => { await db.pool.end(); });

test('migrations are idempotent and tamper-evident', async () => {
  assert.equal(await migrate(db.pool, quiet), 0);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM rooms');
  assert.equal(rows[0].n, 5, 'five launch rooms seeded');
});

test('invite codes: bound to a username, single-use, revocable', async () => {
  const inv = await accounts.createInvite(ADMIN, { username: 'dayo' });
  await assert.rejects(accounts.register({ inviteCode: inv.code, username: 'someone_else', password: PW }), { code: 'invalid_invite' });
  await assert.rejects(accounts.register({ inviteCode: 'AAAAA-AAAAA-AAAAA', username: 'dayo', password: PW }), { code: 'invalid_invite' });
  await assert.rejects(accounts.register({ inviteCode: inv.code, username: 'dayo', password: 'short' }), { code: 'weak_password' });
  const r = await accounts.register({ inviteCode: inv.code.toLowerCase(), username: 'DAYO', password: PW });
  assert.match(r.cookie, /HttpOnly/);
  await assert.rejects(accounts.register({ inviteCode: inv.code, username: 'dayo', password: PW }), { code: 'invalid_invite' });

  const inv2 = await accounts.createInvite(ADMIN, { username: 'efe' });
  await assert.rejects(accounts.createInvite(ADMIN, { username: 'efe' }), { code: 'invite_exists' });
  await accounts.revokeInvite(ADMIN, inv2.id);
  await assert.rejects(accounts.register({ inviteCode: inv2.code, username: 'efe', password: PW }), { code: 'invalid_invite' });
  await assert.rejects(accounts.createInvite(ADMIN, { username: 'ada' }), { code: 'username_taken' });

  const stored = await db.query('SELECT code_hash FROM invites');
  for (const row of stored.rows) assert.ok(Buffer.isBuffer(row.code_hash) && row.code_hash.length === 32, 'only hashes stored');
});

test('member limit is enforced on the server, counting open invites', async () => {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM users WHERE status IN ('active','suspended')`);
  await db.query(`UPDATE app_settings SET value = $1 WHERE key = 'member_limit'`, [JSON.stringify(rows[0].n + 1)]);
  const last = await accounts.createInvite(ADMIN, { username: 'last_seat' });
  await assert.rejects(accounts.createInvite(ADMIN, { username: 'one_too_many' }), { code: 'member_limit' });
  await accounts.register({ inviteCode: last.code, username: 'last_seat', password: PW });
  await assert.rejects(accounts.createInvite(ADMIN, { username: 'one_too_many' }), { code: 'member_limit' });
  await db.query(`UPDATE app_settings SET value = '50' WHERE key = 'member_limit'`);
});

test('login: generic errors, lockout after repeated failures, suspended accounts refused', async () => {
  await assert.rejects(accounts.login({ username: 'nobody', password: PW }), { code: 'unauthorized' });
  const ok = await accounts.login({ username: 'ADA', password: PW });
  assert.match(ok.cookie, /2way_sid=/);
  const s = await sessions.resolve(ok.cookie.split(';')[0]);
  assert.equal(s.user.id, A.id);

  const victim = await join('locky');
  for (let i = 0; i < 5; i++) await assert.rejects(accounts.login({ username: 'locky', password: 'wrong password!' }), { code: 'unauthorized' });
  await assert.rejects(accounts.login({ username: 'locky', password: PW }), { code: 'locked' });
  await db.query('UPDATE users SET locked_until = NULL WHERE id = $1', [victim.id]);

  const live = await accounts.login({ username: 'locky', password: PW });
  await admin.setMemberStatus(ADMIN, victim.id, { status: 'suspended' });
  assert.equal(await sessions.resolve(live.cookie.split(';')[0]), null, 'suspension revokes live sessions');
  await assert.rejects(accounts.login({ username: 'locky', password: PW }), { code: 'suspended' });
});

test('sessions expire when idle and can be revoked', async () => {
  const s = await sessions.createSession(null, B.id, 'ua');
  const cookie = s.cookie.split(';')[0];
  assert.ok(await sessions.resolve(cookie));
  await db.query(`UPDATE sessions SET last_used_at = now() - interval '30 days' WHERE user_id = $1`, [B.id]);
  assert.equal(await sessions.resolve(cookie), null);
  assert.equal(await sessions.resolve('2way_sid=garbage'), null);
  assert.equal(await sessions.resolve(undefined), null);
});

test('room messages: persisted, idempotent on clientId, server timestamps', async () => {
  const clientId = uuid();
  const m1 = await rooms.send(A, { roomId: square, body: '  hello square  ', clientId });
  const m2 = await rooms.send(A, { roomId: square, body: 'hello square', clientId });
  assert.equal(m1.id, m2.id, 'retry returns the stored message');
  assert.equal(m1.body, 'hello square');
  assert.ok(m1.createdAt instanceof Date);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM messages WHERE client_id = $1', [clientId]);
  assert.equal(rows[0].n, 1);
  await assert.rejects(rooms.send(A, { roomId: square, body: '', clientId: uuid() }), { status: 400 });
  await assert.rejects(rooms.send(A, { roomId: 999999, body: 'x', clientId: uuid() }), { status: 404 });
  await assert.rejects(rooms.send(A, { roomId: square, body: 'x', clientId: 'nope' }), { status: 400 });

  const page = await rooms.history(B, square, {});
  assert.ok(page.messages.some((m) => m.id === m1.id));
  assert.equal(page.messages[0].author.username, 'ada');
  assert.equal(page.messages[0].author.password_hash, undefined);
});

test('history pages with before/after cursors', async () => {
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push((await rooms.send(B, { roomId: square, body: `m${i}`, clientId: uuid() })).id);
  const latest = await rooms.history(A, square, { limit: 3 });
  assert.deepEqual(latest.messages.map((m) => m.id), ids.slice(-3));
  assert.equal(latest.hasMore, true);
  const older = await rooms.history(A, square, { before: ids[4], limit: 3 });
  assert.deepEqual(older.messages.map((m) => m.id), ids.slice(1, 4));
  const gap = await rooms.history(A, square, { after: ids[2], limit: 50 });
  assert.deepEqual(gap.messages.map((m) => m.id), ids.slice(3));
});

test('XP: daily post pays once per day; client-sent XP is ignored', async () => {
  const before = await xpOf(C);
  await rooms.send(C, { roomId: square, body: 'first', clientId: uuid() });
  const afterFirst = await xpOf(C);
  for (let i = 0; i < 5; i++) await rooms.send(C, { roomId: square, body: `spam ${i}`, clientId: uuid() });
  assert.equal(await xpOf(C), afterFirst, 'more messages ≠ more XP');
  assert.ok(afterFirst > before);
  const ev = await db.query(`SELECT reason, amount FROM xp_events WHERE user_id = $1 ORDER BY id`, [C.id]);
  assert.ok(ev.rows.some((r) => r.reason === 'daily_post' && r.amount === 5));
  const ach = await db.query(`SELECT achievement_code FROM member_achievements WHERE user_id = $1`, [C.id]);
  assert.ok(ach.rows.some((r) => r.achievement_code === 'first_words'));

  await accounts.updateProfile(C, { xp: 99999, role: 'admin', status: 'vibes' });
  const row = (await db.query('SELECT xp, role, status_message FROM users WHERE id = $1', [C.id])).rows[0];
  assert.ok(row.xp < 1000);
  assert.equal(row.role, 'member');
  assert.equal(row.status_message, 'vibes');
});

test('XP: reactions pay the author once per mate per message, never self', async () => {
  const msg = await rooms.send(A, { roomId: square, body: 'react to me', clientId: uuid() });
  const x0 = await xpOf(A);
  const r = await rooms.react(B, { messageId: msg.id, emoji: 'fire' });
  assert.deepEqual(r.reactions, [{ emoji: 'fire', count: 1, mine: true }]);
  assert.equal(await xpOf(A), x0 + 2);
  await rooms.react(B, { messageId: msg.id, emoji: 'fire' }); // toggle off
  await rooms.react(B, { messageId: msg.id, emoji: 'fire' }); // toggle on
  await rooms.react(B, { messageId: msg.id, emoji: 'laugh' });
  assert.equal(await xpOf(A), x0 + 2, 'toggling or adding emoji does not farm XP');
  await rooms.react(A, { messageId: msg.id, emoji: 'heart' });
  assert.equal(await xpOf(A), x0 + 2, 'self reactions earn nothing');
  await assert.rejects(rooms.react(B, { messageId: msg.id, emoji: 'poop' }), { status: 400 });
});

test('restricted rooms are invisible and inaccessible to non-members', async () => {
  const { id } = await admin.createRoom(ADMIN, { name: 'Inner Circle', description: 'shh', restricted: true });
  const visibleToA = (await rooms.listFor(A)).map((r) => r.id);
  assert.ok(!visibleToA.includes(id));
  await assert.rejects(rooms.assertAccess(A, id), { status: 404 });
  await assert.rejects(rooms.history(A, id, {}), { status: 404 });
  await assert.rejects(rooms.send(A, { roomId: id, body: 'let me in', clientId: uuid() }), { status: 404 });
  const secret = await rooms.send(ADMIN, { roomId: id, body: 'secret', clientId: uuid() });
  await assert.rejects(rooms.react(A, { messageId: secret.id, emoji: 'fire' }), { status: 404 });
  await assert.rejects(rooms.remove(A, secret.id), { status: 404 });

  await admin.setRoomMember(ADMIN, id, A.id, true);
  assert.ok((await rooms.listFor(A)).some((r) => r.id === id));
  assert.equal((await rooms.history(A, id, {})).messages[0].body, 'secret');
  await admin.setRoomMember(ADMIN, id, A.id, false);
  await assert.rejects(rooms.history(A, id, {}), { status: 404 });

  const feed = await activity.recent(50);
  assert.ok(!feed.some((f) => f.room?.id === id), 'restricted rooms never appear in the feed');
});

test('message deletion: authors and admins only', async () => {
  const m = await rooms.send(A, { roomId: square, body: 'oops', clientId: uuid() });
  await assert.rejects(rooms.remove(B, m.id), { status: 403 });
  await rooms.remove(A, m.id);
  const page = await rooms.history(B, square, { after: m.id - 1, limit: 1 });
  assert.equal(page.messages[0].deleted, true);
  assert.equal(page.messages[0].body, '');
  const m2 = await rooms.send(B, { roomId: square, body: 'rude', clientId: uuid() });
  await rooms.remove(ADMIN, m2.id);
  const audit = await db.query(`SELECT action FROM audit_events WHERE action = 'message.moderate_delete'`);
  assert.equal(audit.rowCount, 1);
});

test('DMs: only the two participants can read, send, mark read or delete', async () => {
  const { id } = await dms.open(A, B.id);
  assert.equal((await dms.open(B, A.id)).id, id, 'one conversation per pair');
  await assert.rejects(dms.open(A, A.id), { status: 400 });

  const m = await dms.send(A, { conversationId: id, body: 'just us', clientId: uuid() });
  const dup = await dms.send(A, { conversationId: id, body: 'just us', clientId: m.clientId });
  assert.equal(dup.id, m.id);

  await assert.rejects(dms.history(C, id, {}), { status: 404 });
  await assert.rejects(dms.send(C, { conversationId: id, body: 'hi', clientId: uuid() }), { status: 404 });
  await assert.rejects(dms.markRead(C, { conversationId: id, messageId: m.id }), { status: 404 });
  await assert.rejects(dms.remove(C, m.id), { status: 404 });
  await assert.rejects(dms.remove(B, m.id), { status: 404 }, 'cannot delete the other person’s message');
  assert.equal((await dms.list(C)).length, 0);
  assert.equal(await dms.otherParticipant(C, id), null);

  assert.equal(await dms.unreadTotal(B), 1);
  const listB = await dms.list(B);
  assert.equal(listB[0].unread, 1);
  assert.equal(listB[0].other.username, 'ada');
  await dms.markRead(B, { conversationId: id, messageId: m.id });
  assert.equal(await dms.unreadTotal(B), 0);

  const h1 = await dms.history(A, id, {});
  assert.equal(h1.conversation.otherReadId, m.id, 'read receipts visible when both opt in');
  await accounts.updatePrefs(B, { readReceipts: false });
  const h2 = await dms.history(A, id, {});
  assert.equal(h2.conversation.otherReadId, null, 'hidden when either side opts out');
  await accounts.updatePrefs(B, { readReceipts: true });

  // A message id from another conversation can't move your read pointer.
  const other = await dms.open(B, C.id);
  const cm = await dms.send(C, { conversationId: other.id, body: 'yo', clientId: uuid() });
  await dms.markRead(A, { conversationId: id, messageId: cm.id });
  const p = await db.query('SELECT last_read_message_id FROM dm_participants WHERE conversation_id = $1 AND user_id = $2', [id, A.id]);
  assert.notEqual(p.rows[0].last_read_message_id, cm.id);
});

test('admin XP grants are audited and can rank members up', async () => {
  await admin.grantXp(ADMIN, { userId: B.id, amount: 300, note: 'Won Match Day predictions' });
  const me = await accounts.me(B);
  assert.ok(me.xp >= 300);
  assert.notEqual(me.rank.name, 'Rookie');
  const feed = await activity.recent(50);
  assert.ok(feed.some((f) => f.kind === 'rank_up' && f.user.id === B.id));
  const audit = await db.query(`SELECT details FROM audit_events WHERE action = 'xp.grant'`);
  assert.equal(audit.rows[0].details.amount, 300);
  await assert.rejects(admin.grantXp(ADMIN, { userId: B.id, amount: 5000, note: 'too much' }), { status: 400 });
});

test('activity feed respects the opt-out and never contains message text', async () => {
  await accounts.updatePrefs(B, { showInActivity: false });
  const feed = await activity.recent(50);
  assert.ok(!feed.some((f) => f.user?.id === B.id));
  assert.ok(!JSON.stringify(feed).includes('just us'));
  await accounts.updatePrefs(B, { showInActivity: true });
});

test('member listing exposes only public fields', async () => {
  const list = await members.list();
  const keys = Object.keys(list[0]).sort();
  assert.deepEqual(keys, ['avatar', 'id', 'isAdmin', 'presence', 'rank', 'rankIndex', 'status', 'username', 'xp']);
  assert.ok(!list.some((m) => m.username === 'locky'), 'suspended members are not listed');
});

test('settings: validated, member limit not editable in-app', async () => {
  await assert.rejects(admin.updateSettings(ADMIN, { roomRetentionDays: -1 }), { status: 400 });
  await assert.rejects(admin.updateSettings(ADMIN, { rankThresholds: [{ name: 'Aa', minXp: 5 }, { name: 'Bb', minXp: 6 }] }), { status: 400 });
  await assert.rejects(admin.updateSettings(ADMIN, { memberLimit: 500 }), { status: 400 });
  const s = await admin.updateSettings(ADMIN, { inviteTtlDays: 3 });
  assert.equal(s.inviteTtlDays, 3);
  assert.equal(s.memberLimit, 50);
});

test('retention purge deletes only messages older than the policy', async () => {
  const old = await rooms.send(A, { roomId: square, body: 'ancient', clientId: uuid() });
  const fresh = await rooms.send(A, { roomId: square, body: 'fresh', clientId: uuid() });
  await db.query(`UPDATE messages SET created_at = now() - interval '400 days' WHERE id = $1`, [old.id]);
  await maintenance.runOnce();
  const left = await db.query('SELECT id FROM messages WHERE id = ANY($1::bigint[])', [[old.id, fresh.id]]);
  assert.deepEqual(left.rows.map((r) => r.id), [fresh.id]);
  await admin.updateSettings(ADMIN, { roomRetentionDays: 0 });
  await db.query(`UPDATE messages SET created_at = now() - interval '4000 days' WHERE id = $1`, [fresh.id]);
  await maintenance.runOnce();
  assert.equal((await db.query('SELECT 1 FROM messages WHERE id = $1', [fresh.id])).rowCount, 1, '0 = keep');
});

test('account deletion blanks content, frees the seat and keeps the audit trail', async () => {
  const gone = await join('leaver');
  await rooms.send(gone, { roomId: square, body: 'bye all', clientId: uuid() });
  const { id } = await dms.open(gone, A.id);
  await dms.send(gone, { conversationId: id, body: 'private bye', clientId: uuid() });
  const s = await sessions.createSession(null, gone.id, 'ua');

  const seatsBefore = await admin.listMembers();
  await assert.rejects(accounts.deleteAccount(gone, gone.id, { password: 'wrong password' }), { code: 'wrong_password' });
  await accounts.deleteAccount(gone, gone.id, { password: PW });

  const u = (await db.query('SELECT username, password_hash, status, xp FROM users WHERE id = $1', [gone.id])).rows[0];
  assert.equal(u.status, 'deleted');
  assert.equal(u.password_hash, null);
  assert.equal(u.username, `deleted-${gone.id}`);
  const texts = await db.query(`SELECT body FROM messages WHERE user_id = $1 UNION ALL SELECT body FROM dm_messages WHERE sender_id = $1`, [gone.id]);
  assert.ok(texts.rows.every((r) => r.body === ''));
  assert.equal(await sessions.resolve(s.cookie.split(';')[0]), null);
  assert.equal((await db.query('SELECT 1 FROM xp_events WHERE user_id = $1', [gone.id])).rowCount, 0);
  const seatsAfter = await admin.listMembers();
  assert.equal(seatsAfter.seats.members, seatsBefore.seats.members - 1);
  assert.ok((await db.query(`SELECT 1 FROM audit_events WHERE action = 'account.delete_self' AND target_id = $1`, [String(gone.id)])).rowCount);
  const hist = await dms.history(A, id, {});
  assert.equal(hist.conversation.other.username, 'Former member');
  await assert.rejects(dms.send(A, { conversationId: id, body: 'hello?', clientId: uuid() }), { status: 400 });

  await assert.rejects(accounts.deleteAccount(ADMIN, ADMIN.id, { password: PW }), { code: 'last_admin' });
});

test('password change signs out other sessions', async () => {
  const s1 = await sessions.createSession(null, C.id, 'phone');
  const s2 = await sessions.createSession(null, C.id, 'laptop');
  const keep = await sessions.resolve(s1.cookie.split(';')[0]);
  await accounts.changePassword(C, keep.tokenHash, { currentPassword: PW, newPassword: 'a brand new passphrase' });
  assert.ok(await sessions.resolve(s1.cookie.split(';')[0]));
  assert.equal(await sessions.resolve(s2.cookie.split(';')[0]), null);
  await assert.rejects(accounts.changePassword(C, keep.tokenHash, { currentPassword: 'nope nope nope', newPassword: 'whatever whatever' }), { code: 'wrong_password' });
});

test('concurrent registrations cannot exceed the member limit', async () => {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM users WHERE status IN ('active','suspended')`);
  const invites = [];
  for (const n of ['race_a', 'race_b']) invites.push(await accounts.createInvite(ADMIN, { username: n }));
  // Squeeze the limit after the invites exist so only one can still register.
  await db.query(`UPDATE app_settings SET value = $1 WHERE key = 'member_limit'`, [JSON.stringify(rows[0].n + 1)]);
  const results = await Promise.allSettled(invites.map((i) => accounts.register({ inviteCode: i.code, username: i.intendedUsername, password: PW })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'member_limit');
  await db.query(`UPDATE app_settings SET value = '50' WHERE key = 'member_limit'`);
  void settings;
});

test('remaining read paths and admin edits run cleanly', async () => {
  const presence = require('../../server/services/presence');
  const m = await members.get(A.id);
  assert.equal(m.username, 'ada');
  assert.ok(Array.isArray(m.achievements) && m.achievements.length > 0);
  assert.equal(await members.get(999999), null);

  const me = await accounts.me(A);
  assert.equal(me.ranks.length, 6);
  assert.equal(me.prefs.theme, 'dark');
  const seed = me.avatar;
  const after = await accounts.updateProfile(A, { newAvatar: true });
  assert.notEqual(after.avatar, seed);
  assert.match(after.avatar, /^[a-f0-9]{16}$/);
  await assert.rejects(accounts.updatePrefs(A, { theme: 'neon' }), { status: 400 });
  assert.equal((await accounts.updatePrefs(A, { theme: 'light' })).prefs.theme, 'light');

  const list = await admin.listRooms();
  const room = list.find((r) => r.slug === 'game-zone');
  await admin.updateRoom(ADMIN, room.id, { description: 'Lobbies & clips', archived: true });
  assert.ok(!(await rooms.listFor(A)).some((r) => r.id === room.id), 'archived rooms disappear');
  await assert.rejects(rooms.history(A, room.id, {}), { status: 404 });
  await admin.updateRoom(ADMIN, room.id, { archived: false, sortOrder: 5 });
  assert.equal((await rooms.listFor(A))[0].id, room.id);
  await assert.rejects(admin.updateRoom(ADMIN, room.id, { color: 'plaid' }), { status: 400 });
  await assert.rejects(admin.createRoom(ADMIN, { name: 'Game Zone', slug: 'game-zone' }), { status: 409 });

  const restricted = list.find((r) => r.restricted);
  assert.deepEqual(await admin.roomMembers(restricted.id), []);
  assert.ok((await accounts.listInvites()).some((i) => i.state === 'used'));
  assert.ok((await admin.auditLog({})).length > 5);

  await admin.setMemberStatus(ADMIN, B.id, { role: 'admin' });
  assert.equal((await db.query('SELECT role FROM users WHERE id = $1', [B.id])).rows[0].role, 'admin');
  await admin.setMemberStatus(ADMIN, B.id, { role: 'member' });
  await assert.rejects(admin.setMemberStatus(ADMIN, ADMIN.id, { status: 'suspended' }), { status: 400 });

  presence.connected(A.id, false, null);
  presence.activity(A.id);
  assert.equal(presence.snapshot([A.id])[A.id], 'online');
  presence.setHidden(A.id, true);
  assert.equal(presence.snapshot([A.id])[A.id], 'offline', 'hidden presence reads as offline');
  presence.setHidden(A.id, false);
  presence.disconnected(A.id);
  assert.equal(presence.snapshot([A.id])[A.id], 'recent');
  await presence.flush();
  await new Promise((r) => setTimeout(r, 300)); // disconnected() already started a flush
  const seen = (await db.query('SELECT last_seen_at FROM users WHERE id = $1', [A.id])).rows[0].last_seen_at;
  assert.ok(seen instanceof Date && Date.now() - seen.getTime() < 60_000);
  await presence.warmUp();
});
