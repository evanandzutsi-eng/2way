import { h, icon, avatar, rankBadge, field, sheet, toast } from '../dom.js';
import { api } from '../api.js';
import { store, refreshMe, applyTheme, signedOut } from '../app.js';
import { topbar } from './common.js';

export function profileView(root) {
  const main = h('main', { class: 'main' });
  root.append(topbar(h('h1', { class: 'grow' }, 'Profile')), main);

  function draw() {
    const me = store.me;
    if (!me) return;
    const r = me.rank;
    const fill = h('i');
    fill.style.width = `${Math.round(r.progress * 100)}%`;

    const status = h('input', { class: 'input', value: me.status, maxlength: '80', placeholder: 'What are you on today?', 'aria-label': 'Status message' });
    const saveStatus = h('button', { class: 'btn', type: 'submit' }, 'Save');
    const statusForm = h('form', { class: 'search-box' }, status, saveStatus);
    statusForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      saveStatus.disabled = true;
      try { store.me = await api.patch('/me/profile', { status: status.value }); store.emit('me'); toast('Status saved'); }
      catch (err) { toast(err.message, 'error'); }
      saveStatus.disabled = false;
    });

    const toggle = (key, label, hint) => {
      const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label });
      input.checked = !!me.prefs[key];
      input.addEventListener('change', async () => {
        try { store.me = await api.patch('/me/prefs', { [key]: input.checked }); }
        catch (err) { input.checked = !input.checked; toast(err.message, 'error'); }
      });
      return h('label', { class: 'switch' }, h('span', null, h('span', null, label), h('br'), h('span', { class: 's' }, hint)), input);
    };

    const theme = h('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Light theme' });
    theme.checked = me.prefs.theme === 'light';
    theme.addEventListener('change', async () => {
      const t = theme.checked ? 'light' : 'dark';
      applyTheme(t); // instant, no reload
      try { store.me = await api.patch('/me/prefs', { theme: t }); } catch (err) { toast(err.message, 'error'); }
    });

    main.replaceChildren(
      h('section', { class: 'card profile-hero' },
        avatar(me.avatar, 96),
        h('button', { class: 'btn', onclick: reroll }, icon('refresh'), 'New avatar'),
        h('h2', null, me.username),
        rankBadge(r.name, r.index),
        h('div', { class: 'xp-detail' },
          h('div', { class: 'xpbar', role: 'progressbar', 'aria-valuenow': Math.round(r.progress * 100), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Progress to next rank' }, fill),
          h('p', null, r.nextName ? `${me.xp} XP · ${r.nextMinXp - me.xp} to ${r.nextName}` : `${me.xp} XP · You've reached the top rank`))),

      h('section', { class: 'section' }, h('div', { class: 'section-h' }, h('h2', null, 'Status')), statusForm),

      h('section', { class: 'section' }, h('div', { class: 'section-h' }, h('h2', null, 'Achievements'),
        h('span', { class: 'pill' }, `${me.achievements.filter((a) => a.earnedAt).length}/${me.achievements.length}`)),
        h('div', { class: 'ach' }, me.achievements.map((a) => h('div', { class: `card${a.earnedAt ? '' : ' locked'}` },
          h('span', { class: 'ic' }, icon(a.earnedAt ? a.icon : 'lock', 'i i-sm')),
          h('div', null, h('b', null, a.name), h('span', null, a.description)))))),

      h('section', { class: 'section' }, h('div', { class: 'section-h' }, h('h2', null, 'Ranks')),
        h('div', { class: 'card pad' }, h('div', { class: 'btn-row' }, me.ranks.map((x, i) => h('span', null, rankBadge(x.name, i, true), h('small', { class: 'muted' }, ` ${x.minXp}+`)))),
          h('p', { class: 'muted' }, h('small', null, 'Earn XP by showing up each day, getting reactions from mates, unlocking achievements and joining community events. Posting more messages does not earn more XP.')))),

      h('section', { class: 'section' }, h('div', { class: 'section-h' }, h('h2', null, 'Preferences')),
        h('div', { class: 'card' },
          h('label', { class: 'switch' }, h('span', null, h('span', null, 'Light theme'), h('br'), h('span', { class: 's' }, 'Dark is the default')), theme),
          toggle('showPresence', 'Show when I’m online', 'Off: everyone sees you as offline'),
          toggle('readReceipts', 'Read receipts in DMs', 'Off: you won’t send or see “Seen”'),
          toggle('showInActivity', 'Show me in Recent Activity', 'Rank-ups and achievements in the lounge feed'))),

      h('section', { class: 'section' }, h('div', { class: 'section-h' }, h('h2', null, 'Privacy & your data')),
        h('div', { class: 'card policy' },
          h('p', null, `Room messages are kept for ${days(me.policy.roomRetentionDays)}, direct messages for ${days(me.policy.dmRetentionDays)}, then deleted automatically.`),
          h('p', null, 'Direct messages can only be opened by the two people in them. Admins can remove room messages and manage members, but the app gives no one — admins included — a way to read your DMs.'),
          h('p', null, 'Deleting a message removes its text for everyone. Encrypted backups are kept for up to 14 days, so deleted content can survive in a backup until it rotates out.'),
          h('p', null, 'Deleting your account removes your profile, XP and achievements and blanks every message you sent. A record that an account existed stays in the admin audit log.'))),

      me.isAdmin ? h('section', { class: 'section' }, h('a', { class: 'btn block', href: '#/admin' }, icon('shield'), 'Admin panel')) : null,

      h('section', { class: 'section stack' },
        h('div', { class: 'section-h' }, h('h2', null, 'Account')),
        h('button', { class: 'btn block', onclick: changePassword }, icon('lock'), 'Change password'),
        h('button', { class: 'btn block', onclick: () => logout('/auth/logout') }, icon('logout'), 'Sign out'),
        h('button', { class: 'btn block', onclick: () => logout('/auth/logout-all') }, icon('logout'), 'Sign out on all devices'),
        h('button', { class: 'btn danger block', onclick: deleteAccount }, icon('trash'), 'Delete my account')),
    );
  }

  const days = (n) => (n ? `${n} days` : 'until deleted');

  async function reroll() {
    try { store.me = await api.patch('/me/profile', { newAvatar: true }); store.emit('me'); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function logout(path) {
    try { await api.post(path); } catch { /* signing out locally regardless */ }
    signedOut();
  }

  function changePassword() {
    const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: '10', required: true });
    const err = h('p', { class: 'form-err', role: 'alert' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Update password');
    const form = h('form', null, h('h3', null, 'Change password'), field('Current password', cur), field('New password', next, 'At least 10 characters. Other devices will be signed out.'), err, btn);
    const close = sheet(form, { label: 'Change password' });
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); btn.disabled = true; err.textContent = '';
      try { await api.post('/auth/password', { currentPassword: cur.value, newPassword: next.value }); close(); toast('Password updated'); }
      catch (e2) { err.textContent = e2.message; btn.disabled = false; }
    });
    cur.focus();
  }

  function deleteAccount() {
    const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const err = h('p', { class: 'form-err', role: 'alert' });
    const btn = h('button', { class: 'btn danger block', type: 'submit' }, 'Delete my account permanently');
    const form = h('form', null, h('h3', null, 'Delete your account?'),
      h('p', { class: 'muted' }, 'This frees your seat, removes your profile, XP and achievements, and blanks every message you sent. It cannot be undone.'),
      field('Confirm with your password', pw), err, btn);
    const close = sheet(form, { label: 'Delete account' });
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); btn.disabled = true; err.textContent = '';
      try { await api.post('/me/delete', { password: pw.value }); close(); signedOut(); }
      catch (e2) { err.textContent = e2.message; btn.disabled = false; }
    });
    pw.focus();
  }

  draw();
  refreshMe().then(draw).catch(() => {});
  return store.on('me', draw);
}
