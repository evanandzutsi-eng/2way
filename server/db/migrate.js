'use strict';

// Minimal forward-only migration runner.
//  - Applies migrations/NNN_name.sql in order, each in its own transaction.
//  - Records applied files (with a checksum) in schema_migrations.
//  - Holds a Postgres advisory lock so two app containers can't race.
//  - Refuses to run if an already-applied file was edited afterwards.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');
const LOCK_KEY = 727_2_2_9; // arbitrary constant shared by all 2WaY instances

async function migrate(pool, log = console) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    const applied = new Map(
      (await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map((r) => [r.filename, r.checksum]),
    );
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();

    let count = 0;
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied. Add a new migration instead.`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        count++;
        log.info(`migration applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    return count;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const { pool } = require('./index');
  migrate(pool)
    .then((n) => { console.log(`${n} migration(s) applied`); return pool.end(); })
    .catch((err) => { console.error(err.message); process.exit(1); });
}
