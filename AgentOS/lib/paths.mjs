// path + id + json helpers for AgentOS.
// 设计约束：
//  - 本目录（AgentOS/）是**纯新增制品**，任何模块都不允许写入正在运行的 Stable
//    运行时槽 / 桌面槽（见 lib/candidate.mjs 的 guardWrite）。
//  - 所有落盘都是 UTF-8，追加式；不做原地覆盖（除显式声明的候选清单文件）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const AGENTOS_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// 任务单第五节规定的便携盘目录结构
export const TREE = [
  'supervisor/stable',
  'supervisor/candidate',
  'supervisor/policy',
  'supervisor/recovery',
  'runtime/current',
  'runtime/versions',
  'runtime/rollback',
  'tasks/active',
  'tasks/completed',
  'tasks/failed',
  'candidates/active',
  'candidates/rejected',
  'candidates/promoted',
  'checkpoints',
  'events',
  'verdicts',
  'incidents',
  'invariants',
  'memory/self-model',
  'memory/world-model',
  'memory/project-model',
  'memory/episodic',
  'memory/semantic',
  'memory/procedural',
  'skills/active',
  'skills/candidate',
  'skills/deprecated',
  'skills/benchmarks',
  'tools/active',
  'tools/candidate',
  'tools/sandbox',
  'processes',
  'logs',
  'temp',
  'cache',
  'trash',
  'workspaces',
];

/** 建立（或补齐）第五节目录树。幂等。 */
export function initTree(root = AGENTOS_ROOT) {
  const created = [];
  for (const rel of TREE) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
      created.push(rel);
    }
  }
  return { root, created, total: TREE.length };
}

export function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function nowIso() {
  return new Date().toISOString();
}

/** 稳定 JSON：对象键排序，保证同内容 -> 同字节 -> 同哈希。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 读取文件文本；不存在返回 null。 */
export function readTextIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function readJsonIfExists(p) {
  const t = readTextIfExists(p);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** 列出两边 canonical 形式不同的顶层键，专供 atomicWriteJson 校验失败时定位。 */
function diffKeys(expected, actual) {
  const keys = [...new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})])];
  return keys.filter((k) => canonicalJson(expected?.[k] ?? null) !== canonicalJson(actual?.[k] ?? null)).slice(0, 10);
}

/** 原子写：tmp -> 校验 -> rename，并保留 .bak。用于关键文件。 */
export function atomicWriteJson(file, value, { keepBak = true } = {}) {
  const dir = ensureDir(path.dirname(file));
  const jsonValue = value ?? null;
  const text = JSON.stringify(jsonValue, null, 2) + '\n';
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + randomUUID());
  fs.writeFileSync(tmp, text, 'utf8');

  let back;
  try {
    back = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error('atomicWriteJson: 写出的内容不是合法 JSON (' + file + '): ' + (e && e.message ? e.message : e));
  }

  // 与「写盘等价的规范化值」比较：JSON 没有 undefined，JSON.stringify 会丢键，
  // 拿原始对象直接比会在含 undefined 时**误报**（已实测：watch-status.json）。
  const expected = JSON.parse(JSON.stringify(jsonValue));
  if (canonicalJson(back) !== canonicalJson(expected)) {
    const keys = diffKeys(expected, back);
    fs.rmSync(tmp, { force: true });
    throw new Error('atomicWriteJson: verification failed for ' + file + (keys.length ? ' (differs at: ' + keys.join(', ') + ')' : ''));
  }

  if (keepBak && fs.existsSync(file)) {
    fs.copyFileSync(file, file + '.bak');
  }
  fs.renameSync(tmp, file);
  return file;
}

export function newId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${randomUUID().slice(0, 8)}`;
}

const fwdNorm = (p) => path.resolve(p).split(/[\\/]/).join('/').toLowerCase();

/** 归一化比较：Windows 下大小写不敏感、分隔符统一。 */
export function isUnderOrEqual(child, parent) {
  const c = fwdNorm(child);
  const p = fwdNorm(parent);
  return c === p || c.startsWith(p + '/');
}

export function fwdKey(p) {
  return fwdNorm(p);
}

/**
 * 解析真实路径：对还不存在的目标，先找到最近的已存在祖先再拼回去。
 * 否则 realpathSync 会直接抛错，符号链接 / Junction 逃逸检查就形同虚设。
 */
export function realpathOf(p) {
  let cur = path.resolve(p);
  const parts = [];
  let guard = 0;
  while (!fs.existsSync(cur) && guard++ < 64) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    parts.unshift(path.basename(cur));
    cur = parent;
  }
  const real = fs.existsSync(cur) ? fs.realpathSync(cur) : cur;
  return parts.length ? path.join(real, ...parts) : real;
}
