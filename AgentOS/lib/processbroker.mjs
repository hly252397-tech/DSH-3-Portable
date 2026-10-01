// Process Broker —— 任务单第十九节（进程管理）+ 第二十八节测试 10（模糊查杀被拒）。
//
// 本模块是**执行器**，不是判定器：它真的会 spawn、真的会停。
// 因此安全不变量必须写死在代码里：
//   1. 只有**登记在册且 owner 对得上**的进程才允许停；其余一律拒绝，且**不碰**任何进程。
//   2. 停止优先级按 §19：host_job_id > child_process_handle > exact_pid > local_ipc > stop_sentinel。
//   3. 禁止按名称 / 模糊命令行 / 批量 Stop-Process。
//   4. 每个由 Agent 启动的进程都必须登记（process_id/owner/command/command_hash/start_time/stop_method）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDir, nowIso, sha256Text, readJsonIfExists } from './paths.mjs';
import { evaluateProcessStop, STOP_PRIORITY, FORBIDDEN_STOP_STRATEGIES } from './broker.mjs';

export const REGISTRY_VERSION = 1;

export function registryFile({ root }) {
  return path.join(path.resolve(root), 'processes', 'registry.jsonl');
}

export function appendRegistry({ root, record }) {
  const file = registryFile({ root });
  ensureDir(path.dirname(file));
  const rec = { ...record, recorded_at: nowIso() };
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

function readRegistryLines({ root }) {
  const file = registryFile({ root });
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ type: 'BROKEN_RECORD', raw: line });
    }
  }
  return out;
}

/** 重放登记表：登记 - 停止 = 在册。append-only，不覆盖历史。 */
export function listRegistered({ root, owner_task_id = undefined, includeStopped = false } = {}) {
  const lines = readRegistryLines({ root });
  const byId = new Map();
  for (const r of lines) {
    if (r.type === 'PROCESS_REGISTERED') {
      byId.set(r.process_id, { ...r, stopped: false, stop_record: null, reconciled: false });
    } else if (r.type === 'PROCESS_STOPPED' || r.type === 'PROCESS_RECONCILED') {
      // 对账也算"不再在册"——否则已对账的幽灵条目会一直挂在在册列表里（本轮实测漏过这条）
      const t = byId.get(r.process_id);
      if (t) {
        t.stopped = true;
        t.stop_record = r;
        t.reconciled = r.type === 'PROCESS_RECONCILED';
      }
    }
  }
  let rows = [...byId.values()];
  if (owner_task_id !== undefined) rows = rows.filter((r) => r.owner_task_id === owner_task_id);
  if (!includeStopped) rows = rows.filter((r) => !r.stopped);
  return rows;
}

/** 进程是否还活着。EPERM 视为"活着但没权限"，不算死。 */
export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/** 登记一个由 Agent 启动的进程（§19：所有 Agent 启动的进程必须登记）。 */
export function registerProcess({
  root,
  process_id = null,
  pid,
  owner_task_id,
  owner_job_id = null,
  command = null,
  command_hash = null,
  child = null,
  stop_method = null,
  started_by_agent = true,
} = {}) {
  if (!root) throw new Error('registerProcess: root is required');
  if (!owner_task_id) throw new Error('registerProcess: owner_task_id is required');
  const realPid = pid ?? child?.pid ?? null;
  if (!realPid) throw new Error('registerProcess: pid (or child) is required');
  const id = process_id ?? `proc-${realPid}-${Date.now().toString(36)}`;
  return appendRegistry({
    root,
    record: {
      type: 'PROCESS_REGISTERED',
      schema_version: REGISTRY_VERSION,
      process_id: id,
      pid: realPid,
      owner_task_id,
      owner_job_id,
      command,
      command_hash: command_hash ?? (command ? sha256Text(String(command)) : null),
      start_time: nowIso(),
      stop_method: stop_method ?? 'child_process_handle',
      started_by_agent: started_by_agent === true,
    },
  });
}

/**
 * 启动并登记一个进程。stdio 默认 'ignore'，避免受限环境下的管道问题。
 */
export function spawnTracked({
  root,
  owner_task_id,
  owner_job_id = null,
  command = null,
  file,
  args = [],
  options = {},
  unref = false,
} = {}) {
  if (!root) throw new Error('spawnTracked: root is required');
  if (!owner_task_id) throw new Error('spawnTracked: owner_task_id is required');
  if (!file) throw new Error('spawnTracked: file is required');
  const child = spawn(file, args, {
    stdio: 'ignore',
    windowsHide: true,
    // 实测：只 unref 而不 detached，父进程一退出子进程就没了（pid 立刻消失）。
    // 要让"CLI 起的后台进程"活下来，必须 detached。
    ...(unref ? { detached: true } : {}),
    ...options,
  });
  // unref 后 handle 就没了，停止只能靠精确 PID —— 如实记进 stop_method，不假装还有 handle
  if (unref) child.unref();
  const record = registerProcess({
    root,
    pid: child.pid,
    owner_task_id,
    owner_job_id,
    command: command ?? [file, ...args].join(' '),
    child,
    stop_method: unref ? 'exact_pid' : 'child_process_handle',
  });
  return { child, record };
}

async function waitForExit(pid, { timeoutMs = 8000, intervalMs = 100, sleep } = {}) {
  const sleeper = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isAlive(pid)) return { gone: true, waited_ms: Date.now() - started };
    await sleeper(intervalMs);
  }
  return { gone: false, waited_ms: Date.now() - started };
}

/**
 * 真的停一个进程。
 * 先过 §19 判定（只允许有明确 owner 的精确 PID），判定不过就**什么都不做**并留档。
 */
export async function stopProcess({
  root,
  pid,
  owner_task_id = null,
  strategy = 'exact_pid',
  signal = 'SIGTERM',
  timeoutMs = 8000,
  sleep = undefined,
} = {}) {
  if (!root) throw new Error('stopProcess: root is required');
  if (!pid) throw new Error('stopProcess: pid is required');

  const owned = listRegistered({ root }).map((p) => ({
    pid: p.pid,
    owner_task_id: p.owner_task_id,
    command_hash: p.command_hash,
    process_id: p.process_id,
  }));

  const gate = evaluateProcessStop({ target: { strategy, pid, owner_task_id }, ownedProcesses: owned });
  if (!gate.allowed) {
    appendRegistry({
      root,
      record: { type: 'PROCESS_STOP_DENIED', pid, strategy, owner_task_id, reasons: gate.reasons, chosen_strategy: gate.chosen_strategy },
    });
    return { ok: false, stage: 'gate', pid, strategy, reasons: gate.reasons, chosen_strategy: gate.chosen_strategy, killed: false };
  }

  // 在册且 owner 对得上，才记录目标
  const target = owned.find((p) => p.pid === pid && (!owner_task_id || p.owner_task_id === owner_task_id));
  // 记录"动手前它是否还活着"：否则对一个本来就死的进程会谎报 killed=true
  const wasAliveBefore = isAlive(pid);
  appendRegistry({
    root,
    record: { type: 'PROCESS_STOP_REQUESTED', process_id: target?.process_id ?? null, pid, strategy, signal, owner_task_id, was_alive_before: wasAliveBefore },
  });

  let killError = null;
  if (wasAliveBefore) {
    try {
      process.kill(pid, signal);
    } catch (e) {
      killError = String(e && e.code ? e.code : e);
    }
  }

  const exit = await waitForExit(pid, { timeoutMs, sleep });

  const rec = appendRegistry({
    root,
    record: {
      type: 'PROCESS_STOPPED',
      process_id: target?.process_id ?? null,
      pid,
      strategy,
      signal,
      owner_task_id,
      was_alive_before: wasAliveBefore,
      already_dead: !wasAliveBefore,
      gone: exit.gone,
      waited_ms: exit.waited_ms,
      kill_error: killError,
    },
  });

  return {
    ok: exit.gone,
    stage: 'stopped',
    pid,
    strategy,
    signal,
    // killed 只表示"它本来活着、现在被我停掉了"；本来就死的进程不算我停的
    killed: wasAliveBefore && exit.gone,
    already_dead: !wasAliveBefore,
    was_alive_before: wasAliveBefore,
    waited_ms: exit.waited_ms,
    kill_error: killError,
    process_id: target?.process_id ?? null,
    record: rec,
  };
}

/** 只读视图：在册进程 + 优先级/禁用策略，便于人查。 */
export function processBrokerStatus({ root, owner_task_id = undefined } = {}) {
  const rows = listRegistered({ root, owner_task_id });
  return {
    root: path.resolve(root),
    registry: registryFile({ root }),
    alive: rows.map((r) => ({ process_id: r.process_id, pid: r.pid, owner_task_id: r.owner_task_id, alive: isAlive(r.pid), stop_method: r.stop_method })),
    dead_but_registered: rows.filter((r) => !isAlive(r.pid)).map((r) => r.process_id),
    stop_priority: [...STOP_PRIORITY],
    forbidden_strategies: [...FORBIDDEN_STOP_STRATEGIES],
  };
}

/** 清理登记表里已经死掉的条目（只留档一条 RECONCILED，不删历史）。 */
export function reconcile({ root } = {}) {
  const rows = listRegistered({ root });
  const stale = rows.filter((r) => !isAlive(r.pid));
  for (const r of stale) {
    appendRegistry({ root, record: { type: 'PROCESS_RECONCILED', process_id: r.process_id, pid: r.pid, reason: 'not_alive' } });
  }
  return { checked: rows.length, reconciled: stale.map((r) => r.process_id) };
}
