// Stop-the-Line —— 任务单第十四节。
//
// 达到任一上限后：停止补丁 -> 恢复 Stable -> 完整读实现 -> 重建依赖图 -> 最小复现
//                -> 重建根因假设 -> 全新 Candidate -> 不询问用户普通技术问题。
import { nowIso } from './paths.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  max_consecutive_regressions: 1,
  max_same_strategy_retry: 1,
  max_patch_chain_depth: 1,
  max_no_progress_steps: 3,
  max_self_inflicted_errors: 2,
});

/** 第十四节的 8 个强制动作。 */
export const STOP_LINE_STEPS = Object.freeze([
  'stop_patching',
  'restore_last_stable',
  'read_relevant_implementation_fully',
  'rebuild_dependency_graph_and_dataflow',
  'build_minimal_reproduction',
  'rebuild_root_cause_hypothesis',
  'create_fresh_candidate',
  'do_not_ask_user_trivial_questions',
]);

/**
 * @param {object} o
 * @param {object} o.counters  与 limits 同键的当前计数
 * @param {object} o.limits
 */
export function evaluateStopLine({ counters = {}, limits = DEFAULT_LIMITS } = {}) {
  const violations = [];
  for (const [k, max] of Object.entries(limits)) {
    // limits 用 max_* 命名，计数器的键去掉前缀（consecutive_regressions 等）
    const ck = k.startsWith('max_') ? k.slice(4) : k;
    const v = Number(counters[ck] ?? 0);
    if (Number.isFinite(v) && v > max) violations.push({ counter: ck, limit: k, value: v, max });
  }
  const tripped = violations.length > 0;
  return {
    tripped,
    violations,
    action: tripped ? 'STOP_THE_LINE' : 'CONTINUE',
    steps: tripped ? [...STOP_LINE_STEPS] : [],
    limits: { ...limits },
    evaluated_at: nowIso(),
  };
}

/** 推进计数器的便利函数（Candidate 判废 / 同策略重试 / 补丁深度 / 无进展 / 自伤）。 */
export function bumpCounter(counters, key, by = 1) {
  const next = { ...counters, [key]: Number(counters[key] ?? 0) + by };
  return { counters: next, decision: evaluateStopLine({ counters: next }) };
}

/** 计数器键（limits 去掉 max_ 前缀）。 */
export const COUNTER_KEYS = Object.freeze(
  Object.keys(DEFAULT_LIMITS).map((k) => (k.startsWith('max_') ? k.slice(4) : k)),
);

export function resetCounters(counters, keys = COUNTER_KEYS) {
  const next = { ...counters };
  for (const k of keys) next[k] = 0;
  return next;
}
