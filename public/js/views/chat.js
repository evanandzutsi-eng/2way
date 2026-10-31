// Shared chat screen for rooms and direct messages.
//
// Delivery rules:
//  - A message shows "Sending…" until the server acknowledges it with its
//    stored id; only then is it rendered as sent.
//  - Every send carries a client-generated UUID. Retries reuse it, and the
//    server deduplicates on it, so a retry after a lost ack never doubles up.
//  - After a reconnect the screen fetches anything newer than the last
//    message it has, then merges by id (no duplicates, no gaps).

import { h, icon, avatar, rankBadge, emptyState, spinner, clock, dayLabel, REACTIONS, uuid, sheet, toast } from '../dom.js';
import { api } from '../api.js';
import { rt } from '../rt.js';
import { store, go } from '../app.js';
import { topbar, openMember, ROOM_ICONS } from './common.js';

const GROUP_MS = 5 * 60_000;
const MAX_LEN = 2000;
const coarse = matchMedia('(pointer: coarse)').matches;

export function chatView(root, { kind, id }) {
  const isRoom = kind === 'room';
  const base = isRoom ? `/rooms/${id}/messages` : `/dms/${id}/messages`;
  const me = store.me;

  const msgs = new Map(); // id -> message
  const pending = new Map(); // clientId -> { body, state }
  let hasMore = false;
  let loadingOlder = false;
  let otherReadId = null;
  let conversation = null;
  let disposed = false;

  // ---- Layout ----------------------------------------------------------------------
  const title = h('h1', null, '…');
  const sub = h('div', { class: 'sub' });
  const headLeft = h('div', { class: 'grow' }, title, sub);
  const headIcon = h('span');
  const list = h('div', { class: 'msgs', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' }, spinner('Loading messages'));
  const typingEl = h('div', { class: 'typing', 'aria-live': 'polite' });
  const input = h('textarea', { rows: '1', placeholder: isRoom ? 'Say something…' : 'Message', 'aria-label': 'Message', maxlength: String(MAX_LEN + 200), enterkeyhint: coarse ? 'enter' : 'send' });
  const counter = h('span', { class: 'counter', hidden: true });
  const sendBtn = h('button', { class: 'send', type: 'submit', 'aria-label': 'Send', disabled: true }, icon('send'));
  const form = h('form', { class: 'composer' }, input, counter, sendBtn);

  root.append(h('section', { class: 'chat' },
    topbar(
      h('button', { class: 'icon-btn ghost', 'aria-label': 'Back', onclick: () => go(isRoom ? '/rooms' : '/messages') }, icon('back')),
      headIcon, headLeft,
    ),
    list, typingEl, form));

  // ---- Rendering --------------------------------------------------------------------
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 140;
  const toBottom = () => { list.scrollTop = list.scrollHeight; };

  function reactionsEl(m) {
    if (!isRoom || !m.reactions?.length) return null;
    return h('div', { class: 'reacts' }, m.reactions.map((r) => h('button', {
      class: `react${r.mine ? ' mine' : ''}`, 'aria-pressed': String(r.mine), 'aria-label': `${r.emoji} ${r.count}`,
      onclick: () => react(m, r.emoji),
    }, REACTIONS[r.emoji], h('span', null, String(r.count)))));
  }

  function messageEl(m, prev) {
    const mine = m.author.id === me.id;
    const cont = prev && !prev._pending && prev.author.id === m.author.id && !prev.deleted &&
      new Date(m.createdAt) - new Date(prev.createdAt) < GROUP_MS;
    const el = h('div', { class: `m${mine ? ' me' : ''}${cont ? ' cont' : ''}${m.deleted ? ' deleted' : ''}`, dataset: { id: m.id } },
      mine ? null : h('button', { class: 'av-btn', 'aria-label': m.author.username, onclick: () => openMember(m.author.id) }, avatar(m.author.avatar, 32)),
      h('div', { class: 'm-head' }, h('b', null, m.author.username), isRoom ? rankBadge(m.author.rank, m.author.rankIndex, true) : null, h('time', { datetime: m.createdAt }, clock(m.createdAt))),
      h('button', { class: 'bubble', onclick: () => actions(m) }, m.deleted ? 'Message removed' : m.body),
      reactionsEl(m));
    return el;
  }

  function pendingEl(clientId, p) {
    const failed = p.state === 'failed';
    return h('div', { class: `m me ${failed ? 'failed' : 'pending'}`, dataset: { client: clientId } },
      h('div', { class: 'bubble' }, p.body),
      h('div', { class: 'm-state' }, failed
        ? [icon('close', 'i i-sm'), p.error || 'Not sent', h('button', { type: 'button', onclick: () => deliver(clientId) }, 'Retry'),
          h('button', { type: 'button', onclick: () => { pending.delete(clientId); renderAll(); } }, 'Discard')]
        : 'Sending…'));
  }

  function seenEl(sorted) {
    if (isRoom || otherReadId == null) return null;
    const lastMine = [...sorted].reverse().find((m) => m.author.id === me.id && !m.deleted);
    if (!lastMine || otherReadId < lastMine.id) return null;
    return h('div', { class: 'seen' }, icon('check', 'i i-sm'), 'Seen');
  }

  function renderAll({ keepPosition = false } = {}) {
    const prevHeight = list.scrollHeight;
    const prevTop = list.scrollTop;
    const sorted = [...msgs.values()].sort((a, b) => a.id - b.id);
    const nodes = [h('div', { class: 'msgs-top' }, hasMore ? (loadingOlder ? h('span', { class: 'spin' }) : h('span', { id: 'older-sentinel' }, 'Scroll up for older messages')) : (sorted.length ? 'Start of the conversation' : ''))];
    let prev = null; let lastDay = '';
    for (const m of sorted) {
      const d = dayLabel(m.createdAt);
      if (d !== lastDay) { nodes.push(h('div', { class: 'day' }, d)); lastDay = d; prev = null; }
      nodes.push(messageEl(m, prev));
      prev = m;
    }
    const seen = seenEl(sorted);
    if (seen) nodes.push(seen);
    for (const [cid, p] of pending) nodes.push(pendingEl(cid, p));
    if (!sorted.length && !pending.size) {
      nodes.push(emptyState(isRoom ? 'chat' : 'msg', isRoom ? 'No messages yet' : 'Say hi 👋', isRoom ? 'Be the first to start the conversation.' : 'Only the two of you can see this chat.'));
    }
    list.replaceChildren(...nodes);
    observeOlder();
    if (keepPosition) list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
  }

  /** Merge server messages; returns true if anything new was added. */
  function merge(arr) {
    let added = false;
    for (const m of arr) {
      if (!msgs.has(m.id)) added = true;
      msgs.set(m.id, { ...msgs.get(m.id), ...m });
      if (m.author.id === me.id && m.clientId) pending.delete(m.clientId);
    }
    return added;
  }

  // ---- Loading ----------------------------------------------------------------------
  let observer = null;
  function observeOlder() {
    observer?.disconnect();
    const s = list.querySelector('#older-sentinel');
    if (!s) return;
    observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadOlder(); }, { root: list, rootMargin: '200px 0px 0px 0px' });
    observer.observe(s);
  }

  async function loadInitial() {
    try {
      const d = await api.get(`${base}?limit=40`);
      if (disposed) return;
      if (!isRoom) {
        conversation = d.conversation;
        otherReadId = d.conversation.otherReadId;
        drawHeader();
      }
      hasMore = d.hasMore;
      merge(d.messages);
      renderAll();
      toBottom();
      markRead();
    } catch (e) {
      if (disposed) return;
      list.replaceChildren(e.status === 404
        ? emptyState('lock', isRoom ? 'Room not available' : 'Conversation not found', 'It may have been closed, or you may not have access.')
        : h('div', { class: 'err-box' }, h('p', null, e.message), h('button', { class: 'btn', onclick: loadInitial }, icon('refresh'), 'Retry')));
      form.hidden = e.status === 404;
    }
  }

  async function loadOlder() {
    if (loadingOlder || !hasMore || !msgs.size) return;
    loadingOlder = true;
    const oldest = Math.min(...msgs.keys());
    try {
      const d = await api.get(`${base}?before=${oldest}&limit=40`);
      if (disposed) return;
      hasMore = d.hasMore;
      merge(d.messages);
    } catch (e) { toast(e.message, 'error'); }
    loadingOlder = false;
    renderAll({ keepPosition: true });
  }

  /** After reconnecting: fetch what we missed, page by page. */
  async function catchUp() {
    if (!msgs.size) return loadInitial();
    let newest = Math.max(...msgs.keys());
    for (let i = 0; i < 4; i++) {
      const d = await api.get(`${base}?after=${newest}&limit=50`).catch(() => null);
      if (!d || disposed) return;
      const stick = nearBottom();
      if (merge(d.messages)) { renderAll(); if (stick) toBottom(); }
      if (!d.hasMore) return markRead();
      newest = Math.max(...msgs.keys());
    }
    // Missed too much: start fresh from the latest page.
    msgs.clear(); renderAll(); loadInitial();
  }

  // ---- Header -----------------------------------------------------------------------
  let hereCount = null;
  function drawHeader() {
    if (isRoom) {
      const r = store.rooms.find((x) => x.id === id);
      if (r) {
        title.textContent = r.name;
        headIcon.replaceChildren(h('span', { class: `room-ic c-${r.color}` }, icon(ROOM_ICONS[r.icon] || 'chat')));
      }
      sub.textContent = hereCount ? `${hereCount} here now` : (r?.description || '');
    } else if (conversation) {
      const o = store.members.get(conversation.other.id) || conversation.other;
      title.textContent = o.username;
      headIcon.replaceChildren(h('button', { class: 'av-btn', 'aria-label': `View ${o.username}`, onclick: () => openMember(o.id) }, avatar(o.avatar, 40, o.presence)));
      sub.textContent = o.presence === 'online' ? 'Online' : o.presence === 'recent' ? 'Recently active' : `${o.rank}`;
    }
  }

  // ---- Sending ----------------------------------------------------------------------
  async function deliver(clientId) {
    const p = pending.get(clientId);
    if (!p) return;
    p.state = 'pending'; p.error = null;
    renderAll(); toBottom();
    const payload = isRoom ? { roomId: id, body: p.body, clientId } : { conversationId: id, body: p.body, clientId };
    try {
      let message;
      if (rt.state === 'online') {
        ({ message } = await rt.emit(isRoom ? 'room:send' : 'dm:send', payload));
      } else {
        message = await api.post(base, { body: p.body, clientId }); // REST fallback while the socket reconnects
      }
      if (disposed) return;
      merge([message]);
      pending.delete(clientId);
      renderAll(); toBottom();
    } catch (e) {
      if (disposed) return;
      const cur = pending.get(clientId);
      if (!cur) return; // already confirmed by a broadcast
      cur.state = 'failed';
      cur.error = e.code === 'rate_limited' ? 'Slow down a bit' : e.code === 'offline' || e.code === 'network' || e.code === 'timeout' ? 'Not sent — no connection' : e.message;
      renderAll(); toBottom();
    }
  }

  function submit() {
    const body = input.value.trim();
    if (!body || [...body].length > MAX_LEN) return;
    const clientId = uuid();
    pending.set(clientId, { body, state: 'pending' });
    input.value = '';
    autosize(); updateComposer();
    deliver(clientId);
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); input.focus(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) { e.preventDefault(); submit(); }
  });

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
  }
  function updateComposer() {
    const len = [...input.value.trim()].length;
    sendBtn.disabled = len === 0 || len > MAX_LEN;
    counter.hidden = len < MAX_LEN - 200;
    counter.textContent = String(MAX_LEN - len);
    counter.classList.toggle('over', len > MAX_LEN);
  }

  let lastTyping = 0;
  input.addEventListener('input', () => {
    autosize(); updateComposer();
    if (input.value && Date.now() - lastTyping > 3000) {
      lastTyping = Date.now();
      rt.send('typing', isRoom ? { roomId: id } : { conversationId: id });
    }
  });

  // ---- Actions ------------------------------------------------------------------------
  async function react(m, emoji) {
    try {
      const r = await rt.emit('room:react', { messageId: m.id, emoji });
      const cur = msgs.get(m.id);
      if (cur) { cur.reactions = r.reactions; renderAll({ keepPosition: true }); }
    } catch (e) { toast(e.message, 'error'); }
  }

  function actions(m) {
    if (m.deleted) return;
    const mine = m.author.id === me.id;
    const canDelete = mine || (isRoom && me.isAdmin);
    let close;
    const content = h('div', null,
      isRoom ? h('div', { class: 'react-bar', role: 'group', 'aria-label': 'React' },
        Object.entries(REACTIONS).map(([k, e]) => h('button', { 'aria-label': k, onclick: () => { close(); react(m, k); } }, e))) : null,
      h('div', { class: 'sheet-actions stack' },
        navigator.clipboard ? h('button', { class: 'btn block', onclick: async () => { close(); try { await navigator.clipboard.writeText(m.body); toast('Copied'); } catch { /* ignore */ } } }, 'Copy text') : null,
        canDelete ? h('button', { class: 'btn danger block', onclick: async () => {
          close();
          try {
            if (isRoom) await rt.emit('room:delete', { messageId: m.id });
            else await api.del(`/dm-messages/${m.id}`);
          } catch (e) { toast(e.message, 'error'); }
        } }, icon('trash'), mine ? 'Delete for everyone' : 'Remove (admin)') : null));
    close = sheet(content, { label: 'Message actions' });
  }

  // ---- Read state (DMs) -------------------------------------------------------------
  let readTimer;
  function markRead() {
    if (isRoom || document.visibilityState !== 'visible') return;
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const others = [...msgs.values()].filter((m) => m.author.id !== me.id);
      if (!others.length) return;
      const newest = Math.max(...others.map((m) => m.id));
      api.post(`/dms/${id}/read`, { messageId: newest }).catch(() => {});
    }, 400);
  }
  const onVis = () => { if (document.visibilityState === 'visible') markRead(); };
  document.addEventListener('visibilitychange', onVis);

  // ---- Realtime --------------------------------------------------------------------
  const typers = new Map();
  function drawTyping() {
    const names = [...typers.keys()];
    typingEl.replaceChildren(names.length ? h('span', null, h('span', { class: 'dots' }, h('i'), h('i'), h('i')), ' ',
      names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : 'Several people are typing') : '');
  }

  const offs = [];
  if (isRoom) {
    const join = () => rt.emit('room:join', { roomId: id }).catch((e) => { if (e.code === 'not_found') toast('You no longer have access to this room.', 'error'); });
    join();
    offs.push(rt.on('reconnected', () => { join(); catchUp(); }));
    offs.push(rt.on('room:message', (m) => {
      if (m.roomId !== id) return;
      const stick = nearBottom() || m.author.id === me.id;
      if (merge([m])) { renderAll(); if (stick) toBottom(); }
      typers.delete(m.author.username); drawTyping();
    }));
    offs.push(rt.on('room:reactions', ({ messageId, reactions }) => {
      const m = msgs.get(messageId);
      if (!m) return;
      m.reactions = reactions.map((r) => ({ emoji: r.emoji, count: r.count, mine: r.users.includes(me.id) }));
      renderAll({ keepPosition: true });
    }));
    offs.push(rt.on('room:deleted', ({ messageId }) => {
      const m = msgs.get(messageId);
      if (m) { m.deleted = true; m.body = ''; m.reactions = []; renderAll({ keepPosition: true }); }
    }));
    offs.push(rt.on('room:here', ({ roomId, count }) => { if (roomId === id) { hereCount = count; drawHeader(); } }));
    offs.push(store.on('rooms', drawHeader));
  } else {
    offs.push(rt.on('reconnected', catchUp));
    offs.push(rt.on('dm:message', (m) => {
      if (m.conversationId !== id) return;
      const stick = nearBottom() || m.author.id === me.id;
      if (merge([m])) { renderAll(); if (stick) toBottom(); }
      typers.delete(m.author.username); drawTyping();
      markRead();
    }));
    offs.push(rt.on('dm:read', ({ conversationId, messageId }) => {
      if (conversationId === id) { otherReadId = Math.max(otherReadId || 0, messageId); renderAll({ keepPosition: true }); }
    }));
    offs.push(rt.on('dm:deleted', ({ conversationId, messageId }) => {
      const m = msgs.get(messageId);
      if (conversationId === id && m) { m.deleted = true; m.body = ''; renderAll({ keepPosition: true }); }
    }));
    offs.push(store.on('members', drawHeader));
  }
  offs.push(rt.on('typing', (t) => {
    if (isRoom ? t.roomId !== id : t.conversationId !== id) return;
    if (t.user.id === me.id) return;
    clearTimeout(typers.get(t.user.username));
    typers.set(t.user.username, setTimeout(() => { typers.delete(t.user.username); drawTyping(); }, 4000));
    drawTyping();
  }));

  drawHeader();
  loadInitial();
  updateComposer();
  if (!coarse) input.focus();

  return () => {
    disposed = true;
    offs.forEach((f) => f());
    observer?.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    typers.forEach((t) => clearTimeout(t));
    if (isRoom) rt.send('room:leave', {});
    if (!isRoom) { store.conversations = null; }
  };
}
