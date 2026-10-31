import { h, field, icon } from '../dom.js';
import { api } from '../api.js';

export function authView(root, { onSignedIn }) {
  let mode = location.hash.includes('join') ? 'join' : 'login';
  const card = h('div', { class: 'card auth-card' });
  root.append(h('main', { class: 'auth' }, card));

  function draw() {
    const err = h('p', { class: 'form-err', role: 'alert' });
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, mode === 'login' ? 'Sign in' : 'Join 2WaY');
    const username = h('input', { name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, maxlength: '20' });
    const password = h('input', { name: 'password', type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: mode === 'join' ? '10' : null, maxlength: '128' });
    const code = h('input', { name: 'code', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXXX-XXXXX-XXXXX', required: true, maxlength: '20' });

    const form = h('form', { novalidate: true },
      mode === 'join' ? field('Invite code', code, 'From the admin. Each code works once, for one username.') : null,
      field('Username', username, mode === 'join' ? 'Must match the name on your invite.' : null),
      field('Password', password, mode === 'join' ? 'At least 10 characters. A short phrase works well.' : null),
      err, submit);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        if (mode === 'login') {
          await api.post('/auth/login', { username: username.value, password: password.value });
        } else {
          if ([...password.value].length < 10) throw new Error('Use at least 10 characters for your password.');
          await api.post('/auth/register', { inviteCode: code.value, username: username.value, password: password.value });
        }
        password.value = '';
        history.replaceState(null, '', '/#/lounge');
        onSignedIn();
      } catch (e2) {
        err.textContent = e2.message;
        submit.disabled = false;
      }
    });

    const tab = (key, label) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(mode === key),
      onclick: () => { mode = key; draw(); },
    }, label);

    card.replaceChildren(
      h('span', { class: 'wm' }, h('b', null, '2'), 'WaY'),
      h('p', { class: 'tagline' }, 'Your Circle. Your Culture. Your Vibe.'),
      h('div', { class: 'tabs', role: 'tablist' }, tab('login', 'Sign in'), tab('join', 'I have an invite')),
      form,
      h('p', { class: 'muted auth-foot' }, icon('lock', 'i i-sm'), 'Private and invite-only. No public sign-ups.'),
    );
    (mode === 'join' ? code : username).focus();
  }
  draw();
  return () => {};
}
