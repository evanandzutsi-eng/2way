'use strict';

// Argon2id via @node-rs/argon2 (prebuilt binaries, no native build toolchain
// needed in the Docker image). Parameters follow the OWASP Password Storage
// Cheat Sheet's Argon2id recommendation (m=19 MiB, t=2, p=1), which keeps a
// login well under ~100 ms on a small VPS.

const argon2 = require('@node-rs/argon2');

const OPTIONS = {
  algorithm: 2, // Argon2id
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
};

async function hashPassword(plain) {
  return argon2.hash(plain, OPTIONS);
}

async function verifyPassword(hash, plain) {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// Verified against when the username doesn't exist, so response timing does
// not reveal which usernames are members.
let dummyHash;
async function burnTime(plain) {
  dummyHash ??= await hashPassword('2way-timing-equaliser-' + Math.random());
  await verifyPassword(dummyHash, plain);
}

module.exports = { hashPassword, verifyPassword, burnTime };
