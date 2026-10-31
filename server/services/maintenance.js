'use strict';

// Background housekeeping. Runs hourly in the app process: cheap enough for a
// community of 50 and avoids running a separate scheduler service.
//
//  - Message retention: messages older than the configured number of days are
//    permanently deleted (0 = keep until a member or admin deletes them).
//    Deletes run in batches so a large first purge never locks tables for long.
//  - Expired / idle sessions are removed.
//  - Old activity entries (> 90 days) are pruned.

const db = require('../db');
const settings = require('./settings');
const sessions = require('../security/sessions');
const log = require('../lib/log');

const BATCH = 2000;

async function purge(table, days) {
  if (!days) return 0;
  let total = 0;
  for (;;) {
    const { rowCount } = await db.query(
      `DELETE FROM ${table} WHERE id IN (
         SELECT id FROM ${table} WHERE created_at < now() - make_interval(days => $1) LIMIT ${BATCH})`,
      [days],
    );
    total += rowCount;
    if (rowCount < BATCH) return total;
  }
}

async function runOnce() {
  const s = await settings.all();
  const rooms = await purge('messages', s.room_retention_days);
  const dms = await purge('dm_messages', s.dm_retention_days);
  await sessions.purgeExpired();
  await db.query(`DELETE FROM activity WHERE created_at < now() - interval '90 days'`);
  if (rooms || dms) log.info('retention purge', { roomMessages: rooms, directMessages: dms });
}

let timer = null;
function start() {
  const tick = () => runOnce().catch((err) => log.error('maintenance failed', { err: err.message }));
  setTimeout(tick, 30_000).unref();
  timer = setInterval(tick, 60 * 60_000);
  timer.unref();
}
function stop() { clearInterval(timer); }

module.exports = { runOnce, start, stop };
