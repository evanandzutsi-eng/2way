'use strict';

// In-memory token buckets. Correct for the single-instance deployment this
// project targets (one Node process for ~50 members). If the app is ever
// scaled horizontally, move these counters to Postgres or a shared store.

class RateLimiter {
  /**
   * @param {object} o
   * @param {number} o.capacity  burst size
   * @param {number} o.refillPerSec tokens added per second
   * @param {number} [o.maxKeys] memory bound; oldest keys are evicted
   */
  constructor({ capacity, refillPerSec, maxKeys = 10_000, now = () => Date.now() }) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSec / 1000;
    this.maxKeys = maxKeys;
    this.now = now;
    this.buckets = new Map();
  }

  /** Consume `cost` tokens. Returns { ok, retryAfter } (seconds). */
  take(key, cost = 1) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (b) {
      this.buckets.delete(key); // re-insert to keep Map order = recency
      b.tokens = Math.min(this.capacity, b.tokens + (t - b.at) * this.refillPerMs);
      b.at = t;
    } else {
      b = { tokens: this.capacity, at: t };
    }
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);

    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, retryAfter: 0 };
    }
    return { ok: false, retryAfter: Math.ceil((cost - b.tokens) / this.refillPerMs / 1000) };
  }

  reset(key) {
    this.buckets.delete(key);
  }
}

// Shared limiter instances, tuned for a small friendly community.
const limits = {
  // keyed per IP / IP+username before sign-in
  login: new RateLimiter({ capacity: 10, refillPerSec: 10 / 900 }), // per IP+username: 10 per 15 min
  loginIp: new RateLimiter({ capacity: 60, refillPerSec: 60 / 900 }), // per IP: 60 per 15 min
  register: new RateLimiter({ capacity: 20, refillPerSec: 20 / 3600 }), // 20 per hour (codes are ~74-bit, so this is about abuse, not guessing)
  api: new RateLimiter({ capacity: 120, refillPerSec: 2 }), // general REST
  // per user
  message: new RateLimiter({ capacity: 8, refillPerSec: 1 }), // bursts of 8, then 1/s
  reaction: new RateLimiter({ capacity: 15, refillPerSec: 1 }),
  typing: new RateLimiter({ capacity: 5, refillPerSec: 0.5 }),
  socketEvent: new RateLimiter({ capacity: 40, refillPerSec: 10 }),
  sensitive: new RateLimiter({ capacity: 5, refillPerSec: 5 / 900 }), // password change, delete account
};

module.exports = { RateLimiter, limits };
