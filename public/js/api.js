// REST client. Same-origin only; cookies carry the session. Every
// state-changing request sends X-Requested-With, which the server requires as
// part of its CSRF defence.

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body !== undefined
        ? { 'Content-Type': 'application/json', 'X-Requested-With': '2way' }
        : { 'X-Requested-With': '2way' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', "Can't reach 2WaY. Check your connection.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error?.code || 'error', data?.error?.message || 'Something went wrong.');
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
};
