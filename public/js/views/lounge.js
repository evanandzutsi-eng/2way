import { h, icon, avatar, rankBadge, emptyState, spinner, ago } from '../dom.js';
import { store, loadLounge } from '../app.js';
import { topbar, roomActivity, openMember, openSearch, ROOM_ICONS } from './common.js';

const PRESENCE_ORDER = { online: 0, recent: 1, offline: 2 };

export function loungeView(root) {
  const hello = h('section', { class: 'card hello' });
  const mates = h('div', { class: 'mates', role: 'list' });
  const matesCount = h('span', { class: 'pill' });
  const rooms = h('div', { class: 'rooms' });
  const feed = h('div', { class: 'card list feed' });

  root.append(
    topbar(
      h('span', { class: 'wm grow' }, h('b', null, '2'), 'WaY'),
      h('button', { class: 'icon-btn', 'aria-label': 'Search', onclick: openSearch }, icon('search')),
      h('a', { class: 'icon-btn', href: '#/profile', 'aria-label': 'Settings' }, icon('gear')),
    ),
    h('main', { class: 'main' },
      hello,
      h('section', { class: 'section', 'aria-labelledby': 'mates-h' },
        h('div', { class: 'section-h' }, h('h2', { id: 'mates-h' }, 'Active Mates'), matesCount),
        mates),
      h('section', { class: 'section', 'aria-labelledby': 'rooms-h' },
        h('div', { class: 'section-h' }, h('h2', { id: 'rooms-h' }, 'Rooms'), h('a', { class: 'link', href: '#/rooms' }, 'All rooms')),
        rooms),
      h('section', { class: 'section', 'aria-labelledby': 'feed-h' },
        h('div', { class: 'section-h' }, h('h2', { id: 'feed-h' }, 'Recent Activity')),
        feed),
    ),
  );

  function drawHello() {
    const me = store.me;
    if (!me) return;
    const r = me.rank;
    const pct = Math.round(r.progress * 100);
    const fill = h('i');
    fill.style.width = `${pct}%`; // CSSOM: allowed under the strict CSP
    hello.replaceChildren(
      avatar(me.avatar, 48),
      h('div', { class: 'grow' },
        h('strong', null, `Hey ${me.username} 👋`),
        h('div', { class: 'xp-detail' }, rankBadge(r.name, r.index, true), ' ',
          r.nextName ? `${me.xp} / ${r.nextMinXp} XP to ${r.nextName}` : `${me.xp} XP · top rank`),
        h('div', { class: 'xpbar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Progress to next rank' },
          fill)),
    );
  }

  function drawMates() {
    if (!store.loungeLoaded) { mates.replaceChildren(spinner('Loading mates')); return; }
    const list = [...store.members.values()]
      .filter((m) => m.id !== store.me?.id)
      .sort((a, b) => (PRESENCE_ORDER[a.presence] - PRESENCE_ORDER[b.presence]) || a.username.localeCompare(b.username));
    const online = list.filter((m) => m.presence === 'online').length;
    matesCount.replaceChildren(online ? h('span', { class: 'live' }) : null, online ? `${online} online` : `${list.length} mates`);
    if (!list.length) { mates.replaceChildren(h('p', { class: 'muted' }, 'Your mates will show up here once they join.')); return; }
    mates.replaceChildren(...list.map((m) => h('button', {
      class: `mate${m.presence === 'online' ? ' is-online' : ''}`, role: 'listitem',
      'aria-label': `${m.username}, ${m.rank}${m.presence === 'online' ? ', online' : ''}`,
      onclick: () => openMember(m.id),
    }, avatar(m.avatar, 56, m.presence), h('span', { class: 'name' }, m.username), rankBadge(m.rank, m.rankIndex, true))));
  }

  function drawRooms() {
    if (!store.loungeLoaded) { rooms.replaceChildren(spinner('Loading rooms')); return; }
    if (!store.rooms.length) { rooms.replaceChildren(emptyState('grid', 'No rooms yet')); return; }
    rooms.replaceChildren(...store.rooms.map((r) => h('a', { class: `room-card c-${r.color}`, href: `#/rooms/${r.id}` },
      h('span', { class: 'ic' }, icon(ROOM_ICONS[r.icon] || 'chat')),
      roomActivity(r),
      h('h3', null, r.name),
      h('p', null, r.description))));
  }

  function drawFeed() {
    if (!store.loungeLoaded) { feed.replaceChildren(spinner('Loading activity')); return; }
    if (!store.activity.length) { feed.replaceChildren(emptyState('spark', 'Nothing yet', 'Rank-ups, achievements and new rooms appear here.')); return; }
    feed.replaceChildren(...store.activity.map((a) => {
      let text;
      if (a.kind === 'member_joined') text = 'joined the circle';
      else if (a.kind === 'rank_up') text = `ranked up to ${a.data.rank}`;
      else if (a.kind === 'achievement') text = `unlocked “${a.data.name}”`;
      else if (a.kind === 'room_created') text = `New room: ${a.room?.name || a.data.name}`;
      const who = a.user ? a.user.username : null;
      return h(a.user ? 'button' : 'a', a.user ? { class: 'row', onclick: () => openMember(a.user.id) } : { class: 'row', href: a.room ? `#/rooms/${a.room.id}` : '#/rooms' },
        a.user ? avatar(a.user.avatar, 32) : h('span', { class: 'room-ic c-violet' }, icon('spark')),
        h('div', { class: 'grow' }, h('div', { class: 's' }, who ? h('b', null, who) : null, who ? ' ' : null, text)),
        h('span', { class: 'meta' }, ago(a.createdAt)));
    }));
  }

  drawHello(); drawMates(); drawRooms(); drawFeed();
  const offs = [
    store.on('me', drawHello), store.on('members', drawMates), store.on('rooms', drawRooms), store.on('activity', drawFeed),
  ];
  loadLounge().catch(() => {
    if (!store.loungeLoaded) feed.replaceChildren(h('div', { class: 'err-box' }, h('p', null, "Couldn't load the lounge."), h('button', { class: 'btn', onclick: () => loadLounge().catch(() => {}) }, icon('refresh'), 'Retry')));
  });
  return () => offs.forEach((f) => f());
}
