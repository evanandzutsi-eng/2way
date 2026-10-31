'use strict';

const express = require('express');
const http = require('../security/http');
const sessions = require('../security/sessions');
const accounts = require('../services/accounts');
const members = require('../services/members');
const rooms = require('../services/rooms');
const dms = require('../services/dms');
const activity = require('../services/activity');
const admin = require('../services/admin');
const presence = require('../services/presence');
const v = require('../lib/validate');
const { notFound } = require('../lib/errors');

const { limits, requireUser, requireAdmin, rateLimit } = http;

const router = express.Router();
const byUser = (req) => `u:${req.user.id}`;

function pageOpts(q) {
  return {
    before: v.optionalId(q.before, 'cursor'),
    after: v.optionalId(q.after, 'cursor'),
    limit: q.limit ? Math.min(50, Math.max(1, parseInt(q.limit, 10) || 40)) : 40,
  };
}

// ---- Auth ------------------------------------------------------------------

router.post('/auth/register', rateLimit(limits.register), async (req, res) => {
  const r = await accounts.register(v.payload(req.body), req.get('user-agent'));
  res.setHeader('Set-Cookie', r.cookie);
  res.status(201).json({ ok: true });
});

// Two limits: per IP+username (stops guessing one account) and a looser
// per-IP cap (stops spraying many accounts), sized so friends sharing a
// carrier-NAT IP don't lock each other out.
const loginKey = (req) => `${req.ip}|${String(req.body?.username || '').toLowerCase().slice(0, 40)}`;
router.post('/auth/login', rateLimit(limits.login, loginKey), rateLimit(limits.loginIp), async (req, res) => {
  const r = await accounts.login(v.payload(req.body), req.get('user-agent'));
  limits.login.reset(loginKey(req)); // successful login clears that account's penalty
  res.setHeader('Set-Cookie', r.cookie);
  res.json({ ok: true });
});

router.post('/auth/logout', async (req, res) => {
  if (req.sessionHash) {
    await sessions.revoke(req.sessionHash);
    // Close only the sockets that belonged to this session.
    await require('../realtime/hub').kickSession(req.user.id, req.sessionHash);
  }
  res.setHeader('Set-Cookie', sessions.clearCookie());
  res.json({ ok: true });
});

router.post('/auth/logout-all', requireUser, async (req, res) => {
  await sessions.revokeAllForUser(null, req.user.id);
  await require('../realtime/hub').kick(req.user.id);
  res.setHeader('Set-Cookie', sessions.clearCookie());
  res.json({ ok: true });
});

router.post('/auth/password', requireUser, rateLimit(limits.sensitive, byUser), async (req, res) => {
  res.json(await accounts.changePassword(req.user, req.sessionHash, v.payload(req.body)));
});

// ---- Me --------------------------------------------------------------------

router.get('/me', requireUser, async (req, res) => res.json(await accounts.me(req.user)));
router.patch('/me/profile', requireUser, async (req, res) => res.json(await accounts.updateProfile(req.user, req.body)));
router.patch('/me/prefs', requireUser, async (req, res) => res.json(await accounts.updatePrefs(req.user, req.body)));
router.post('/me/delete', requireUser, rateLimit(limits.sensitive, byUser), async (req, res) => {
  const body = v.payload(req.body);
  await accounts.deleteAccount(req.user, req.user.id, { password: typeof body.password === 'string' ? body.password : '' });
  res.setHeader('Set-Cookie', sessions.clearCookie());
  res.json({ ok: true });
});

// ---- Lounge (one round trip for the home screen) ----------------------------

router.get('/lounge', requireUser, async (req, res) => {
  const [list, roomList, feed, unread] = await Promise.all([
    members.list(), rooms.listFor(req.user), activity.recent(12), dms.unreadTotal(req.user),
  ]);
  res.json({ members: list, rooms: roomList, activity: feed, unreadDms: unread, onlineNow: presence.onlineCount() });
});

// ---- Members ----------------------------------------------------------------

router.get('/members', requireUser, async (req, res) => res.json({ members: await members.list() }));
router.get('/members/:id', requireUser, async (req, res) => {
  const m = await members.get(v.id(req.params.id, 'member'));
  if (!m) throw notFound('Member not found.');
  res.json(m);
});

// ---- Rooms ------------------------------------------------------------------

router.get('/rooms', requireUser, async (req, res) => res.json({ rooms: await rooms.listFor(req.user) }));
router.get('/rooms/:id', requireUser, async (req, res) => {
  const r = await rooms.assertAccess(req.user, v.id(req.params.id, 'room'));
  res.json(rooms.shapeRoom(r));
});
router.get('/rooms/:id/messages', requireUser, async (req, res) => {
  res.json(await rooms.history(req.user, v.id(req.params.id, 'room'), pageOpts(req.query)));
});
// REST fallback for sending (the client normally uses the socket).
router.post('/rooms/:id/messages', requireUser, rateLimit(limits.message, byUser), async (req, res) => {
  const body = v.payload(req.body);
  res.status(201).json(await rooms.send(req.user, { ...body, roomId: req.params.id }));
});
router.post('/messages/:id/reactions', requireUser, rateLimit(limits.reaction, byUser), async (req, res) => {
  res.json(await rooms.react(req.user, { messageId: req.params.id, emoji: v.payload(req.body).emoji }));
});
router.delete('/messages/:id', requireUser, async (req, res) => res.json(await rooms.remove(req.user, req.params.id)));

// ---- Direct messages ---------------------------------------------------------

router.get('/dms', requireUser, async (req, res) => res.json({ conversations: await dms.list(req.user) }));
router.post('/dms', requireUser, async (req, res) => res.json(await dms.open(req.user, v.payload(req.body).userId)));
router.get('/dms/:id/messages', requireUser, async (req, res) => res.json(await dms.history(req.user, req.params.id, pageOpts(req.query))));
router.post('/dms/:id/messages', requireUser, rateLimit(limits.message, byUser), async (req, res) => {
  res.status(201).json(await dms.send(req.user, { ...v.payload(req.body), conversationId: req.params.id }));
});
router.post('/dms/:id/read', requireUser, async (req, res) => {
  res.json(await dms.markRead(req.user, { conversationId: req.params.id, messageId: v.payload(req.body).messageId }));
});
router.delete('/dm-messages/:id', requireUser, async (req, res) => res.json(await dms.remove(req.user, req.params.id)));

// ---- Admin ------------------------------------------------------------------

const a = express.Router();
a.use(requireAdmin);
a.get('/members', async (req, res) => res.json(await admin.listMembers()));
a.patch('/members/:id', async (req, res) => res.json(await admin.setMemberStatus(req.user, req.params.id, v.payload(req.body))));
a.post('/members/:id/delete', async (req, res) => {
  res.json(await accounts.deleteAccount(req.user, v.id(req.params.id, 'member'), { reason: 'admin' }));
});
a.post('/xp', async (req, res) => res.json(await admin.grantXp(req.user, req.body)));
a.get('/invites', async (req, res) => res.json({ invites: await accounts.listInvites() }));
a.post('/invites', async (req, res) => res.status(201).json(await accounts.createInvite(req.user, v.payload(req.body))));
a.post('/invites/:id/revoke', async (req, res) => res.json(await accounts.revokeInvite(req.user, req.params.id)));
a.get('/rooms', async (req, res) => res.json({ rooms: await admin.listRooms() }));
a.post('/rooms', async (req, res) => res.status(201).json(await admin.createRoom(req.user, req.body)));
a.patch('/rooms/:id', async (req, res) => res.json(await admin.updateRoom(req.user, req.params.id, req.body)));
a.get('/rooms/:id/members', async (req, res) => res.json({ members: await admin.roomMembers(req.params.id) }));
a.put('/rooms/:id/members/:userId', async (req, res) => res.json(await admin.setRoomMember(req.user, req.params.id, req.params.userId, true)));
a.delete('/rooms/:id/members/:userId', async (req, res) => res.json(await admin.setRoomMember(req.user, req.params.id, req.params.userId, false)));
a.get('/settings', async (req, res) => res.json(await admin.getSettings()));
a.patch('/settings', async (req, res) => res.json(await admin.updateSettings(req.user, req.body)));
a.get('/audit', async (req, res) => res.json({ events: await admin.auditLog({ before: v.optionalId(req.query.before, 'cursor') }) }));
router.use('/admin', a);

module.exports = router;
