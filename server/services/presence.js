'use strict';

// Lightweight presence, held in memory (single-process deployment).
//
//   online   at least one live socket and activity in the last 5 minutes
//   recent   connected but idle, or disconnected within the last 15 minutes
//   offline  otherwise
//   hidden   the member turned presence off: everyone else sees "offline"
//
// Socket.IO's own ping/pong (25 s interval, 20 s timeout) detects dead
// connections. last_seen_at is written to Postgres in batches, not on every
// event.

const db = require('../db');
const hub = require('../realtime/hub');
const log = require('../lib/log');

const ACTIVE_MS = 5 * 60_000;
const RECENT_MS = 15 * 60_000;

const conns = new Map(); // userId -> number of live sockets
const lastActive = new Map(); // userId -> ms timestamp
const hidden = new Set(); // userIds with presence hidden
const lastBroadcast = new Map(); // userId -> state last sent to clients
const dirty = new Set(); // userIds whose last_seen_at needs flushing

function rawState(userId, now = Date.now()) {
  const t = lastActive.get(userId) || 0;
  if (conns.get(userId) > 0) return now - t < ACTIVE_MS ? 'online' : 'recent';
  return now - t < RECENT_MS ? 'recent' : 'offline';
}

/** What other members are allowed to see. */
function visibleState(userId, now) {
  return hidden.has(userId) ? 'offline' : rawState(userId, now);
}

function broadcastIfChanged(userId) {
  const s = visibleState(userId);
  if (lastBroadcast.get(userId) === s) return;
  lastBroadcast.set(userId, s);
  hub.toMembers('presence', { userId, state: s });
}

function touch(userId) {
  lastActive.set(userId, Date.now());
  dirty.add(userId);
}

function connected(userId, isHidden, lastSeenAt) {
  if (isHidden) hidden.add(userId); else hidden.delete(userId);
  if (!lastActive.has(userId) && lastSeenAt) lastActive.set(userId, lastSeenAt.getTime());
  conns.set(userId, (conns.get(userId) || 0) + 1);
  touch(userId);
  broadcastIfChanged(userId);
}

function disconnected(userId) {
  const n = (conns.get(userId) || 1) - 1;
  if (n <= 0) conns.delete(userId); else conns.set(userId, n);
  touch(userId);
  if (n <= 0) flush().catch(() => {});
  broadcastIfChanged(userId);
}

function activity(userId) {
  const before = rawState(userId);
  touch(userId);
  if (before !== 'online') broadcastIfChanged(userId);
}

function setHidden(userId, isHidden) {
  if (isHidden) hidden.add(userId); else hidden.delete(userId);
  broadcastIfChanged(userId);
}

/** Snapshot for a list of user ids (used when rendering member lists). */
function snapshot(userIds) {
  const now = Date.now();
  const out = {};
  for (const id of userIds) out[id] = visibleState(id, now);
  return out;
}

function onlineCount() {
  let n = 0;
  for (const id of conns.keys()) if (!hidden.has(id)) n++;
  return n;
}

async function flush() {
  if (!dirty.size) return;
  const ids = [...dirty];
  dirty.clear();
  const times = ids.map((id) => new Date(lastActive.get(id) || Date.now()));
  try {
    await db.query(
      `UPDATE users u SET last_seen_at = v.t
         FROM unnest($1::bigint[], $2::timestamptz[]) AS v(id, t)
        WHERE u.id = v.id AND (u.last_seen_at IS NULL OR u.last_seen_at < v.t)`,
      [ids, times],
    );
  } catch (err) {
    for (const id of ids) dirty.add(id);
    log.warn('presence flush failed', { err: err.message });
  }
}

/** Seed "recent" state after a restart from persisted last_seen_at. */
async function warmUp() {
  const { rows } = await db.query(
    `SELECT u.id, u.last_seen_at, COALESCE(p.show_presence, true) AS show
       FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id
      WHERE u.status = 'active'`,
  );
  for (const r of rows) {
    if (r.last_seen_at) lastActive.set(r.id, r.last_seen_at.getTime());
    if (!r.show) hidden.add(r.id);
  }
}

let timer = null;
function start() {
  timer = setInterval(() => {
    for (const id of new Set([...conns.keys(), ...lastBroadcast.keys()])) broadcastIfChanged(id);
    flush().catch(() => {});
  }, 60_000);
  timer.unref();
}
function stop() { clearInterval(timer); return flush(); }

function forget(userId) {
  conns.delete(userId); lastActive.delete(userId); hidden.delete(userId); lastBroadcast.delete(userId); dirty.delete(userId);
}

module.exports = { connected, disconnected, activity, setHidden, snapshot, visibleState, onlineCount, warmUp, start, stop, flush, forget, _rawState: rawState };
