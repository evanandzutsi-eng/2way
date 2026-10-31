'use strict';

// Database-backed sessions. The browser holds a random 256-bit token in an
// HttpOnly cookie; the database holds only its SHA-256. Sessions have an idle
// timeout and an absolute lifetime, and can be revoked individually or all at
// once (logout everywhere, password change, suspension, account deletion).

const config = require('../config');
const db = require('../db');
const { newSessionToken, sha256 } = require('../lib/tokens');

const DAY = 86_400_000;
const TOUCH_EVERY_MS = 10 * 60_000; // avoid a DB write on every request

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

function cookieHeader(value, maxAgeSec) {
  const parts = [
    `${config.session.cookieName}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (config.isProd) parts.push('Secure');
  return parts.join('; ');
}

async function createSession(client, userId, userAgent) {
  const token = newSessionToken();
  const now = Date.now();
  const expiresAt = new Date(now + config.session.absoluteDays * DAY);
  await (client || db).query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)`,
    [sha256(token), userId, expiresAt, String(userAgent || '').slice(0, 200)],
  );
  // Housekeeping: drop expired rows for this user opportunistically.
  await (client || db).query(`DELETE FROM sessions WHERE user_id = $1 AND expires_at < now()`, [userId]);
  return { token, cookie: cookieHeader(token, config.session.absoluteDays * 86_400) };
}

function clearCookie() {
  return cookieHeader('', 0);
}

/**
 * Resolve a raw cookie header to { user, tokenHash } or null.
 * Rejects expired, idle, suspended and deleted accounts.
 */
async function resolve(cookieHeaderValue) {
  const token = parseCookies(cookieHeaderValue)[config.session.cookieName];
  if (!token || token.length > 100) return null;
  const tokenHash = sha256(token);
  const { rows } = await db.query(
    `SELECT s.last_used_at, s.expires_at,
            u.id, u.username, u.role, u.status, u.avatar_seed, u.status_message, u.xp
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  const now = Date.now();
  const idleLimit = row.last_used_at.getTime() + config.session.idleDays * DAY;
  if (row.status !== 'active' || row.expires_at.getTime() < now || idleLimit < now) {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    return null;
  }
  if (now - row.last_used_at.getTime() > TOUCH_EVERY_MS) {
    db.query('UPDATE sessions SET last_used_at = now() WHERE token_hash = $1', [tokenHash]).catch(() => {});
  }
  const user = {
    id: row.id, username: row.username, role: row.role, avatarSeed: row.avatar_seed,
    statusMessage: row.status_message, xp: row.xp,
  };
  return { user, tokenHash };
}

async function revoke(tokenHash) {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

async function revokeAllForUser(client, userId, exceptTokenHash = null) {
  await (client || db).query(
    `DELETE FROM sessions WHERE user_id = $1 AND ($2::bytea IS NULL OR token_hash <> $2)`,
    [userId, exceptTokenHash],
  );
}

async function purgeExpired() {
  const idleCutoff = new Date(Date.now() - config.session.idleDays * DAY);
  await db.query('DELETE FROM sessions WHERE expires_at < now() OR last_used_at < $1', [idleCutoff]);
}

module.exports = { parseCookies, createSession, clearCookie, resolve, revoke, revokeAllForUser, purgeExpired };
