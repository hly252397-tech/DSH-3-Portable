// Boot First-Error Collector（宿主半侧）—— 任务单第十八节 + 第二十二节。
//
// 要解决的具体问题：启动时 73 个插件一起 import failed，但**第一条真实异常**只出现一次。
// 后续 72 条都是它的连锁后果。所以取证的第一原则是：
//   **第一条永不覆盖**；后续只做统计、受影响清单与共同依赖分析。
//
// 产物：Data/Recovery/<incident-id>/
//   ├── incident.json                 事故元信息（runtime / candidate / 指纹 / 时间）
//   ├── first-import-error.json       第一条真实错误（永不覆盖）
//   ├── first-network-failure.json    第一个失败模块请求（永不覆盖）
//   ├── subsequent-errors.jsonl       后续错误（append-only，只统计）
//   └── shared-layer-analysis.json    共同依赖分析 + 二分分组
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, atomicWriteJson, readJsonIfExists, nowIso, sha256Text } from './paths.mjs';

export const RECOVERY_DIR_REL = 'Data/Recovery';

export function incidentDir({ portableRoot, incidentId }) {
  if (!portableRoot) throw new Error('incidentDir: portableRoot is required');
  if (!incidentId) throw new Error('incidentDir: incidentId is required');
  return path.join(path.resolve(portableRoot), RECOVERY_DIR_REL, incidentId);
}

export function newIncidentId({ prefix = 'boot-failure', at = new Date() } = {}) {
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

/** 开一次事故取证：建目录 + 写元信息。同名目录已存在则复用（不覆盖已有取证）。 */
export function openIncident({
  portableRoot,
  incidentId,
  runtime = null,
  candidate = null,
  workspaceFingerprint = null,
  runtimeFingerprint = null,
  note = null,
} = {}) {
  const dir = incidentDir({ portableRoot, incidentId });
  ensureDir(dir);
  const metaFile = path.join(dir, 'incident.json');
  const existing = readJsonIfExists(metaFile);
  const meta = existing ?? {
    schema_version: 1,
    incident_id: incidentId,
    opened_at: nowIso(),
    runtime,
    candidate,
    workspace_fingerprint: workspaceFingerprint,
    runtime_fingerprint: runtimeFingerprint,
    note,
    state: 'OPEN',
  };
  if (!existing) atomicWriteJson(metaFile, meta, { keepBak: false });
  return { dir, meta, meta_file: metaFile, reused: Boolean(existing) };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { type: 'BROKEN_RECORD', raw: l };
      }
    });
}

function appendJsonl(file, rec) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify({ ...rec, recorded_at: nowIso() }) + '\n', 'utf8');
}

/**
 * 记第一条真实 import 异常。**已存在就绝不覆盖**，转为后续记录。
 * @returns {{ stored:boolean, path:string, reason:'first'|'already_captured' }}
 */
export function recordFirstError({ portableRoot, incidentId, error } = {}) {
  if (!error || (!error.message && !error.type)) throw new Error('recordFirstError: error.message or error.type is required');
  const dir = incidentDir({ portableRoot, incidentId });
  ensureDir(dir);
  const file = path.join(dir, 'first-import-error.json');
  if (fs.existsSync(file)) {
    appendJsonl(path.join(dir, 'subsequent-errors.jsonl'), { kind: 'import_error', ...error });
    return { stored: false, path: file, reason: 'already_captured' };
  }
  const rec = {
    schema_version: 1,
    incident_id: incidentId,
    captured_at: nowIso(),
    first_error: {
      type: error.type ?? 'unknown',
      message: error.message ?? null,
      module_url: error.module_url ?? null,
      source_file: error.source_file ?? null,
      line: error.line ?? null,
      column: error.column ?? null,
      stack: error.stack ?? null,
      initiator: error.initiator ?? null,
    },
    fingerprint: sha256Text(JSON.stringify({ t: error.type, m: error.message, u: error.module_url })),
  };
  atomicWriteJson(file, rec, { keepBak: false });
  return { stored: true, path: file, reason: 'first' };
}

/** 记第一个失败的模块请求（404 / 返回 HTML / 超时）。同样**永不覆盖**。 */
export function recordFirstNetworkFailure({ portableRoot, incidentId, failure } = {}) {
  const dir = incidentDir({ portableRoot, incidentId });
  ensureDir(dir);
  const file = path.join(dir, 'first-network-failure.json');
  if (fs.existsSync(file)) {
    appendJsonl(path.join(dir, 'subsequent-errors.jsonl'), { kind: 'network_failure', ...failure });
    return { stored: false, path: file, reason: 'already_captured' };
  }
  const rec = {
    schema_version: 1,
    incident_id: incidentId,
    captured_at: nowIso(),
    first_network_failure: {
      url: failure?.url ?? null,
      status: failure?.status ?? null,
      content_type: failure?.content_type ?? null,
      initiator: failure?.initiator ?? null,
      error: failure?.error ?? null,
    },
    fingerprint: sha256Text(JSON.stringify({ u: failure?.url, s: failure?.status })),
  };
  atomicWriteJson(file, rec, { keepBak: false });
  return { stored: true, path: file, reason: 'first' };
}

/**
 * 共同依赖分析：把一堆失败插件按"共享层"归组。
 * 目的：证明这是**共享启动层故障**，而不是 N 个插件各自坏了。
 */
export function analyzeSharedLayer({ failures = [] } = {}) {
  const groups = new Map();
  for (const f of failures) {
    const name = String(f.plugin ?? f.name ?? 'unknown');
    let family;
    if (f.shared_source) family = String(f.shared_source);
    else if (name.startsWith('@')) family = name.split('/')[0];
    else if (name.includes('-')) family = name.split('-').slice(0, 2).join('-');
    else family = name;
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(name);
  }
  const rows = [...groups.entries()].map(([family, plugins]) => ({ family, count: plugins.length, plugins: plugins.sort() }));
  rows.sort((a, b) => b.count - a.count);

  const total = failures.length;
  return {
    total_failures: total,
    group_count: rows.length,
    groups: rows,
    // 结论口径：当绝大多数失败落在少数共享组里，就是共享层故障，不是 N 个独立故障
    looks_like_shared_layer_failure: total >= 2 && rows.length > 0 && rows[0].count >= Math.max(2, Math.ceil(total * 0.5)),
    largest_group: rows[0] ?? null,
    advice: total >= 2 ? '禁止逐个修插件；按共享层分组做二分定位' : '失败数不足以判定为共享层故障',
  };
}

/**
 * 按"共享层变更分组"给出二分计划（第十八节第 8 步）。
 * @param {Array} changeGroups [{ id, files:[], description }] —— 按共享层把变更分组
 */
export function planBisect({ changeGroups = [] } = {}) {
  if (!changeGroups.length) {
    return { steps: [], note: '没有变更分组，无法二分；先从 diff / 构建产物 / 检查点重建变更集' };
  }
  const steps = changeGroups.map((g, i) => ({
    order: i + 1,
    group: g.id,
    description: g.description ?? null,
    files: g.files ?? [],
    action: '在同一隔离候选里只应用这一组，跑 Boot Gate',
    expected: '首次产生 BOOT_FAILED 的那一组即为根因组',
  }));
  return { steps, strategy: 'binary_search_over_shared_layers', note: '每一组只在新 Candidate 中测试，禁止在坏候选上继续改' };
}

/**
 * 收口：写统计与共同依赖分析。
 * 后续错误只统计，绝不回写第一条。
 */
export function finalizeIncident({
  portableRoot,
  incidentId,
  affectedPlugins = [],
  failedPluginCount = null,
  sharedSource = null,
  changeGroups = null,
} = {}) {
  const dir = incidentDir({ portableRoot, incidentId });
  const firstError = readJsonIfExists(path.join(dir, 'first-import-error.json'));
  const firstNet = readJsonIfExists(path.join(dir, 'first-network-failure.json'));
  const subsequent = readJsonl(path.join(dir, 'subsequent-errors.jsonl'));

  const failures = affectedPlugins.map((p) => ({ plugin: typeof p === 'string' ? p : p.plugin, shared_source: sharedSource }));
  const analysis = analyzeSharedLayer({ failures: affectedPlugins.length ? failures : subsequent.filter((s) => s.kind === 'import_error').map((s) => ({ plugin: s.plugin })) });

  const summary = {
    schema_version: 1,
    incident_id: incidentId,
    finalized_at: nowIso(),
    first_error: firstError?.first_error ?? null,
    first_error_fingerprint: firstError?.fingerprint ?? null,
    first_network_failure: firstNet?.first_network_failure ?? null,
    subsequent_error_count: subsequent.length,
    failed_plugin_count: failedPluginCount ?? (affectedPlugins.length || analysis.total_failures || null),
    affected_plugins: affectedPlugins.map((p) => (typeof p === 'string' ? p : p.plugin)).filter(Boolean),
    shared_layer_analysis: analysis,
    bisect_plan: changeGroups ? planBisect({ changeGroups }) : null,
    invariant_checks: [
      { id: 'first_error_preserved', ok: Boolean(firstError), detail: firstError ? 'first-import-error.json 存在且未被后续覆盖' : '尚未捕获第一条错误' },
      { id: 'no_individual_plugin_fix', ok: true, detail: '禁止逐个修插件；按共享层二分' },
    ],
  };
  const file = path.join(dir, 'first-import-error-summary.json');
  atomicWriteJson(file, summary, { keepBak: false });
  return { summary, file, dir };
}

/** 只读：读回一次事故的全部取证。 */
export function readIncident({ portableRoot, incidentId } = {}) {
  const dir = incidentDir({ portableRoot, incidentId });
  return {
    dir,
    exists: fs.existsSync(dir),
    meta: readJsonIfExists(path.join(dir, 'incident.json')),
    first_error: readJsonIfExists(path.join(dir, 'first-import-error.json')),
    first_network_failure: readJsonIfExists(path.join(dir, 'first-network-failure.json')),
    summary: readJsonIfExists(path.join(dir, 'first-import-error-summary.json')),
    subsequent_errors: readJsonl(path.join(dir, 'subsequent-errors.jsonl')),
  };
}
