// Stable, plugin-owned preferences. Importing this module performs no disk I/O.
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_PREFERENCES_BYTES = 32 * 1024;
export const DEFAULT_PREFS = Object.freeze({
  sites: Object.freeze([]), radiusKm: 300, minMagnitude: 4, alertWindowSeconds: 180, sound: false,
});

export function preferenceError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function onlyKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))
    || keys.some(key => !Object.hasOwn(value, key))) {
    throw preferenceError('INVALID_PREFERENCES', '偏好字段不完整或包含未知字段。');
  }
}

function number(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw preferenceError('INVALID_PREFERENCES', '偏好数值超出允许范围。');
  }
  return value;
}

export function validatePreferences(value) {
  onlyKeys(value, ['sites', 'radiusKm', 'minMagnitude', 'alertWindowSeconds', 'sound']);
  if (!Array.isArray(value.sites) || value.sites.length > 20 || typeof value.sound !== 'boolean') {
    throw preferenceError('INVALID_PREFERENCES', '最多配置20个地点，声音开关必须是布尔值。');
  }
  const names = new Set();
  const coordinates = new Set();
  const sites = value.sites.map(site => {
    onlyKeys(site, ['name', 'latitude', 'longitude']);
    if (typeof site.name !== 'string' || !site.name.trim() || site.name.length > 40
      || /[\x00-\x1f\x7f]/u.test(site.name)) {
      throw preferenceError('INVALID_PREFERENCES', '地点名称应为1至40个有效字符。');
    }
    const normalized = {
      name: site.name.trim().normalize('NFC'), latitude: number(site.latitude, -90, 90), longitude: number(site.longitude, -180, 180),
    };
    const key = normalized.name.toLowerCase();
    const location = `${normalized.latitude},${normalized.longitude === 180 ? -180 : normalized.longitude}`;
    if (names.has(key) || coordinates.has(location)) throw preferenceError('INVALID_PREFERENCES', '地点名称或坐标重复，未保存。');
    names.add(key); coordinates.add(location);
    return normalized;
  });
  return {
    sites, radiusKm: number(value.radiusKm, 10, 2000), minMagnitude: number(value.minMagnitude, 0, 10),
    alertWindowSeconds: number(value.alertWindowSeconds, 30, 3600), sound: value.sound,
  };
}

const encode = prefs => JSON.stringify({ schema: 1, prefs }, null, 2) + '\n';
const revision = text => createHash('sha256').update(text).digest('hex');
const defaultText = encode(DEFAULT_PREFS);

export function resolvePreferencesFile(environment = process.env) {
  const portable = environment.DSH_PORTABLE_ROOT;
  const home = environment.DSH_HOME;
  const root = portable || home;
  if (typeof root !== 'string' || !path.isAbsolute(root) || /[\x00-\x1f]/u.test(root)) {
    throw preferenceError('PREFERENCES_UNAVAILABLE', '缺少明确的便携根目录或DSH家园，不能保存地点。', 503);
  }
  return portable
    ? path.join(path.resolve(root), 'Data', 'Plugins', 'dsh-earthquake-alert', 'preferences.json')
    : path.join(path.resolve(root), 'plugins', 'dsh-earthquake-alert', 'preferences.json');
}

async function safeDirectory(directory, create) {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const anchor = await fs.lstat(current);
  if (anchor.isSymbolicLink() || !anchor.isDirectory()) throw preferenceError('UNSAFE_PREFERENCES_PATH', '偏好目录必须是普通目录，不能使用链接。', 503);
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await fs.mkdir(current); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw preferenceError('UNSAFE_PREFERENCES_PATH', '偏好目录必须是普通目录，不能使用链接。', 503);
    }
  }
  return true;
}

async function readStored(file) {
  if (!await safeDirectory(path.dirname(file), false)) {
    return { revision: revision(defaultText), persisted: false, prefs: validatePreferences(DEFAULT_PREFS) };
  }
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { revision: revision(defaultText), persisted: false, prefs: validatePreferences(DEFAULT_PREFS) };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw preferenceError('UNSAFE_PREFERENCES_PATH', '偏好文件必须是普通文件，不能使用链接。', 503);
  }
  if (stat.size > MAX_PREFERENCES_BYTES) throw preferenceError('PREFERENCES_TOO_LARGE', '偏好文件过大，未读取或覆盖。', 503);
  const handle = await fs.open(file, 'r');
  let raw;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw preferenceError('PREFERENCES_BUSY', '偏好文件正在改变，请重新读取。', 409);
    }
    const buffer = Buffer.alloc(MAX_PREFERENCES_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_PREFERENCES_BYTES) throw preferenceError('PREFERENCES_TOO_LARGE', '偏好文件过大，未读取或覆盖。', 503);
    raw = buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
  await safeDirectory(path.dirname(file), false);
  const after = await fs.lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) {
    throw preferenceError('PREFERENCES_BUSY', '偏好文件正在改变，请重新读取。', 409);
  }
  let value;
  try {
    value = JSON.parse(raw);
    onlyKeys(value, ['schema', 'prefs']);
    if (value.schema !== 1) throw new Error('schema');
    value = validatePreferences(value.prefs);
  } catch {
    throw preferenceError('INVALID_STORED_PREFERENCES', '已保存的偏好无效，保留原文件且不会自动覆盖。', 503);
  }
  return { revision: revision(raw), persisted: true, prefs: value };
}

export function createPreferencesStore(environment = process.env) {
  let file, pathError;
  try { file = resolvePreferencesFile(environment); } catch (error) { pathError = error; }
  let closed = false;
  let writing = false;
  const tasks = new Set();
  const available = () => {
    if (closed) throw preferenceError('UNAVAILABLE', '插件正在卸载。', 503);
    if (pathError) throw pathError;
  };
  const publicError = error => error.code?.startsWith('PREFERENCES_') || ['UNAVAILABLE', 'REVISION_CONFLICT', 'INVALID_PREFERENCES', 'INVALID_STORED_PREFERENCES', 'UNSAFE_PREFERENCES_PATH'].includes(error.code)
    ? error : preferenceError('PREFERENCES_IO_ERROR', '偏好文件无法读取或保存，原有设置保持不变。', 503);

  const read = () => {
    available();
    const task = readStored(file).catch(error => { throw publicError(error); });
    tasks.add(task);
    task.then(() => tasks.delete(task), () => tasks.delete(task));
    return task;
  };

  const save = request => {
    available();
    onlyKeys(request, ['revision', 'prefs']);
    if (typeof request.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(request.revision)) {
      throw preferenceError('INVALID_PREFERENCES', '保存需要当前偏好修订号。');
    }
    const prefs = validatePreferences(request.prefs);
    if (writing) throw preferenceError('PREFERENCES_BUSY', '已有保存操作正在进行，请稍后重试。', 409);
    writing = true;
    const task = (async () => {
      let lock, temporary, lockIdentity, temporaryIdentity;
      const lockFile = file + '.lock';
      const nonce = randomUUID();
      try {
        await safeDirectory(path.dirname(file), true);
        const directoryIdentity = await fs.lstat(path.dirname(file));
        try { lock = await fs.open(lockFile, 'wx', 0o600); }
        catch (error) {
          if (error.code === 'EEXIST') throw preferenceError('PREFERENCES_BUSY', '偏好正在被另一实例保存，请稍后重试。', 409);
          throw error;
        }
        lockIdentity = await lock.stat();
        await lock.writeFile(nonce, 'utf8');
        const before = await readStored(file);
        if (before.revision !== request.revision) throw preferenceError('REVISION_CONFLICT', '偏好已被其他页面修改，请重新读取，未覆盖。', 409);
        if (closed) throw preferenceError('UNAVAILABLE', '插件正在卸载，保存已取消。', 503);
        const raw = encode(prefs);
        if (Buffer.byteLength(raw) > MAX_PREFERENCES_BYTES) throw preferenceError('PREFERENCES_TOO_LARGE', '偏好内容超出保存上限。');
        temporary = path.join(path.dirname(file), `.preferences-${nonce}.tmp`);
        const output = await fs.open(temporary, 'wx', 0o600);
        try { temporaryIdentity = await output.stat(); await output.writeFile(raw, 'utf8'); await output.sync(); } finally { await output.close(); }
        await safeDirectory(path.dirname(file), false);
        const directoryAfter = await fs.lstat(path.dirname(file));
        if (directoryAfter.dev !== directoryIdentity.dev || directoryAfter.ino !== directoryIdentity.ino) {
          throw preferenceError('UNSAFE_PREFERENCES_PATH', '偏好目录正在改变，未提交。', 503);
        }
        const current = await readStored(file);
        if (current.revision !== before.revision || current.persisted !== before.persisted) {
          throw preferenceError('REVISION_CONFLICT', '偏好已被其他页面修改，请重新读取，未覆盖。', 409);
        }
        if (closed) throw preferenceError('UNAVAILABLE', '插件正在卸载，保存已取消。', 503);
        await fs.rename(temporary, file);
        temporary = undefined;
        return { revision: revision(raw), persisted: true, prefs };
      } catch (error) { throw publicError(error); }
      finally {
        if (temporary) {
          // Only our individually named ordinary temporary file; never recurse or follow links.
          try { await safeDirectory(path.dirname(file), false); const stat = await fs.lstat(temporary); if (stat.isFile() && !stat.isSymbolicLink() && temporaryIdentity && stat.dev === temporaryIdentity.dev && stat.ino === temporaryIdentity.ino) await fs.unlink(temporary); } catch {}
        }
        if (lock) {
          try { await lock.close(); } catch {}
          try {
            await safeDirectory(path.dirname(file), false);
            const stat = await fs.lstat(lockFile);
            if (stat.isFile() && !stat.isSymbolicLink() && lockIdentity && stat.dev === lockIdentity.dev && stat.ino === lockIdentity.ino && stat.size === nonce.length && await fs.readFile(lockFile, 'utf8') === nonce) await fs.unlink(lockFile);
          } catch {}
        }
        writing = false;
      }
    })();
    tasks.add(task);
    task.then(() => tasks.delete(task), () => tasks.delete(task));
    return task;
  };

  return { read, save, async close() { closed = true; await Promise.allSettled([...tasks]); } };
}
