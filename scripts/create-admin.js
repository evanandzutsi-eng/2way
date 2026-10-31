'use strict';

// Bootstrap the first administrator. Run once after deploying:
//   docker compose exec app node scripts/create-admin.js <username>
// The password is read from a hidden prompt (or ADMIN_PASSWORD for automation)
// and never echoed or logged. Refuses to run if an active admin already exists
// unless --force is passed.

const readline = require('node:readline');
const db = require('../server/db');
const { migrate } = require('../server/db/migrate');
const v = require('../server/lib/validate');
const { hashPassword } = require('../server/security/passwords');
const accounts = require('../server/services/accounts');
const settings = require('../server/services/settings');

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(s); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function main() {
  const [name, flag] = process.argv.slice(2);
  const username = v.username(name || '');
  await migrate(db.pool, { info: () => {} });

  const existing = await db.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'`);
  if (existing.rows[0].n > 0 && flag !== '--force') {
    throw new Error('An admin already exists. Use the in-app admin panel to invite members (or pass --force).');
  }

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await askHidden('Password (min 10 chars): ');
    const again = await askHidden('Repeat password: ');
    if (password !== again) throw new Error('Passwords did not match.');
  }
  v.password(password);
  const hash = await hashPassword(password);

  await db.tx(async (client) => {
    const limit = await settings.get('member_limit', client);
    const seats = await accounts.seatsInUse(client);
    if (seats.members >= limit) throw new Error(`Member limit (${limit}) reached.`);
    const { rows } = await client.query(
      `INSERT INTO users (username, password_hash, role, avatar_seed) VALUES ($1, $2, 'admin', $3) RETURNING id`,
      [username, hash, accounts.newAvatarSeed()],
    );
    await client.query('INSERT INTO user_preferences (user_id) VALUES ($1)', [rows[0].id]);
    await client.query(
      `INSERT INTO audit_events (actor_id, action, target_type, target_id) VALUES ($1, 'admin.bootstrap', 'user', $1::text)`,
      [rows[0].id],
    );
  });
  console.log(`Admin "${username}" created. Sign in at your APP_ORIGIN.`);
}

main()
  .then(() => db.pool.end())
  .catch((err) => { console.error(err.message); db.pool.end().finally(() => process.exit(1)); });
