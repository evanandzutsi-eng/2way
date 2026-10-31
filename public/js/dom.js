// DOM helpers. All user-provided text goes through textContent — never
// innerHTML — so message bodies and names can't inject markup.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

// --- Icons: one inline sprite, referenced with <use>. --------------------------
const SVGNS = 'http://www.w3.org/2000/svg';
export function icon(name, cls = 'i') {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', `#i-${name}`);
  s.append(u);
  return s;
}

// --- Avatars --------------------------------------------------------------------
export function avatar(seed, size = 40, presence) {
  const wrap = h('span', { class: `av av-${size}` });
  if (seed) {
    const img = h('img', { src: `/avatars/${seed}.svg`, alt: '', width: size, height: size, loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(h('span', { class: 'av-fallback' }, icon('user'))), { once: true });
    wrap.append(img);
  } else {
    wrap.append(h('span', { class: 'av-fallback' }, icon('user')));
  }
  if (presence && presence !== 'offline') wrap.append(h('span', { class: `dot dot-${presence}`, title: presence === 'online' ? 'Online' : 'Recently active' }));
  return wrap;
}

const RANK_CLASS = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'];
export function rankBadge(name, index = 0, small = false) {
  return h('span', { class: `rank ${RANK_CLASS[Math.min(index, 5)]}${small ? ' rank-sm' : ''}`, title: `Rank: ${name}` },
    icon('rank', 'i rank-i'), name);
}

// --- Time -------------------------------------------------------------------------
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
export function clock(iso) { return timeFmt.format(new Date(iso)); }
export function dayLabel(iso) {
  const d = new Date(iso); const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return dayFmt.format(d);
}
export function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const REACTIONS = { fire: '🔥', laugh: '😂', heart: '❤️', goal: '⚽', clap: '👏', skull: '💀' };

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

let toastTimer;
export function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

/** Bottom sheet / dialog. Returns a close() function. */
export function sheet(content, { label = 'Dialog' } = {}) {
  const prev = document.activeElement;
  const box = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label, tabindex: '-1' },
    h('div', { class: 'sheet-grip' }), content);
  const scrim = h('div', { class: 'scrim' }, box);
  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(scrim);
  box.focus();
  return close;
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-l' }, label), input, hint ? h('span', { class: 'field-h' }, hint) : null);
}

export function emptyState(iconName, title, text) {
  return h('div', { class: 'empty' }, icon(iconName, 'i i-xl'), h('p', { class: 'empty-t' }, title), text ? h('p', { class: 'muted' }, text) : null);
}

export function spinner(label = 'Loading') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spin' }), h('span', { class: 'sr' }, label));
}
