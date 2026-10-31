'use strict';

// Pure-logic tests: no database, no network, no npm dependencies.
//   node --test test/unit/

const test = require('node:test');
const assert = require('node:assert/strict');

const v = require('../../server/lib/validate');
const { rankFor, normalizeThresholds, DEFAULT_THRESHOLDS } = require('../../server/lib/ranks');
const { RateLimiter } = require('../../server/lib/rateLimit');
const { newInviteCode, newSessionToken, sha256, INVITE_ALPHABET } = require('../../server/lib/tokens');
const { csrfOk, handshakeOriginOk } = require('../../server/security/origin');
const avatar = require('../../server/lib/avatar');
const log = require('../../server/lib/log');

const ORIGIN = 'https://2way.example.com';

test('usernames: 3–20 of [A-Za-z0-9_], trimmed', () => {
  assert.equal(v.username('  Tunde_99 '), 'Tunde_99');
  for (const bad of ['ab', 'a'.repeat(21), 'has space', 'émile', '<script>', '', null, 42]) {
    assert.throws(() => v.username(bad), /3–20/);
  }
});

test('passwords: 10–128 code points', () => {
  assert.throws(() => v.password('short'), /at least 10/);
  assert.equal(v.password('ten chars!'), 'ten chars!');
  assert.equal(v.password('🔥'.repeat(10)), '🔥'.repeat(10)); // counted as 10, not 20
  assert.throws(() => v.password('x'.repeat(129)), /at most 128/);
  assert.throws(() => v.password({}), /required/);
});

test('message bodies: trimmed, control chars and bidi overrides stripped, bounded', () => {
  assert.equal(v.messageBody('  hi\u0000 there‮  '), 'hi there');
  assert.equal(v.messageBody('a\r\nb'), 'a\nb');
  assert.equal(v.messageBody('a\n\n\n\n\n\nb'), 'a\n\n\nb');
  assert.throws(() => v.messageBody('   '), /can't be empty/);
  assert.throws(() => v.messageBody('x'.repeat(2001)), /at most 2000/);
  assert.equal([...v.messageBody('😂'.repeat(2000))].length, 2000);
  assert.throws(() => v.messageBody({ toString: () => 'hi' }), /Invalid/);
  // Markup is kept as text (the client renders with textContent), not rejected.
  assert.equal(v.messageBody('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
});

test('ids reject non-positive, non-integer and oversized values', () => {
  assert.equal(v.id('42'), 42);
  assert.equal(v.id(7), 7);
  for (const bad of ['0', '-1', '1.5', '1e3', '9999999999999999', 'abc', null, [], {}, '1;DROP']) {
    assert.throws(() => v.id(bad), /Invalid/);
  }
});

test('client ids must be UUIDs and are normalised to lower case', () => {
  assert.equal(v.clientId('3F2504E0-4F89-41D3-9A0C-0305E82C3301'), '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  assert.throws(() => v.clientId('not-a-uuid'));
  assert.throws(() => v.clientId(123));
});

test('payload() only accepts plain objects', () => {
  assert.deepEqual(v.payload({ a: 1 }), { a: 1 });
  for (const bad of [null, [], 'x', 5]) assert.throws(() => v.payload(bad), /Malformed/);
});

test('invite codes: 15 chars from an unambiguous alphabet, normalised on input', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = newInviteCode();
    assert.match(c.display, /^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    assert.equal(c.raw.length, 15);
    for (const ch of c.raw) assert.ok(INVITE_ALPHABET.includes(ch));
    seen.add(c.raw);
  }
  assert.equal(seen.size, 500);
  const c = newInviteCode();
  assert.equal(v.inviteCode(c.display.toLowerCase().replace(/-/g, ' ')), c.raw);
  assert.throws(() => v.inviteCode('ABC'), /not valid/);
});

test('session tokens are 256-bit and stored only as SHA-256', () => {
  const t = newSessionToken();
  assert.equal(Buffer.from(t, 'base64url').length, 32);
  assert.equal(sha256(t).length, 32);
  assert.notEqual(newSessionToken(), t);
});

test('ranks: default ladder and boundaries', () => {
  assert.equal(rankFor(0).name, 'Rookie');
  assert.equal(rankFor(99).name, 'Rookie');
  assert.equal(rankFor(100).name, 'Regular');
  assert.equal(rankFor(2999).name, 'Elite');
  const top = rankFor(99999);
  assert.equal(top.name, 'Ultimate');
  assert.equal(top.nextName, null);
  assert.equal(top.progress, 1);
  const mid = rankFor(200);
  assert.equal(mid.nextName, 'Star');
  assert.equal(mid.progress, 0.5);
  assert.equal(DEFAULT_THRESHOLDS.length, 6);
});

test('rank thresholds are validated before being saved', () => {
  assert.throws(() => normalizeThresholds([{ name: 'A', minXp: 0 }]), /2–12/);
  assert.throws(() => normalizeThresholds([{ name: 'Aa', minXp: 5 }, { name: 'Bb', minXp: 10 }]), /start at 0/);
  assert.throws(() => normalizeThresholds([{ name: 'Aa', minXp: 0 }, { name: 'Bb', minXp: 0 }]), /increase/);
  assert.throws(() => normalizeThresholds([{ name: '<b>', minXp: 0 }, { name: 'Bb', minXp: 1 }]), /letter name/);
  assert.deepEqual(normalizeThresholds([{ name: 'Aa', minXp: 0, extra: 1 }, { name: 'Bb', minXp: 1 }]), [{ name: 'Aa', minXp: 0 }, { name: 'Bb', minXp: 1 }]);
});

test('rate limiter: burst, refill and retry-after', () => {
  let now = 0;
  const rl = new RateLimiter({ capacity: 3, refillPerSec: 1, now: () => now });
  assert.ok(rl.take('k').ok); assert.ok(rl.take('k').ok); assert.ok(rl.take('k').ok);
  const denied = rl.take('k');
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfter, 1);
  assert.ok(rl.take('other').ok, 'keys are independent');
  now += 1000;
  assert.ok(rl.take('k').ok);
  assert.equal(rl.take('k').ok, false);
  rl.reset('k');
  assert.ok(rl.take('k').ok);
});

test('rate limiter memory is bounded', () => {
  const rl = new RateLimiter({ capacity: 1, refillPerSec: 1, maxKeys: 100 });
  for (let i = 0; i < 1000; i++) rl.take(`k${i}`);
  assert.equal(rl.buckets.size, 100);
});

test('CSRF: unsafe methods need the custom header and a same-origin context', () => {
  const base = { method: 'POST', xRequestedWith: '2way' };
  assert.ok(csrfOk({ method: 'GET' }, ORIGIN));
  assert.ok(csrfOk({ ...base, origin: ORIGIN, secFetchSite: 'same-origin' }, ORIGIN));
  assert.ok(csrfOk(base, ORIGIN), 'older browsers without Origin/Fetch Metadata');
  assert.equal(csrfOk({ method: 'POST', origin: ORIGIN }, ORIGIN), false, 'missing header');
  assert.equal(csrfOk({ ...base, origin: 'https://evil.example' }, ORIGIN), false);
  assert.equal(csrfOk({ ...base, secFetchSite: 'cross-site' }, ORIGIN), false);
  assert.equal(csrfOk({ ...base, secFetchSite: 'same-site' }, ORIGIN), false);
  assert.equal(csrfOk({ method: 'DELETE', xRequestedWith: 'XMLHttpRequest' }, ORIGIN), false);
});

test('Socket.IO handshake origin check', () => {
  assert.ok(handshakeOriginOk({ origin: ORIGIN }, ORIGIN));
  assert.equal(handshakeOriginOk({ origin: 'https://evil.example' }, ORIGIN), false);
  assert.equal(handshakeOriginOk({ origin: 'null' }, ORIGIN), false);
  assert.ok(handshakeOriginOk({ 'sec-fetch-site': 'same-origin' }, ORIGIN));
  assert.equal(handshakeOriginOk({ 'sec-fetch-site': 'cross-site' }, ORIGIN), false);
});

test('avatars are deterministic, distinct and small', () => {
  const a = avatar.svg('0123456789abcdef');
  assert.equal(a, avatar.svg('0123456789abcdef'));
  assert.notEqual(a, avatar.svg('fedcba9876543210'));
  assert.match(a, /^<svg [^>]*viewBox="0 0 12 12"/);
  assert.ok(!/script|on\w+=|href/i.test(a));
  assert.ok(Buffer.byteLength(a) < 4096, `avatar is ${Buffer.byteLength(a)} bytes`);
  const g = avatar.grid('x');
  assert.equal(g.length, 12);
  assert.ok(g.every((row) => row.length === 12));
});

test('logger redacts secrets by field name', () => {
  const out = log._scrub({ password: 'x', sessionToken: 'y', inviteCode: 'z', body: 'msg', userId: 4, path: '/a' });
  assert.deepEqual(out, { password: '[redacted]', sessionToken: '[redacted]', inviteCode: '[redacted]', body: '[redacted]', userId: 4, path: '/a' });
});
