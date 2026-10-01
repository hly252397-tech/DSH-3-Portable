// Stable Recovery Broker —— Stable 的定义来自晋升台账；指针只能由受控通道改
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmrf, writeFile, initAgentTree } from './helpers.mjs';
import {
  recordPromotion,
  resolveStable,
  evaluateRecoveryConditions,
  mintRecoveryCapability,
  writeRuntimePointer,
  refusePointerWrite,
  executeRecovery,
  readRecoveryJournal,
  stableLedgerFile,
} from '../lib/stablerecovery.mjs';

/** 造一个便携盘：Data/Runtime/Harness/{current.json, slots/<slot>} */
function makePortable({ slots = [], current = null, previous = null } = {}) {
  const base = makeTempDir('portable-');
  for (const s of slots) writeFile(path.join(base, 'Data', 'Runtime', 'Harness', 'slots', s, 'index.js'), 'export {};\n');
  if (current || previous) {
    writeFile(
      path.join(base, 'Data', 'Runtime', 'Harness', 'current.json'),
      JSON.stringify({
        schema: 1,
        current: current ? { relativePath: `Harness/slots/${current}`, version: current.split('-').slice(0, 2).join('-') } : null,
        previous: previous ? { relativePath: `Harness/slots/${previous}`, version: previous.split('-').slice(0, 2).join('-') } : null,
      }, null, 2),
    );
  }
  return base;
}

test('§11-I: 晋升台账校验 —— 非法 boot_verdict 直接拒', () => {
  const root = initAgentTree();
  try {
    assert.throws(() => recordPromotion({ root, stable_version: '1.0.0', runtime_slot: 'a/b', boot_verdict: 'MAYBE' }), /PASS\|FAIL\|INVALID/);
    assert.throws(() => recordPromotion({ root, runtime_slot: 'a/b', boot_verdict: 'PASS' }), /stable_version is required/);
    const ok = recordPromotion({ root, stable_version: '0.1.5-rc.2', runtime_slot: 'Harness/slots/x', boot_verdict: 'PASS' });
    assert.equal(ok.status, 'STABLE');
    const bad = recordPromotion({ root, stable_version: '0.1.6-a1', runtime_slot: 'Harness/slots/y', boot_verdict: 'FAIL' });
    assert.equal(bad.status, 'REJECTED');
    assert.ok(fs.existsSync(stableLedgerFile({ root })));
  } finally {
    rmrf(root);
  }
});

test('§11-J: Stable **不等于** previous、**不等于**最新槽 —— 只能从台账解析', () => {
  const root = initAgentTree();
  const base = makePortable({ slots: ['0.1.5-rc.2-aaa', '0.1.6-alpha.1-bbb', '0.1.9-zzz'], current: '0.1.6-alpha.1-bbb', previous: '0.1.5-rc.2-aaa' });
  try {
    recordPromotion({ root, stable_version: '0.1.5-rc.2', runtime_slot: 'Harness/slots/0.1.5-rc.2-aaa', boot_verdict: 'PASS' });
    recordPromotion({ root, stable_version: '0.1.6-alpha.1', runtime_slot: 'Harness/slots/0.1.6-alpha.1-bbb', boot_verdict: 'FAIL' });
    recordPromotion({ root, stable_version: '0.1.9', runtime_slot: 'Harness/slots/0.1.9-zzz', boot_verdict: 'PASS' });

    const r = resolveStable({ root, portableRoot: base });
    assert.equal(r.found, true);
    assert.equal(r.stable.runtime_slot, 'Harness/slots/0.1.9-zzz', '应取台账里最后一条 STABLE+PASS');
    assert.equal(r.stable.stable_version, '0.1.9');
    assert.notEqual(r.stable.runtime_slot, 'Harness/slots/0.1.5-rc.2-aaa', 'previous 不是 Stable 的定义');
    assert.equal(r.considered.filter((c) => c.reachable).length, 2, 'FAIL 那条不是候选');
    assert.equal(r.total_promotions, 3);
  } finally {
    rmrf(root);
    rmrf(base);
  }
});

test('§11-K: 台账里有记录但槽在盘上不可达 -> 不算有效 Stable', () => {
  const root = initAgentTree();
  const base = makePortable({ slots: [], current: null });
  try {
    recordPromotion({ root, stable_version: '0.1.5-rc.2', runtime_slot: 'Harness/slots/ghost', boot_verdict: 'PASS' });
    const r = resolveStable({ root, portableRoot: base });
    assert.equal(r.found, false);
    assert.equal(r.stable, null);
    assert.equal(r.rejected_for_unreachable.length, 1);
  } finally {
    rmrf(root);
    rmrf(base);
  }
});

test('§11-L: 四个恢复条件逐条给结果，缺一条就不许恢复', () => {
  const root = initAgentTree();
  const base = makePortable({ slots: ['stable-aaa', 'cand-bbb'], current: 'cand-bbb', previous: 'stable-aaa' });
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(base, 'Data', 'Runtime', 'Harness', 'current.json'), 'utf8'));
    const bootBad = { status: 'BOOT_FAILED', triggers: [{ rule: 'two_unrelated_plugins_import_failed' }] };

    // 台账里没有 Stable -> 恢复被拒；此时「跑的是不是候选」也无从判定（如实标出）
    let r = evaluateRecoveryConditions({ root, pointer, bootVerdict: bootBad, portableRoot: base });
    assert.equal(r.allowed, false);
    assert.ok(r.blockers.includes('valid_stable_exists'));
    const undecidable = r.conditions.find((c) => c.id === 'running_object_is_candidate');
    assert.equal(undecidable.ok, false);
    assert.ok(undecidable.detail.includes('无法判定'), '没有 Stable 时必须说"无法判定"，不能猜');

    recordPromotion({ root, stable_version: '1.0.0', runtime_slot: 'Harness/slots/stable-aaa', boot_verdict: 'PASS' });
    r = evaluateRecoveryConditions({ root, pointer, bootVerdict: bootBad, portableRoot: base });
    assert.equal(r.allowed, true, JSON.stringify(r.blockers));
    assert.equal(r.stable.runtime_slot, 'Harness/slots/stable-aaa');
    assert.ok(r.conditions.find((c) => c.id === 'running_object_is_candidate').detail.includes('≠ stable'));

    // Boot Gate 没失败 -> 不该恢复
    r = evaluateRecoveryConditions({ root, pointer, bootVerdict: { status: 'OK' }, portableRoot: base });
    assert.equal(r.allowed, false);
    assert.ok(r.blockers.includes('boot_gate_failed'));

    // 外部不可逆操作 -> 暂停自动恢复
    r = evaluateRecoveryConditions({ root, pointer, bootVerdict: bootBad, portableRoot: base, externalIrreversible: true });
    assert.equal(r.allowed, false);
    assert.ok(r.blockers.includes('no_external_irreversible_op'));

    // 当前跑的就是 Stable（不是候选）-> 不该恢复
    const stablePointer = { ...pointer, current: pointer.previous, previous: pointer.current };
    r = evaluateRecoveryConditions({ root, pointer: stablePointer, bootVerdict: bootBad, portableRoot: base });
    assert.equal(r.allowed, false);
    assert.ok(r.blockers.includes('running_object_is_candidate'));
  } finally {
    rmrf(root);
    rmrf(base);
  }
});

test('§11-M: **没有凭证绝不许改运行指针**（Stable Shield 的合法例外只能走这条）', () => {
  const root = initAgentTree();
  const base = makePortable({ slots: ['s-aaa', 'c-bbb'], current: 'c-bbb', previous: 's-aaa' });
  try {
    const pointerFile = path.join(base, 'Data', 'Runtime', 'Harness', 'current.json');
    const before = fs.readFileSync(pointerFile, 'utf8');
    const pointer = JSON.parse(before);

    // 1) 无凭证
    let w = writeRuntimePointer({ pointerFile, pointer: { ...pointer, previous: pointer.current, current: { relativePath: 'Harness/slots/s-aaa', version: '1.0.0' } }, reason: 'try' });
    assert.equal(w.ok, false);
    assert.equal(w.error, 'capability_required');
    assert.equal(fs.readFileSync(pointerFile, 'utf8'), before, '被拒时指针文件必须字节不变');

    // 2) 假的凭证（形状不对）
    w = writeRuntimePointer({ pointerFile, pointer, capability: { kind: 'fake' } });
    assert.equal(w.ok, false);
    assert.equal(w.error, 'capability_required');

    // 3) 条件不满足 -> 铸不出凭证
    const notAllowed = mintRecoveryCapability({ conditionsResult: { allowed: false, blockers: ['valid_stable_exists'] }, root: base });
    assert.equal(notAllowed.ok, false);
    assert.deepEqual(notAllowed.blockers, ['valid_stable_exists']);

    // 4) 条件满足 -> 铸得出，且能改；过期/根不匹配要拒
    const minted = mintRecoveryCapability({ conditionsResult: { allowed: true, stable: { runtime_slot: 'Harness/slots/s-aaa' } }, root: base });
    assert.equal(minted.ok, true);
    assert.equal(writeRuntimePointer({ pointerFile, pointer, capability: minted.capability, now: () => Date.now() + 10 * 60_000 }).error, 'capability_expired');
    const otherRoot = makeTempDir('other-');
    try {
      const foreign = mintRecoveryCapability({ conditionsResult: { allowed: true, stable: { runtime_slot: 'x' } }, root: otherRoot });
      assert.equal(writeRuntimePointer({ pointerFile, pointer, capability: foreign.capability }).error, 'capability_root_mismatch');
    } finally {
      rmrf(otherRoot);
    }
    assert.equal(fs.readFileSync(pointerFile, 'utf8'), before, '至此指针文件仍未被动过');

    const okw = writeRuntimePointer({ pointerFile, pointer: { ...pointer, previous: pointer.current, current: { relativePath: 'Harness/slots/s-aaa', version: '1.0.0' } }, capability: minted.capability, reason: 'test' });
    assert.equal(okw.ok, true);
    assert.equal(okw.changed, true);
    assert.ok(okw.before.fingerprint && okw.after.fingerprint && okw.before.fingerprint !== okw.after.fingerprint);

    assert.equal(refusePointerWrite({ role: 'agent-worker' }).error, 'pointer_write_forbidden');
    assert.equal(refusePointerWrite({ role: 'weird' }).error, 'pointer_write_forbidden');
  } finally {
    rmrf(root);
    rmrf(base);
  }
});

test('§11-N: executeRecovery 端到端 —— 切指针 + 留档，**不删除任何数据**', () => {
  const root = initAgentTree();
  const base = makePortable({ slots: ['0.1.5-rc.2-aaa', '0.1.6-alpha.1-bbb'], current: '0.1.6-alpha.1-bbb', previous: '0.1.5-rc.2-aaa' });
  try {
    recordPromotion({ root, stable_version: '0.1.5-rc.2', runtime_slot: 'Harness/slots/0.1.5-rc.2-aaa', boot_verdict: 'PASS', verdict_run_id: 'run-stable' });
    writeFile(path.join(root, 'tasks', 'active', 'T-keep.json'), '{"task":{}}');
    writeFile(path.join(root, 'verdicts', 'run-1.json'), '{"run_id":"run-1"}');

    const bootBad = { status: 'BOOT_FAILED', triggers: [{ rule: 'two_unrelated_plugins_import_failed' }, { rule: 'core_service_not_ready' }] };
    const res = executeRecovery({ root, portableRoot: base, candidateId: 'cand-x', bootVerdict: bootBad, reason: 'boot_gate_failed' });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.to_slot, 'Harness/slots/0.1.5-rc.2-aaa');
    assert.equal(res.from_slot, 'Harness/slots/0.1.6-alpha.1-bbb');
    assert.equal(res.stable_version, '0.1.5-rc.2');
    assert.deepEqual(res.boot_triggers, ['two_unrelated_plugins_import_failed', 'core_service_not_ready']);
    assert.ok(res.pointer_before_fingerprint !== res.pointer_after_fingerprint);
    assert.deepEqual(res.deletions, [], '恢复不删除任何东西');

    const pointer = JSON.parse(fs.readFileSync(path.join(base, 'Data', 'Runtime', 'Harness', 'current.json'), 'utf8'));
    assert.equal(pointer.current.relativePath, 'Harness/slots/0.1.5-rc.2-aaa');
    assert.equal(pointer.recovery.by, 'recovery-broker');
    assert.equal(pointer.recovery.boot_verdict.status, 'BOOT_FAILED');
    assert.ok(fs.existsSync(path.join(base, 'Data', 'Runtime', 'Harness', 'current.json.bak')), '原指针要留 bak');

    // 数据一律保留
    assert.ok(fs.existsSync(path.join(root, 'tasks', 'active', 'T-keep.json')));
    assert.ok(fs.existsSync(path.join(root, 'verdicts', 'run-1.json')));
    assert.ok(fs.existsSync(path.join(base, 'Data', 'Runtime', 'Harness', 'slots', '0.1.6-alpha.1-bbb')), '失败候选的槽不许删');

    const journal = readRecoveryJournal({ root });
    assert.equal(journal.length, 1);
    assert.equal(journal[0].type, 'RECOVERY_EXECUTED');
    assert.equal(journal[0].reason, 'boot_gate_failed');
  } finally {
    rmrf(root);
    rmrf(base);
  }
});

test('§11-O: 条件不满足时 executeRecovery 拒绝并留档，指针不动', () => {
  const root = initAgentTree();
  const base = makePortable({ slots: ['c-bbb'], current: 'c-bbb', previous: null });
  try {
    const pointerFile = path.join(base, 'Data', 'Runtime', 'Harness', 'current.json');
    writeFile(pointerFile, JSON.stringify({ schema: 1, current: { relativePath: 'Harness/slots/c-bbb' }, previous: { relativePath: 'Harness/slots/c-bbb' } }, null, 2));
    const before = fs.readFileSync(pointerFile, 'utf8');

    const res = executeRecovery({ root, portableRoot: base, bootVerdict: { status: 'BOOT_FAILED', triggers: [] } });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'conditions_not_met');
    assert.ok(res.blockers.includes('valid_stable_exists'));
    assert.equal(fs.readFileSync(pointerFile, 'utf8'), before);

    const journal = readRecoveryJournal({ root });
    assert.equal(journal.length, 1);
    assert.equal(journal[0].type, 'RECOVERY_REFUSED');
  } finally {
    rmrf(root);
    rmrf(base);
  }
});
