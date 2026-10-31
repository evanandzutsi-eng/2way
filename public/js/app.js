// 2WaY client entry: state store, hash router, app shell and realtime wiring.
// Heavier screens (chat, profile, admin) are loaded on demand with import().

import { h, $, icon, toast } from './dom.js';
import { api, setUnauthorizedHandler } from './api.js';
import { rt } from './rt.js';

// ---- Store ---------------------------------------------------------------------
const subs = new Map();
export const store = {
  me: null,
  members: new Map(),
  rooms: [],
  activity: [],
  conversations: null,
  unreadDms: 0,
  onlineNow: 0,
  loungeLoaded: false,
  on(key, fn) {
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(fn);
    return () => subs.get(key).delete(fn);
  },
  emit(key) { subs.get(key)?.forEach((fn) => fn()); },
};

export async function loadLounge() {
  const d = await api.get('/lounge');
  store.members = new Map(d.members.map((m) => [m.id, m]));
  store.rooms = d.rooms;
  store.activity = d.activity;
  store.unreadDms = d.unreadDms;
  store.onlineNow = d.onlineNow;
  store.loungeLoaded = true;
  store.emit('members'); store.emit('rooms'); store.emit('activity'); store.emit('unread');
}

export async function refreshMe() {
  store.me = await api.get('/me');
  applyTheme(store.me.prefs.theme);
  store.emit('me');
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('2way-theme', theme); } catch { /* ignore */ }
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', theme === 'light' ? '#f4f6fb' : '#071020'));
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---- Router ----------------------------------------------------------------------
const routes = [
  [/^\/?$/, 'lounge'],
  [/^\/lounge$/, 'lounge'],
  [/^\/rooms$/, 'rooms'],
  [/^\/rooms\/(\d+)$/, 'room'],
  [/^\/messages$/, 'messages'],
  [/^\/messages\/(\d+)$/, 'dm'],
  [/^\/profile$/, 'profile'],
  [/^\/admin$/, 'admin'],
];

function parse() {
  const path = location.hash.replace(/^#/, '') || '/';
  for (const [re, name] of routes) {
    const m = re.exec(path);
    if (m) return { name, params: m.slice(1).map(Number) };
  }
  return { name: 'lounge', params: [] };
}

export function go(path) { location.hash = path; }

const NAV = [
  ['lounge', '#/lounge', 'home', 'Lounge'],
  ['rooms', '#/rooms', 'grid', 'Rooms'],
  ['messages', '#/messages', 'msg', 'Messages'],
  ['profile', '#/profile', 'user', 'Profile'],
];
const NAV_OF = { lounge: 'lounge', rooms: 'rooms', room: 'rooms', messages: 'messages', dm: 'messages', profile: 'profile', admin: 'profile' };

let shell = null;
let cleanup = null;
let renderSeq = 0;

function buildShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
    h('div', { class: 'nav-brand' }, h('span', { class: 'wm' }, h('b', null, '2'), 'WaY')),
    NAV.map(([key, href, ic, label]) => h('a', { href, dataset: { key } }, icon(ic), h('span', null, label),
      key === 'messages' ? h('span', { class: 'badge', id: 'dm-badge', hidden: true }) : null)));
  const view = h('div', { id: 'view' });
  const el = h('div', { class: 'shell' }, view, nav);
  const app = $('#app');
  app.replaceChildren(el);
  shell = { el, nav, view };
  updateBadge();
}

function updateBadge() {
  const b = $('#dm-badge');
  if (!b) return;
  b.hidden = !store.unreadDms;
  b.textContent = store.unreadDms > 99 ? '99+' : String(store.unreadDms);
}
store.on('unread', updateBadge);

async function render() {
  const seq = ++renderSeq;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }

  if (!store.me) {
    shell = null;
    const { authView } = await import('./views/auth.js');
    if (seq !== renderSeq) return;
    const root = $('#app');
    root.replaceChildren();
    cleanup = authView(root, { onSignedIn: start });
    return;
  }
  if (!shell) buildShell();
  const route = parse();
  const navKey = NAV_OF[route.name];
  shell.nav.querySelectorAll('a').forEach((a) => {
    if (a.dataset.key === navKey) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const inChat = route.name === 'room' || route.name === 'dm';
  shell.el.classList.toggle('in-chat', inChat);

  const view = h('div');
  shell.view.replaceChildren(view);
  window.scrollTo(0, 0);

  let mod;
  try {
    switch (route.name) {
      case 'lounge': mod = (await import('./views/lounge.js')).loungeView; break;
      case 'rooms': mod = (await import('./views/lists.js')).roomsView; break;
      case 'messages': mod = (await import('./views/lists.js')).messagesView; break;
      case 'room': case 'dm': mod = (await import('./views/chat.js')).chatView; break;
      case 'profile': mod = (await import('./views/profile.js')).profileView; break;
      case 'admin':
        if (!store.me.isAdmin) { go('/lounge'); return; }
        mod = (await import('./views/admin.js')).adminView; break;
      default: mod = (await import('./views/lounge.js')).loungeView;
    }
  } catch {
    view.replaceChildren(h('div', { class: 'empty' }, icon('wifi-off', 'i i-xl'), h('p', { class: 'empty-t' }, "Couldn't load this screen."),
      h('button', { class: 'btn', onclick: () => render() }, icon('refresh'), 'Try again')));
    return;
  }
  if (seq !== renderSeq) return;
  cleanup = mod(view, { kind: route.name === 'dm' ? 'dm' : 'room', id: route.params[0] });
}

window.addEventListener('hashchange', render);

// ---- Connection banner -----------------------------------------------------------
function showConn(state) {
  const el = $('#conn');
  if (state === 'online' || state === 'idle') { el.hidden = true; return; }
  el.hidden = false;
  el.className = `conn ${state}`;
  el.replaceChildren(
    state === 'offline' ? icon('wifi-off', 'i i-sm') : h('span', { class: 'spin' }),
    state === 'offline' ? "You're offline — messages will wait" : 'Reconnecting…',
  );
}
// Only show "reconnecting" if it lasts more than a moment.
let connTimer;
rt.onState((s) => {
  clearTimeout(connTimer);
  if (s === 'online' || s === 'idle') showConn(s);
  else connTimer = setTimeout(() => showConn(rt.state), s === 'offline' ? 0 : 1500);
});

// ---- Realtime wiring -----------------------------------------------------------
const refetchLounge = debounce(() => loadLounge().catch(() => {}), 600);

rt.on('presence', ({ userId, state }) => {
  const m = store.members.get(userId);
  if (!m || m.presence === state) return;
  m.presence = state;
  store.emit('members');
});
rt.on('members:changed', () => { refetchLounge(); });
rt.on('rooms:changed', refetchLounge);
rt.on('activity:new', refetchLounge);
rt.on('reconnected', () => { refetchLounge(); });
rt.on('dm:message', (msg) => {
  if (msg.author.id === store.me?.id) return;
  const open = parse();
  if (!(open.name === 'dm' && open.params[0] === msg.conversationId && document.visibilityState === 'visible')) {
    store.unreadDms += 1;
    store.emit('unread');
  }
  store.conversations = null; // list refetches on next visit
  store.emit('conversations');
});
rt.on('dm:unread', () => { api.get('/lounge').then((d) => { store.unreadDms = d.unreadDms; store.emit('unread'); }).catch(() => {}); });
rt.on('xp:update', ({ xp, rankUp }) => {
  if (store.me) { store.me.xp = xp; store.emit('me'); }
  if (rankUp) toast(`Rank up! You're now ${rankUp}`);
});
rt.on('achievement', ({ name }) => toast(`Achievement unlocked: ${name}`));
rt.on('session:ended', () => signedOut());

// Tell the server we're actively using the app (drives "online" vs "recent").
let lastActive = 0;
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => {
  if (Date.now() - lastActive > 60_000) { lastActive = Date.now(); rt.send('active'); }
}, { passive: true }));

// ---- Lifecycle ---------------------------------------------------------------------
export async function start() {
  try {
    await refreshMe();
  } catch (err) {
    store.me = null;
    if (err.status !== 401) {
      $('#app').replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'card auth-card err-box' },
        h('span', { class: 'wm' }, h('b', null, '2'), 'WaY'), h('p', null, err.message),
        h('button', { class: 'btn primary', onclick: start }, icon('refresh'), 'Try again'))));
      return;
    }
    render();
    return;
  }
  rt.connect();
  loadLounge().catch(() => {});
  render();
}

export function signedOut() {
  rt.disconnect();
  store.me = null;
  store.members = new Map(); store.rooms = []; store.activity = []; store.conversations = null; store.unreadDms = 0;
  // Remove cached avatars and any other per-member cache on this device.
  navigator.serviceWorker?.controller?.postMessage({ type: 'signed-out' });
  history.replaceState(null, '', '/');
  render();
}

setUnauthorizedHandler(() => { if (store.me) signedOut(); });

if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') {
  window.addEventListener('load', () => navigator.serviceWorker?.register('/sw.js').catch(() => {}));
}

start();
