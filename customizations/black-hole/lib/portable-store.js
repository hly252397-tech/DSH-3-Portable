import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDefaultState, normalizeState } from './core.js';

export const MAX_STORE_BYTES = 12 * 1024 * 1024;

export class StoreError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

export function storageDirectory(config = {}, env = process.env) {
  if (typeof config.dataDirectory === 'string' && config.dataDirectory.trim()) return resolve(config.dataDirectory.trim());
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim()) return join(resolve(env.DSH_HOME), 'workbench', 'black-hole');
  return undefined;
}

function paths(directory) {
  return {
    directory,
    state: join(directory, 'black-holes.json'),
    previous: join(directory, 'black-holes.previous.json'),
    temp: join(directory, 'black-holes.next.json'),
  };
}

function ensureDirectory(directory) {
  if (!directory) throw new StoreError('storage-unconfigured', 503);
  mkdirSync(directory, { recursive: true });
  return paths(directory);
}

function emptyEnvelope() {
  return { revision: 0, data: null };
}

function readEnvelope(directory) {
  const target = paths(directory).state;
  if (!existsSync(target)) return emptyEnvelope();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    throw new StoreError('storage-corrupt', 500);
  }
  if (!parsed || !Number.isInteger(parsed.revision) || parsed.revision < 0 || parsed.revision > 1e9) throw new StoreError('storage-corrupt', 500);
  if (parsed.data === null) return { revision: parsed.revision, data: null };
  try {
    return { revision: parsed.revision, data: normalizeState(parsed.data) };
  } catch {
    throw new StoreError('storage-invalid', 500);
  }
}

function atomicWrite(target, temporary, value) {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  writeFileSync(temporary, serialized, 'utf8');
  try {
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function commit(directory, current, data) {
  const target = paths(directory);
  let normalized;
  try { normalized = normalizeState(data); } catch (error) { throw new StoreError(error.message || 'invalid-data'); }
  const next = { revision: current.revision + 1, data: normalized };
  if (Buffer.byteLength(JSON.stringify(next, null, 2) + '\n', 'utf8') > MAX_STORE_BYTES) throw new StoreError('store-capacity-exceeded', 413);
  const previous = { revision: current.revision, data: current.data };
  if (current.data !== null) atomicWrite(target.previous, `${target.previous}.next`, previous);
  atomicWrite(target.state, target.temp, next);
  return next;
}

export function transactStore(directory, request) {
  const target = ensureDirectory(directory);
  if (!request || typeof request !== 'object') throw new StoreError('invalid-request');
  const action = request.action;
  const current = readEnvelope(directory);
  if (action === 'load') return current;
  if (action === 'migrate') {
    if (current.data !== null) return current;
    const data = request.data === undefined ? createDefaultState() : normalizeState(request.data);
    return commit(directory, current, data);
  }
  if (action === 'save') {
    if (request.revision !== current.revision) throw new StoreError('revision-conflict', 409);
    if (request.data === undefined) throw new StoreError('invalid-data');
    return commit(directory, current, request.data);
  }
  if (action === 'reset') {
    if (request.revision !== current.revision) throw new StoreError('revision-conflict', 409);
    return commit(directory, current, createDefaultState());
  }
  throw new StoreError('unknown-action');
}
