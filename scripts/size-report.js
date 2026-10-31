'use strict';

// Measures compressed transfer sizes of the front end against the budgets in
// the spec (JS ≤ 100 KB, CSS ≤ 30 KB compressed for the initial load).
// Usage: npm run size

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const pub = path.join(__dirname, '..', 'public');
const gz = (b) => zlib.gzipSync(b, { level: 9 }).length;
const br = (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const kb = (n) => (n / 1024).toFixed(1).padStart(6) + ' KB';

function report(title, files) {
  let raw = 0; let g = 0; let b = 0;
  console.log(`\n${title}`);
  for (const f of files) {
    const buf = fs.readFileSync(path.join(pub, f));
    raw += buf.length; g += gz(buf); b += br(buf);
    console.log(`  ${f.padEnd(28)} ${kb(buf.length)} raw ${kb(gz(buf))} gzip ${kb(br(buf))} brotli`);
  }
  console.log(`  ${'TOTAL'.padEnd(28)} ${kb(raw)} raw ${kb(g)} gzip ${kb(b)} brotli`);
  return { raw, g, b };
}

const html = report('HTML', ['index.html']);
const css = report('CSS (initial)', ['css/app.css']);
const jsSignedOut = report('JS — sign-in screen', ['js/theme.js', 'js/app.js', 'js/dom.js', 'js/api.js', 'js/rt.js', 'js/views/auth.js']);
const jsLounge = report('JS — first screen after sign-in (lounge)', ['js/theme.js', 'js/app.js', 'js/dom.js', 'js/api.js', 'js/rt.js', 'js/views/common.js', 'js/views/lounge.js']);
const jsAll = report('JS — every app module (incl. lazy chat/profile/admin)', fs.readdirSync(path.join(pub, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f)
  .concat(fs.readdirSync(path.join(pub, 'js/views')).map((f) => 'js/views/' + f)));

console.log('\nBudgets (gzip):');
const SOCKET_IO_CLIENT_GZIP = 15 * 1024; // socket.io.min.js v4.8, approx.; loaded after sign-in
const check = (label, val, max) => console.log(`  ${val <= max ? '✓' : '✗'} ${label}: ${kb(val)} / ${kb(max)}`);
check('initial CSS', css.g, 30 * 1024);
check('initial JS, signed out', jsSignedOut.g, 100 * 1024);
check('initial JS, lounge + Socket.IO client (~15 KB est.)', jsLounge.g + SOCKET_IO_CLIENT_GZIP, 100 * 1024);
void html; void jsAll;
