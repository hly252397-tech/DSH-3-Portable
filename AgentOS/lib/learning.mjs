// Learning Promotion + Skill/Tool 自我开发 —— 任务单第二十三节（学习晋升）+ 第二十四节。
//
// 晋升链（顺序不可跳）：
//   Observation -> Experience Candidate -> Regression Test -> 多次验证 -> Verifier
//   -> Validated Knowledge -> Skill Candidate -> Benchmark -> Shadow Mode -> Production Skill
//
// 铁律：
//   - 未经验证的经验不得直接成为正式知识或正式 Skill。
//   - 禁止把一次偶然成功学成全局规则（需要**多个不同上下文**的验证）。
//   - 禁止直接修改正在运行的 Stable Core；Supervisor/Policy/Recovery 必须 A/B Runtime。

export const LEARNING_STAGES = Object.freeze([
  'OBSERVATION',
  'EXPERIENCE_CANDIDATE',
  'REGRESSION_TESTED',
  'VALIDATED',
  'VERIFIER_PASSED',
  'VALIDATED_KNOWLEDGE',
  'SKILL_CANDIDATE',
  'BENCHMARKED',
  'SHADOWED',
  'PRODUCTION_SKILL',
]);

export const DEFAULT_PROMOTION_POLICY = Object.freeze({
  min_validations: 3,
  require_distinct_contexts: true,
  require_regression_test: true,
  require_verifier: true,
  require_benchmark: true,
  require_shadow_mode: true,
  require_rollback_available: true,
});

function okValidations(record) {
  return (record.validations || []).filter((v) => v && v.ok === true);
}

function distinctContextCount(record, policy) {
  const ok = okValidations(record);
  if (policy.require_distinct_contexts === false) return ok.length;
  return new Set(ok.map((v) => v.context)).size;
}

/** 依据记录内容判定「当前最多能站到哪一级」。 */
export function evaluateStage(record, policy = DEFAULT_PROMOTION_POLICY) {
  const r = record || {};
  const distinct = distinctContextCount(r, policy);

  const gates = {
    has_hypothesis: typeof r.hypothesis === 'string' && r.hypothesis.trim().length > 0,
    regression_ok: r.regression_test ? r.regression_test.passing === true : policy.require_regression_test !== true,
    validations_ok: distinct >= policy.min_validations,
    distinct_ok_contexts: distinct,
    verifier_ok: r.verifier ? r.verifier.status === 'PASS' : policy.require_verifier !== true,
    benchmark_ok: r.benchmark
      ? typeof r.benchmark.delta === 'number' || r.benchmark.verdict === 'accepted'
      : policy.require_benchmark !== true,
    shadow_ok: r.shadow ? r.shadow.mode === 'shadow' || r.shadow.mode === 'production' : policy.require_shadow_mode !== true,
    rollback_ok: r.rollback ? r.rollback.available === true : policy.require_rollback_available !== true,
  };

  let stage = 'OBSERVATION';
  if (gates.has_hypothesis) stage = 'EXPERIENCE_CANDIDATE';
  if (stage === 'EXPERIENCE_CANDIDATE' && gates.regression_ok) stage = 'REGRESSION_TESTED';
  if (stage === 'REGRESSION_TESTED' && gates.validations_ok) stage = 'VALIDATED';
  if (stage === 'VALIDATED' && gates.verifier_ok) stage = 'VERIFIER_PASSED';
  if (stage === 'VERIFIER_PASSED') stage = 'VALIDATED_KNOWLEDGE';
  if (stage === 'VALIDATED_KNOWLEDGE') stage = 'SKILL_CANDIDATE';
  if (stage === 'SKILL_CANDIDATE' && gates.benchmark_ok) stage = 'BENCHMARKED';
  if (stage === 'BENCHMARKED' && gates.shadow_ok) stage = 'SHADOWED';
  if (stage === 'SHADOWED' && gates.rollback_ok) stage = 'PRODUCTION_SKILL';

  return { stage, gates, eligible_for_production: stage === 'PRODUCTION_SKILL' };
}

/** 下一级还差什么。 */
export function evaluateLearningPromotion(record, policy = DEFAULT_PROMOTION_POLICY) {
  const ev = evaluateStage(record, policy);
  const idx = LEARNING_STAGES.indexOf(ev.stage);
  const next = LEARNING_STAGES[idx + 1] ?? null;
  const blockers = [];

  if (next === 'EXPERIENCE_CANDIDATE' && !ev.gates.has_hypothesis) {
    blockers.push({ requirement: 'hypothesis', detail: '经验候选必须有明确假设，不能只有一次观察' });
  }
  if (next === 'REGRESSION_TESTED' && !ev.gates.regression_ok) {
    blockers.push({ requirement: 'regression_test', detail: '需要一条通过中的回归用例' });
  }
  if (next === 'VALIDATED' && !ev.gates.validations_ok) {
    blockers.push({
      requirement: 'validations',
      detail: `需要 ${policy.min_validations} 个**不同上下文**的成功验证，当前 ${ev.gates.distinct_ok_contexts} 个`,
    });
  }
  if (next === 'VERIFIER_PASSED' && !ev.gates.verifier_ok) {
    blockers.push({ requirement: 'verifier', detail: 'Verifier 必须返回 PASS' });
  }
  if (next === 'BENCHMARKED' && !ev.gates.benchmark_ok) {
    blockers.push({ requirement: 'benchmark', detail: '需要 benchmark 的 delta 或 accepted 结论' });
  }
  if (next === 'SHADOWED' && !ev.gates.shadow_ok) {
    blockers.push({ requirement: 'shadow_mode', detail: '必须先以 shadow 模式运行' });
  }
  if (next === 'PRODUCTION_SKILL' && !ev.gates.rollback_ok) {
    blockers.push({ requirement: 'rollback', detail: '必须存在可用的回滚路径' });
  }

  return {
    stage: ev.stage,
    next_stage: next,
    gates: ev.gates,
    blockers,
    would_advance: blockers.length === 0 && next !== null,
    eligible_for_production: ev.eligible_for_production,
  };
}

/**
 * 跳级检测：请求的等级高于「当前内容实际够格」的等级 -> 拒绝。
 * 这条直接落实「未经验证的经验不得直接成为正式知识或正式 Skill」。
 */
export function assertNoShortcut(record, requestedStage, policy = DEFAULT_PROMOTION_POLICY) {
  const ev = evaluateStage(record, policy);
  const to = LEARNING_STAGES.indexOf(requestedStage);
  if (to < 0) return { ok: false, error: 'unknown_stage', requested_stage: requestedStage, allowed: [...LEARNING_STAGES] };
  const qualified = LEARNING_STAGES.indexOf(ev.stage);
  if (to > qualified) {
    return {
      ok: false,
      error: 'would_skip_required_gates',
      qualified_stage: ev.stage,
      requested_stage: requestedStage,
      gates: ev.gates,
    };
  }
  return { ok: true, qualified_stage: ev.stage, requested_stage: requestedStage, gates: ev.gates };
}

/**
 * 第二十四节：Skill / Tool / Workflow / Runtime 候选的晋升门。
 * Candidate -> Sandbox -> Test -> Benchmark -> Shadow Mode -> Verifier -> Promote -> Rollback Available
 */
export function evaluateArtifactCandidate({
  targetIsRunningStableCore = false,
  candidateIsolated = false,
  tested = false,
  benchmarked = false,
  shadowed = false,
  verifierPassed = false,
  rollbackAvailable = false,
} = {}) {
  const blockers = [];
  if (targetIsRunningStableCore) blockers.push('direct_modification_of_running_stable_core_forbidden');
  if (!candidateIsolated) blockers.push('candidate_must_be_isolated');
  if (!tested) blockers.push('sandbox_test_required');
  if (!benchmarked) blockers.push('benchmark_required');
  if (!shadowed) blockers.push('shadow_mode_required');
  if (!verifierPassed) blockers.push('verifier_pass_required');
  if (!rollbackAvailable) blockers.push('rollback_must_be_available');

  return {
    ok: blockers.length === 0,
    blockers,
    action: blockers.length ? 'REJECT' : 'PROMOTE',
    pipeline: ['candidate', 'sandbox', 'test', 'benchmark', 'shadow_mode', 'verifier', 'promote', 'rollback_available'],
    ab_runtime: {
      a: 'current_stable_keeps_running',
      b: 'candidate_tested_independently',
      on_candidate_failure: 'restore_a',
      applies_to: ['supervisor', 'policy_engine', 'recovery_engine'],
    },
  };
}
