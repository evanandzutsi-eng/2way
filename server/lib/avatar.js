'use strict';

// Self-hosted, deterministic pixel-art avatars. A seed string always produces
// the same 12×12 character, rendered as a tiny crisp-edged SVG (~1–2 KB).
// No third-party avatar service, so no member data leaves the server.

const crypto = require('node:crypto');

const SKIN = ['#3b2219', '#4e2c1d', '#6b4129', '#8a5636', '#a86f47', '#c98e5d', '#e3b48a'];
const HAIR = ['#0d0907', '#24160f', '#4a2c18', '#8b5cf6', '#22d3ee', '#f59e0b', '#e2e8f0', '#ef4444'];
const SHIRT = ['#8b5cf6', '#22d3ee', '#10b981', '#f59e0b', '#f43f5e', '#6366f1', '#e2e8f0', '#0ea5e9'];
const BG = ['#1e1b4b', '#0c4a6e', '#064e3b', '#4c1d95', '#3f1d38', '#1f2937', '#422006', '#0f172a'];

function rng(seed) {
  // Expand the seed into a byte stream; plenty of bytes for every choice.
  const bytes = crypto.createHash('sha512').update('2way-avatar:' + seed).digest();
  let i = 0;
  return (n) => bytes[i++ % bytes.length] % n;
}

function darken(hex, f = 0.72) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Returns a 12×12 array of colour strings (or null for transparent). */
function grid(seed) {
  const pick = rng(String(seed));
  const skin = SKIN[pick(SKIN.length)];
  const hair = HAIR[pick(HAIR.length)];
  const shirt = SHIRT[pick(SHIRT.length)];
  const bg = BG[pick(BG.length)];
  const hairStyle = pick(6);
  const eyes = pick(4);
  const mouth = pick(3);
  const extra = pick(5);

  const g = Array.from({ length: 12 }, () => Array(12).fill(bg));
  const set = (x, y, c) => { if (x >= 0 && x < 12 && y >= 0 && y < 12) g[y][x] = c; };
  const row = (y, x0, x1, c) => { for (let x = x0; x <= x1; x++) set(x, y, c); };

  // Shoulders / shirt
  row(10, 2, 9, shirt); row(11, 1, 10, shirt); row(9, 4, 7, shirt);
  set(5, 9, darken(shirt)); set(6, 9, darken(shirt)); // collar
  // Neck
  row(8, 5, 6, darken(skin, 0.85));
  // Head
  for (let y = 2; y <= 7; y++) row(y, 3, 8, skin);
  set(2, 5, skin); set(9, 5, skin); // ears

  // Hair
  switch (hairStyle) {
    case 0: row(1, 3, 8, hair); row(2, 3, 8, hair); set(3, 3, hair); set(8, 3, hair); break; // short crop
    case 1: row(0, 3, 8, hair); row(1, 2, 9, hair); row(2, 2, 9, hair); set(2, 3, hair); set(9, 3, hair); set(2, 4, hair); set(9, 4, hair); break; // afro
    case 2: row(1, 3, 8, hair); row(2, 3, 9, hair); row(2, 9, 10, darken(hair)); break; // cap
    case 3: row(0, 5, 6, hair); row(1, 5, 6, hair); row(2, 4, 7, hair); break; // mohawk / top
    case 4: row(2, 3, 8, hair); set(3, 3, hair); break; // low fade
    default: row(1, 4, 7, hair); row(2, 3, 8, hair); for (let y = 3; y <= 7; y++) { set(3, y, hair); set(8, y, hair); } break; // long / locs
  }

  // Eyes
  const eye = '#0b1020';
  if (eyes === 3) {
    row(4, 3, 8, '#0b1020'); set(4, 4, '#22d3ee'); set(7, 4, '#22d3ee'); // shades
  } else {
    set(4, 4, eye); set(7, 4, eye);
    if (eyes === 1) { set(4, 3, darken(skin, 0.6)); set(7, 3, darken(skin, 0.6)); } // brows
    if (eyes === 2) { set(4, 4, '#f8fafc'); set(7, 4, '#f8fafc'); set(5, 4, eye); set(8, 4, eye); } // side glance
  }
  // Mouth
  const lip = darken(skin, 0.55);
  if (mouth === 0) { row(6, 5, 6, lip); }
  else if (mouth === 1) { set(4, 6, lip); row(7, 5, 6, lip); set(7, 6, lip); } // smile
  else { row(6, 5, 6, '#f8fafc'); } // grin

  // Extras
  if (extra === 1) set(2, 6, '#facc15'); // earring
  if (extra === 2) { row(1, 2, 9, '#334155'); set(2, 4, '#334155'); set(2, 5, '#64748b'); set(9, 4, '#334155'); set(9, 5, '#64748b'); } // headphones
  if (extra === 3) row(11, 4, 7, darken(shirt)); // shirt stripe
  return g;
}

/** Render to SVG, merging horizontal runs to keep the markup small. */
function svg(seed) {
  const g = grid(seed);
  let rects = '';
  for (let y = 0; y < 12; y++) {
    let x = 0;
    while (x < 12) {
      const c = g[y][x];
      let w = 1;
      while (x + w < 12 && g[y][x + w] === c) w++;
      if (c) rects += `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${c}"/>`;
      x += w;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" shape-rendering="crispEdges">${rects}</svg>`;
}

module.exports = { svg, grid };
