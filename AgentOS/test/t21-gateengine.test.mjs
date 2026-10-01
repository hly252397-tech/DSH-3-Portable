// 任务单第二十一节（Verifier 七层）+ 第十六节（verdict 绑定指纹）+ 第十八节（自动熔断执行侧）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmrf, writeFile, initAgentTree, cleanExitState } from './helpers.mjs';
import {
  GATE_LAYERS,
  runStaticGateLayer,
  runTargetGateLayer,
  runFamilyGateLayer,
  runRegressionGateLayer,
  runDifferentialGateLayer,
  runBootGateLayer,
  runCompletionGateLayer,
  runGatePipeline,
  enforceBootRejection,
} from '../lib/gateengine.mjs';
import { declareCandidate } from '../lib/candidate.mjs';
import { buildImpactSet } from '../lib/impactset.mjs';
import { evaluateBoot } from '../lib/bootbreaker.mjs';

function makeProfile({ bundles = [], missing = {} } = {}) {
  const dir = makeTempDir('profile-');
  writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles } } }, null, 2));
  for (const b of bundles) {
    const pdir = path.join(dir, 'node_modules', b);
    writeFile(
      path.join(pdir, 'package.json'),
      JSON.stringify({ name: b, version: '1.0.0', main: 'lib/index.js', exports: { '.': { default: './lib/index.js' }, './client': './lib/client.js' } }, null, 2),
    );
    if (missing[b] !== 'main') writeFile(path.join(pdir, 'lib', 'index.js'), 'export {};\n');
    if (missing[b] !== 'client') writeFile(path.join(pdir, 'lib', 'client.js'), 'export {};\n');
  }
  return dir;
}

function makeWorkspaceRoot() {
  const root = initAgentTree();
  writeFile(path.join(root, 'sub', 'a.js'), 'export const a = 1;\n');
  return root;
}

test('§21-A: 七层齐全且顺序固定', () => {
  assert.deepEqual([...GATE_LAYERS], ['static', 'target', 'family', 'regression', 'differential', 'boot', 'completion']);
});

test('§21-B: Static Gate —— 修改范围越界与禁止模式都被抓住', () => {
  const root = initAgentTree();
  try {
    writeFile(path.join(root, 'sub', 'a.js'), 'export const a = 1;\n');
    writeFile(path.join(root, 'sub', 'b.js'), 'export const b = 1;\n');
    writeFile(path.join(root, 'sub', 'bad.js'), 'export const c = 1; // !important\n');

    const ok = runStaticGateLayer({ root, changedFiles: ['sub/a.js'], allowedFiles: ['sub/a.js'] });
    assert.equal(ok.ok, true);
    assert.equal(ok.checks[0].id, 'static:change_scope');

    const out = runStaticGateLayer({ root, changedFiles: ['sub/a.js', 'sub/b.js'], allowedFiles: ['sub/a.js'] });
    assert.equal(out.ok, false);
    assert.ok(out.checks[0].detail.includes('sub/b.js'));

    const forbidden = runStaticGateLayer({
      root,
      changedFiles: ['sub/bad.js'],
      forbiddenPatterns: [{ id: 'no-important', pattern: '!important' }],
    });
    assert.equal(forbidden.ok, false);
    assert.ok(forbidden.checks.some((c) => c.id === 'static:forbidden:no-important' && c.detail.includes('sub/bad.js')));

    // 语法检查：好文件过、坏文件不过
    writeFile(path.join(root, 'sub', 'broken.mjs'), 'export const = ;\n');
    const syn = runStaticGateLayer({ root, changedFiles: ['sub/a.js', 'sub/broken.mjs'], syntaxCheck: true });
    assert.equal(syn.ok, false);
    assert.ok(syn.checks.some((c) => c.id.startsWith('static:syntax:') && c.ok === false));
  } finally {
    rmrf(root);
  }
});

test('§21-C: Target / Regression / Differential 三层语义', () => {
  assert.equal(runTargetGateLayer({ targetFixed: true }).ok, true);
  assert.equal(runTargetGateLayer({ targetFixed: false }).ok, false);

  assert.equal(runRegressionGateLayer({ baselineFailures: ['X'], candidateFailures: ['X'] }).ok, true, 'X 是原有缺陷，不算新回归');
  const reg = runRegressionGateLayer({ baselineFailures: [], candidateFailures: ['B'] });
  assert.equal(reg.ok, false);
  assert.equal(reg.checks[0].detail, 'B');

  assert.equal(runDifferentialGateLayer({ expectedDeltas: ['D'], actualDeltas: ['D'] }).ok, true);
  assert.equal(runDifferentialGateLayer({ expectedDeltas: [], actualDeltas: ['surprise'] }).ok, false);
});

test('§21-D: Family Gate —— 少验一个成员就不过；Impact Set 有 UNCHECKED 也不过', () => {
  const bad = runFamilyGateLayer({ problem_class: 'FAMILY', members: ['a', 'b'], validated_members: ['a'] });
  assert.equal(bad.ok, false);
  assert.ok(bad.checks[0].detail.includes('b'));

  const set = buildImpactSet({ members: ['a', 'b'], dimensions: ['all_states'] });
  const withUnchecked = runFamilyGateLayer({ problem_class: 'FAMILY', members: ['a', 'b'], validated_members: ['a', 'b'], impact_set: set });
  assert.equal(withUnchecked.ok, false, 'impact set 没勾完不算过');
  assert.ok(withUnchecked.checks.some((c) => c.id === 'family:impact_set_complete' && c.ok === false));
});

test('§21-E: Boot Gate —— BOOT_FAILED 必挂；PARTIAL 只有显式放行才能过', () => {
  const failed = evaluateBoot({
    plugins: [{ name: '@x/a', status: 'import_failed', family: '@x' }, { name: 'b', status: 'import_failed', family: 'local' }],
    services: [{ name: 'locale', ready: true }, { name: 'settingsScope', ready: true }, { name: 'slots', ready: true }],
    bootCompleted: true,
  });
  const l1 = runBootGateLayer({ boot: failed });
  assert.equal(l1.ok, false);
  assert.ok(l1.checks[0].detail.includes('two_unrelated_plugins_import_failed'));

  const partial = evaluateBoot({ plugins: [{ name: 'a', status: 'ok' }], services: null, bootCompleted: null });
  assert.equal(partial.verdict_completeness, 'PARTIAL');
  assert.equal(runBootGateLayer({ boot: partial, allowPartial: false }).ok, false, '不允许 PARTIAL 时必须挂');
  const accepted = runBootGateLayer({ boot: partial, allowPartial: true });
  assert.equal(accepted.ok, true);
  assert.ok(accepted.checks[1].detail.includes('core_service_not_ready'), '放行也要把未验证项写清楚');

  assert.equal(runBootGateLayer({}).ok, false, '没提供审计就等于没验');
});

test('§21-F: Completion Gate —— 不给退出状态就是没过；13 条照旧生效', () => {
  assert.equal(runCompletionGateLayer({}).ok, false);
  assert.equal(runCompletionGateLayer({ exitState: cleanExitState() }).ok, true);
  const dirty = runCompletionGateLayer({ exitState: cleanExitState({ workspace_dirty: true, temporary_artifacts: 1 }) });
  assert.equal(dirty.ok, false);
  assert.ok(dirty.checks[0].detail.includes('workspace_dirty'));
  assert.ok(dirty.checks[0].detail.includes('temporary_artifacts'));
});

test('§21-G: 管线 —— 任一层失败 → verdict FAIL，且绑定前后指纹', async () => {
  const root = makeWorkspaceRoot();
  try {
    const extraFiles = { changed: 'sub/a.js' };
    const r = await runGatePipeline({
      root,
      extraFiles,
      task_id: 'T-gate',
      candidate_id: 'c1',
      layers: {
        target: { targetFixed: true },
        regression: { baselineFailures: [], candidateFailures: ['B'] },
        differential: { expectedDeltas: [], actualDeltas: [] },
        completion: { exitState: cleanExitState() },
      },
    });

    assert.equal(r.verdict.status, 'FAIL');
    assert.equal(r.verdict.status_reason, 'checks_failed:regression:no_new_failures');
    assert.equal(r.fingerprint_before, r.fingerprint_after, '管线内没改文件，前后指纹必须一致');
    assert.equal(r.verdict.workspace_fingerprint, r.fingerprint_after);
    const layers = r.layers.map((l) => `${l.layer}:${l.ok}`);
    assert.deepEqual(layers, ['target:true', 'regression:false', 'differential:true', 'completion:true']);
  } finally {
    rmrf(root);
  }
});

test('§21-H: 管线 —— 全绿 → PASS；零覆盖指纹 → INVALID（防假 PASS）', async () => {
  const root = makeWorkspaceRoot();
  try {
    const green = await runGatePipeline({
      root,
      extraFiles: { changed: 'sub/a.js' },
      layers: { target: { targetFixed: true }, completion: { exitState: cleanExitState() } },
    });
    assert.equal(green.verdict.status, 'PASS');

    const noCoverage = await runGatePipeline({
      root,
      layers: { target: { targetFixed: true }, completion: { exitState: cleanExitState() } },
    });
    assert.equal(noCoverage.verdict.status, 'INVALID');
    assert.equal(noCoverage.verdict.status_reason, 'fingerprint_degraded_zero_coverage');
  } finally {
    rmrf(root);
  }
});

test('§18-G: 自动熔断 —— 管线内自动跑启动审计，BOOT_FAILED 时真的把候选判废', async () => {
  const root = makeWorkspaceRoot();
  const broken = makeProfile({ bundles: ['@x/a-plugin', 'b-plugin'], missing: { '@x/a-plugin': 'client', 'b-plugin': 'client' } });
  try {
    declareCandidate({
      root,
      id: 'cand-boot',
      hypothesis: 'h',
      expected_delta: [],
      protected_invariants: [],
      allowed_files: ['sub/a.js'],
      impact_set: [{ id: 'x', status: 'VERIFIED' }],
      forbidden_extra_changes: [],
    });

    const r = await runGatePipeline({
      root,
      extraFiles: { changed: 'sub/a.js' },
      profileDir: broken,
      runBootAudit: true,
      candidate_id: 'cand-boot',
      layers: { target: { targetFixed: true }, completion: { exitState: cleanExitState() } },
      verdictsDir: path.join(root, 'verdicts'),
    });

    assert.equal(r.boot.status, 'BOOT_FAILED');
    assert.equal(r.verdict.status, 'FAIL');
    assert.ok(r.layers.some((l) => l.layer === 'boot' && l.ok === false));
    assert.equal(r.enforcement.rejected, true, '必须真的执行判废');
    assert.equal(r.enforcement.action, 'CURRENT_CANDIDATE_REJECTED');
    assert.ok(r.verdict_file && r.verdict_file.endsWith('.json'));

    // 判废后不能继续开发（冻结标志是硬闸门）
    assert.equal(r.enforcement.candidate.frozen, true);
    assert.equal(r.enforcement.candidate.can_continue_development, false);
    assert.equal(r.enforcement.candidate.rollback_required, true);

    // 已从 active 移到 rejected
    assert.equal(fs.existsSync(path.join(root, 'candidates', 'active', 'cand-boot.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'candidates', 'rejected', 'cand-boot.json')), true);
  } finally {
    rmrf(root);
    rmrf(broken);
  }
});

test('§18-H: 启动正常时不判废；没有 candidate_id 时也不动任何东西', async () => {
  const root = makeWorkspaceRoot();
  const healthy = makeProfile({ bundles: ['@x/a-plugin'] });
  try {
    declareCandidate({
      root,
      id: 'cand-ok',
      hypothesis: 'h',
      expected_delta: [],
      protected_invariants: [],
      allowed_files: ['sub/a.js'],
      impact_set: [{ id: 'x', status: 'VERIFIED' }],
      forbidden_extra_changes: [],
    });

    const r = await runGatePipeline({
      root,
      extraFiles: { changed: 'sub/a.js' },
      profileDir: healthy,
      runBootAudit: true,
      candidate_id: 'cand-ok',
      layers: { target: { targetFixed: true }, completion: { exitState: cleanExitState() } },
    });
    assert.equal(r.boot.status, 'OK');
    assert.equal(r.enforcement, null, '启动正常不该有判废动作');
    assert.equal(r.verdict.status, 'PASS');

    const nf = enforceBootRejection({ root, candidateId: null, bootVerdict: { status: 'BOOT_FAILED', triggers: [] } });
    assert.equal(nf.rejected, false);
    assert.equal(nf.reason, 'no_candidate_id');
  } finally {
    rmrf(root);
    rmrf(healthy);
  }
});
