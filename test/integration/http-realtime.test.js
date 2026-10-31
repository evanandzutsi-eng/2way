'use strict';

// Drives the real Express routes and Socket.IO handlers end to end against a
// real PostgreSQL. With the real packages installed, this runs through real
// Express/Socket.IO objects only at the edges (createApp / socket.create);
// the dispatch below uses each app's own handle() so it works either way.
//
//   DATABASE_URL=postgres://…/twoway_test npm run test:integration

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.APP_ORIGIN = 'http://localhost:3000';
if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) { console.error('DATABASE_URL must end in _test'); process.exit(1); }

const db = require('../../server/db');
const { migrate } = require('../../server/db/migrate');
const { createApp } = require('../../server/app');
const socket = require('../../server/realtime/socket');
const accounts = require('../../server/services/accounts');
const admin = require('../../server/services/admin');
const { hashPassword } = require('../../server/security/passwords');
const { limits } = require('../../server/lib/rateLimit');

const ORIGIN = 'http://localhost:3000';
const PW = 'correct horse battery';
let app; let io; let ADMIN; const cookies = {}; const users = {};

function request(method, url, { body, cookie, origin = ORIGIN, xrw = true } = {}) {
  const [path, qs] = url.split('?');
  const headers = { 'user-agent': 'test', origin };
  if (cookie) headers.cookie = cookie;
  if (xrw) headers['x-requested-with'] = '2way';
  const req = {
    method, originalPath: path, path, url, headers, body: body ?? {}, ip: '10.0.0.1',
    query: Object.fromEntries(new URLSearchParams(qs || '')), get: (h) => headers[h.toLowerCase()],
  };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      json(b) { this.body = b; resolve(this); },
      send(b) { this.body = b; resolve(this); },
      end() { resolve(this); },
    };
    app.handle(req, res, () => resolve({ statusCode: 404, headers: {}, body: null }));
  });
}

async function signIn(username) {
  const r = await request('POST', '/api/auth/login', { body: { username, password: PW } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  cookies[username] = r.headers['set-cookie'].split(';')[0];
  return cookies[username];
}

test.before(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db.pool, { info: () => {} });
  const hash = await hashPassword(PW);
  ADMIN = (await db.query(`INSERT INTO users (username, password_hash, role, avatar_seed) VALUES ('boss', $1, 'admin', 'aaaaaaaaaaaaaaaa') RETURNING id, role`, [hash])).rows[0];
  for (const name of ['ada', 'bayo', 'chidi']) {
    const inv = await accounts.createInvite(ADMIN, { username: name });
    await accounts.register({ inviteCode: inv.code, username: name, password: PW });
    users[name] = (await db.query('SELECT id, role, username FROM users WHERE username = $1', [name])).rows[0];
  }
  app = createApp();
  io = socket.create({});
  for (const n of ['boss', 'ada', 'bayo', 'chidi']) await signIn(n);
});

test.after(async () => { await db.pool.end(); });

test('health check and avatar route', async () => {
  assert.equal((await request('GET', '/healthz')).body.ok, true);
  assert.equal((await request('GET', '/avatars/../../etc.svg')).statusCode, 404);
  const av = await request('GET', '/avatars/0123456789abcdef.svg');
  assert.match(av.body, /^<svg/);
  assert.match(av.headers['cache-control'], /immutable/);
  assert.match(av.headers['content-security-policy'], /default-src 'none'/);
});

test('security headers are set on every response', async () => {
  const r = await request('GET', '/api/me', { cookie: cookies.ada });
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('CSRF: state-changing requests need the header and our origin', async () => {
  assert.equal((await request('POST', '/api/auth/login', { body: { username: 'ada', password: PW }, xrw: false })).statusCode, 403);
  assert.equal((await request('POST', '/api/auth/login', { body: { username: 'ada', password: PW }, origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await request('PATCH', '/api/me/profile', { cookie: cookies.ada, body: { status: 'x' }, xrw: false })).statusCode, 403);
});

test('authentication and authorisation are enforced server-side', async () => {
  assert.equal((await request('GET', '/api/me')).statusCode, 401);
  assert.equal((await request('GET', '/api/me', { cookie: '2way_sid=forged' })).statusCode, 401);
  const me = await request('GET', '/api/me', { cookie: cookies.ada });
  assert.equal(me.body.username, 'ada');
  assert.ok(!JSON.stringify(me.body).includes('password'));
  assert.equal((await request('GET', '/api/admin/members', { cookie: cookies.ada })).statusCode, 403);
  assert.equal((await request('POST', '/api/admin/invites', { cookie: cookies.ada, body: { username: 'sneaky' } })).statusCode, 403);
  assert.equal((await request('GET', '/api/admin/members', { cookie: cookies.boss })).statusCode, 200);
  const wrong = await request('POST', '/api/auth/login', { body: { username: 'ada', password: 'not the password' } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.body.error.message, 'Wrong username or password.');
  assert.equal((await request('GET', '/api/nope', { cookie: cookies.ada })).statusCode, 404);
});

test('lounge returns everything for the home screen in one call', async () => {
  const r = await request('GET', '/api/lounge', { cookie: cookies.ada });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rooms.length, 5);
  assert.equal(r.body.members.length, 4);
  assert.ok(r.body.rooms.every((x) => x.hereNow === 0), 'no invented activity');
});

test('DM IDOR: changing the conversation id does not leak messages', async () => {
  const open = await request('POST', '/api/dms', { cookie: cookies.ada, body: { userId: users.bayo.id } });
  const id = open.body.id;
  const sent = await request('POST', `/api/dms/${id}/messages`, { cookie: cookies.ada, body: { body: 'secret plan', clientId: crypto.randomUUID() } });
  assert.equal(sent.statusCode, 201);
  const peek = await request('GET', `/api/dms/${id}/messages`, { cookie: cookies.chidi });
  assert.equal(peek.statusCode, 404);
  assert.ok(!JSON.stringify(peek.body).includes('secret'));
  assert.equal((await request('GET', `/api/dms/${id}/messages`, { cookie: cookies.bayo })).body.messages[0].body, 'secret plan');
  assert.equal((await request('GET', `/api/dms/abc/messages`, { cookie: cookies.bayo })).statusCode, 400);
});

test('malformed and oversized input is rejected cleanly', async () => {
  const r = await request('POST', '/api/rooms/1/messages', { cookie: cookies.ada, body: ['not', 'an', 'object'] });
  assert.equal(r.statusCode, 400);
  const big = await request('POST', '/api/rooms/1/messages', { cookie: cookies.ada, body: { body: 'x'.repeat(5000), clientId: crypto.randomUUID() } });
  assert.equal(big.statusCode, 400);
  const page = await request('GET', '/api/rooms/1/messages?before=1;DROP%20TABLE', { cookie: cookies.ada });
  assert.equal(page.statusCode, 400);
});

// ---- Socket.IO -----------------------------------------------------------------------

test('socket handshake: foreign origin and missing session are refused', async () => {
  const allow = (headers) => new Promise((r) => io.opts.allowRequest({ headers }, (e, ok) => r(ok)));
  assert.equal(await allow({ origin: 'https://evil.example' }), false);
  assert.equal(await allow({ origin: ORIGIN }), true);
  assert.equal((await io.connect({ origin: ORIGIN })).error, 'unauthorized');
  assert.equal((await io.connect({ origin: ORIGIN, cookie: '2way_sid=forged' })).error, 'unauthorized');
});

test('room events: authorised join, acked send, broadcast only to the room', async () => {
  const ada = await io.connect({ cookie: cookies.ada });
  const bayo = await io.connect({ cookie: cookies.bayo });
  const chidi = await io.connect({ cookie: cookies.chidi });
  assert.ok(ada.rooms.has(`user:${users.ada.id}`) && ada.rooms.has('members'));

  assert.equal((await ada.call('room:join', { roomId: 1 })).ok, true);
  assert.equal((await bayo.call('room:join', { roomId: 1 })).ok, true);
  const here = bayo.received.filter(([e]) => e === 'room:here').pop();
  assert.equal(here[1].count, 2);

  const clientId = crypto.randomUUID();
  const ack = await ada.call('room:send', { roomId: 1, body: 'yo yo', clientId });
  assert.equal(ack.ok, true);
  assert.equal(ack.message.body, 'yo yo');
  assert.ok(bayo.received.some(([e, d]) => e === 'room:message' && d.id === ack.message.id));
  assert.ok(!chidi.received.some(([e]) => e === 'room:message'), 'not in the room → no message');

  const retry = await ada.call('room:send', { roomId: 1, body: 'yo yo', clientId });
  assert.equal(retry.message.id, ack.message.id);
  assert.equal(bayo.received.filter(([e, d]) => e === 'room:message' && d.id === ack.message.id).length, 1, 'retry is not re-broadcast');

  const bad = await ada.call('room:send', 'just a string');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'bad_request');

  // Typing into a room you haven't joined is dropped.
  await chidi.call('typing', { roomId: 1 });
  assert.ok(!ada.received.some(([e]) => e === 'typing'));
  await bayo.call('typing', { roomId: 1 });
  assert.ok(ada.received.some(([e, d]) => e === 'typing' && d.user.username === 'bayo'));

  const react = await bayo.call('room:react', { messageId: ack.message.id, emoji: 'goal' });
  assert.equal(react.ok, true);
  const bcast = ada.received.filter(([e]) => e === 'room:reactions').pop()[1];
  assert.deepEqual(bcast.reactions[0].users, [users.bayo.id], 'user ids are numbers');
  [ada, bayo, chidi].forEach((s) => s.disconnect());
});

test('restricted room: socket join is refused and nothing leaks', async () => {
  const { id } = await admin.createRoom(ADMIN, { name: 'VIP', restricted: true });
  const ada = await io.connect({ cookie: cookies.ada });
  const r = await ada.call('room:join', { roomId: id });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
  assert.ok(!ada.rooms.has(`room:${id}`));
  const send = await ada.call('room:send', { roomId: id, body: 'hi', clientId: crypto.randomUUID() });
  assert.equal(send.ok, false);
  ada.disconnect();
});

test('DM events reach only the two participants', async () => {
  const ada = await io.connect({ cookie: cookies.ada });
  const bayo = await io.connect({ cookie: cookies.bayo });
  const chidi = await io.connect({ cookie: cookies.chidi });
  const conv = (await request('POST', '/api/dms', { cookie: cookies.ada, body: { userId: users.bayo.id } })).body.id;
  const ack = await ada.call('dm:send', { conversationId: conv, body: 'psst', clientId: crypto.randomUUID() });
  assert.equal(ack.ok, true);
  assert.ok(bayo.received.some(([e, d]) => e === 'dm:message' && d.body === 'psst'));
  assert.ok(!chidi.received.some(([e]) => e === 'dm:message'));
  const sneak = await chidi.call('dm:send', { conversationId: conv, body: 'hi', clientId: crypto.randomUUID() });
  assert.equal(sneak.error.code, 'not_found');
  await chidi.call('typing', { conversationId: conv });
  assert.ok(!bayo.received.some(([e]) => e === 'typing'));
  [ada, bayo, chidi].forEach((s) => s.disconnect());
});

test('message flooding is rate limited per member', async () => {
  limits.message.reset(`u:${users.chidi.id}`);
  const s = await io.connect({ cookie: cookies.chidi });
  const results = [];
  for (let i = 0; i < 14; i++) results.push(await s.call('room:send', { roomId: 2, body: `flood ${i}`, clientId: crypto.randomUUID() }));
  const limited = results.filter((r) => !r.ok && r.error.code === 'rate_limited').length;
  assert.ok(limited >= 5, `${limited} of 14 were limited`);
  s.disconnect();
});

test('logout ends that session and closes its sockets only', async () => {
  const phone = await signIn('bayo');
  const laptop = cookies.bayo = (await request('POST', '/api/auth/login', { body: { username: 'bayo', password: PW } })).headers['set-cookie'].split(';')[0];
  const s1 = await io.connect({ cookie: phone });
  const s2 = await io.connect({ cookie: laptop });
  const out = await request('POST', '/api/auth/logout', { cookie: phone });
  assert.match(out.headers['set-cookie'], /Max-Age=0/);
  assert.equal(s1.connected, false);
  assert.equal(s2.connected, true);
  assert.equal((await request('GET', '/api/me', { cookie: phone })).statusCode, 401);
  assert.equal((await request('GET', '/api/me', { cookie: laptop })).statusCode, 200);
  await request('POST', '/api/auth/logout-all', { cookie: laptop });
  assert.equal(s2.connected, false);
});
