import { h, icon, avatar, rankBadge, sheet, toast, emptyState, spinner, ago } from '../dom.js';
import { api } from '../api.js';
import { store, go } from '../app.js';

export const ROOM_ICONS = { chat: 'chat', moon: 'moon', ball: 'ball', spark: 'spark', pad: 'pad', music: 'music', star: 'star', lock: 'lock' };

export function topbar(...children) {
  return h('header', { class: 'topbar' }, ...children);
}

export function roomActivity(r) {
  if (r.hereNow > 0) return h('span', { class: 'act' }, h('span', { class: 'live' }), `${r.hereNow} here`);
  if (r.messages24h > 0) return h('span', { class: 'act' }, `${r.messages24h} today`);
  if (r.lastMessageAt) return h('span', { class: 'act' }, ago(r.lastMessageAt));
  return h('span', { class: 'act' }, 'Quiet');
}

/** Member profile sheet with a "Message" action. */
export async function openMember(id) {
  const body = h('div', null, spinner());
  const close = sheet(body, { label: 'Member profile' });
  try {
    const m = await api.get(`/members/${id}`);
    const isMe = m.id === store.me?.id;
    body.replaceChildren(
      h('div', { class: 'profile-hero' },
        avatar(m.avatar, 96, m.presence),
        h('h2', null, m.username),
        rankBadge(m.rank, m.rankIndex),
        m.status ? h('p', { class: 'status' }, m.status) : null,
        h('p', { class: 'muted' }, h('small', null, `${m.xp} XP · ${m.presence === 'online' ? 'Online now' : m.presence === 'recent' ? 'Recently active' : 'Offline'}`))),
      m.achievements.length
        ? h('div', { class: 'ach' }, m.achievements.map((a) => h('div', { class: 'card' }, h('span', { class: 'ic' }, icon(a.icon, 'i i-sm')), h('div', null, h('b', null, a.name), h('span', null, a.description)))))
        : h('p', { class: 'muted' }, 'No achievements yet.'),
      h('div', { class: 'sheet-actions' },
        isMe ? h('a', { class: 'btn block', href: '#/profile', onclick: close }, 'Edit my profile')
          : h('button', { class: 'btn primary block', onclick: async () => {
            try { const c = await api.post('/dms', { userId: m.id }); close(); go(`/messages/${c.id}`); } catch (e) { toast(e.message, 'error'); }
          } }, icon('msg'), `Message ${m.username}`)),
    );
  } catch (e) {
    body.replaceChildren(emptyState('user', "Couldn't load this member", e.message));
  }
}

/** Search members and rooms already in memory (no extra network). */
export function openSearch() {
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search mates and rooms', 'aria-label': 'Search', autocomplete: 'off' });
  const results = h('div', { class: 'list card' });
  let close;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const rooms = store.rooms.filter((r) => !q || r.name.toLowerCase().includes(q));
    const mates = [...store.members.values()].filter((m) => !q || m.username.toLowerCase().includes(q) || m.status?.toLowerCase().includes(q));
    const rows = [
      ...rooms.slice(0, 5).map((r) => h('a', { class: 'row', href: `#/rooms/${r.id}`, onclick: () => close() },
        h('span', { class: `room-ic c-${r.color}` }, icon(ROOM_ICONS[r.icon] || 'chat')), h('div', { class: 'grow' }, h('div', { class: 't' }, r.name), h('div', { class: 's' }, r.description)))),
      ...mates.slice(0, 12).map((m) => h('button', { class: 'row', onclick: () => { close(); openMember(m.id); } },
        avatar(m.avatar, 40, m.presence), h('div', { class: 'grow' }, h('div', { class: 't' }, h('span', null, m.username), rankBadge(m.rank, m.rankIndex, true)), m.status ? h('div', { class: 's' }, m.status) : null))),
    ];
    results.replaceChildren(...(rows.length ? rows : [emptyState('search', 'Nothing found')]));
  };
  input.addEventListener('input', draw);
  close = sheet(h('div', null, h('div', { class: 'search-box' }, input), results), { label: 'Search' });
  draw();
  input.focus();
}
