'use strict';

const { Server } = require('socket.io');
const config = require('../config');
const sessions = require('../security/sessions');
const hub = require('./hub');
const presence = require('../services/presence');
const rooms = require('../services/rooms');
const dms = require('../services/dms');
const db = require('../db');
const v = require('../lib/validate');
const { limits } = require('../lib/rateLimit');
const { AppError, tooMany } = require('../lib/errors');
const log = require('../lib/log');
const { handshakeOriginOk } = require('../security/origin');

const RECHECK_MS = 5 * 60_000;

function errorPayload(err) {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  log.error('socket handler error', { err: err.message });
  return { code: 'server_error', message: 'Something went wrong on our side.' };
}

function create(httpServer) {
  const io = new Server(httpServer, {
    serveClient: true, // serves /socket.io/socket.io.min.js from the same origin
    maxHttpBufferSize: 16 * 1024, // messages are ≤ 2000 chars; nothing legit is bigger
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,
    // Recover brief drops (e.g. tunnel/elevator) without losing events.
    connectionStateRecovery: { maxDisconnectionDuration: 60_000, skipMiddlewares: false },
    cors: { origin: false }, // same-origin only
    allowRequest: (req, cb) => cb(null, handshakeOriginOk(req.headers, config.appOrigin)),
  });

  // Authenticate every connection from the session cookie.
  io.use(async (socket, next) => {
    try {
      const s = await sessions.resolve(socket.request.headers.cookie);
      if (!s) return next(new Error('unauthorized'));
      socket.data.user = s.user;
      socket.data.tokenHash = s.tokenHash;
      socket.data.checkedAt = Date.now();
      next();
    } catch (err) {
      log.warn('socket auth failed', { err: err.message });
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);
    socket.join('members');

    try {
      const { rows } = await db.query(
        `SELECT COALESCE(p.show_presence, true) AS show, u.last_seen_at
           FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id WHERE u.id = $1`,
        [user.id],
      );
      presence.connected(user.id, rows[0] ? !rows[0].show : false, rows[0]?.last_seen_at);
    } catch {
      presence.connected(user.id, false, null);
    }

    /**
     * Wrap a handler: per-user rate limit, payload shape check, periodic
     * session re-validation, and a uniform { ok, ... } acknowledgement.
     */
    const on = (event, handler, limiter = null) => {
      socket.on(event, async (payload, ack) => {
        if (typeof ack !== 'function') ack = () => {};
        try {
          const general = limits.socketEvent.take(`u:${user.id}`);
          if (!general.ok) throw tooMany(general.retryAfter);
          if (limiter) {
            const r = limiter.take(`u:${user.id}`);
            if (!r.ok) throw tooMany(r.retryAfter);
          }
          if (Date.now() - socket.data.checkedAt > RECHECK_MS) {
            const s = await sessions.resolve(socket.request.headers.cookie);
            if (!s || s.user.id !== user.id) { socket.emit('session:ended'); socket.disconnect(true); return; }
            socket.data.user = s.user;
            socket.data.checkedAt = Date.now();
          }
          const result = await handler(v.payload(payload ?? {}));
          ack({ ok: true, ...(result || {}) });
        } catch (err) {
          ack({ ok: false, error: errorPayload(err) });
        }
      });
    };

    const viewing = () => [...socket.rooms].filter((r) => r.startsWith('room:'));

    async function announceHere(roomId) {
      const ids = await hub.roomViewers(roomId);
      const visible = Object.values(presence.snapshot(ids)).filter((s) => s !== 'offline').length;
      hub.toRoom(roomId, 'room:here', { roomId, count: visible });
    }

    on('room:join', async (p) => {
      const roomId = v.id(p.roomId, 'room');
      await rooms.assertAccess(socket.data.user, roomId); // authorise before subscribing
      for (const r of viewing()) {
        socket.leave(r);
        announceHere(Number(r.slice(5))).catch(() => {});
      }
      socket.join(`room:${roomId}`);
      presence.activity(user.id);
      await announceHere(roomId);
    });

    on('room:leave', async () => {
      for (const r of viewing()) {
        socket.leave(r);
        announceHere(Number(r.slice(5))).catch(() => {});
      }
    });

    on('room:send', async (p) => {
      presence.activity(user.id);
      return { message: await rooms.send(socket.data.user, p) };
    }, limits.message);

    on('room:react', async (p) => rooms.react(socket.data.user, p), limits.reaction);
    on('room:delete', async (p) => rooms.remove(socket.data.user, p.messageId));

    on('dm:send', async (p) => {
      presence.activity(user.id);
      return { message: await dms.send(socket.data.user, p) };
    }, limits.message);

    on('dm:read', async (p) => dms.markRead(socket.data.user, p));

    on('typing', async (p) => {
      if (p.roomId !== undefined) {
        const roomId = v.id(p.roomId, 'room');
        // Only sockets that passed the room:join access check are in the channel.
        if (!socket.rooms.has(`room:${roomId}`)) return;
        hub.toRoom(roomId, 'typing', { roomId, user: { id: user.id, username: user.username } }, socket);
      } else if (p.conversationId !== undefined) {
        const otherId = await dms.otherParticipant(socket.data.user, p.conversationId);
        if (!otherId) return;
        hub.toUser(otherId, 'typing', { conversationId: Number(p.conversationId), user: { id: user.id, username: user.username } });
      }
    }, limits.typing);

    on('active', async () => { presence.activity(user.id); });

    socket.on('disconnecting', () => {
      const left = viewing();
      setImmediate(() => left.forEach((r) => announceHere(Number(r.slice(5))).catch(() => {})));
    });
    socket.on('disconnect', () => presence.disconnected(user.id));
  });

  hub.attach(io);
  return io;
}

module.exports = { create };
