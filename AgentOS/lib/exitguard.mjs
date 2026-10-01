// Exit Guard —— 任务单第十七节。
//
// Agent 准备结束当前任务前，Task Engine 必须逐条检查。任一不满足 -> EXIT_BLOCKED，
// 系统自动选择下一可执行事项继续；**不允许**用「等待用户说继续」来结束。
import { readJsonIfExists } from './paths.mjs';

/** 第十七节的 13 个退出条件。 */
export const EXIT_CONDITIONS = Object.freeze([
  { field: 'pending_items', expected: 0, kind: 'eq' },
  { field: 'executable_items', expected: 0, kind: 'eq' },
  { field: 'known_defects', expected: 0, kind: 'eq' },
  { field: 'new_failures', expected: 0, kind: 'eq' },
  { field: 'unexpected_deltas', expected: 0, kind: 'eq' },
  { field: 'unverified_changes', expected: 0, kind: 'eq' },
  { field: 'temporary_artifacts', expected: 0, kind: 'eq' },
  { field: 'failed_gates', expected: 0, kind: 'eq' },
  { field: 'unconsumed_critical_events', expected: 0, kind: 'eq' },
  { field: 'incomplete_acceptance_items', expected: 0, kind: 'eq' },
  { field: 'workspace_dirty', expected: false, kind: 'eq' },
  { field: 'parent_task_stack_empty', expected: true, kind: 'eq' },
  { field: 'current_fingerprint', expected: null, kind: 'fingerprint_eq' },
]);

function asCount(v) {
  if (Array.isArray(v)) return v.length;
  if (v === undefined || v === null) return 0;
  return Number(v);
}

/**
 * @param {object} state 见 EXIT_CONDITIONS 的 field 列表。
 *   last_pass_fingerprint 与 current_fingerprint 一起用于第 13 条。
 */
export function evaluateExit(state = {}) {
  const blockers = [];
  for (const cond of EXIT_CONDITIONS) {
    if (cond.kind === 'fingerprint_eq') {
      const cur = state.current_fingerprint ?? null;
      const last = state.last_pass_fingerprint ?? null;
      if (!cur || !last || cur !== last) {
        blockers.push({ field: 'current_fingerprint', actual: cur, required: 'current_fingerprint == last_pass_fingerprint', detail: last ? 'mismatch' : 'no_last_pass' });
      }
      continue;
    }
    const raw = state[cond.field];
    if (cond.kind === 'eq' && typeof cond.expected === 'boolean') {
      if (raw !== cond.expected) blockers.push({ field: cond.field, actual: raw, required: cond.expected });
    } else {
      const n = asCount(raw);
      if (n !== cond.expected) blockers.push({ field: cond.field, actual: n, required: cond.expected });
    }
  }
  return {
    status: blockers.length ? 'EXIT_BLOCKED' : 'OK',
    blockers,
    checked: EXIT_CONDITIONS.length,
  };
}

/** 第十七节：出现这些词，必须检查对应工作是否已入队/执行/有合法用户阻塞。 */
export const DEFERRED_PHRASES = Object.freeze([
  '下一步',
  '下一轮',
  '之后',
  '稍后',
  '接下来会',
  '准备处理',
  '剩余',
  '还没完成',
]);

export function detectDeferredPhrases(text) {
  const s = String(text ?? '');
  return DEFERRED_PHRASES.filter((p) => s.includes(p));
}

/**
 * 拒绝「把未完成的工作写进答复就退出」。
 * @param {object} o
 * @param {string} o.text            即将发出的答复
 * @param {Array}  o.queuedItems     已入队的待办
 * @param {Array}  o.runningItems    正在执行的待办
 * @param {boolean} o.blockedUser    是否存在**合法**用户阻塞（缺凭据/待拍板/难回滚确认）
 */
export function checkDeferredWork({ text = '', queuedItems = [], runningItems = [], blockedUser = false } = {}) {
  const phrases = detectDeferredPhrases(text);
  if (!phrases.length) return { allowed: true, blocked_phrases: [], reason: 'no_deferred_phrasing' };
  const hasQueued = queuedItems.length > 0;
  const hasRunning = runningItems.length > 0;
  if (hasQueued || hasRunning) {
    return { allowed: true, blocked_phrases: phrases, reason: hasRunning ? 'work_already_running' : 'work_already_queued' };
  }
  if (blockedUser) {
    return { allowed: true, blocked_phrases: phrases, reason: 'legitimate_user_block' };
  }
  return { allowed: false, blocked_phrases: phrases, reason: 'deferred_work_not_queued_must_continue' };
}

/** 便利：从账本 + 状态合成一个 exit state。 */
export function buildExitStateFrom({ stateFile, ledger, workspaceDirty, currentFingerprint, lastPassFingerprint }) {
  const s = readJsonIfExists(stateFile) || {};
  return {
    pending_items: s.pending_items ?? 0,
    executable_items: s.executable_items ?? 0,
    known_defects: s.known_defects ?? 0,
    new_failures: s.new_failures ?? [],
    unexpected_deltas: s.unexpected_deltas ?? [],
    unverified_changes: s.unverified_changes ?? 0,
    temporary_artifacts: s.temporary_artifacts ?? 0,
    failed_gates: s.failed_gates ?? 0,
    unconsumed_critical_events: ledger ? ledger.unconsumedCritical().length : 0,
    incomplete_acceptance_items: s.incomplete_acceptance_items ?? 0,
    workspace_dirty: workspaceDirty === true,
    parent_task_stack_empty: s.parent_task_stack_empty !== false,
    current_fingerprint: currentFingerprint ?? null,
    last_pass_fingerprint: lastPassFingerprint ?? null,
  };
}
