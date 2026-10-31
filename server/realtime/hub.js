'use strict';

// Thin indirection so services can push realtime events without importing
// Socket.IO directly (and so tests can run services without a socket server).
//
// Channel naming:
//   user:<id>  every socket of one member (DMs, personal notices)
//   room:<id>  sockets currently viewing a room (joined only after an access check)
//   members    every authenticated socket (presence, activity, room list changes)

let io = null;

function attach(server) { io = server; }

function toUser(userId, event, data) { io?.to(`user:${userId}`).emit(event, data); }
function toUsers(userIds, event, data) { if (io && userIds.length) io.to(userIds.map((id) => `user:${id}`)).emit(event, data); }
function toRoom(roomId, event, data, exceptSocket) {
  if (!io) return;
  (exceptSocket ? exceptSocket.to(`room:${roomId}`) : io.to(`room:${roomId}`)).emit(event, data);
}
function toMembers(event, data) { io?.to('members').emit(event, data); }

/** Disconnect sockets for a user (optionally keeping one session alive). */
async function kick(userId, exceptTokenHash = null) {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    if (exceptTokenHash && s.data.tokenHash && s.data.tokenHash.equals(exceptTokenHash)) continue;
    s.emit('session:ended');
    s.disconnect(true);
  }
}

/** Disconnect only the sockets opened with one session token. */
async function kickSession(userId, tokenHash) {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    if (s.data.tokenHash && s.data.tokenHash.equals(tokenHash)) { s.emit('session:ended'); s.disconnect(true); }
  }
}

/** Remove every socket of a user from a room channel (e.g. access revoked). */
async function evictFromRoom(userId, roomId) {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) s.leave(`room:${roomId}`);
}

/** Sockets currently in a room channel → distinct user ids. */
async function roomViewers(roomId) {
  if (!io) return [];
  const sockets = await io.in(`room:${roomId}`).fetchSockets();
  return [...new Set(sockets.map((s) => s.data.user.id))];
}

module.exports = { attach, toUser, toUsers, toRoom, toMembers, kick, kickSession, evictFromRoom, roomViewers };
