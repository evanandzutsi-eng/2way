'use strict';

// Small, explicit validators. Each returns the normalised value or throws a
// 400 AppError. Used by both REST handlers and Socket.IO events so the two
// paths can never disagree about what is valid.

const { bad } = require('./errors');

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// C0/C1 control characters except tab and newline; plus bidi overrides that can
// be used to visually disguise text.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

const REACTIONS = Object.freeze(['fire', 'laugh', 'heart', 'goal', 'clap', 'skull']);
const ROOM_COLORS = Object.freeze(['violet', 'indigo', 'green', 'amber', 'cyan', 'rose']);
const ROOM_ICONS = Object.freeze(['chat', 'moon', 'ball', 'spark', 'pad', 'music', 'star', 'lock']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function payload(v) {
  if (!isPlainObject(v)) throw bad('Malformed request.');
  return v;
}

function id(v, field = 'id') {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 1) throw bad(`Invalid ${field}.`);
  return n;
}

function optionalId(v, field) {
  return v === undefined || v === null || v === '' ? null : id(v, field);
}

function username(v) {
  if (typeof v !== 'string' || !USERNAME_RE.test(v.trim())) {
    throw bad('Usernames are 3–20 letters, numbers or underscores.', 'invalid_username');
  }
  return v.trim();
}

function password(v) {
  if (typeof v !== 'string') throw bad('Password required.', 'invalid_password');
  // Length is counted in code points so emoji passphrases are fine.
  const len = [...v].length;
  if (len < 10) throw bad('Use at least 10 characters for your password.', 'weak_password');
  if (len > 128) throw bad('Passwords can be at most 128 characters.', 'invalid_password');
  return v;
}

/** Clean free text: strip control chars, normalise newlines, trim, bound length. */
function text(v, { field = 'text', min = 0, max, multiline = false } = {}) {
  if (typeof v !== 'string') throw bad(`Invalid ${field}.`);
  let s = v.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
  s = multiline ? s.replace(/\n{4,}/g, '\n\n\n') : s.replace(/\n/g, ' ');
  s = s.trim();
  const len = [...s].length;
  if (len < min) throw bad(min <= 1 ? `${field} can't be empty.` : `${field} is too short.`);
  if (len > max) throw bad(`${field} can be at most ${max} characters.`);
  return s;
}

function messageBody(v) {
  return text(v, { field: 'Message', min: 1, max: 2000, multiline: true });
}

function clientId(v) {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw bad('Invalid message id.');
  return v.toLowerCase();
}

function oneOf(v, allowed, field) {
  if (!allowed.includes(v)) throw bad(`Invalid ${field}.`);
  return v;
}

function bool(v, field) {
  if (typeof v !== 'boolean') throw bad(`Invalid ${field}.`);
  return v;
}

function int(v, { field, min, max }) {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${field} must be between ${min} and ${max}.`);
  return v;
}

function slug(v) {
  if (typeof v !== 'string' || !/^[a-z0-9-]{2,32}$/.test(v)) throw bad('Slugs are 2–32 lowercase letters, numbers or dashes.');
  return v;
}

/** Normalise an invite code as people type it: case- and separator-insensitive. */
function inviteCode(v) {
  if (typeof v !== 'string') throw bad('Invite code required.', 'invalid_invite');
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 15) throw bad('That invite code is not valid.', 'invalid_invite');
  return s;
}

module.exports = {
  REACTIONS, ROOM_COLORS, ROOM_ICONS, isPlainObject, payload, id, optionalId, username, password, text,
  messageBody, clientId, oneOf, bool, int, slug, inviteCode,
};
