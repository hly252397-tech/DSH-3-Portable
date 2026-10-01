// One operation contract shared by model tools and the authenticated editor.
export const operations = ['list', 'search', 'read', 'history', 'edit', 'restore', 'sync'];
export const MAX_BODY_BYTES = 600_000;

export async function dispatchManual(store, args, { author = 'model', writable = true, signal } = {}) {
  signal?.throwIfAborted();
  if (!args || typeof args !== 'object' || Array.isArray(args) || !operations.includes(args.operation)) {
    throw Object.assign(new Error('Invalid manual operation'), { code: 'INVALID_OPERATION' });
  }
  const { operation } = args;
  if (['edit', 'restore'].includes(operation) && !writable) {
    throw Object.assign(new Error('Manual editing is disabled'), { code: 'READ_ONLY' });
  }
  if (['edit', 'restore'].includes(operation) && !Object.hasOwn(args, 'expectedRevision')) {
    throw Object.assign(new Error('Read first; expectedRevision is required (null for a new note)'), { code: 'REVISION_REQUIRED' });
  }
  // Never trust a caller-supplied author/status/source/root or executable method name.
  const input = Object.fromEntries(['id', 'query', 'offset', 'limit', 'kind', 'content', 'title', 'expectedRevision', 'revision', 'reason']
    .filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]]));
  if (operation === 'edit' || operation === 'restore') input.author = author;
  if (signal) input.signal = signal;
  const value = operation === 'sync' ? await store.sync(input) : await store[operation](input);
  // Mutations settle before cancellation is reported; no abandoned writes on teardown.
  signal?.throwIfAborted();
  return value;
}

export function safeError(error) {
  const code = /^[A-Z_]{2,60}$/.test(error?.code || '') ? error.code : 'STORAGE_UNAVAILABLE';
  return { code, ...(typeof error?.currentRevision === 'string' ? { currentRevision: error.currentRevision } : {}) };
}

export function trustedManualRequest(req, trustedHosts = []) {
  const authority = req.headers?.host;
  if (typeof authority !== 'string') return false;
  let target;
  try { target = new URL('http://' + authority); } catch { return false; }
  if (target.host !== authority.toLowerCase() || target.username || target.password) return false;
  const loopback = target.hostname === 'localhost' || target.hostname === '[::1]' || /^127(?:\.(?:\d{1,3})){3}$/.test(target.hostname);
  const trusted = trustedHosts.some(entry => {
    try { const url = new URL('http://' + entry); return url.port ? url.host === target.host : url.hostname === target.hostname; } catch { return false; }
  });
  if (!loopback && !trusted) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== target.origin) return false;
  return req.headers['x-dsh-manual'] === '1';
}

export async function readBody(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw Object.assign(new Error('Payload too large'), { code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { code: 'INVALID_JSON' }); }
}
