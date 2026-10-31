'use strict';

const crypto = require('node:crypto');

// No 0/O, 1/I/L or U: easy to read aloud and type on a phone.
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** 15 characters ≈ 73.6 bits of entropy, shown as XXXXX-XXXXX-XXXXX. */
function newInviteCode() {
  const out = [];
  // Rejection sampling avoids modulo bias.
  const limit = 256 - (256 % INVITE_ALPHABET.length);
  while (out.length < 15) {
    for (const b of crypto.randomBytes(32)) {
      if (b < limit) out.push(INVITE_ALPHABET[b % INVITE_ALPHABET.length]);
      if (out.length === 15) break;
    }
  }
  const raw = out.join('');
  return { raw, display: `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10)}` };
}

/** 256-bit opaque session token for the cookie. */
function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Only hashes are stored; a database leak does not hand out live sessions or invites. */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

module.exports = { INVITE_ALPHABET, newInviteCode, newSessionToken, sha256 };
