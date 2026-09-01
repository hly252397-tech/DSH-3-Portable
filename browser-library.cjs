'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHROME_EPOCH_MS = Date.UTC(1601, 0, 1);
const MAX_HISTORY = 5000;
const DEFAULT_HOMEPAGES = Object.freeze([
  'https://deepseek.com/en/',
  'https://chat.deepseek.com/'
]);

function normalizeHomepages(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/[\r\n,]+/);
  const normalized = [];
  for (const entry of entries) {
    const input = String(entry || '').trim();
    if (!input) continue;
    try {
      const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`;
      const parsed = new URL(candidate);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      const url = parsed.toString();
      if (!normalized.includes(url)) normalized.push(url);
      if (normalized.length >= 8) break;
    } catch {}
  }
  return normalized.length ? normalized : [...DEFAULT_HOMEPAGES];
}

function createBrowserLibrary({ safeStorage, browserDataRoot, stateRoot, appendLog }) {
  const libraryPath = path.join(browserDataRoot, 'library.json');
  const extensionsRoot = path.join(browserDataRoot, 'extensions');
  const backupRoot = path.join(stateRoot, 'browser-import-backups');
  fs.mkdirSync(extensionsRoot, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });

  const defaults = () => ({
    version: 1,
    history: [],
    bookmarks: [],
    credentials: [],
    autofill: [],
    extensions: [],
    pendingImport: null,
    lastImport: null,
    settings: { historyEnabled: true, autoRetryImport: true, loadExtensions: true, homepages: [...DEFAULT_HOMEPAGES] }
  });

  function load() {
    try {
      if (!fs.existsSync(libraryPath)) return defaults();
      const baseline = defaults();
      const stored = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
      return {
        ...baseline,
        ...stored,
        settings: {
          ...baseline.settings,
          ...(stored.settings || {}),
          homepages: normalizeHomepages(stored.settings?.homepages)
        }
      };
    } catch (error) {
      appendLog(`Browser library ignored: ${error.message}`);
      return defaults();
    }
  }

  let data = load();

  function save() {
    const temporary = `${libraryPath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, libraryPath);
  }

  function backup(reason) {
    if (!fs.existsSync(libraryPath)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(backupRoot, `${stamp}-${String(reason || 'change').replace(/[^a-z0-9_-]/gi, '-')}.json`);
    fs.copyFileSync(libraryPath, destination);
    return destination;
  }

  function publicSnapshot() {
    return {
      history: data.history.slice(0, 500),
      bookmarks: data.bookmarks.slice(),
      credentials: data.credentials.map(({ id, origin, username, label, createdAt, updatedAt, importedFrom }) => ({ id, origin, username, label, createdAt, updatedAt, importedFrom })),
      autofill: data.autofill.slice(),
      extensions: data.extensions.map(({ id, name, version, enabled, source, error }) => ({ id, name, version, enabled, source, error })),
      pendingImport: data.pendingImport,
      lastImport: data.lastImport,
      settings: { ...data.settings, homepages: normalizeHomepages(data.settings?.homepages) },
      encryptionAvailable: Boolean(safeStorage.isEncryptionAvailable()),
      sources: detectSources()
    };
  }

  function recordHistory(url, title, favicon = '') {
    if (!data.settings.historyEnabled || !/^https?:\/\//i.test(url || '')) return;
    const now = new Date().toISOString();
    const existing = data.history.find((entry) => entry.url === url);
    if (existing) {
      existing.title = title || existing.title;
      existing.favicon = favicon || existing.favicon || '';
      existing.lastVisitAt = now;
      existing.visitCount = Number(existing.visitCount || 0) + 1;
    } else {
      data.history.unshift({ id: crypto.randomUUID(), url, title: title || url, favicon: favicon || '', lastVisitAt: now, visitCount: 1 });
    }
    data.history.sort((a, b) => String(b.lastVisitAt).localeCompare(String(a.lastVisitAt)));
    data.history.splice(MAX_HISTORY);
    save();
  }

  function toggleBookmark(entry) {
    const url = String(entry?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('只能收藏 HTTP 或 HTTPS 页面。');
    const index = data.bookmarks.findIndex((item) => item.url === url);
    if (index >= 0) data.bookmarks.splice(index, 1);
    else data.bookmarks.unshift({ id: crypto.randomUUID(), url, title: String(entry?.title || url), favicon: String(entry?.favicon || ''), createdAt: new Date().toISOString() });
    save();
    return index < 0;
  }

  function remove(kind, id) {
    const key = kind === 'history' ? 'history' : kind === 'bookmark' ? 'bookmarks' : kind === 'credential' ? 'credentials' : null;
    if (!key) return false;
    const before = data[key].length;
    data[key] = data[key].filter((entry) => entry.id !== id);
    if (data[key].length !== before) save();
    return data[key].length !== before;
  }

  function clear(kind) {
    const key = kind === 'history' ? 'history' : kind === 'bookmarks' ? 'bookmarks' : kind === 'credentials' ? 'credentials' : null;
    if (!key) return false;
    backup(`clear-${key}`);
    data[key] = [];
    save();
    return true;
  }

  function encryptSecret(value) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储当前不可用，未保存密码。');
    return safeStorage.encryptString(String(value || '')).toString('base64');
  }

  function decryptSecret(value) {
    return safeStorage.decryptString(Buffer.from(String(value || ''), 'base64'));
  }

  function saveCredential(input) {
    const origin = new URL(String(input?.origin || '')).origin;
    const username = String(input?.username || '').trim();
    const password = String(input?.password || '');
    if (!password) throw new Error('密码不能为空。');
    const now = new Date().toISOString();
    const existing = data.credentials.find((entry) => entry.id === input?.id || (entry.origin === origin && entry.username === username));
    if (existing) Object.assign(existing, { origin, username, label: String(input?.label || ''), secret: encryptSecret(password), updatedAt: now });
    else data.credentials.unshift({ id: crypto.randomUUID(), origin, username, label: String(input?.label || ''), secret: encryptSecret(password), createdAt: now, updatedAt: now });
    save();
    return true;
  }

  function credentialSecret(id) {
    const entry = data.credentials.find((item) => item.id === id);
    if (!entry) throw new Error('未找到该密码记录。');
    return { ...entry, password: decryptSecret(entry.secret) };
  }

  function setSettings(patch) {
    const next = { ...(patch || {}) };
    if (Object.prototype.hasOwnProperty.call(next, 'homepages')) next.homepages = normalizeHomepages(next.homepages);
    data.settings = { ...data.settings, ...next, homepages: normalizeHomepages(next.homepages ?? data.settings?.homepages) };
    save();
    return { ...data.settings };
  }

  function detectSources() {
    // DSH 会把 LOCALAPPDATA 重定向到移动盘；浏览器迁移必须读取真实 Windows 用户配置。
    const hostProfile = `${process.env.HOMEDRIVE || ''}${process.env.HOMEPATH || ''}`;
    const local = hostProfile ? path.join(hostProfile, 'AppData', 'Local') : (process.env.LOCALAPPDATA || '');
    const candidates = [
      {
        id: 'codex', name: 'Codex 浏览器',
        profile: path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Roaming', 'Codex', 'web', 'Codex', 'Default', 'Partitions', 'codex-browser-app'),
        localState: path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Roaming', 'Codex', 'web', 'Codex', 'Local State')
      },
      { id: 'edge', name: 'Microsoft Edge', profile: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default'), localState: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Local State') },
      { id: 'chrome', name: 'Google Chrome', profile: path.join(local, 'Google', 'Chrome', 'User Data', 'Default'), localState: path.join(local, 'Google', 'Chrome', 'User Data', 'Local State') }
    ];
    return candidates.map((source) => ({ ...source, available: fs.existsSync(path.join(source.profile, 'History')) }));
  }

  function sourceById(id) {
    const source = detectSources().find((entry) => entry.id === id && entry.available);
    if (!source) throw new Error('未找到可迁移的浏览器配置。');
    return source;
  }

  function chromiumTime(value) {
    const numeric = Number(value || 0);
    return numeric > 0 ? new Date(CHROME_EPOCH_MS + numeric / 1000).toISOString() : null;
  }

  function openSqlite(file) {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(file, { readOnly: true });
  }

  function importHistory(source) {
    const db = openSqlite(path.join(source.profile, 'History'));
    try {
      const statement = db.prepare('SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT 5000');
      statement.setReadBigInts(true);
      const rows = statement.all();
      let imported = 0;
      for (const row of rows) {
        if (!/^https?:\/\//i.test(row.url || '')) continue;
        const when = chromiumTime(row.last_visit_time) || new Date().toISOString();
        const existing = data.history.find((entry) => entry.url === row.url);
        if (existing) {
          if (when > String(existing.lastVisitAt || '')) existing.lastVisitAt = when;
          existing.title = row.title || existing.title;
          existing.visitCount = Math.max(Number(existing.visitCount || 0), Number(row.visit_count || 1));
        } else {
          data.history.push({ id: crypto.randomUUID(), url: row.url, title: row.title || row.url, favicon: '', lastVisitAt: when, visitCount: Number(row.visit_count || 1), importedFrom: source.id });
          imported += 1;
        }
      }
      data.history.sort((a, b) => String(b.lastVisitAt).localeCompare(String(a.lastVisitAt)));
      data.history.splice(MAX_HISTORY);
      return imported;
    } finally { db.close(); }
  }

  function walkBookmark(node, output) {
    if (!node) return;
    if (node.type === 'url' && /^https?:\/\//i.test(node.url || '')) output.push({ url: node.url, title: node.name || node.url });
    for (const child of Array.isArray(node.children) ? node.children : []) walkBookmark(child, output);
  }

  function importBookmarks(source) {
    const file = path.join(source.profile, 'Bookmarks');
    if (!fs.existsSync(file)) return 0;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const found = [];
    for (const root of Object.values(parsed.roots || {})) walkBookmark(root, found);
    let imported = 0;
    for (const item of found) {
      if (data.bookmarks.some((entry) => entry.url === item.url)) continue;
      data.bookmarks.push({ id: crypto.randomUUID(), ...item, favicon: '', createdAt: new Date().toISOString(), importedFrom: source.id });
      imported += 1;
    }
    return imported;
  }

  function unprotectDpapi(buffer) {
    return new Promise((resolve, reject) => {
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); Add-Type -AssemblyName System.Security; $o=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))';
      const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let error = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { error += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(Buffer.from(output, 'base64')) : reject(new Error(error || `DPAPI 退出码 ${code}`)));
      child.stdin.end(Buffer.from(buffer).toString('base64'));
    });
  }

  async function chromiumKey(source) {
    const state = JSON.parse(fs.readFileSync(source.localState, 'utf8'));
    const wrapped = Buffer.from(String(state?.os_crypt?.encrypted_key || ''), 'base64');
    if (!wrapped.length) throw new Error('源浏览器没有可用的 Windows 加密密钥。');
    return unprotectDpapi(wrapped.subarray(0, 5).toString() === 'DPAPI' ? wrapped.subarray(5) : wrapped);
  }

  async function decryptChromium(buffer, key, host = '') {
    const value = Buffer.from(buffer || []);
    let plain;
    const prefix = value.subarray(0, 3).toString();
    if (prefix === 'v10' || prefix === 'v11') {
      const nonce = value.subarray(3, 15);
      const payload = value.subarray(15, -16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(value.subarray(-16));
      plain = Buffer.concat([decipher.update(payload), decipher.final()]);
    } else if (prefix === 'v20') {
      throw new Error('源浏览器使用应用绑定加密，当前系统不允许跨应用解密。');
    } else {
      plain = await unprotectDpapi(value);
    }
    if (host && plain.length > 32) {
      const expected = crypto.createHash('sha256').update(host).digest();
      if (crypto.timingSafeEqual(plain.subarray(0, 32), expected)) plain = plain.subarray(32);
    }
    return plain.toString('utf8');
  }

  async function importPasswords(source) {
    const file = path.join(source.profile, 'Login Data');
    if (!fs.existsSync(file)) return { imported: 0 };
    const db = openSqlite(file);
    let rows;
    try { rows = db.prepare('SELECT origin_url, signon_realm, username_value, password_value FROM logins WHERE blacklisted_by_user = 0').all(); }
    finally { db.close(); }
    if (!rows.length) return { imported: 0 };
    const key = await chromiumKey(source);
    let imported = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        const origin = new URL(row.origin_url || row.signon_realm).origin;
        const password = await decryptChromium(row.password_value, key);
        const username = String(row.username_value || '');
        if (!password || data.credentials.some((entry) => entry.origin === origin && entry.username === username)) continue;
        data.credentials.push({ id: crypto.randomUUID(), origin, username, label: '', secret: encryptSecret(password), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), importedFrom: source.id });
        imported += 1;
      } catch { skipped += 1; }
    }
    return { imported, skipped };
  }

  function importAutofill(source) {
    const file = path.join(source.profile, 'Web Data');
    if (!fs.existsSync(file)) return 0;
    const db = openSqlite(file);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      if (!tables.includes('autofill')) return 0;
      const rows = db.prepare('SELECT name, value, count FROM autofill ORDER BY count DESC LIMIT 500').all();
      let imported = 0;
      for (const row of rows) {
        const name = String(row.name || '');
        const value = String(row.value || '');
        if (!name || !value || data.autofill.some((entry) => entry.name === name && entry.value === value)) continue;
        data.autofill.push({ id: crypto.randomUUID(), name, value, count: Number(row.count || 1), importedFrom: source.id });
        imported += 1;
      }
      return imported;
    } finally { db.close(); }
  }

  async function importCookies(source, browserSession) {
    const file = path.join(source.profile, 'Network', 'Cookies');
    if (!fs.existsSync(file)) return { imported: 0 };
    const db = openSqlite(file);
    let rows;
    try {
      const statement = db.prepare('SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies');
      statement.setReadBigInts(true);
      rows = statement.all();
    }
    finally { db.close(); }
    if (!rows.length) return { imported: 0 };
    const key = await chromiumKey(source);
    let imported = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        const host = String(row.host_key || '');
        const value = row.value || await decryptChromium(row.encrypted_value, key, host);
        const cookie = {
          url: `${row.is_secure ? 'https' : 'http'}://${host.replace(/^\./, '')}${row.path || '/'}`,
          name: String(row.name || ''), value, domain: host, path: String(row.path || '/'),
          secure: Boolean(row.is_secure), httpOnly: Boolean(row.is_httponly),
          sameSite: Number(row.samesite) === 1 ? 'lax' : Number(row.samesite) === 2 ? 'strict' : Number(row.samesite) === 3 ? 'no_restriction' : 'unspecified'
        };
        const expirationDate = (CHROME_EPOCH_MS + Number(row.expires_utc || 0) / 1000) / 1000;
        if (expirationDate > Date.now() / 1000) cookie.expirationDate = expirationDate;
        await browserSession.cookies.set(cookie);
        imported += 1;
      } catch { skipped += 1; }
    }
    return { imported, skipped };
  }

  function copyPlain(source, destination) {
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      fs.mkdirSync(destination, { recursive: true });
      for (const name of fs.readdirSync(source)) copyPlain(path.join(source, name), path.join(destination, name));
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, fs.readFileSync(source));
    }
  }

  function extensionDisplayName(manifest, extensionPath, fallback) {
    const raw = String(manifest.name || fallback);
    const match = raw.match(/^__MSG_(.+)__$/i);
    if (!match || !manifest.default_locale) return raw;
    try {
      const messages = JSON.parse(fs.readFileSync(path.join(extensionPath, '_locales', String(manifest.default_locale), 'messages.json'), 'utf8'));
      return String(messages?.[match[1]]?.message || raw);
    } catch { return raw; }
  }

  function importExtensions(source) {
    const sourceRoot = path.join(source.profile, 'Extensions');
    if (!fs.existsSync(sourceRoot)) return { imported: 0, skipped: 0 };
    let imported = 0;
    let skipped = 0;
    for (const extensionId of fs.readdirSync(sourceRoot)) {
      const idRoot = path.join(sourceRoot, extensionId);
      const versions = fs.readdirSync(idRoot).filter((name) => fs.existsSync(path.join(idRoot, name, 'manifest.json'))).sort().reverse();
      if (!versions.length) { skipped += 1; continue; }
      const version = versions[0];
      try {
        const extensionPath = path.join(idRoot, version);
        const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
        const destination = path.join(extensionsRoot, extensionId, version);
        if (!fs.existsSync(path.join(destination, 'manifest.json'))) copyPlain(extensionPath, destination);
        const existing = data.extensions.find((item) => item.id === extensionId);
        const entry = { id: extensionId, name: extensionDisplayName(manifest, extensionPath, extensionId), version: manifest.version || version, path: destination, enabled: true, source: source.id, error: '' };
        if (existing) Object.assign(existing, entry); else data.extensions.push(entry);
        imported += 1;
      } catch { skipped += 1; }
    }
    return { imported, skipped };
  }

  async function importProfile(sourceId, browserSession) {
    const source = sourceById(sourceId);
    backup(`before-import-${source.id}`);
    const result = { source: source.id, history: 0, bookmarks: 0, passwords: 0, autofill: 0, cookies: 0, extensions: 0, skipped: 0, pending: [] };
    const run = async (name, work) => {
      try { return await work(); }
      catch (error) {
        result.pending.push(name);
        appendLog(`Browser import ${source.id}/${name} deferred: ${error.message}`);
        return null;
      }
    };
    result.history = (await run('history', () => importHistory(source))) || 0;
    result.bookmarks = (await run('bookmarks', () => importBookmarks(source))) || 0;
    const passwords = await run('passwords', () => importPasswords(source));
    result.passwords = passwords?.imported || 0;
    result.skipped += passwords?.skipped || 0;
    result.autofill = (await run('autofill', () => importAutofill(source))) || 0;
    const cookies = await run('cookies', () => importCookies(source, browserSession));
    result.cookies = cookies?.imported || 0;
    result.skipped += cookies?.skipped || 0;
    const extensions = await run('extensions', () => importExtensions(source));
    result.extensions = extensions?.imported || 0;
    result.skipped += extensions?.skipped || 0;
    result.completedAt = new Date().toISOString();
    data.pendingImport = result.pending.length ? { source: source.id, items: result.pending, lastAttemptAt: result.completedAt } : null;
    data.lastImport = result;
    save();
    return result;
  }

  async function retryPending(browserSession) {
    if (!data.settings.autoRetryImport || !data.pendingImport?.source) return null;
    return importProfile(data.pendingImport.source, browserSession);
  }

  async function loadExtensions(browserSession) {
    if (!data.settings.loadExtensions) return [];
    const results = [];
    for (const entry of data.extensions.filter((item) => item.enabled)) {
      try {
        const loaded = await browserSession.loadExtension(entry.path, { allowFileAccess: false });
        entry.error = '';
        results.push({ id: loaded.id, loaded: true });
      } catch (error) {
        entry.error = String(error.message || error);
        results.push({ id: entry.id, loaded: false, error: entry.error });
      }
    }
    save();
    return results;
  }

  function toggleExtension(id, enabled) {
    const entry = data.extensions.find((item) => item.id === id);
    if (!entry) return false;
    entry.enabled = Boolean(enabled);
    entry.error = '';
    save();
    return true;
  }

  return { publicSnapshot, recordHistory, toggleBookmark, remove, clear, saveCredential, credentialSecret, setSettings, importProfile, retryPending, loadExtensions, toggleExtension };
}

module.exports = { createBrowserLibrary, DEFAULT_HOMEPAGES };
