'use strict';

const db = require('../db');
const { DEFAULT_THRESHOLDS, normalizeThresholds } = require('../lib/ranks');

// App settings are read constantly (rank thresholds on every member render)
// and change rarely, so keep a short-lived in-memory copy.
let cache = null;
let loadedAt = 0;
const TTL_MS = 60_000;

const DEFAULTS = {
  member_limit: 50,
  room_retention_days: 365,
  dm_retention_days: 365,
  invite_ttl_days: 7,
  rank_thresholds: DEFAULT_THRESHOLDS,
};

// What an admin may change through the app, and how each is validated.
// member_limit is intentionally absent: it can only be changed by an operator
// with database access (see docs/OPERATIONS.md).
const EDITABLE = {
  room_retention_days: (v) => intIn(v, 0, 3650),
  dm_retention_days: (v) => intIn(v, 0, 3650),
  invite_ttl_days: (v) => intIn(v, 1, 30),
  rank_thresholds: (v) => normalizeThresholds(v),
};

function intIn(v, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`must be an integer between ${min} and ${max}`);
  return v;
}

async function all(client) {
  if (!client && cache && Date.now() - loadedAt < TTL_MS) return cache;
  const { rows } = await (client || db).query('SELECT key, value FROM app_settings');
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  try { out.rank_thresholds = normalizeThresholds(out.rank_thresholds); } catch { out.rank_thresholds = DEFAULT_THRESHOLDS; }
  if (!client) { cache = out; loadedAt = Date.now(); }
  return out;
}

async function get(key, client) {
  return (await all(client))[key];
}

async function set(client, key, value, actorId) {
  const validator = EDITABLE[key];
  if (!validator) throw new Error('not editable');
  const clean = validator(value);
  await client.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(clean), actorId],
  );
  cache = null;
  return clean;
}

module.exports = { all, get, set, EDITABLE, DEFAULTS };
