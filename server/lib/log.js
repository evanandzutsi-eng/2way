'use strict';

// Tiny structured logger (one JSON line per event). Deliberately has no
// "log the request body" helper: message bodies, passwords, invite codes,
// cookies and tokens must never reach the logs.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[process.env.LOG_LEVEL] || (process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug);
const REDACT = /pass|token|secret|cookie|invite|body|hash|authorization/i;

function scrub(fields) {
  if (!fields) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = REDACT.test(k) ? '[redacted]' : v;
  return out;
}

function emit(level, msg, fields) {
  if (LEVELS[level] < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...scrub(fields) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  debug: (m, f) => emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
  _scrub: scrub,
};
