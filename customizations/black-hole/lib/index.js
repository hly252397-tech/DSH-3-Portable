import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import Schema from 'schemastery';
import { MAX_STORE_BYTES, StoreError, storageDirectory, transactStore } from './portable-store.js';

export const name = 'dsh-black-hole';
export const inject = ['webServer', 'webRuntime'];

export const Config = Schema.object({
  dataDirectory: Schema.string().default('').description('黑洞资料绝对存储目录；留空使用 DSH_HOME/workbench/black-hole。'),
});

function header(headers, key) {
  const value = headers?.[key];
  return typeof value === 'string' ? value : undefined;
}

function parseAuthority(authority) {
  try { return new URL('http://' + authority); } catch { return undefined; }
}

function isLoopback(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function isTrustedRequest(req, trustedHosts = []) {
  const authority = header(req.headers, 'host');
  const hostUrl = authority ? parseAuthority(authority) : undefined;
  if (!hostUrl) return false;
  const trusted = trustedHosts.some((entry) => {
    const parsed = parseAuthority(entry);
    return parsed && (parsed.port === '' ? parsed.hostname === hostUrl.hostname : parsed.host === hostUrl.host);
  });
  if (!isLoopback(hostUrl.hostname) && !trusted) return false;
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(req.headers, 'origin');
  if (origin === undefined) return true;
  try { return new URL(origin).hostname === hostUrl.hostname; } catch { return false; }
}

function writeJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_STORE_BYTES) throw new StoreError('payload-too-large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new StoreError('invalid-json'); }
}

function errorPayload(error) {
  return { ok: false, error: { code: error instanceof StoreError ? error.code : 'storage-unavailable' } };
}

export function apply(ctx, config = { dataDirectory: '' }) {
  if (config.dataDirectory && (!isAbsolute(config.dataDirectory) || !existsSync(resolve(config.dataDirectory)))) {
    if (config.dataDirectory && !isAbsolute(config.dataDirectory)) throw new Error('dataDirectory must be absolute');
  }
  ctx.effect(() => {
    let disposed = false;
    const pending = new Set();
    const requests = new Set();
    const unregister = ctx.webServer.register({
      kind: 'exact',
      path: '/black-hole/api/store',
      handler: (req, res) => {
        const task = (async () => {
          const timer = setTimeout(() => req.destroy(), 15000);
          requests.add(req);
          try {
            if (disposed) throw new StoreError('storage-unavailable', 503);
            if (!isTrustedRequest(req, ctx.webRuntime.trustedHosts)) throw new StoreError('forbidden', 403);
            const connection = ctx.get('connection');
            if (typeof connection?.requestRejection !== 'function') throw new StoreError('authorization-unavailable', 503);
            if (connection?.requestRejection) {
              const rejection = connection.requestRejection(req);
              if (rejection) throw new StoreError('forbidden', 403);
            }
            if (req.method !== 'POST') throw new StoreError('method-not-allowed', 405);
            if (header(req.headers, 'x-dsh-black-hole') !== '1') throw new StoreError('missing-plugin-header', 415);
            if (!/^application\/json(?:;|$)/i.test(header(req.headers, 'content-type') || '')) throw new StoreError('invalid-content-type', 415);
            const origin = header(req.headers, 'origin');
            const host = header(req.headers, 'host');
            if (origin && host && origin !== 'http://' + host) throw new StoreError('forbidden', 403);
            const body = await readJson(req);
            if (disposed || req.aborted) throw new StoreError('storage-unavailable', 503);
            const result = transactStore(storageDirectory(config), body);
            writeJson(res, 200, { ok: true, value: result });
          } catch (error) {
            if (!res.destroyed && !res.writableEnded) writeJson(res, error instanceof StoreError ? error.status : 503, errorPayload(error));
          } finally {
            clearTimeout(timer);
            requests.delete(req);
          }
        })();
        pending.add(task);
        task.then(() => pending.delete(task), () => pending.delete(task));
        return task;
      },
    });
    return async () => {
      disposed = true;
      unregister();
      for (const req of requests) req.destroy();
      await Promise.allSettled([...pending]);
    };
  }, 'dsh-black-hole: portable storage route');
}
