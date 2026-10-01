// Trigger / Watcher —— 任务单第十五节（Watcher 只能作为自动触发器）+ 第十九节（单实例锁与陈旧锁清理）。
//
// 设计要点（为什么这么做）：
//   1. **触发无关**：任何触发方式（git hook / DSH 插件 / 计划任务 / 人手）都只需调用 `watchOnce`。
//      所以"挂到哪个触发点"不再阻塞自动化 —— 谁都能调。
//   2. **便宜优先**：实测本盘 `git status --porcelain` ≈ 118ms，所以每次先比工作区指纹；
//      指纹没变就**直接跳过**，不做任何重活（不跑门禁、不启进程）。
//   3. **Watcher 不是正确性来源**（§15）：真正的判定永远来自 `verify`（同步门禁）。
//      Watcher 停了、坏了、被杀了，正确性不受影响（§28 测试 4 已验）。
//   4. 单实例锁 + 陈旧锁清理（§19）：不允许两个 watcher 同时跑；崩溃留下的锁能被后来自愈。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, atomicWriteJson, readJsonIfExists, nowIso } from './paths.mjs';
import { computeFingerprint } from './fingerprint.mjs';

export const DEFAULT_COOLDOWN_MS = 0;
export const DEFAULT_INTERVAL_MS = 5000;
export const DEFAULT_STALE_LOCK_MS = 30 * 60 * 1000;

export function watchPaths({ root, taskId = 'watch', stateDir = null } = {}) {
  const dir = stateDir ? path.resolve(stateDir) : path.join(path.resolve(root), 'processes', `watch-${taskId}`);
  return {
    dir,
    state: path.join(dir, 'watch-state.json'),
    status: path.join(dir, 'watch-status.json'),
    lock: path.join(dir, 'watch.lock'),
    stop: path.join(dir, 'watch.stop'),
  };
}

export function readLock({ lockFile }) {
  return readJsonIfExists(lockFile);
}

/** 取锁。活锁 -> 拒绝；陈旧锁 -> 清理后继续，并把"清过陈旧锁"记下来便于审计。 */
export function acquireLock({ lockFile, owner = null, staleMs = DEFAULT_STALE_LOCK_MS, now = Date.now() } = {}) {
  const existing = readLock({ lockFile });
  let staleCleared = null;
  if (existing) {
    const age = now - Date.parse(existing.acquired_at ?? 0);
    if (Number.isFinite(age) && age <= staleMs) {
      return { ok: false, reason: 'held_by_live_instance', existing, age_ms: age };
    }
    staleCleared = { previous: existing, age_ms: Number.isFinite(age) ? age : null };
  }
  ensureDir(path.dirname(lockFile));
  const lock = {
    schema_version: 1,
    owner: owner ?? { pid: process.pid, started_at: nowIso() },
    acquired_at: new Date(now).toISOString(),
  };
  atomicWriteJson(lockFile, lock, { keepBak: false });
  return { ok: true, lock, stale_cleared: staleCleared };
}

export function releaseLock({ lockFile }) {
  if (fs.existsSync(lockFile)) {
    fs.rmSync(lockFile, { force: true });
    return true;
  }
  return false;
}

export function shouldStop({ stopFile }) {
  return Boolean(stopFile) && fs.existsSync(stopFile);
}

export function requestStop({ stopFile, reason = 'manual' }) {
  ensureDir(path.dirname(stopFile));
  atomicWriteJson(stopFile, { requested_at: nowIso(), reason }, { keepBak: false });
  return stopFile;
}

export function clearStop({ stopFile }) {
  if (stopFile && fs.existsSync(stopFile)) fs.rmSync(stopFile, { force: true });
  return true;
}

/**
 * 跑一次检查（**这是触发器唯一需要的入口**）。
 *
 * @param {object} o
 * @param {string} o.root
 * @param {string} [o.taskId='watch']
 * @param {object} [o.extraFiles]        纳入指纹的文件（不给就只覆盖 git 变更/未跟踪，可能零覆盖）
 * @param {Function} [o.runVerify]       指纹**变化**时调用；返回结果对象
 * @param {object} [o.ledger]
 * @param {number} [o.cooldownMs=0]
 * @param {boolean} [o.force=false]      忽略"没变"与冷却，强制执行一次
 * @param {Function} [o.now]
 */
export async function watchOnce({
  root,
  taskId = 'watch',
  extraFiles = {},
  runVerify = null,
  ledger = null,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  force = false,
  stateDir = null,
  now = () => Date.now(),
} = {}) {
  if (!root) throw new Error('watchOnce: root is required');
  const files = watchPaths({ root, taskId, stateDir });
  ensureDir(files.dir);
  const prev = readJsonIfExists(files.state) || {};

  const fp = computeFingerprint({ root, extraFiles });
  const unchanged = prev.fingerprint === fp.aggregate;
  // 间隔必须用**同一个时钟**算：last_run_at 是人读的 ISO，last_run_at_ms 才是可注入时钟的数值记法。
  // 混用两个时钟会让注入 now() 的调用方算出错误间隔（已实测：算出巨大负间隔，冷却形同虚设）。
  const lastRunMs =
    typeof prev.last_run_at_ms === 'number' ? prev.last_run_at_ms : prev.last_run_at ? Date.parse(prev.last_run_at) : null;
  const elapsed = lastRunMs !== null && Number.isFinite(lastRunMs) ? now() - lastRunMs : Infinity;
  const inCooldown = cooldownMs > 0 && elapsed < cooldownMs;

  const base = {
    task_id: taskId,
    fingerprint: fp.aggregate,
    coverage: fp.coverage,
    degraded: fp.degraded === true,
    files: { state: files.state, status: files.status, lock: files.lock, stop: files.stop },
  };

  if (!force && unchanged) {
    const status = {
      schema_version: 1,
      ...base,
      action: 'SKIP',
      reason: 'fingerprint_unchanged',
      checked_at: nowIso(),
      last_run_at: prev.last_run_at ?? null,
      last_result: prev.last_result ?? null,
      total_runs: prev.total_runs ?? 0,
      total_checks: (prev.total_checks ?? 0) + 1,
    };
    atomicWriteJson(files.state, { ...prev, last_checked_at: nowIso(), total_checks: status.total_checks }, { keepBak: false });
    atomicWriteJson(files.status, status, { keepBak: false });
    return status;
  }

  if (!force && inCooldown) {
    const status = {
      schema_version: 1,
      ...base,
      action: 'SKIP',
      reason: 'cooldown',
      checked_at: nowIso(),
      remaining_ms: cooldownMs - elapsed,
      last_run_at: prev.last_run_at ?? null,
      total_runs: prev.total_runs ?? 0,
      total_checks: prev.total_checks ?? 0,
    };
    atomicWriteJson(files.status, status, { keepBak: false });
    return status;
  }

  const ranMs = now();
  const ranAt = new Date(ranMs).toISOString();
  let result = null;
  let failure = null;
  try {
    result = runVerify ? await runVerify({ fingerprint: fp, taskId }) : null;
  } catch (e) {
    failure = String(e && e.message ? e.message : e);
  }

  const verdictStatus = result?.verdict_status ?? result?.verdict?.status ?? null;
  const status = {
    schema_version: 1,
    ...base,
    action: 'RAN',
    reason: force ? 'forced' : 'fingerprint_changed',
    checked_at: ranAt,
    last_run_at: ranAt,
    last_result: verdictStatus,
    total_runs: (prev.total_runs ?? 0) + 1,
    total_checks: (prev.total_checks ?? 0) + 1,
    error: failure,
    result: result ?? null,
  };
  atomicWriteJson(files.state, {
    schema_version: 1,
    task_id: taskId,
    fingerprint: fp.aggregate,
    coverage: fp.coverage,
    last_checked_at: ranAt,
    last_run_at: ranAt,
    last_run_at_ms: ranMs,
    last_result: verdictStatus,
    total_runs: status.total_runs,
    total_checks: status.total_checks,
  }, { keepBak: false });
  atomicWriteJson(files.status, status, { keepBak: false });

  if (ledger) {
    ledger.append({
      type: verdictStatus && ['PASS', 'FAIL', 'INVALID'].includes(verdictStatus) ? verdictStatus : 'WATCH_RUN',
      task_id: taskId,
      detail: `watch:${status.reason}${failure ? ':error=' + failure : ''}`,
    });
  }
  return status;
}

export function readWatchStatus({ root, taskId = 'watch', stateDir = null } = {}) {
  const files = watchPaths({ root, taskId, stateDir });
  return {
    files,
    lock: readLock({ lockFile: files.lock }),
    stop_requested: shouldStop({ stopFile: files.stop }),
    state: readJsonIfExists(files.state),
    status: readJsonIfExists(files.status),
  };
}

/**
 * 轮询模式（可选）。`maxIterations` 是安全阀，避免意外常驻。
 * 任何触发方式都可以只调 `watchOnce`；这个循环只是给"想常驻"的人用。
 */
export async function watchLoop({
  root,
  taskId = 'watch',
  extraFiles = {},
  runVerify = null,
  ledger = null,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxIterations = 60,
  stateDir = null,
  staleMs = DEFAULT_STALE_LOCK_MS,
  onIteration = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const files = watchPaths({ root, taskId, stateDir });
  const lock = acquireLock({ lockFile: files.lock, staleMs, now: now() });
  if (!lock.ok) return { ok: false, error: lock.reason, existing: lock.existing, age_ms: lock.age_ms };

  const iterations = [];
  let stopped = null;
  try {
    for (let i = 0; i < maxIterations; i++) {
      if (shouldStop({ stopFile: files.stop })) {
        stopped = 'stop_sentinel';
        break;
      }
      const r = await watchOnce({ root, taskId, extraFiles, runVerify, ledger, cooldownMs, stateDir, now });
      iterations.push({ i, action: r.action, reason: r.reason });
      if (onIteration) onIteration(r, i);
      if (i < maxIterations - 1) await sleep(intervalMs);
    }
    if (!stopped && iterations.length >= maxIterations) stopped = 'max_iterations';
  } finally {
    releaseLock({ lockFile: files.lock });
  }

  const summary = {
    ok: true,
    task_id: taskId,
    iterations: iterations.length,
    ran: iterations.filter((x) => x.action === 'RAN').length,
    skipped: iterations.filter((x) => x.action === 'SKIP').length,
    stopped,
    stale_lock_cleared: lock.stale_cleared,
    detail: iterations,
    files,
  };
  atomicWriteJson(files.status, { schema_version: 1, kind: 'loop_summary', ...summary, finished_at: nowIso() }, { keepBak: false });
  return summary;
}
