'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const http = require('./security/http');
const avatar = require('./lib/avatar');
const api = require('./routes/api');

const PUBLIC = path.join(__dirname, '..', 'public');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', 'strong');

  app.use(http.securityHeaders);

  app.get('/healthz', async (req, res) => {
    try { await db.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  // Self-hosted pixel avatars. The seed is random and changes when a member
  // re-rolls, so each URL is immutable and can be cached for a year.
  const avatarCache = new Map();
  app.get('/avatars/:file', (req, res) => {
    const m = /^([a-f0-9]{16})\.svg$/.exec(req.params.file);
    if (!m) return res.status(404).end();
    const seed = m[1];
    let body = avatarCache.get(seed);
    if (!body) {
      body = avatar.svg(seed);
      if (avatarCache.size > 500) avatarCache.delete(avatarCache.keys().next().value);
      avatarCache.set(seed, body);
    }
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.send(body);
  });

  // API: JSON only, small bodies, CSRF checks, session, never cached.
  app.use(
    '/api',
    http.noStore,
    express.json({ limit: '16kb', strict: true }),
    http.csrf,
    http.loadSession,
    // Keyed per member when signed in: friends on the same mobile carrier
    // often share one public IP (carrier-grade NAT).
    http.rateLimit(http.limits.api, (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`)),
    api,
  );
  app.use('/api', http.notFoundHandler);

  // Static app shell. HTML, JS, CSS and the service worker revalidate on every
  // load (cheap 304s via ETag) so deploys take effect immediately; the service
  // worker provides the offline/instant-load cache on top.
  app.use(express.static(PUBLIC, {
    index: 'index.html',
    etag: true,
    lastModified: false,
    setHeaders(res, file) {
      if (/\.(png|svg|ico|woff2)$/.test(file) && !file.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30 days
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
      if (file.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
      if (file.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
    },
  }));

  app.use(http.errorHandler);
  return app;
}

module.exports = { createApp };
