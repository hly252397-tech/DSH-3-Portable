// 验收测试 3 / 4 —— 指纹绑定与 Watcher 独立性（任务单第十六、二十八节）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeWorkspace, rmrf, writeFile } from './helpers.mjs';
import { computeFingerprint, readGitHead } from '../lib/fingerprint.mjs';
import { buildVerdict, isVerdictValidFor } from '../lib/verdict.mjs';

test('T3: PASS 绑定指纹；文件变了旧 PASS 自动失效', () => {
  const ws = makeWorkspace({ 'a.js': 'export const a = 1;\n', 'b.js': 'export const b = 1;\n' });
  try {
    const fp1 = computeFingerprint({ root: ws, includeGitStatus: false, extraChanged: ['a.js', 'b.js'] });
    const verdict = buildVerdict({ checks: [{ id: 'c1', ok: true }], before: fp1, after: fp1, exit_code: 0 });

    assert.equal(verdict.status, 'PASS');
    assert.equal(verdict.workspace_fingerprint, fp1.aggregate);
    assert.equal(isVerdictValidFor(verdict, fp1).valid, true);

    // 改动一个文件 —— 不改 verdict，只改工作区
    writeFile(path.join(ws, 'a.js'), 'export const a = 2;\n');
    const fp2 = computeFingerprint({ root: ws, includeGitStatus: false, extraChanged: ['a.js', 'b.js'] });

    assert.notEqual(fp1.aggregate, fp2.aggregate, '文件内容变了，聚合指纹必须变');
    const validity = isVerdictValidFor(verdict, fp2);
    assert.equal(validity.valid, false);
    assert.equal(validity.reason, 'fingerprint_mismatch');
  } finally {
    rmrf(ws);
  }
});

test('T3b: 门禁运行期间工作区被改动 -> verdict 判为 INVALID', () => {
  const ws = makeWorkspace({ 'a.js': 'v1\n' });
  try {
    const before = computeFingerprint({ root: ws, includeGitStatus: false, extraChanged: ['a.js'] });
    writeFile(path.join(ws, 'a.js'), 'v2\n'); // 模拟门禁跑到一半被改
    const after = computeFingerprint({ root: ws, includeGitStatus: false, extraChanged: ['a.js'] });

    const v = buildVerdict({ checks: [{ id: 'c1', ok: true }], before, after, exit_code: 0 });
    assert.equal(v.status, 'INVALID');
    assert.equal(v.status_reason, 'workspace_changed_during_gate_run');
  } finally {
    rmrf(ws);
  }
});

test('T3c: 指纹确定性 —— 内容相同则聚合指纹相同（不受计算时刻影响）', () => {
  const ws = makeWorkspace({ 'x.txt': 'same\n' });
  try {
    const f1 = computeFingerprint({ root: ws, includeGitStatus: false, extraChanged: ['x.txt'] });
    const f2 = computeFingerprint({ root: ws, includeGitStatus: false, extraChanged: ['x.txt'] });
    assert.equal(f1.aggregate, f2.aggregate);
    assert.notEqual(f1.computed_at, undefined);
  } finally {
    rmrf(ws);
  }
});

test('T3d: 缺失文件被显式标记，不静默当成 OK', () => {
  const ws = makeWorkspace({});
  try {
    const f = computeFingerprint({ root: ws, includeGitStatus: false, extraChanged: ['nope.js'], extraFiles: { gate: 'missing-gate.mjs' } });
    const missing = f.entries.filter((e) => e.kind === 'missing');
    assert.equal(missing.length, 2, '两个不存在的东西都必须被标为 missing');
    assert.equal(f.counts.missing, 2);
  } finally {
    rmrf(ws);
  }
});

test('T4: 同步门禁完全独立于 Watcher —— 无 Watcher 也能出正式 verdict', () => {
  const ws = makeWorkspace({ 'ok.js': 'ok\n' });
  try {
    const fp = computeFingerprint({ root: ws, includeGitStatus: false, extraChanged: ['ok.js'] });
    // 这里没有任何 watcher 输入：只有 before/after 指纹 + checks
    const v = buildVerdict({ checks: [{ id: 'gate', ok: true }], before: fp, after: fp, exit_code: 0 });

    assert.equal(v.status, 'PASS');
    assert.equal('watcher' in v, false, 'verdict 不允许把 Watcher 当作正确性输入');
    assert.equal(v.status_reason, 'all_checks_passed_and_fingerprint_stable');
  } finally {
    rmrf(ws);
  }
});

test('T4b: 非 git 工作区也能算指纹（HEAD 为 null 且显式记录来源）', () => {
  const ws = makeWorkspace({ 'a.txt': 'x\n' });
  try {
    assert.equal(readGitHead(ws).head, null);
    const f = computeFingerprint({ root: ws, includeGitStatus: false, extraChanged: ['a.txt'] });
    assert.equal(f.git.head, null);
    assert.equal(f.git.head_source, 'no-git-dir');
    assert.equal(f.git.status_ok, false);
    assert.equal(f.git.status_reason, 'disabled');
    assert.equal(typeof f.aggregate, 'string');
    assert.equal(f.aggregate.length, 64);
  } finally {
    rmrf(ws);
  }
});

test('T4c: 覆盖 0 个文件的指纹被标为 degraded，且不得产出 PASS（防假阳性）', () => {
  const ws = makeWorkspace({ 'a.txt': 'x\n' });
  try {
    // 既没有 git，又没有声明任何待纳入文件 -> 覆盖 0 个
    const empty = computeFingerprint({ root: ws, includeGitStatus: false });
    assert.equal(empty.coverage, 0);
    assert.equal(empty.degraded, true);

    const v = buildVerdict({ checks: [{ id: 'c1', ok: true }], before: empty, after: empty, exit_code: 0 });
    assert.equal(v.status, 'INVALID', '覆盖 0 文件时绝不能给 PASS');
    assert.equal(v.status_reason, 'fingerprint_degraded_zero_coverage');

    // 声明了文件之后就不再 degraded，可以正常 PASS
    const covered = computeFingerprint({ root: ws, includeGitStatus: false, extraChanged: ['a.txt'] });
    assert.equal(covered.coverage, 1);
    assert.equal(covered.degraded, false);
    const v2 = buildVerdict({ checks: [{ id: 'c1', ok: true }], before: covered, after: covered, exit_code: 0 });
    assert.equal(v2.status, 'PASS');
  } finally {
    rmrf(ws);
  }
});
