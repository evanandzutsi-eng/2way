'use strict';

/** An error that is safe to show to the client. Anything else becomes a 500. */
class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    if (extra) this.extra = extra;
  }
}

const bad = (message, code = 'bad_request') => new AppError(400, code, message);
const unauthorized = (message = 'Please sign in.') => new AppError(401, 'unauthorized', message);
const forbidden = (message = 'You do not have access to that.') => new AppError(403, 'forbidden', message);
// Used when revealing existence would leak information (e.g. a DM you are not in).
const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);
const conflict = (message, code = 'conflict') => new AppError(409, code, message);
const tooMany = (retryAfterSec, message = 'Slow down a little and try again.') =>
  new AppError(429, 'rate_limited', message, { retryAfter: retryAfterSec });

module.exports = { AppError, bad, unauthorized, forbidden, notFound, conflict, tooMany };
