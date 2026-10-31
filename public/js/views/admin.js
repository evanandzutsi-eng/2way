// Admin panel (loaded only for admins; the server enforces the role on every
// /api/admin call regardless of what this screen shows).

import { h, icon, field, sheet, toast, spinner, emptyState, ago } from '../dom.js';
import { api } from '../api.js';
import { store } from '../app.js';
import { topbar } from './common.js';

const TABS = [['invites', 'Invites'], ['members', 'Members'], ['rooms', 'Rooms'], ['xp', 'XP'], ['settings', 'Settings'], ['audit', 'Audit log']];
const COLORS = ['violet', 'indigo', 'green', 'amber', 'cyan', 'rose'];
const ICONS = ['chat', 'moon', 'ball', 'spark', 'pad', 'music', 'star', 'lock'];

export function adminView(root) {
  let tab = 'invites';
  const body = h('div', { class: 'section' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  root.append(topbar(h('a', { class: 'icon-btn ghost', href: '#/profile', 'aria-label': 'Back' }, icon('back')), h('h1', { class: 'grow' }, 'Admin')),
    h('main', { class: 'main' }, h('div', { class: 'section' }, tabs), body));

  function drawTabs() {
    tabs.replaceChildren(...TABS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; drawTabs(); show(); } }, l)));
  }

  const fail = (e) => body.replaceChildren(h('div', { class: 'card err-box' }, h('p', null, e.message), h('button', { class: 'btn', onclick: show }, 'Retry')));

  async function show() {
    body.replaceChildren(spinner());
    try { await ({ invites, members, rooms, xp, settings, audit })[tab](); } catch (e) { fail(e); }
  }

  // ---- Invites ------------------------------------------------------------------
  async function invites() {
    const [{ invites: list }, seats] = await Promise.all([api.get('/admin/invites'), api.get('/admin/members')]);
    const username = h('input', { autocapitalize: 'none', maxlength: '20', required: true });
    const note = h('input', { maxlength: '120' });
    const err = h('p', { class: 'form-err' });
    const form = h('form', { class: 'card pad' },
      h('p', { class: 'muted' }, `Seats: ${seats.seats.members} members + ${seats.seats.open_invites} open invites of ${seats.limit}.`),
      field('Username for this invite', username, 'The code only works for this exact username.'),
      field('Note (optional)', note), err, h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Create invite'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      try {
        const inv = await api.post('/admin/invites', { username: username.value, note: note.value });
        sheet(h('div', null, h('h3', null, `Invite for ${inv.intendedUsername}`),
          h('div', { class: 'code-box' }, inv.code),
          h('p', { class: 'muted' }, `Send this privately. It works once, only for “${inv.intendedUsername}”, and expires ${new Date(inv.expiresAt).toLocaleDateString()}. It won't be shown again.`),
          navigator.clipboard ? h('button', { class: 'btn block', onclick: () => navigator.clipboard.writeText(inv.code).then(() => toast('Copied')) }, 'Copy code') : null), { label: 'New invite' });
        invites();
      } catch (e2) { err.textContent = e2.message; }
    });
    body.replaceChildren(form, h('div', { class: 'section card table-wrap' }, list.length ? h('table', { class: 'admin-table' },
      h('thead', null, h('tr', null, h('th', null, 'Username'), h('th', null, 'State'), h('th', null, 'Expires'), h('th', null, ''))),
      h('tbody', null, list.map((i) => h('tr', null, h('td', null, i.intendedUsername, i.note ? h('div', { class: 'muted' }, i.note) : null),
        h('td', null, i.state === 'used' ? `used by ${i.usedBy || '—'}` : i.state),
        h('td', null, new Date(i.expiresAt).toLocaleDateString()),
        h('td', null, i.state === 'open' ? h('button', { class: 'btn danger', onclick: async () => {
          try { await api.post(`/admin/invites/${i.id}/revoke`); toast('Invite revoked'); invites(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Revoke') : null))))) : emptyState('door', 'No invites yet')));
  }

  // ---- Members -------------------------------------------------------------------
  async function members() {
    const d = await api.get('/admin/members');
    const act = async (fn, msg) => { try { await fn(); toast(msg); members(); } catch (e) { toast(e.message, 'error'); } };
    body.replaceChildren(h('div', { class: 'card table-wrap' }, h('table', { class: 'admin-table' },
      h('thead', null, h('tr', null, h('th', null, 'Member'), h('th', null, 'Rank'), h('th', null, 'Status'), h('th', null, ''))),
      h('tbody', null, d.members.map((m) => {
        const self = m.id === store.me.id;
        return h('tr', null,
          h('td', null, m.username, m.role === 'admin' ? h('div', { class: 'muted' }, 'admin') : null),
          h('td', null, `${m.rank} · ${m.xp}`),
          h('td', null, m.status),
          h('td', null, self ? h('span', { class: 'muted' }, 'you') : h('div', { class: 'btn-row' },
            h('button', { class: 'btn', onclick: () => act(() => api.patch(`/admin/members/${m.id}`, { status: m.status === 'active' ? 'suspended' : 'active' }), 'Updated') }, m.status === 'active' ? 'Suspend' : 'Restore'),
            h('button', { class: 'btn', onclick: () => act(() => api.patch(`/admin/members/${m.id}`, { role: m.role === 'admin' ? 'member' : 'admin' }), 'Role updated') }, m.role === 'admin' ? 'Remove admin' : 'Make admin'),
            h('button', { class: 'btn danger', onclick: () => {
              if (confirm(`Delete ${m.username}'s account? Their messages are blanked and their seat is freed. This cannot be undone.`)) {
                act(() => api.post(`/admin/members/${m.id}/delete`), 'Account deleted');
              }
            } }, 'Delete'))));
      })))));
  }

  // ---- Rooms ------------------------------------------------------------------------
  async function rooms() {
    const { rooms: list } = await api.get('/admin/rooms');
    body.replaceChildren(
      h('button', { class: 'btn primary', onclick: () => roomForm(null) }, icon('plus'), 'New room'),
      h('div', { class: 'section card list' }, list.map((r) => h('div', { class: 'row' },
        h('span', { class: `room-ic c-${r.color}` }, icon(r.restricted ? 'lock' : r.icon)),
        h('div', { class: 'grow' }, h('div', { class: 't' }, h('span', null, r.name), r.archived ? h('span', { class: 'pill' }, 'archived') : null),
          h('div', { class: 's' }, r.restricted ? `Restricted · ${r.memberCount} members` : r.description)),
        h('div', { class: 'btn-row' },
          r.restricted ? h('button', { class: 'btn', onclick: () => roomMembers(r) }, 'Members') : null,
          h('button', { class: 'btn', onclick: () => roomForm(r) }, 'Edit'),
          h('button', { class: 'btn', onclick: async () => {
            try { await api.patch(`/admin/rooms/${r.id}`, { archived: !r.archived }); rooms(); } catch (e) { toast(e.message, 'error'); }
          } }, r.archived ? 'Restore' : 'Archive'))))));
  }

  function roomForm(r) {
    const name = h('input', { value: r?.name || '', maxlength: '32', required: true });
    const desc = h('input', { value: r?.description || '', maxlength: '120' });
    const color = h('select', null, COLORS.map((c) => h('option', { value: c, selected: r?.color === c }, c)));
    const ic = h('select', null, ICONS.map((c) => h('option', { value: c, selected: r?.icon === c }, c)));
    const restricted = h('input', { type: 'checkbox' }); restricted.checked = !!r?.restricted;
    const err = h('p', { class: 'form-err' });
    const form = h('form', null, h('h3', null, r ? 'Edit room' : 'New room'), field('Name', name), field('Description', desc), field('Colour', color), field('Icon', ic),
      h('label', { class: 'switch' }, h('span', null, 'Restricted (invite specific members)'), restricted), err,
      h('button', { class: 'btn primary block', type: 'submit' }, 'Save'));
    const close = sheet(form, { label: 'Room' });
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      const payload = { name: name.value, description: desc.value, color: color.value, icon: ic.value, restricted: restricted.checked };
      try { if (r) await api.patch(`/admin/rooms/${r.id}`, payload); else await api.post('/admin/rooms', payload); close(); rooms(); }
      catch (e2) { err.textContent = e2.message; }
    });
  }

  async function roomMembers(r) {
    const box = h('div', null, spinner());
    sheet(h('div', null, h('h3', null, `${r.name} members`), box), { label: 'Room members' });
    const draw = async () => {
      const { members: inRoom } = await api.get(`/admin/rooms/${r.id}/members`);
      const ids = new Set(inRoom.map((m) => m.id));
      box.replaceChildren(h('div', { class: 'list card' }, [...store.members.values()].map((m) => {
        const cb = h('input', { type: 'checkbox', 'aria-label': m.username }); cb.checked = ids.has(m.id);
        cb.addEventListener('change', async () => {
          try { if (cb.checked) await api.put(`/admin/rooms/${r.id}/members/${m.id}`); else await api.del(`/admin/rooms/${r.id}/members/${m.id}`); }
          catch (e) { cb.checked = !cb.checked; toast(e.message, 'error'); }
        });
        return h('label', { class: 'switch' }, h('span', null, m.username), cb);
      })));
    };
    draw().catch((e) => box.replaceChildren(h('p', { class: 'form-err' }, e.message)));
  }

  // ---- XP -------------------------------------------------------------------------
  async function xp() {
    const who = h('select', { required: true }, [...store.members.values()].map((m) => h('option', { value: m.id }, m.username)));
    const amount = h('input', { type: 'number', min: '-500', max: '500', step: '1', value: '25', required: true });
    const note = h('input', { maxlength: '120', required: true, placeholder: 'e.g. Won the Match Day prediction' });
    const err = h('p', { class: 'form-err' });
    const form = h('form', { class: 'card pad' }, h('p', { class: 'muted' }, 'For community events and challenges. Every grant is logged with your name and reason.'),
      field('Member', who), field('XP (−500 to 500)', amount), field('Reason', note), err, h('button', { class: 'btn primary', type: 'submit' }, 'Grant XP'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      try { await api.post('/admin/xp', { userId: Number(who.value), amount: Number(amount.value), note: note.value }); toast('XP granted'); note.value = ''; }
      catch (e2) { err.textContent = e2.message; }
    });
    body.replaceChildren(form);
  }

  // ---- Settings -------------------------------------------------------------------
  async function settings() {
    const s = await api.get('/admin/settings');
    const num = (v, min, max) => h('input', { type: 'number', value: String(v), min: String(min), max: String(max), required: true });
    const room = num(s.roomRetentionDays, 0, 3650);
    const dm = num(s.dmRetentionDays, 0, 3650);
    const ttl = num(s.inviteTtlDays, 1, 30);
    const ranks = h('textarea', { rows: '7' }); ranks.value = s.rankThresholds.map((r) => `${r.name} ${r.minXp}`).join('\n');
    const err = h('p', { class: 'form-err' });
    const form = h('form', { class: 'card pad' },
      h('p', { class: 'muted' }, `Member limit: ${s.memberLimit} (changed only by the server operator).`),
      field('Keep room messages for (days, 0 = until deleted)', room),
      field('Keep direct messages for (days, 0 = until deleted)', dm),
      field('Invite codes expire after (days)', ttl),
      field('Rank thresholds (one per line: Name MinXP)', ranks, 'The first rank must start at 0 and values must increase.'),
      err, h('button', { class: 'btn primary', type: 'submit' }, 'Save settings'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      try {
        const rankThresholds = ranks.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const m = /^(.+?)\s+(\d+)$/.exec(l);
          if (!m) throw new Error(`Can't read “${l}”`);
          return { name: m[1], minXp: Number(m[2]) };
        });
        await api.patch('/admin/settings', { roomRetentionDays: Number(room.value), dmRetentionDays: Number(dm.value), inviteTtlDays: Number(ttl.value), rankThresholds });
        toast('Settings saved');
      } catch (e2) { err.textContent = e2.message; }
    });
    body.replaceChildren(form);
  }

  // ---- Audit log -------------------------------------------------------------------
  async function audit() {
    const { events } = await api.get('/admin/audit');
    body.replaceChildren(h('div', { class: 'card list' }, events.length ? events.map((e) => h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 't' }, h('span', null, e.action)),
        h('div', { class: 's' }, `${e.actor || 'system'}${e.targetType ? ` → ${e.targetType} ${e.targetId}` : ''}`)),
      h('span', { class: 'meta' }, ago(e.createdAt)))) : emptyState('shield', 'Nothing logged yet')));
  }

  drawTabs();
  show();
  return () => {};
}
