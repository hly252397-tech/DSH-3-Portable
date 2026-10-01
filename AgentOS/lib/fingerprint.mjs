// Workspace Fingerprint —— 任务单第十六节。
//
// 为什么指纹是核心：PASS 必须绑定「当前工作区代码指纹」。指纹变了，旧 PASS 立刻失效。
// 允许作为 PASS 依据的东西只有指纹本身；禁止用时间新鲜度 / "30 分钟内通过" / Git HEAD /
// Watcher 还在跑 来判断 PASS 有效。
//
// 指纹至少包含：
//   - Git HEAD
//   - 已修改文件相对路径
//   - 文件内容 SHA-256
//   - 未跟踪相关文件 SHA-256
//   - 门禁脚本 SHA-256
//   - 验证配置 SHA-256
//   - 关键 manifest SHA-256
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJson, sha256Text, nowIso, rel } from './paths.mjs';

export const FINGERPRINT_SCHEMA_VERSION = 1;

/** 读取 .git 目录判断 HEAD（不启动 git 进程，避免受限环境下管道 EPERM）。 */
export function readGitHead(root) {
  const gitDir = path.join(root, '.git');
  if (!fs.existsSync(gitDir)) return { head: null, branch: null, source: 'no-git-dir' };
  const headText = (fs.existsSync(path.join(gitDir, 'HEAD')) ? fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8') : '').trim();
  if (!headText) return { head: null, branch: null, source: 'empty-head' };
  const m = /^ref:\s*(.+)$/.exec(headText);
  if (!m) return { head: headText, branch: null, source: 'detached' };
  const ref = m[1].trim();
  const packed = path.join(gitDir, 'packed-refs');
  const refFile = path.join(gitDir, ref);
  let sha = null;
  if (fs.existsSync(refFile)) {
    sha = fs.readFileSync(refFile, 'utf8').trim();
  } else if (fs.existsSync(packed)) {
    for (const line of fs.readFileSync(packed, 'utf8').split(/\r?\n/)) {
      const p = line.trim().split(/\s+/);
      if (p.length === 2 && p[1] === ref) {
        sha = p[0];
        break;
      }
    }
  }
  return { head: sha, branch: ref.replace(/^refs\/heads\//, ''), ref, source: 'ref-file' };
}

/**
 * git status --porcelain 解析出变更/未跟踪文件。
 * 受限沙箱下 spawn 管道可能 EPERM —— 此时**显式降级并标记**，绝不假装成功。
 */
export function readGitStatus(root, { timeoutMs = 20000 } = {}) {
  try {
    const r = spawnSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'], {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (r.error) return { ok: false, reason: String(r.error.message || r.error), modified: [], untracked: [] };
    if (r.status !== 0) return { ok: false, reason: `git exit ${r.status}: ${(r.stderr || '').trim()}`, modified: [], untracked: [] };
    const modified = [];
    const untracked = [];
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      let p = line.slice(3).trim();
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      if (code === '??') untracked.push(p);
      else modified.push(p);
    }
    return { ok: true, reason: null, modified, untracked };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e), modified: [], untracked: [] };
  }
}

function hashEntry(root, relPath, label) {
  const abs = path.join(root, relPath);
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { path: relPath, label, kind: 'not-a-file', sha256: null, size: null };
    const buf = fs.readFileSync(abs);
    return { path: relPath, label, kind: 'file', sha256: sha256Text(buf), size: buf.length };
  } catch (e) {
    return { path: relPath, label, kind: 'missing', sha256: null, size: null, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 计算工作区指纹。
 *
 * @param {object} o
 * @param {string} o.root            工作区根
 * @param {object} [o.extraFiles]    { 标签: 相对路径 } —— 门禁脚本 / 验证配置 / 关键 manifest
 * @param {boolean} [o.includeGitStatus=true]
 * @param {string[]} [o.extraChanged] 额外纳入的变更文件（相对路径），用于非 git 工作区
 * @param {number} [o.maxFiles=800]
 */
export function computeFingerprint({
  root,
  extraFiles = {},
  includeGitStatus = true,
  extraChanged = [],
  maxFiles = 800,
} = {}) {
  if (!root) throw new Error('computeFingerprint: root is required');
  const absRoot = path.resolve(root);
  const gitHead = readGitHead(absRoot);
  const status = includeGitStatus ? readGitStatus(absRoot) : { ok: false, reason: 'disabled', modified: [], untracked: [] };

  const wanted = new Map(); // relPath -> label
  for (const p of status.modified) wanted.set(p, 'modified');
  for (const p of status.untracked) wanted.set(p, 'untracked');
  for (const p of extraChanged) if (!wanted.has(p)) wanted.set(p, 'changed');

  // 非 git 工作区（或 git 降级）时，用调用方声明的 extraChanged 兜底
  const entries = [];
  const truncated = wanted.size > maxFiles;
  let n = 0;
  for (const [p, label] of [...wanted.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n++ >= maxFiles) break;
    entries.push(hashEntry(absRoot, p, label));
  }
  for (const [label, p] of Object.entries(extraFiles)) {
    entries.push(hashEntry(absRoot, p, label));
  }
  entries.sort((a, b) => (a.label + ':' + a.path).localeCompare(b.label + ':' + b.path));

  const gitPart = {
    head: gitHead.head,
    branch: gitHead.branch,
    ref: gitHead.ref,
    head_source: gitHead.source,
    status_ok: status.ok,
    status_reason: status.reason,
  };

  const payload = { schema_version: FINGERPRINT_SCHEMA_VERSION, git: gitPart, entries };
  const aggregate = sha256Text(canonicalJson(payload));

  return {
    schema_version: FINGERPRINT_SCHEMA_VERSION,
    algorithm: 'sha256',
    computed_at: nowIso(),
    root: absRoot,
    git: gitPart,
    counts: {
      entries: entries.length,
      missing: entries.filter((e) => e.kind === 'missing').length,
      modified: entries.filter((e) => e.label === 'modified').length,
      untracked: entries.filter((e) => e.label === 'untracked').length,
    },
    truncated,
    coverage: entries.length,
    // 覆盖 0 个文件的指纹对「PASS 绑定代码指纹」毫无意义，必须显式降级而不是静默放行
    degraded: entries.length === 0,
    entries,
    aggregate,
  };
}

/** 两份指纹是否可判定为「同一份代码」。 */
export function fingerprintsEqual(a, b) {
  if (!a || !b) return false;
  return a.aggregate === b.aggregate;
}

export { rel };
