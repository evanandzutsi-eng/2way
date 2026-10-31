// Realtime connection. Socket.IO's client is loaded only after sign-in, so the
// login screen stays tiny. Exposes connection state for the UI banner and a
// promise-based emit() that resolves only on a server acknowledgement.

const listeners = new Map();
let socket = null;
let state = 'idle'; // idle | connecting | online | offline
const stateFns = new Set();

function setState(s) {
  if (s === state) return;
  state = s;
  stateFns.forEach((fn) => fn(s));
}

function loadClient() {
  if (window.io) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/socket.io/socket.io.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('socket client failed to load'));
    document.head.append(s);
  });
}

export const rt = {
  get state() { return state; },
  onState(fn) { stateFns.add(fn); return () => stateFns.delete(fn); },

  async connect() {
    if (socket) return;
    setState('connecting');
    try { await loadClient(); } catch { setState('offline'); setTimeout(() => { socket = null; rt.connect(); }, 5000); return; }
    socket = window.io({
      transports: ['websocket', 'polling'],
      withCredentials: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 10000,
    });
    socket.on('connect', () => { setState('online'); this.fire('reconnected', { recovered: socket.recovered }); });
    socket.on('disconnect', () => setState(navigator.onLine ? 'connecting' : 'offline'));
    socket.on('connect_error', () => setState(navigator.onLine ? 'connecting' : 'offline'));
    socket.onAny((event, data) => this.fire(event, data));
    window.addEventListener('offline', () => setState('offline'));
    window.addEventListener('online', () => { if (!socket.connected) { setState('connecting'); socket.connect(); } });
  },

  disconnect() {
    socket?.disconnect();
    socket = null;
    setState('idle');
  },

  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  },

  fire(event, data) { listeners.get(event)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },

  /** Emit with acknowledgement; rejects on server error, timeout or no connection. */
  emit(event, payload, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!socket || !socket.connected) { reject(Object.assign(new Error('Not connected.'), { code: 'offline' })); return; }
      socket.timeout(timeoutMs).emit(event, payload, (err, res) => {
        if (err) return reject(Object.assign(new Error('No response from server.'), { code: 'timeout' }));
        if (!res?.ok) return reject(Object.assign(new Error(res?.error?.message || 'Failed.'), { code: res?.error?.code }));
        resolve(res);
      });
    });
  },

  /** Fire-and-forget (typing, activity). */
  send(event, payload) { if (socket?.connected) socket.emit(event, payload, () => {}); },
};
