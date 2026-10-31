'use strict';

// Server-authoritative XP. Clients never send XP amounts; every change is a
// row in xp_events (the audit trail) and the users.xp cache is updated in the
// same transaction. Rules are designed to reward showing up and being
// appreciated by others, not message volume, so spamming earns nothing.

const settings = require('./settings');
const { rankFor } = require('../lib/ranks');

const RULES = Object.freeze({
  dailyPost: { amount: 5, reason: 'daily_post' }, // first room message of the day
  reactionReceived: { amount: 2, reason: 'reaction_received', dailyCap: 20 }, // from distinct mates, capped per rolling 24 h
});

const TZ = process.env.APP_TIMEZONE || 'Africa/Lagos';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function localDay(d = new Date()) { return dayFmt.format(d); } // YYYY-MM-DD in the community's timezone

/**
 * A unit-of-work context. Services push follow-up realtime notifications into
 * `after`; the caller runs them only once the transaction has committed, so
 * clients never hear about changes that were rolled back.
 */
function ctx() {
  const after = [];
  return { after, flush: () => { for (const fn of after) { try { fn(); } catch { /* best effort */ } } } };
}

async function canShowInActivity(client, userId) {
  const { rows } = await client.query('SELECT show_in_activity FROM user_preferences WHERE user_id = $1', [userId]);
  return rows[0] ? rows[0].show_in_activity : true;
}

async function addActivity(client, c, { kind, userId = null, roomId = null, data = {} }) {
  if (userId && kind !== 'room_created' && !(await canShowInActivity(client, userId))) return;
  const { rows } = await client.query(
    `INSERT INTO activity (kind, user_id, room_id, data) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [kind, userId, roomId, JSON.stringify(data)],
  );
  c.after.push(() => require('../realtime/hub').toMembers('activity:new', { id: rows[0].id }));
}

/**
 * Award XP once per (user, refKey). Returns { awarded, xp, rankUp }.
 * refKey = null is only allowed for explicit admin grants.
 */
async function award(client, c, { userId, amount, reason, refKey, grantedBy = null, note = '' }) {
  const ins = await client.query(
    `INSERT INTO xp_events (user_id, amount, reason, ref_key, granted_by, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, ref_key) WHERE ref_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, amount, reason, refKey, grantedBy, note],
  );
  if (!ins.rowCount) return { awarded: false };

  const upd = await client.query(
    `UPDATE users SET xp = GREATEST(0, xp + $2) WHERE id = $1 RETURNING xp, xp - $2 AS before_raw, username`,
    [userId, amount],
  );
  const after = upd.rows[0].xp;
  const before = Math.max(0, upd.rows[0].before_raw);
  const thresholds = await settings.get('rank_thresholds');
  const rb = rankFor(before, thresholds);
  const ra = rankFor(after, thresholds);
  const rankUp = ra.index > rb.index ? ra.name : null;
  if (rankUp) await addActivity(client, c, { kind: 'rank_up', userId, data: { rank: rankUp } });
  c.after.push(() => require('../realtime/hub').toUser(userId, 'xp:update', { xp: after, delta: amount, reason, rankUp }));
  return { awarded: true, xp: after, rankUp };
}

async function grantAchievement(client, c, userId, code) {
  const ins = await client.query(
    `INSERT INTO member_achievements (user_id, achievement_code) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING earned_at`,
    [userId, code],
  );
  if (!ins.rowCount) return false;
  const { rows } = await client.query('SELECT name, xp_reward FROM achievements WHERE code = $1', [code]);
  if (!rows[0]) return false;
  await addActivity(client, c, { kind: 'achievement', userId, data: { code, name: rows[0].name } });
  if (rows[0].xp_reward > 0) {
    await award(client, c, { userId, amount: rows[0].xp_reward, reason: 'achievement', refKey: `ach:${code}` });
  }
  c.after.push(() => require('../realtime/hub').toUser(userId, 'achievement', { code, name: rows[0].name }));
  return true;
}

/** Called inside the send-room-message transaction. */
async function onRoomMessage(client, c, userId) {
  const day = localDay();
  const newDay = await client.query(
    `INSERT INTO member_active_days (user_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING day`,
    [userId, day],
  );
  if (!newDay.rowCount) return; // already handled today: nothing else can change

  await award(client, c, { userId, amount: RULES.dailyPost.amount, reason: RULES.dailyPost.reason, refKey: `daily_post:${day}` });
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM member_active_days WHERE user_id = $1)::int AS days,
            (SELECT count(DISTINCT room_id) FROM messages WHERE user_id = $1)::int AS rooms`,
    [userId],
  );
  await grantAchievement(client, c, userId, 'first_words');
  if (rows[0].rooms >= 5) await grantAchievement(client, c, userId, 'explorer');
  if (rows[0].days >= 7) await grantAchievement(client, c, userId, 'week_streak');
  if (rows[0].days >= 30) await grantAchievement(client, c, userId, 'month_regular');
}

/** Explorer can also be reached on a non-first message of the day. */
async function checkExplorer(client, c, userId) {
  const { rows } = await client.query('SELECT count(DISTINCT room_id)::int AS n FROM messages WHERE user_id = $1', [userId]);
  if (rows[0].n >= 5) await grantAchievement(client, c, userId, 'explorer');
}

/** Called inside the add-reaction transaction. */
async function onReaction(client, c, { messageId, authorId, reactorId }) {
  if (authorId === reactorId) return;
  const { rows } = await client.query(
    `SELECT COALESCE(sum(amount), 0)::int AS today FROM xp_events
      WHERE user_id = $1 AND reason = $2 AND created_at >= now() - interval '24 hours'`,
    [authorId, RULES.reactionReceived.reason],
  );
  if (rows[0].today < RULES.reactionReceived.dailyCap) {
    // One payout per (message, reactor) no matter how many emoji they add or
    // how often they toggle — ref_key makes it idempotent.
    await award(client, c, {
      userId: authorId, amount: RULES.reactionReceived.amount, reason: RULES.reactionReceived.reason,
      refKey: `react:${messageId}:${reactorId}`,
    });
  }
  const total = await client.query(
    `SELECT count(DISTINCT (r.message_id, r.user_id))::int AS n
       FROM message_reactions r JOIN messages m ON m.id = r.message_id
      WHERE m.user_id = $1 AND r.user_id <> $1`,
    [authorId],
  );
  if (total.rows[0].n >= 25) await grantAchievement(client, c, authorId, 'crowd_pleaser');
}

module.exports = { RULES, localDay, ctx, award, grantAchievement, onRoomMessage, checkExplorer, onReaction, addActivity };
