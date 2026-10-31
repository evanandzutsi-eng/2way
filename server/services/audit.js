'use strict';

const db = require('../db');
const log = require('../lib/log');

/**
 * Record an administrative or security-relevant event. `details` must never
 * contain message bodies, passwords, invite codes or tokens.
 * Pass a transaction client to make the audit row part of the same commit.
 */
async function record(client, { actorId = null, action, targetType = null, targetId = null, details = {} }) {
  const q = client || db;
  try {
    await q.query(
      `INSERT INTO audit_events (actor_id, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5)`,
      [actorId, action, targetType, targetId == null ? null : String(targetId), JSON.stringify(details)],
    );
  } catch (err) {
    if (client) throw err; // inside a transaction: fail the whole operation
    log.error('audit write failed', { action, err: err.message });
  }
}

module.exports = { record };
