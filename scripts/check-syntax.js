'use strict';

// Static checks that need no dependencies:
//  1. every server file parses (node --check)
//  2. every browser ES module parses
//  3. every named import in the browser code is actually exported by its target
//  4. every file the service worker precaches exists
// Usage: npm run check

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
let failures = 0;
const fail = (msg) => { failures++; console.error('✗ ' + msg); };

function walk(dir, ext) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(p, ext);
    return p.endsWith(ext) ? [p] : [];
  });
}

const serverFiles = [...walk(path.join(root, 'server'), '.js'), ...walk(path.join(root, 'scripts'), '.js'), ...walk(path.join(root, 'test'), '.js')];
for (const f of serverFiles) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { fail(`${path.relative(root, f)}: ${e.stderr}`); }
}

const pub = path.join(root, 'public');
const modules = walk(path.join(pub, 'js'), '.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '2way-check-'));
const exportsOf = new Map();
for (const f of modules) {
  const src = fs.readFileSync(f, 'utf8');
  const isModule = /^\s*(import|export)\s/m.test(src);
  const copy = path.join(tmp, path.basename(f).replace(/\.js$/, isModule ? '.mjs' : '.cjs'));
  fs.writeFileSync(copy, src);
  try { execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' }); } catch (e) { fail(`${path.relative(root, f)}: ${e.stderr}`); }
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(',').forEach((n) => names.add(n.trim().split(/\s+as\s+/).pop()));
  exportsOf.set(f, names);
}
for (const f of modules) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const target = path.resolve(path.dirname(f), m[2]);
    if (!exportsOf.has(target)) { fail(`${path.relative(root, f)} imports missing module ${m[2]}`); continue; }
    for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      if (!exportsOf.get(target).has(name)) fail(`${path.relative(root, f)} imports "${name}" which ${m[2]} does not export`);
    }
  }
  for (const m of src.matchAll(/import\('([^']+)'\)\)?\.?([A-Za-z_$][\w$]*)?/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    if (!exportsOf.has(target)) fail(`${path.relative(root, f)} dynamically imports missing ${m[1]}`);
    else if (m[2] && !exportsOf.get(target).has(m[2])) fail(`${path.relative(root, f)} uses "${m[2]}" which ${m[1]} does not export`);
  }
}

const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
const list = /SHELL_FILES = \[([\s\S]*?)\];/.exec(sw)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
for (const p of list) {
  if (p === '/') continue;
  if (!fs.existsSync(path.join(pub, p))) fail(`service worker precaches missing file ${p}`);
}
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
  if (!fs.existsSync(path.join(pub, m[1]))) fail(`index.html references missing ${m[1]}`);
}
for (const m of html.matchAll(/style="/g)) fail('index.html uses an inline style attribute (blocked by CSP)'), void m;
const iconsUsed = new Set();
for (const f of modules) for (const m of fs.readFileSync(f, 'utf8').matchAll(/icon\('([a-z-]+)'/g)) iconsUsed.add(m[1]);
for (const name of iconsUsed) if (!html.includes(`id="i-${name}"`)) fail(`icon "${name}" is used but not in the sprite`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} problem(s)` : `✓ ${serverFiles.length} server files, ${modules.length} browser modules, ${list.length} precached files, ${iconsUsed.size} icons OK`);
process.exit(failures ? 1 : 0);
