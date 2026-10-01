// Task State Machine —— 任务单第六节 + 第十五节（事件 -> 状态）。
//
// 铁律：
//   - 任务状态只能由 Task Engine 改（Agent Worker 无权）。
//   - 合法终态只有 4 个：COMPLETED / BLOCKED_USER / BLOCKED_POLICY / FAILED_EXHAUSTED。
//   - MUST_CONTINUE_STATES 里的状态**不得**结束任务或等待用户继续。
//   - 进入 COMPLETED 必须过完成守卫（退出条件 + Goal Contract + 指纹 + 候选晋升）。
import { nowIso } from './paths.mjs';

export const STATES = Object.freeze([
  'NEW',
  'SCOPING',
  'PLANNING',
  'EXECUTING',
  'DIRTY',
  'VERIFYING',
  'VERIFY_FAILED',
  'REPAIRING',
  'CLEANING',
  'PACKAGING',
  'READY_TO_COMPLETE',
  'COMPLETED',
  'BLOCKED_USER',
  'BLOCKED_POLICY',
  'FAILED_EXHAUSTED',
  'BOOT_BROKEN',
  'RECOVERING',
  'RESUMING_PARENT',
]);

/** 第六节：合法终态。 */
export const TERMINAL_STATES = Object.freeze(['COMPLETED', 'BLOCKED_USER', 'BLOCKED_POLICY', 'FAILED_EXHAUSTED']);

/** 第六节：这些状态不得结束任务或等待用户继续。 */
export const MUST_CONTINUE_STATES = Object.freeze([
  'SCOPING',
  'PLANNING',
  'EXECUTING',
  'DIRTY',
  'VERIFYING',
  'VERIFY_FAILED',
  'REPAIRING',
  'CLEANING',
  'PACKAGING',
  'RESUMING_PARENT',
  'RECOVERING',
]);

/** 第六节：只要仍存在可自动执行的工作就必须继续的状态（含 BOOT_BROKEN）。 */
export const NON_TERMINAL_STATES = Object.freeze(STATES.filter((s) => !TERMINAL_STATES.includes(s)));

export const TRANSITIONS = Object.freeze({
  NEW: ['SCOPING'],
  SCOPING: ['PLANNING', 'BLOCKED_POLICY', 'BLOCKED_USER', 'BOOT_BROKEN', 'FAILED_EXHAUSTED'],
  PLANNING: ['EXECUTING', 'BLOCKED_USER', 'BLOCKED_POLICY', 'FAILED_EXHAUSTED', 'BOOT_BROKEN'],
  EXECUTING: ['DIRTY', 'VERIFYING', 'CLEANING', 'VERIFY_FAILED', 'BLOCKED_USER', 'BLOCKED_POLICY', 'FAILED_EXHAUSTED', 'BOOT_BROKEN', 'RECOVERING'],
  DIRTY: ['VERIFYING', 'REPAIRING', 'CLEANING', 'RECOVERING', 'FAILED_EXHAUSTED', 'BOOT_BROKEN'],
  VERIFYING: ['VERIFY_FAILED', 'CLEANING', 'READY_TO_COMPLETE', 'DIRTY', 'BOOT_BROKEN', 'RECOVERING', 'FAILED_EXHAUSTED'],
  VERIFY_FAILED: ['REPAIRING', 'FAILED_EXHAUSTED', 'RECOVERING', 'BLOCKED_POLICY', 'BOOT_BROKEN'],
  REPAIRING: ['DIRTY', 'VERIFYING', 'FAILED_EXHAUSTED', 'RECOVERING', 'BOOT_BROKEN', 'BLOCKED_POLICY'],
  CLEANING: ['PACKAGING', 'EXECUTING', 'DIRTY', 'FAILED_EXHAUSTED', 'RECOVERING', 'BOOT_BROKEN'],
  PACKAGING: ['READY_TO_COMPLETE', 'REPAIRING', 'RECOVERING', 'FAILED_EXHAUSTED', 'BOOT_BROKEN'],
  READY_TO_COMPLETE: ['COMPLETED', 'REPAIRING', 'FAILED_EXHAUSTED', 'RECOVERING', 'DIRTY'],
  COMPLETED: [],
  BLOCKED_USER: [],
  BLOCKED_POLICY: [],
  FAILED_EXHAUSTED: [],
  BOOT_BROKEN: ['RECOVERING', 'BLOCKED_POLICY'],
  RECOVERING: ['RESUMING_PARENT', 'DIRTY', 'VERIFYING', 'FAILED_EXHAUSTED', 'BOOT_BROKEN', 'BLOCKED_POLICY'],
  RESUMING_PARENT: ['EXECUTING', 'DIRTY', 'VERIFYING', 'COMPLETED', 'FAILED_EXHAUSTED', 'RECOVERING'],
});

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/** 第十七节相关：当前状态**是否允许**收工/等用户。 */
export function mayStop(state) {
  if (!STATES.includes(state)) return false;
  if (isTerminal(state)) return true;
  return !MUST_CONTINUE_STATES.includes(state);
}

/**
 * 终态归属目录（第五节的 tasks/active | tasks/completed | tasks/failed）。
 * COMPLETED -> completed；FAILED_EXHAUSTED -> failed；
 * BLOCKED_USER / BLOCKED_POLICY 仍留在 active（任务仍归系统所有，等合法外部决定）。
 */
export function terminalDirFor(state) {
  if (state === 'COMPLETED') return 'completed';
  if (state === 'FAILED_EXHAUSTED') return 'failed';
  return null;
}

/**
 * 在合法迁移图上做 BFS，返回 from -> to 的最短路径（**不含** from，含 to）。
 * 用途：Supervisor 要把任务推到 READY_TO_COMPLETE 时走合法路径，而不是硬塞跳步。
 * 不可达返回 null。
 */
export function findTransitionPath(from, to, { maxDepth = 10 } = {}) {
  if (!STATES.includes(from) || !STATES.includes(to)) return null;
  if (from === to) return [];
  if (isTerminal(from)) return null;
  const queue = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const path = queue.shift();
    if (path.length > maxDepth) continue;
    const last = path[path.length - 1];
    for (const next of TRANSITIONS[last] || []) {
      if (next === to) return [...path.slice(1), next];
      if (seen.has(next) || isTerminal(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

export function createTask({ id, goal_contract_id = null, state = 'NEW', parent_task_id = null } = {}) {
  if (!id) throw new Error('createTask: id is required');
  if (!STATES.includes(state)) throw new Error('createTask: unknown state ' + state);
  return {
    schema_version: 1,
    id,
    goal_contract_id,
    parent_task_id,
    state,
    created_at: nowIso(),
    updated_at: nowIso(),
    history: [{ from: null, to: state, at: nowIso(), reason: 'created' }],
  };
}

/**
 * 迁状态。返回 { ok, record } 或 { ok:false, error, ... }。
 * 不抛异常，方便调用方逐条汇总阻塞原因。
 */
export function transition(record, to, { reason = null, guard = null } = {}) {
  if (!record || !record.state) return { ok: false, error: 'invalid_task_record' };
  const from = record.state;
  if (!STATES.includes(from)) return { ok: false, error: 'unknown_current_state', from };
  if (!STATES.includes(to)) return { ok: false, error: 'unknown_target_state', to };
  if (isTerminal(from)) return { ok: false, error: 'terminal_state_has_no_transitions', from };

  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) return { ok: false, error: 'illegal_transition', from, to, allowed };

  if (to === 'COMPLETED') {
    // 第六节 + 第十七节：COMPLETED 必须过完成守卫，Agent 无权自行宣布
    const g = guard || {};
    const blockers = [];
    if (g.exitOk !== true) blockers.push('exit_guard_not_ok');
    if (g.contractDone !== true) blockers.push('goal_contract_not_done');
    if (g.fingerprintMatch !== true) blockers.push('fingerprint_mismatch');
    if (g.candidateOutcome !== 'promoted') blockers.push('candidate_not_promoted');
    if (blockers.length) return { ok: false, error: 'completion_guard_failed', blockers };
  }

  const at = nowIso();
  return {
    ok: true,
    record: {
      ...record,
      state: to,
      updated_at: at,
      history: [...(record.history || []), { from, to, at, reason }],
    },
  };
}

/** 与 transition 相同，但非法即抛（给 Gate 用）。 */
export function assertTransition(record, to, opts) {
  const r = transition(record, to, opts);
  if (!r.ok) {
    const e = new Error(`illegal task transition ${record && record.state} -> ${to}: ${r.error}`);
    e.detail = r;
    throw e;
  }
  return r.record;
}

/**
 * 第十五节：关键事件 -> 任务状态。
 * PASS / PROCESS_EXIT 不改变状态（它们是信息性的，由消费方决定）。
 */
export function deriveStateFromCriticalEvent(eventType) {
  switch (String(eventType)) {
    case 'FAIL':
    case 'TIMEOUT':
    case 'ERROR':
      return 'VERIFY_FAILED';
    case 'BOOT_FAILED':
      return 'BOOT_BROKEN';
    case 'INVALID':
      return 'DIRTY';
    case 'PASS':
    case 'PROCESS_EXIT':
      return null;
    default:
      return null;
  }
}
