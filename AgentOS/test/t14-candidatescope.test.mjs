// 验收测试 14（系统级）—— Candidate 白名单真的进 File Broker；Stable 目录自动禁写
// 任务单第二十节 + 第十一/十三节 + 第二十八节测试 14
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmrf, writeFile, initAgentTree } from './helpers.mjs';
import { FileBroker } from '../lib/filebroker.mjs';
import { declareCandidate, loadActiveCandidate, candidateScope, rejectCandidate } from '../lib/candidate.mjs';

function makeWorkspace() {
  const root = initAgentTree();
  writeFile(path.join(root, 'sub', 'a.js'), 'export const a = 1;\n');
  writeFile(path.join(root, 'sub', 'b.js'), 'export const b = 1;\n');
  writeFile(path.join(root, 'checkpoints', 'cp.json'), '{}\n');
  writeFile(path.join(root, 'supervisor', 'stable', 'policy.mjs'), 'export const P = 1;\n');
  return root;
}

function declare({ root, id = 'cand-1', over = {} }) {
  return declareCandidate({
    root,
    id,
    hypothesis: 'h',
    expected_delta: [],
    protected_invariants: [],
    allowed_files: ['sub/a.js'],
    impact_set: [{ id: 'x', status: 'VERIFIED' }],
    forbidden_extra_changes: ['supervisor'],
    ...over,
  });
}

test('§14-A: 候选白名单进 File Broker —— 白名单内放行、白名单外被拒且不落盘', () => {
  const root = makeWorkspace();
  try {
    declare({ root });
    const b = new FileBroker({ root, candidateId: 'cand-1' });

    // 白名单内
    b.read(path.join(root, 'sub', 'a.js'));
    const ok = b.write({ target: path.join(root, 'sub', 'a.js'), content: 'export const a = 2;\n', checkpointId: 'cp' });
    assert.equal(ok.ok, true, JSON.stringify(ok.checks.filter((c) => !c.ok)));
    assert.equal(ok.scope_source ?? b.evaluatePreconditions({ target: path.join(root, 'sub', 'a.js'), checkpointId: 'cp' }).scope_source, 'candidate.allowed_files');

    // 白名单外
    b.read(path.join(root, 'sub', 'b.js'));
    const before = fs.readFileSync(path.join(root, 'sub', 'b.js'), 'utf8');
    const denied = b.write({ target: path.join(root, 'sub', 'b.js'), content: 'CLOBBERED\n', checkpointId: 'cp' });
    assert.equal(denied.ok, false);
    assert.equal(denied.stage, 'preconditions');
    assert.ok(denied.checks.find((c) => c.id === 'pre:within_task_scope' && !c.ok));
    assert.equal(fs.readFileSync(path.join(root, 'sub', 'b.js'), 'utf8'), before, '被拒时文件字节不许动');

    const pre = b.evaluatePreconditions({ target: path.join(root, 'sub', 'b.js'), checkpointId: 'cp' });
    assert.equal(pre.scope_source, 'candidate.allowed_files');
    assert.ok(pre.checks.find((c) => c.id === 'pre:within_task_scope').detail.includes('不在候选 allowed_files'));
  } finally {
    rmrf(root);
  }
});

test('§14-B: 候选在场时 supervisor/stable **自动**进禁止面', () => {
  const root = makeWorkspace();
  try {
    declare({ root });
    const b = new FileBroker({ root, candidateId: 'cand-1' });

    const stableFile = path.join(root, 'supervisor', 'stable', 'policy.mjs');
    const before = fs.readFileSync(stableFile, 'utf8');
    b.read(stableFile);
    const w = b.write({ target: stableFile, content: 'CLOBBERED\n', checkpointId: 'cp' });

    assert.equal(w.ok, false);
    const bad = w.checks.filter((c) => !c.ok).map((c) => c.id);
    assert.ok(bad.includes('pre:within_allowed_roots'), JSON.stringify(bad));
    assert.equal(fs.readFileSync(stableFile, 'utf8'), before);

    // 没有候选时，禁止面里就没有 supervisor/stable（证明是"候选在场"触发的那条）
    const plain = new FileBroker({ root });
    assert.equal(plain.forbiddenRoots.some((p) => p.toLowerCase().includes('supervisor')), false);
    assert.equal(b.forbiddenRoots.some((p) => p.toLowerCase().includes('supervisor')), true);
  } finally {
    rmrf(root);
  }
});

test('§14-C: 命中 forbidden_extra_changes 被单独拦下（即使落在 allowed_files 里）', () => {
  const root = makeWorkspace();
  try {
    // allowed_files 故意包含 supervisor 下的文件，但 forbidden_extra_changes 禁掉 supervisor
    declare({ root, over: { allowed_files: ['supervisor/stable/policy.mjs'], forbidden_extra_changes: ['supervisor'] } });
    const b = new FileBroker({ root, candidateId: 'cand-1' });

    const pre = b.evaluatePreconditions({ target: path.join(root, 'supervisor', 'stable', 'policy.mjs'), checkpointId: 'cp' });
    const fot = pre.checks.find((c) => c.id === 'pre:not_forbidden_extra_change');
    assert.ok(fot, '必须有 forbidden_extra_changes 这条检查');
    assert.equal(fot.ok, false);
    assert.ok(fot.detail.includes('supervisor'));
    assert.equal(pre.ok, false);
  } finally {
    rmrf(root);
  }
});

test('§14-D: 候选未声明 allowed_files（空）=> 空即禁止写入，不许当成"无限制"', () => {
  const root = makeWorkspace();
  try {
    declare({ root, over: { allowed_files: [] } });
    const b = new FileBroker({ root, candidateId: 'cand-1' });
    b.read(path.join(root, 'sub', 'a.js'));
    const w = b.write({ target: path.join(root, 'sub', 'a.js'), content: 'x\n', checkpointId: 'cp' });
    assert.equal(w.ok, false);
    const c = w.checks.find((x) => x.id === 'pre:within_task_scope');
    assert.equal(c.ok, false);
    assert.ok(c.detail.includes('未声明 allowed_files'));
  } finally {
    rmrf(root);
  }
});

test('§14-E: 已判废的候选不能再写（预检里已有下一条）', () => {
  const root = makeWorkspace();
  try {
    const cand = declare({ root, id: 'cand-dead' });
    rejectCandidate({ root, candidate: cand, reason: 'introduced regression', evidence: {} });

    // rejected 已从 active 移走 -> 只给 candidateId 应报"找不到候选"
    const missing = new FileBroker({ root, candidateId: 'cand-dead' });
    missing.read(path.join(root, 'sub', 'a.js'));
    const w1 = missing.write({ target: path.join(root, 'sub', 'a.js'), content: 'x\n', checkpointId: 'cp' });
    assert.equal(w1.ok, false);
    assert.equal(w1.checks.find((c) => c.id === 'pre:candidate_found').ok, false);

    // 直接把 rejected 记录喂进去 -> 冻结检查必须拦
    const rejected = JSON.parse(fs.readFileSync(path.join(root, 'candidates', 'rejected', 'cand-dead.json'), 'utf8'));
    const b = new FileBroker({ root, candidate: rejected });
    b.read(path.join(root, 'sub', 'a.js'));
    const w2 = b.write({ target: path.join(root, 'sub', 'a.js'), content: 'x\n', checkpointId: 'cp' });
    assert.equal(w2.ok, false);
    const frozen = w2.checks.find((c) => c.id === 'pre:candidate_can_develop');
    assert.equal(frozen.ok, false);
    assert.ok(frozen.detail.includes('判废'));
  } finally {
    rmrf(root);
  }
});

test('§14-F: 没给候选时行为与从前一致（不回归）', () => {
  const root = makeWorkspace();
  try {
    const b = new FileBroker({ root });
    b.read(path.join(root, 'sub', 'b.js'));
    const w = b.write({ target: path.join(root, 'sub', 'b.js'), content: 'export const b = 2;\n', checkpointId: 'cp' });
    assert.equal(w.ok, true, JSON.stringify(w.checks.filter((c) => !c.ok)));
    const pre = b.evaluatePreconditions({ target: path.join(root, 'sub', 'b.js'), checkpointId: 'cp' });
    assert.equal(pre.scope_source, 'none');
    assert.equal(pre.candidate_id, null);
    // 显式 task_scope 仍然按老语义工作
    const pre2 = b.evaluatePreconditions({ target: path.join(root, 'sub', 'b.js'), checkpointId: 'cp', taskScope: ['sub/a.js'] });
    assert.equal(pre2.scope_source, 'task_scope');
    assert.equal(pre2.checks.find((c) => c.id === 'pre:within_task_scope').ok, false);
  } finally {
    rmrf(root);
  }
});

test('§14-G: loadActiveCandidate / candidateScope 的契约', () => {
  const root = makeWorkspace();
  try {
    assert.equal(loadActiveCandidate({ root, candidateId: 'nope' }), null);
    assert.equal(loadActiveCandidate({ root, candidateId: null }), null);
    declare({ root, id: 'cand-x' });
    const c = loadActiveCandidate({ root, candidateId: 'cand-x' });
    assert.equal(c.id, 'cand-x');
    assert.deepEqual(candidateScope(c), { allowed_files: ['sub/a.js'], forbidden_extra_changes: ['supervisor'] });
    assert.deepEqual(candidateScope(null), { allowed_files: null, forbidden_extra_changes: [] });
  } finally {
    rmrf(root);
  }
});
