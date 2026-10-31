'use strict';

const { Pool } = require('pg');
const config = require('../config');
const log = require('../lib/log');

// pg returns BIGINT (int8) as strings to avoid precision loss. Our ids stay far
// below 2^53, so parse them as numbers for simpler, consistent JSON.
const types = require('pg').types;
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Guard against runaway queries holding connections.
  statement_timeout: 10_000,
  application_name: '2way',
});

pool.on('error', (err) => log.error('db pool error', { err: err.message }));

/** Run a parameterised query. Never interpolate values into SQL text. */
function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run `fn(client)` inside a transaction. Rolls back on any thrown error.
 * Retries once on serialization failure / deadlock.
 */
async function tx(fn, { attempts = 2 } = {}) {
  for (let i = 1; ; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (i < attempts && (err.code === '40001' || err.code === '40P01')) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { pool, query, tx };
