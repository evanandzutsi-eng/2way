'use strict';

// Pure origin / CSRF decision functions (no I/O, unit-tested).

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated HTTP requests:
 *  1. SameSite=Lax session cookie.
 *  2. State-changing requests must carry X-Requested-With: 2way. A custom
 *     header cannot be sent cross-site without a CORS preflight, and this
 *     server never answers preflights.
 *  3. If the browser sends Origin / Sec-Fetch-Site, they must be same-origin.
 */
function csrfOk({ method, origin, secFetchSite, xRequestedWith }, appOrigin) {
  if (SAFE_METHODS.has(method)) return true;
  if (xRequestedWith !== '2way') return false;
  if (origin && origin !== appOrigin) return false;
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') return false;
  return true;
}

/**
 * Cross-site WebSocket hijacking defence for the Socket.IO handshake.
 * Browsers always send Origin on a WebSocket handshake and on cross-origin
 * requests, so a foreign Origin is rejected outright. Same-origin
 * long-polling GETs may omit Origin; those pass only when Fetch Metadata
 * (if present) confirms same-origin.
 */
function handshakeOriginOk(headers, appOrigin) {
  const origin = headers.origin;
  if (origin) return origin === appOrigin;
  const site = headers['sec-fetch-site'];
  return !site || site === 'same-origin';
}

module.exports = { csrfOk, handshakeOriginOk };
