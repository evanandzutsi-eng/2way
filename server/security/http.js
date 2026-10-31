'use strict';

const config = require('../config');
const sessions = require('./sessions');
const { limits } = require('../lib/rateLimit');
const { AppError, unauthorized, forbidden, tooMany } = require('../lib/errors');
const log = require('../lib/log');
const { csrfOk } = require('./origin');

const wsOrigin = config.appOrigin.replace(/^http/, 'ws');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${wsOrigin}`,
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

function csrf(req, res, next) {
  const ok = csrfOk({
    method: req.method,
    origin: req.get('origin'),
    secFetchSite: req.get('sec-fetch-site'),
    xRequestedWith: req.get('x-requested-with'),
  }, config.appOrigin);
  if (!ok) return next(forbidden('Request blocked.'));
  next();
}

function rateLimit(limiter, keyFn = (req) => req.ip) {
  return (req, res, next) => {
    const r = limiter.take(keyFn(req));
    if (!r.ok) return next(tooMany(r.retryAfter));
    next();
  };
}

/** Attaches req.user / req.sessionHash when a valid session cookie is present. */
async function loadSession(req, res, next) {
  try {
    const s = await sessions.resolve(req.headers.cookie);
    if (s) { req.user = s.user; req.sessionHash = s.tokenHash; }
    next();
  } catch (err) { next(err); }
}

function requireUser(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden());
  next();
}

/** Private API responses must never land in a shared or service-worker cache. */
function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    if (err.extra?.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter));
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'too_large', message: 'That request is too large.' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_request', message: 'Malformed request.' } });
  }
  log.error('unhandled error', { path: req.path, method: req.method, err: err.message, stack: config.isProd ? undefined : err.stack });
  res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on our side.' } });
}

module.exports = {
  CSP, securityHeaders, csrfOk, csrf, rateLimit, loadSession, requireUser, requireAdmin, noStore,
  notFoundHandler, errorHandler, limits,
};
