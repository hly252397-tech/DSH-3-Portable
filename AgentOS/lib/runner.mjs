// Runtime Governor —— 任务单第三节（Supervisor / Runtime Governor）的"可被反复触发"那一半。
//
// 为什么需要它：Supervisor 是一次**进程内**循环。高自治要求的不是"跑一次跑完"，
// 而是「任何时刻被触发都能接着上次的进度继续，进程重启也不丢」。所以：
//   - 每次治理调用有步数预算（外部触发不会被一次调用卡死）；
//   - 已满足的合约条目、计数器、失败集合**持久化**，下次调用续跑；
//   - 每次调用写 status.json（心跳），外部触发/人一眼能看出"现在到哪了、下一步该干嘛"。
//
// 本模块**不决定**触发方式（git hook / DSH 插件 / watcher 由用户拍板）；它只定义"被触发时该干什么"。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, atomicWriteJson, readJsonIfExists, nowIso } from './paths.mjs';
import { Supervisor } from './supervisor.mjs';
import { terminalDirFor, isTerminal, mayStop } from './taskstate.mjs';
import { runGatePipeline } from './gateengine.mjs';
import { DEFAULT_LIMITS } from './stopline.mjs';

export const DEFAULT_STEP_BUDGET = 25;

export function runPaths({ root, taskId }) {
  const dir = path.join(root, 'workspaces', taskId);
  return { dir, run: path.join(dir, 'run.json'), status: path.join(dir, 'status.json') };
}

export function findTaskFile({ root, taskId }) {
  for (const d of ['active', 'completed', 'failed']) {
    const file = path.join(root, 'tasks', d, `${taskId}.json`);
    if (fs.existsSync(file)) return { file, dir: d, state: readJsonIfExists(file) };
  }
  return null;
}

export function loadRunState({ root, taskId }) {
  const p = runPaths({ root, taskId });
  const j = readJsonIfExists(p.run);
  if (j) return j;
  return {
    schema_version: 1,
    task_id: taskId,
    invocation: 0,
    satisfied: [],
    counters: {},
    failures: [],
    total_steps: 0,
    created_at: nowIso(),
    updated_at: null,
    history: [],
  };
}

export function saveRunState({ root, taskId, state }) {
  const p = runPaths({ root, taskId });
  ensureDir(p.dir);
  atomicWriteJson(p.run, state, { keepBak: false });
  return p.run;
}

/** 一次治理调用结束后，下一次触发该干什么。 */
export function deriveNextAction(r, bootFailed = false) {
  if (bootFailed) return 'BOOT_FAILED';
  const stopped = r.stopped?.action ?? null;
  if (stopped === 'STOP_THE_LINE') return 'STOP_THE_LINE';
  if (r.is_terminal) return 'DONE';
  if (r.state === 'BLOCKED_USER') return 'BLOCKED_USER';
  if (r.state === 'BLOCKED_POLICY') return 'BLOCKED_POLICY';
  if (r.state === 'FAILED_EXHAUSTED') return 'FAILED_EXHAUSTED';
  return 'CONTINUE';
}

/**
 * 治理一次。幂等：同一任务反复调用会从上次进度继续，直到终态。
 *
 * @param {object} o
 * @param {string} o.root
 * @param {string} o.taskId
 * @param {object} o.worker                        Supervisor 的 Worker（必需）
 * @param {number} [o.stepBudget]                  本次调用的步数预算
 * @param {object} [o.policy]                      指纹 / 候选结论等
 * @param {object} [o.ledger]
 * @param {object} [o.memory]
 * @param {object} [o.verify]                      给了就跑七层门禁管线（可含自动启动审计）
 */
export async function governOnce({
  root,
  taskId,
  worker,
  stepBudget = DEFAULT_STEP_BUDGET,
  policy = {},
  ledger = null,
  memory = null,
  limits = DEFAULT_LIMITS,
  verify = null,
} = {}) {
  if (!root) throw new Error('governOnce: root is required');
  if (!taskId) throw new Error('governOnce: taskId is required');
  if (!worker || typeof worker.act !== 'function') throw new Error('governOnce: worker.act is required');

  const found = findTaskFile({ root, taskId });
  if (!found) return { ok: false, error: 'task_not_found', task_id: taskId };
  const bundle = found.state;
  if (!bundle || !bundle.task || !bundle.contract) {
    return { ok: false, error: 'task_bundle_incomplete', task_id: taskId, file: found.file };
  }

  const prev = loadRunState({ root, taskId });
  const invocation = (prev.invocation || 0) + 1;

  // ---- 1) 门禁管线（可选；启动审计可在其中自动执行）----
  let gate = null;
  let bootFailed = false;
  if (verify) {
    gate = await runGatePipeline({
      root,
      task_id: taskId,
      candidate_id: verify.candidateId ?? null,
      extraFiles: verify.extraFiles || {},
      layers: verify.layers || {},
      runBootAudit: verify.runBootAudit === true,
      profileDir: verify.profileDir ?? null,
      harnessSlotDir: verify.harnessSlotDir ?? null,
      probeUrls: verify.probeUrls || [],
      moduleUrls: verify.moduleUrls || [],
      allowPartialBoot: verify.allowPartialBoot !== false,
      rejectCandidateOnBootFailure: verify.rejectCandidateOnBootFailure !== false,
      verdictsDir: verify.verdictsDir ?? null,
    });
    bootFailed = gate.boot?.status === 'BOOT_FAILED';
    if (ledger) {
      ledger.append({
        type: gate.verdict.status,
        task_id: taskId,
        candidate_id: verify.candidateId ?? null,
        run_id: gate.verdict.run_id,
        detail: 'governOnce:' + gate.verdict.status_reason,
      });
    }
  }

  // ---- 2) 用上次进度续跑 Supervisor ----
  const sup = new Supervisor({
    task: bundle.task,
    contract: bundle.contract,
    worker,
    ledger,
    memory,
    limits,
    policy: {
      ...policy,
      initial_satisfied: prev.satisfied || [],
      initial_counters: prev.counters || {},
    },
  });
  sup.failures = [...(prev.failures || [])];

  const r = await sup.run({ maxSteps: stepBudget });

  // ---- 3) 持久化进度（这是"进程重启不丢"的关键）----
  const nextState = {
    ...prev,
    invocation,
    satisfied: [...sup.satisfied],
    counters: { ...sup.counters },
    failures: [...sup.failures],
    total_steps: (prev.total_steps || 0) + r.steps,
    updated_at: nowIso(),
    last_state: r.state,
    last_stopped: r.stopped?.action ?? null,
    // §26 控制台要看"父任务 resume point"，所以把栈信息持久化下来
    stack_depth: r.stack_depth ?? 1,
    resume_points: r.resume_points ?? [],
    subtasks: (r.subtasks ?? []).map((s) => ({ id: s.id, reason: s.reason, items: s.items })),
    history: [...(prev.history || []).slice(-49), { invocation, at: nowIso(), state: r.state, steps: r.steps, stopped: r.stopped?.action ?? null }],
  };
  const runFile = saveRunState({ root, taskId, state: nextState });

  // ---- 4) 终态归位（复用公共规则，不各写一份）----
  let movedTo = found.file;
  const dstDir = terminalDirFor(r.state);
  if (dstDir && found.dir !== dstDir) {
    const dst = path.join(root, 'tasks', dstDir, `${taskId}.json`);
    ensureDir(path.dirname(dst));
    atomicWriteJson(dst, { ...bundle, task: { ...bundle.task, state: r.state } }, { keepBak: false });
    fs.rmSync(found.file, { force: true });
    movedTo = dst;
  } else if (dstDir) {
    atomicWriteJson(found.file, { ...bundle, task: { ...bundle.task, state: r.state } }, { keepBak: false });
  }

  // ---- 5) 心跳 / 状态文件 ----
  const nextAction = deriveNextAction(r, bootFailed);
  const status = {
    schema_version: 1,
    task_id: taskId,
    updated_at: nowIso(),
    invocation,
    state: r.state,
    is_terminal: r.is_terminal,
    may_stop: r.may_stop,
    next_action: nextAction,
    contract: {
      total: r.contract_progress.total,
      done: r.contract_progress.done,
      unmet: r.contract_progress.unmet.map((u) => u.id),
    },
    exit_status: r.exit_status,
    counters: r.counters,
    last_stopped: r.stopped ?? null,
    boot: gate?.boot ?? null,
    gate_verdict: gate?.verdict?.status ?? null,
    steps_this_invocation: r.steps,
    total_steps: nextState.total_steps,
    task_file: movedTo,
    run_file: runFile,
  };
  const p = runPaths({ root, taskId });
  atomicWriteJson(p.status, status, { keepBak: false });

  return {
    ok: true,
    task_id: taskId,
    invocation,
    state: r.state,
    is_terminal: r.is_terminal,
    may_stop: r.may_stop,
    next_action: nextAction,
    steps_this_invocation: r.steps,
    total_steps: nextState.total_steps,
    satisfied: nextState.satisfied,
    counters: nextState.counters,
    failures: nextState.failures,
    contract_progress: r.contract_progress,
    supervisor_stopped: r.stopped,
    gate: gate ? { verdict_status: gate.verdict.status, boot: gate.boot, enforcement: gate.enforcement } : null,
    persisted: { run_file: runFile, status_file: p.status, task_file: movedTo },
  };
}

/** 只读心跳：外部触发/人用来判断"现在到哪了"，不做任何副作用。 */
export function readGovernorStatus({ root, taskId }) {
  const p = runPaths({ root, taskId });
  const status = readJsonIfExists(p.status);
  const run = readJsonIfExists(p.run);
  return {
    task_id: taskId,
    has_status: Boolean(status),
    status,
    run: run ? { invocation: run.invocation, satisfied: run.satisfied, counters: run.counters, failures: run.failures, total_steps: run.total_steps, updated_at: run.updated_at } : null,
    files: p,
  };
}

export { isTerminal, mayStop };
