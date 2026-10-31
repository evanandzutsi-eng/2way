'use strict';

const db = require('../db');
const settings = require('./settings');
const presence = require('./presence');
const { rankFor } = require('../lib/ranks');

const MEMBER_COLS = 'u.id, u.username, u.role, u.status, u.avatar_seed, u.status_message, u.xp, u.created_at';

/** The public shape of a member as other members see it. */
function shape(row, thresholds, presenceMap) {
  const deleted = row.status === 'deleted';
  const r = rankFor(row.xp || 0, thresholds);
  return {
    id: row.id,
    username: deleted ? 'Former member' : row.username,
    avatar: deleted ? null : row.avatar_seed,
    rank: r.name,
    rankIndex: r.index,
    xp: row.xp,
    status: deleted ? '' : row.status_message,
    isAdmin: row.role === 'admin',
    presence: presenceMap ? presenceMap[row.id] || 'offline' : undefined,
  };
}

/** Compact author shape embedded in each message. */
function author(row, thresholds) {
  const deleted = row.author_status === 'deleted';
  const r = rankFor(row.author_xp || 0, thresholds);
  return {
    id: row.user_id ?? row.sender_id,
    username: deleted ? 'Former member' : row.author_username,
    avatar: deleted ? null : row.author_avatar,
    rank: r.name,
    rankIndex: r.index,
  };
}

async function list() {
  const { rows } = await db.query(
    `SELECT ${MEMBER_COLS} FROM users u WHERE u.status = 'active' ORDER BY lower(u.username)`,
  );
  const thresholds = await settings.get('rank_thresholds');
  const p = presence.snapshot(rows.map((r) => r.id));
  return rows.map((r) => shape(r, thresholds, p));
}

async function get(id) {
  const { rows } = await db.query(`SELECT ${MEMBER_COLS} FROM users u WHERE u.id = $1 AND u.status = 'active'`, [id]);
  if (!rows[0]) return null;
  const thresholds = await settings.get('rank_thresholds');
  const member = shape(rows[0], thresholds, presence.snapshot([id]));
  const ach = await db.query(
    `SELECT a.code, a.name, a.description, a.icon, ma.earned_at
       FROM member_achievements ma JOIN achievements a ON a.code = ma.achievement_code
      WHERE ma.user_id = $1 ORDER BY a.sort_order`,
    [id],
  );
  member.achievements = ach.rows.map((a) => ({ code: a.code, name: a.name, description: a.description, icon: a.icon, earnedAt: a.earned_at }));
  member.joinedAt = rows[0].created_at;
  return member;
}

module.exports = { MEMBER_COLS, shape, author, list, get };
