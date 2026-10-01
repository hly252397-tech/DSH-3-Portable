// 任务单第二十三、二十四节 —— Experience Memory + 学习晋升 + Skill/Tool 自我开发
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTempDir, rmrf } from './helpers.mjs';
import { MemoryStore, MEMORY_KINDS, MEMORY_KIND_DIRS, MEMORY_STATUSES, WORKING_MEMORY_LOCATION } from '../lib/memory.mjs';
import {
  LEARNING_STAGES,
  DEFAULT_PROMOTION_POLICY,
  evaluateStage,
  evaluateLearningPromotion,
  assertNoShortcut,
  evaluateArtifactCandidate,
} from '../lib/learning.mjs';

function withStore(fn) {
  const dir = makeTempDir('mem-');
  try {
    return fn(new MemoryStore({ root: dir }), dir);
  } finally {
    rmrf(dir);
  }
}

test('§23-1: 六种记忆与第五节目录一一对应；working 不在目录里', () => {
  assert.deepEqual([...MEMORY_KINDS], ['episodic', 'semantic', 'procedural', 'self_model', 'world_model', 'project_model']);
  assert.equal(MEMORY_KIND_DIRS.episodic, 'memory/episodic');
  assert.equal(MEMORY_KIND_DIRS.semantic, 'memory/semantic');
  assert.equal(MEMORY_KIND_DIRS.procedural, 'memory/procedural');
  assert.equal(MEMORY_KIND_DIRS.self_model, 'memory/self-model');
  assert.equal(MEMORY_KIND_DIRS.world_model, 'memory/world-model');
  assert.equal(MEMORY_KIND_DIRS.project_model, 'memory/project-model');
  assert.equal(WORKING_MEMORY_LOCATION, 'tasks/active');
  assert.equal(MEMORY_KIND_DIRS.working, undefined, '第五节目录里没有 working');
});

test('§25-1: 记忆 append-only —— 状态变更不覆盖原文，错误结论被保留并标记', () => {
  withStore((store) => {
    store.remember({ kind: 'episodic', id: 'exp-1', content: '把 empty-launcher 宽度改成 420px', source: 'session-a' });
    assert.equal(store.current('episodic')[0].status, 'active');

    const r = store.setStatus({ kind: 'episodic', id: 'exp-1', status: 'superseded', reason: 'FAMILY 级问题，单实例补丁不适用' });
    assert.equal(r.ok, true);

    const all = store.readAll('episodic');
    assert.equal(all.length, 2, '状态变更必须是追加，不是改写');
    assert.equal(all[0].content, '把 empty-launcher 宽度改成 420px', '原文一字未动');
    assert.equal(all[0].status, undefined, '原文里不应该被塞进 status');

    const view = store.current('episodic')[0];
    assert.equal(view.status, 'superseded');
    assert.equal(view.status_reason, 'FAMILY 级问题，单实例补丁不适用');
    assert.equal(view.content, '把 empty-launcher 宽度改成 420px');
    assert.equal(store.byStatus('episodic', 'superseded').length, 1);
    assert.equal(store.byStatus('episodic', 'active').length, 0);
  });
});

test('§25-2: 四种「保留但标记」的状态都合法；非法状态与不存在的记录被拒', () => {
  withStore((store) => {
    store.remember({ kind: 'semantic', id: 'k1', content: 'x' });
    for (const s of ['rejected', 'superseded', 'deprecated', 'questionable']) {
      assert.equal(store.setStatus({ kind: 'semantic', id: 'k1', status: s, reason: 'r' }).ok, true, s + ' 应当合法');
    }
    assert.deepEqual([...MEMORY_STATUSES], ['active', 'rejected', 'superseded', 'deprecated', 'questionable']);
    assert.equal(store.setStatus({ kind: 'semantic', id: 'k1', status: 'deleted' }).error, 'unknown_status');
    assert.equal(store.setStatus({ kind: 'semantic', id: 'nope', status: 'rejected' }).error, 'memory_not_found');
    assert.throws(() => store.remember({ kind: 'made-up', id: 'z', content: 'x' }), /unknown kind/);
  });
});

test('§23-5: Self Model 记录能力与历史表现', () => {
  withStore((store) => {
    store.recordCapability({ capability: 'browser_automation', outcome: 'success', context: 'login' });
    store.recordCapability({ capability: 'browser_automation', outcome: 'success', context: 'data-entry' });
    store.recordCapability({ capability: 'browser_automation', outcome: 'failure', context: 'captcha' });
    store.recordCapability({ capability: 'git_bisect', outcome: 'success', context: 'shared-layer' });

    const s = store.capabilitySummary();
    const ba = s.find((x) => x.capability === 'browser_automation');
    assert.equal(ba.attempts, 3);
    assert.equal(ba.successes, 2);
    assert.equal(ba.failures, 1);
    assert.equal(ba.success_rate, 0.6667);
    assert.equal(ba.distinct_contexts, 3);

    assert.throws(() => store.recordCapability({ capability: 'x', outcome: 'maybe', context: 'c' }), /success\|failure/);
  });
});

test('§23-6: World / Project Model 快照（目标/架构/版本/依赖/约束/路线图）', () => {
  withStore((store) => {
    assert.equal(store.snapshot({ kind: 'episodic', data: {} }).error, 'snapshot_kind_must_be_world_or_project_model');

    store.snapshot({ kind: 'project_model', data: { goal: '宏建云数据录入', versions: { dsh: '0.1.6-alpha.1' }, constraints: ['只操作 *.hongjian.com'] } });
    store.snapshot({ kind: 'project_model', data: { goal: '宏建云数据录入', roadmap: ['BOM 批量录入'] } });

    const latest = store.latestSnapshot('project_model');
    assert.deepEqual(latest.data.roadmap, ['BOM 批量录入']);
    assert.equal(store.readAll('project_model').filter((r) => r.type === 'SNAPSHOT').length, 2, '快照也是追加');
  });
});

test('§23-2: 一次偶然成功**不得**成为正式知识（反过拟合闸门）', () => {
  const oneShot = {
    id: 'exp-x',
    observation: 'schemastery 装回去就好了',
    hypothesis: '本地插件依赖被剪枝',
    regression_test: { id: 'rt-1', passing: true },
    validations: [{ context: 'profile-web', ok: true }],
    verifier: { status: 'PASS', run_id: 'r1' },
  };
  const ev = evaluateStage(oneShot);
  assert.equal(ev.stage, 'REGRESSION_TESTED', '只有 1 次验证，绝不能到 VALIDATED');
  assert.notEqual(ev.stage, 'VALIDATED_KNOWLEDGE');
  assert.notEqual(ev.stage, 'SKILL_CANDIDATE');
  assert.equal(ev.eligible_for_production, false);

  const p = evaluateLearningPromotion(oneShot);
  assert.equal(p.next_stage, 'VALIDATED');
  assert.ok(p.blockers.some((b) => b.requirement === 'validations'));

  const shortcut = assertNoShortcut(oneShot, 'PRODUCTION_SKILL');
  assert.equal(shortcut.ok, false);
  assert.equal(shortcut.error, 'would_skip_required_gates');
  assert.equal(shortcut.qualified_stage, 'REGRESSION_TESTED');
});

test('§23-3: 同一上下文重复验证不算数；不同上下文才推进', () => {
  const base = {
    observation: 'o', hypothesis: 'h',
    regression_test: { passing: true },
    verifier: { status: 'PASS' },
  };
  const repeated = { ...base, validations: [{ context: 'c1', ok: true }, { context: 'c1', ok: true }, { context: 'c1', ok: true }] };
  assert.equal(evaluateStage(repeated).gates.distinct_ok_contexts, 1);
  assert.equal(evaluateStage(repeated).stage, 'REGRESSION_TESTED', '同上下文刷次数不算验证');

  const distinct = { ...base, validations: [{ context: 'c1', ok: true }, { context: 'c2', ok: true }, { context: 'c3', ok: true }] };
  assert.equal(evaluateStage(distinct).stage, 'SKILL_CANDIDATE');

  // 失败的验证不计数
  const withFails = { ...base, validations: [{ context: 'c1', ok: true }, { context: 'c2', ok: true }, { context: 'c3', ok: false }, { context: 'c4', ok: true }] };
  assert.equal(evaluateStage(withFails).gates.distinct_ok_contexts, 3);
  assert.equal(evaluateStage(withFails).stage, 'SKILL_CANDIDATE');

  // 策略可放宽（显式、可审计）
  const lenient = { ...DEFAULT_PROMOTION_POLICY, require_distinct_contexts: false };
  assert.equal(evaluateStage(repeated, lenient).gates.distinct_ok_contexts, 3);
  assert.equal(evaluateStage(repeated, lenient).stage, 'SKILL_CANDIDATE');
});

test('§23-4: 晋升链全程 —— 回归用例/验证/Verifier/benchmark/shadow/rollback 一个都少不了', () => {
  assert.equal(LEARNING_STAGES.length, 10);
  assert.equal(LEARNING_STAGES[0], 'OBSERVATION');
  assert.equal(LEARNING_STAGES.at(-1), 'PRODUCTION_SKILL');

  let rec = { id: 'exp-1', observation: 'side-chat undefined.length' };
  assert.equal(evaluateStage(rec).stage, 'OBSERVATION');

  rec = { ...rec, hypothesis: 'container 宽度未约束导致子项未挂载' };
  assert.equal(evaluateStage(rec).stage, 'EXPERIENCE_CANDIDATE');
  assert.ok(evaluateLearningPromotion(rec).blockers.some((b) => b.requirement === 'regression_test'));

  rec = { ...rec, regression_test: { id: 'rt', passing: false } };
  assert.equal(evaluateStage(rec).stage, 'EXPERIENCE_CANDIDATE', '回归用例没通过不算过');

  rec = { ...rec, regression_test: { id: 'rt', passing: true } };
  assert.equal(evaluateStage(rec).stage, 'REGRESSION_TESTED');

  rec = { ...rec, validations: [{ context: 'a', ok: true }, { context: 'b', ok: true }, { context: 'c', ok: true }] };
  assert.equal(evaluateStage(rec).stage, 'VALIDATED');
  assert.ok(evaluateLearningPromotion(rec).blockers.some((b) => b.requirement === 'verifier'));

  rec = { ...rec, verifier: { status: 'FAIL' } };
  assert.equal(evaluateStage(rec).stage, 'VALIDATED', 'Verifier 没过不许变知识');

  rec = { ...rec, verifier: { status: 'PASS', run_id: 'r' } };
  assert.equal(evaluateStage(rec).stage, 'SKILL_CANDIDATE');

  rec = { ...rec, benchmark: { id: 'b', verdict: 'accepted' } };
  assert.equal(evaluateStage(rec).stage, 'BENCHMARKED');
  assert.ok(evaluateLearningPromotion(rec).blockers.some((b) => b.requirement === 'shadow_mode'));

  rec = { ...rec, shadow: { mode: 'shadow' } };
  assert.equal(evaluateStage(rec).stage, 'SHADOWED');
  const last = evaluateLearningPromotion(rec);
  assert.ok(last.blockers.some((b) => b.requirement === 'rollback'), '没有回滚路径不许上生产');
  assert.equal(last.eligible_for_production, false);

  rec = { ...rec, rollback: { available: true, ref: 'skills/active/prev' } };
  const done = evaluateStage(rec);
  assert.equal(done.stage, 'PRODUCTION_SKILL');
  assert.equal(done.eligible_for_production, true);
  assert.deepEqual(evaluateLearningPromotion(rec).blockers, []);
});

test('§23-5: 跳级在任意两点都被拒；已知等级以外的目标被拒', () => {
  const rec = { observation: 'o', hypothesis: 'h', regression_test: { passing: true }, validations: [{ context: 'a', ok: true }] };
  assert.equal(assertNoShortcut(rec, 'EXPERIENCE_CANDIDATE').ok, true, '等于当前等级允许');
  assert.equal(assertNoShortcut(rec, 'REGRESSION_TESTED').ok, true);
  assert.equal(assertNoShortcut(rec, 'VALIDATED').ok, false);
  assert.equal(assertNoShortcut(rec, 'VALIDATED_KNOWLEDGE').ok, false);
  assert.equal(assertNoShortcut(rec, 'NOPE').error, 'unknown_stage');
  assert.deepEqual(assertNoShortcut(rec, 'NOPE').allowed, [...LEARNING_STAGES]);
});

test('§24: Skill/Tool 候选必须走完整管线，禁止直接改运行中的 Stable Core', () => {
  const forbidden = evaluateArtifactCandidate({ targetIsRunningStableCore: true });
  assert.equal(forbidden.ok, false);
  assert.ok(forbidden.blockers.includes('direct_modification_of_running_stable_core_forbidden'));

  const half = evaluateArtifactCandidate({ candidateIsolated: true, tested: true });
  assert.equal(half.ok, false);
  assert.ok(half.blockers.includes('benchmark_required'));
  assert.ok(half.blockers.includes('shadow_mode_required'));
  assert.ok(half.blockers.includes('verifier_pass_required'));
  assert.ok(half.blockers.includes('rollback_must_be_available'));
  assert.equal(half.action, 'REJECT');

  const full = evaluateArtifactCandidate({
    candidateIsolated: true, tested: true, benchmarked: true, shadowed: true, verifierPassed: true, rollbackAvailable: true,
  });
  assert.equal(full.ok, true);
  assert.equal(full.action, 'PROMOTE');
  assert.deepEqual(full.blockers, []);
  assert.deepEqual(full.pipeline, ['candidate', 'sandbox', 'test', 'benchmark', 'shadow_mode', 'verifier', 'promote', 'rollback_available']);
  assert.equal(full.ab_runtime.on_candidate_failure, 'restore_a');
  assert.deepEqual(full.ab_runtime.applies_to, ['supervisor', 'policy_engine', 'recovery_engine']);
});
