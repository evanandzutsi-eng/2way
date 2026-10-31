'use strict';

// Create an invite from the command line (the admin panel does the same):
//   docker compose exec app node scripts/invite.js <admin-username> <intended-username> [note]
// Prints the one-time code; it is not stored anywhere in plain form.

const db = require('../server/db');
const accounts = require('../server/services/accounts');

async function main() {
  const [adminName, username, ...note] = process.argv.slice(2);
  if (!adminName || !username) throw new Error('Usage: node scripts/invite.js <admin-username> <intended-username> [note]');
  const { rows } = await db.query(`SELECT id, role FROM users WHERE lower(username) = lower($1) AND status = 'active'`, [adminName]);
  if (!rows[0] || rows[0].role !== 'admin') throw new Error('No active admin with that username.');
  const inv = await accounts.createInvite({ id: rows[0].id }, { username, note: note.join(' ') });
  console.log(`Invite for ${inv.intendedUsername}: ${inv.code}  (expires ${inv.expiresAt.toISOString()})`);
}

main()
  .then(() => db.pool.end())
  .catch((err) => { console.error(err.message); db.pool.end().finally(() => process.exit(1)); });
