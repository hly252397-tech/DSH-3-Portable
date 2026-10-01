// 验收测试 12 / 14 + 晋升 7 条件 + 补丁连锁禁令（任务单第十一、十二、十三、十四、二十二、二十八节）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { initAgentTree, rmrf } from './helpers.mjs';
import {
  declareCandidate,
  validateCandidateShape,
  evaluatePromotion,
  evaluatePatchChain,
  rejectCandidate,
  assertCandidateMayDevelop,
  guardWrite,
  MECHANICAL_FIX_KINDS,
} from '../lib/candidate.mjs';
import { evaluateIncidentClosure } from '../lib/incident.mjs';

const goodImpact = [{ id: 'layout-width', status: 'VERIFIED' }];

function candInput(over = {}) {
  return {
    id: 'cand-1',
    hypothesis: 'shared Web boot layer regressed by bundled plugin patch',
    expected_delta: ['boot_ok', 'no_new_console_error'],
    protected_invariants: ['sidebar-drag', 'theme-tokens'],
    allowed_files: ['sub/a.js'],
    impact_set: goodImpact,
    forbidden_extra_changes: ['supervisor', 'boot-gate'],
    ...over,
  };
}

test('T12: 事故只修代码、没加机器门禁 -> 不允许 CLOSED', () => {
  const incident = { id: 'INC-1', root_cause: 'schemastery pruned from profile', code_fix: 'reinstall schemastery', stable_promoted: true };

  const open = evaluateIncidentClosure({ incident, gatesAdded: [] });
  assert.equal(open.status, 'OPEN');
  assert.ok(open.missing.includes('no_machine_gate_added'));

  const bogusGate = evaluateIncidentClosure({ incident, gatesAdded: [{ id: 'g1', kind: 'a_promise', passing: true }] });
  assert.equal(bogusGate.status, 'OPEN');
  assert.ok(bogusGate.missing.includes('no_machine_gate_added'));
  assert.deepEqual(bogusGate.rejected_gate_kinds, ['a_promise']);

  const failingGate = evaluateIncidentClosure({ incident, gatesAdded: [{ id: 'g2', kind: 'unit_test', passing: false }] });
  assert.equal(failingGate.status, 'OPEN');
  assert.ok(failingGate.missing.includes('regression_case_not_passing:g2'));

  const ok = evaluateIncidentClosure({ incident, gatesAdded: [{ id: 'g3', kind: 'boot_gate', passing: true }] });
  assert.equal(ok.status, 'CLOSED');
  assert.deepEqual(ok.missing, []);
});

test('T12b: 根因/修复/晋升任一缺失都不得 CLOSED', () => {
  const r = evaluateIncidentClosure({
    incident: { id: 'INC-2', stable_promoted: false },
    gatesAdded: [{ id: 'g', kind: 'runtime_assertion', passing: true }],
  });
  assert.equal(r.status, 'OPEN');
  assert.ok(r.missing.includes('root_cause_not_confirmed'));
  assert.ok(r.missing.includes('code_fix_missing'));
  assert.ok(r.missing.includes('stable_not_promoted'));
});

test('T14: Candidate 改写 Supervisor Stable 被拒；白名单外文件被拒；白名单内放行', () => {
  const root = initAgentTree();
  try {
    const cand = declareCandidate({ root, ...candInput() });
    const stableDir = path.join(root, 'supervisor', 'stable');

    const stableWrite = guardWrite({ candidate: cand, file: path.join(stableDir, 'policy.mjs'), supervisorStableDirs: [stableDir] });
    assert.equal(stableWrite.allowed, false);
    assert.equal(stableWrite.code, 'STABLE_IMMUTABLE');

    const outside = guardWrite({ candidate: cand, file: path.join(root, 'sub', 'b.js'), supervisorStableDirs: [stableDir] });
    assert.equal(outside.allowed, false);
    assert.equal(outside.code, 'FORBIDDEN_EXTRA_CHANGE');

    const inside = guardWrite({ candidate: cand, file: path.join(root, 'sub', 'a.js'), supervisorStableDirs: [stableDir] });
    assert.equal(inside.allowed, true);

    // 即使文件名对，只要落在 supervisor/stable 下也必须先被 STABLE_IMMUTABLE 拦掉
    const tricky = guardWrite({ candidate: { ...cand, allowed_files: ['policy.mjs'] }, file: path.join(stableDir, 'policy.mjs'), supervisorStableDirs: [stableDir] });
    assert.equal(tricky.allowed, false);
    assert.equal(tricky.code, 'STABLE_IMMUTABLE');
  } finally {
    rmrf(root);
  }
});

test('Candidate 声明缺字段 / impact_set 有 UNCHECKED -> 直接拒绝声明', () => {
  const bad = validateCandidateShape({ hypothesis: 'h' });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.problem === 'missing_fields'));

  const unchecked = validateCandidateShape(candInput({ impact_set: [{ id: 'x', status: 'UNCHECKED' }] }));
  assert.equal(unchecked.ok, false);
  assert.ok(unchecked.problems.some((p) => p.problem === 'impact_set_has_unchecked'));
});

test('晋升：7 个条件必须同时满足', () => {
  const base = {
    candidate: { id: 'c', can_continue_development: true },
    targetFixed: true,
    delta: { new_failures: [], unexpected_deltas: [] },
    invariants: [{ id: 'i1', ok: true }],
    currentFingerprint: { aggregate: 'FP-A' },
    validationFingerprint: { aggregate: 'FP-A' },
    bootOk: true,
    verdict: { status: 'PASS', workspace_fingerprint: 'FP-A' },
  };
  assert.equal(evaluatePromotion(base).ok, true, JSON.stringify(evaluatePromotion(base).reasons));

  const cases = [
    [{ targetFixed: false }, 'target_not_fixed'],
    [{ delta: { new_failures: ['X'], unexpected_deltas: [] } }, 'new_failures:X'],
    [{ delta: { new_failures: [], unexpected_deltas: ['Y'] } }, 'unexpected_deltas:Y'],
    [{ invariants: [{ id: 'i1', ok: false }] }, 'protected_invariants_failed:i1'],
    [{ currentFingerprint: { aggregate: 'FP-B' } }, 'fingerprint_not_equal_to_validated'],
    [{ bootOk: false }, 'boot_not_ok'],
    [{ verdict: { status: 'FAIL', workspace_fingerprint: 'FP-A' } }, 'no_passing_verdict'],
    [{ verdict: { status: 'PASS', workspace_fingerprint: 'FP-OLD' } }, 'verdict_fingerprint_stale'],
    [{ candidate: { id: 'c', can_continue_development: false } }, 'candidate_already_frozen'],
  ];
  for (const [over, expected] of cases) {
    const r = evaluatePromotion({ ...base, ...over });
    assert.equal(r.ok, false, '期望被拒绝: ' + JSON.stringify(over));
    assert.ok(r.reasons.includes(expected), `${JSON.stringify(over)} 应包含 ${expected}，实际 ${JSON.stringify(r.reasons)}`);
  }
});

test('补丁连锁：新缺陷/扩大范围/无法归因 -> 拒绝并回滚；仅 4 类机械修正放行一次', () => {
  const rejected = evaluatePatchChain({ newConsoleError: true, fixKind: 'missing_import' });
  assert.equal(rejected.action, 'REJECT_AND_ROLLBACK');
  assert.ok(rejected.rejections.includes('new_console_error'));

  assert.equal(evaluatePatchChain({ needsMoreSharedLayerChanges: true }).action, 'REJECT_AND_ROLLBACK');
  assert.equal(evaluatePatchChain({ unableToAttribute: true }).action, 'REJECT_AND_ROLLBACK');
  assert.equal(evaluatePatchChain({ patchChainDepth: 2, maxPatchChainDepth: 1 }).action, 'REJECT_AND_ROLLBACK');

  for (const kind of MECHANICAL_FIX_KINDS) {
    const r = evaluatePatchChain({ fixKind: kind, patchChainDepth: 1, maxPatchChainDepth: 1 });
    assert.equal(r.action, 'ALLOW_ONE_MECHANICAL_FIX', kind + ' 应当允许一次局部机械修正');
  }
  assert.equal(evaluatePatchChain({}).action, 'NO_OP');
});

test('失败候选失去继续开发资格：判废后写入被 assertCandidateMayDevelop 拒绝', () => {
  const root = initAgentTree();
  try {
    const cand = declareCandidate({ root, ...candInput({ id: 'cand-reject' }) });
    const rejected = rejectCandidate({ root, candidate: cand, reason: 'introduced regression B', evidence: { new_failures: ['B'] } });

    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.frozen, true);
    assert.equal(rejected.rollback_required, true);
    assert.equal(rejected.can_continue_development, false);
    assert.throws(() => assertCandidateMayDevelop(rejected), /REJECTED\/FROZEN/);
  } finally {
    rmrf(root);
  }
});
