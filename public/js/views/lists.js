import { h, icon, avatar, rankBadge, emptyState, spinner, ago, sheet, toast } from '../dom.js';
import { api } from '../api.js';
import { store, loadLounge, go } from '../app.js';
import { topbar, roomActivity, openSearch, ROOM_ICONS } from './common.js';

export function roomsView(root) {
  const list = h('div', { class: 'card list' });
  root.append(
    topbar(h('h1', { class: 'grow' }, 'Rooms'), h('button', { class: 'icon-btn', 'aria-label': 'Search', onclick: openSearch }, icon('search'))),
    h('main', { class: 'main' }, h('div', { class: 'section' }, list)),
  );
  function draw() {
    if (!store.loungeLoaded) { list.replaceChildren(spinner('Loading rooms')); return; }
    if (!store.rooms.length) { list.replaceChildren(emptyState('grid', 'No rooms yet', 'The admin can add rooms.')); return; }
    list.replaceChildren(...store.rooms.map((r) => {
      const act = roomActivity(r);
      return h('a', { class: 'row', href: `#/rooms/${r.id}` },
        h('span', { class: `room-ic c-${r.color}` }, icon(r.restricted ? 'lock' : ROOM_ICONS[r.icon] || 'chat')),
        h('div', { class: 'grow' }, h('div', { class: 't' }, h('span', null, r.name)), h('div', { class: 's' }, r.description)),
        h('span', { class: 'meta' }, act.textContent));
    }));
  }
  draw();
  const off = store.on('rooms', draw);
  loadLounge().catch(() => {});
  return off;
}

export function messagesView(root) {
  const list = h('div', { class: 'card list' }, spinner('Loading conversations'));
  root.append(
    topbar(h('h1', { class: 'grow' }, 'Messages'),
      h('button', { class: 'icon-btn', 'aria-label': 'New message', onclick: pickMember }, icon('plus'))),
    h('main', { class: 'main' }, h('div', { class: 'section' }, list)),
  );

  async function load() {
    try {
      const d = await api.get('/dms');
      store.conversations = d.conversations;
      draw();
    } catch (e) {
      list.replaceChildren(h('div', { class: 'err-box' }, h('p', null, e.message), h('button', { class: 'btn', onclick: load }, icon('refresh'), 'Retry')));
    }
  }

  function draw() {
    const convs = store.conversations;
    if (!convs) return;
    if (!convs.length) {
      list.replaceChildren(h('div', null, emptyState('msg', 'No conversations yet', 'Start a private chat with any mate.'),
        h('div', { class: 'pad' }, h('button', { class: 'btn primary block', onclick: pickMember }, icon('plus'), 'New message'))));
      return;
    }
    list.replaceChildren(...convs.map((c) => {
      const lm = c.lastMessage;
      const preview = !lm ? '' : lm.deleted ? 'Message removed' : `${lm.mine ? 'You: ' : ''}${lm.preview}`;
      return h('a', { class: `row${c.unread ? ' unread' : ''}`, href: `#/messages/${c.id}` },
        avatar(c.other.avatar, 48, c.other.presence),
        h('div', { class: 'grow' },
          h('div', { class: 't' }, h('span', null, c.other.username), rankBadge(c.other.rank, c.other.rankIndex, true)),
          h('div', { class: 's' }, preview)),
        h('span', { class: 'meta' }, lm ? ago(lm.createdAt) : '', c.unread ? h('span', { class: 'badge' }, String(c.unread)) : null));
    }));
  }

  function pickMember() {
    const mates = [...store.members.values()].filter((m) => m.id !== store.me.id).sort((a, b) => a.username.localeCompare(b.username));
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Find a mate', 'aria-label': 'Find a mate' });
    const rows = h('div', { class: 'list card' });
    let close;
    const drawRows = () => {
      const q = input.value.trim().toLowerCase();
      const found = mates.filter((m) => m.username.toLowerCase().includes(q));
      rows.replaceChildren(...(found.length ? found.map((m) => h('button', {
        class: 'row',
        onclick: async () => {
          try { const c = await api.post('/dms', { userId: m.id }); close(); go(`/messages/${c.id}`); } catch (e) { toast(e.message, 'error'); }
        },
      }, avatar(m.avatar, 40, m.presence), h('div', { class: 'grow' }, h('div', { class: 't' }, h('span', null, m.username), rankBadge(m.rank, m.rankIndex, true))))) : [emptyState('user', 'No mates match')]));
    };
    input.addEventListener('input', drawRows);
    close = sheet(h('div', null, h('h3', null, 'New message'), h('div', { class: 'search-box' }, input), rows), { label: 'New message' });
    drawRows();
  }

  if (store.conversations) draw();
  load();
  const offs = [store.on('conversations', load)];
  if (!store.loungeLoaded) loadLounge().catch(() => {});
  return () => offs.forEach((f) => f());
}
