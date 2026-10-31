'use strict';

// The lounge's compact "what's happening" feed. It only ever contains
// milestones (joins, rank-ups, achievements, new rooms) — never message text,
// never anything from DMs, and nothing about members who opted out.

const db = require('../db');

async function recent(limit = 15) {
  const { rows } = await db.query(
    `SELECT a.id, a.kind, a.data, a.created_at, u.id AS user_id, u.username, u.avatar_seed, r.id AS room_id, r.name AS room_name
       FROM activity a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN rooms r ON r.id = a.room_id
       LEFT JOIN user_preferences p ON p.user_id = a.user_id
      WHERE (a.user_id IS NULL OR (u.status = 'active' AND COALESCE(p.show_in_activity, true)))
        AND (a.room_id IS NULL OR (r.archived_at IS NULL AND NOT r.is_restricted))
      ORDER BY a.id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    createdAt: r.created_at,
    user: r.user_id ? { id: r.user_id, username: r.username, avatar: r.avatar_seed } : null,
    room: r.room_id ? { id: r.room_id, name: r.room_name } : null,
    data: {
      rank: typeof r.data.rank === 'string' ? r.data.rank : undefined,
      name: typeof r.data.name === 'string' ? r.data.name : undefined,
    },
  }));
}

module.exports = { recent };
