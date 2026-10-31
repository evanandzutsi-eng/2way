'use strict';

// All runtime configuration comes from environment variables. In production
// the process refuses to start with unsafe or missing values rather than
// silently falling back to development defaults.

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

const env = process.env.NODE_ENV === 'production' ? 'production' : 'development';
const isProd = env === 'production';

const config = {
  env,
  isProd,
  port: int('PORT', 3000, { min: 1, max: 65535 }),
  host: process.env.HOST || '0.0.0.0',
  // The exact public origin, e.g. https://2way.example.com. Used for CSRF
  // origin checks on HTTP and for the Socket.IO handshake.
  appOrigin: (process.env.APP_ORIGIN || 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: process.env.DATABASE_URL || 'postgres://twoway:twoway@localhost:5432/twoway',
  dbPoolMax: int('DB_POOL_MAX', 10, { min: 2, max: 50 }),
  // Number of reverse proxies in front of the app (Caddy = 1). Controls how
  // the client IP used for rate limiting is derived.
  trustProxy: int('TRUST_PROXY', isProd ? 1 : 0, { min: 0, max: 3 }),
  session: {
    cookieName: isProd ? '__Host-2way_sid' : '2way_sid',
    idleDays: int('SESSION_IDLE_DAYS', 14, { min: 1, max: 90 }),
    absoluteDays: int('SESSION_ABSOLUTE_DAYS', 60, { min: 1, max: 365 }),
  },
  logLevel: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
};

if (isProd) {
  const problems = [];
  if (!config.appOrigin.startsWith('https://')) problems.push('APP_ORIGIN must be an https:// origin in production');
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL is required in production');
  if (/twoway:twoway@/.test(config.databaseUrl)) problems.push('DATABASE_URL uses the development password');
  if (problems.length) {
    throw new Error('Unsafe production configuration:\n  - ' + problems.join('\n  - '));
  }
}

module.exports = config;
