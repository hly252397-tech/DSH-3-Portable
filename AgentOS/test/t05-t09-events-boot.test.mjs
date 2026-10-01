// 验收测试 5 / 9 —— 事件自动改变任务状态；两个无关插件 import failed 触发 BOOT_FAILED
// （任务单第十五、十八、二十八节）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTempDir, rmrf, cleanExitState } from './helpers.mjs';
import { Ledger, validateJobRegistration } from '../lib/ledger.mjs';
import { evaluateBoot, REQUIRED_CORE_SERVICES } from '../lib/bootbreaker.mjs';
import { evaluateExit } from '../lib/exitguard.mjs';

function withLedger(fn) {
  const dir = makeTempDir('ledger-');
  try {
    return fn(new Ledger(path.join(dir, 'events.jsonl')), dir);
  } finally {
    rmrf(dir);
  }
}

test('T5: Watcher 的 FAIL 进入账本后自动阻断完成，消费后才放行', () => {
  withLedger((ledger) => {
    // PASS 本身也是第十五节定义的关键事件：Task Engine 必须消费它，否则同样阻断完成
    const pass = ledger.append({ type: 'PASS', task_id: 'T', run_id: 'r1' });
    assert.equal(pass.critical, true, 'PASS 也是关键事件');
    ledger.consume(pass.seq, { by: 'task-engine', note: 'advanced task state' });
    assert.equal(ledger.unconsumedCritical().length, 0);

    const fail = ledger.append({ type: 'FAIL', task_id: 'T', run_id: 'r2', detail: 'watcher: layout assertion failed' });

    assert.equal(fail.critical, true, 'FAIL 必须被认定为关键事件');
    assert.equal(ledger.unconsumedCritical().length, 1);

    const blocked = evaluateExit(cleanExitState({ unconsumed_critical_events: ledger.unconsumedCritical().length }));
    assert.equal(blocked.status, 'EXIT_BLOCKED');
    assert.equal(blocked.blockers.length, 1, '只允许未消费关键事件这一条挡住');
    assert.equal(blocked.blockers[0].field, 'unconsumed_critical_events');

    ledger.consume(fail.seq, { by: 'task-engine', note: 'moved task to VERIFY_FAILED' });

    assert.equal(ledger.unconsumedCritical().length, 0, 'FAIL 被消费后不再阻断');
    const after = evaluateExit(cleanExitState());
    assert.equal(after.status, 'OK');
  });
});

test('T5b: 账本 append-only —— 消费不覆盖原事件，且链式完整性可验证', () => {
  withLedger((ledger) => {
    const a = ledger.append({ type: 'NOTE', msg: 'first' });
    const b = ledger.append({ type: 'NOTE', msg: 'second' });
    ledger.consume(a.seq, { by: 'x' });

    const all = ledger.readAll().events;
    assert.equal(all.length, 3, '消费是追加，不是改写');
    assert.equal(all[0].msg, 'first', '原事件保持原样');
    assert.equal(all[0].integrity, a.integrity);
    assert.equal(b.prev_hash, a.integrity, 'prev_hash 串成链');

    const check = ledger.verifyIntegrity();
    assert.equal(check.ok, true, JSON.stringify(check.problems));
  });
});

test('T5c: 关键事件类型自动判定；作业登记缺字段/只写日志会被拒', () => {
  withLedger((ledger) => {
    for (const t of ['PASS', 'FAIL', 'ERROR', 'TIMEOUT', 'INVALID', 'PROCESS_EXIT', 'BOOT_FAILED']) {
      assert.equal(ledger.append({ type: t }).critical, true, t + ' 必须是关键事件');
    }
    assert.equal(ledger.append({ type: 'NOTE' }).critical, false);
  });

  const bad = validateJobRegistration({ job_id: 'j1', critical: true, output_channel: 'log' });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.problem === 'missing_fields'));
  assert.ok(bad.problems.some((p) => p.problem === 'critical_job_writes_log_only'));

  const good = validateJobRegistration({
    job_id: 'j1', owner_task_id: 't1', process_id: 123, status: 'running',
    output_channel: 'event-bus', critical: true, last_event_id: 1, last_event_status: 'PASS', consumed: false,
  });
  assert.equal(good.ok, true);
});

test('T9: 两个无关插件 import failed -> BOOT_FAILED + 候选判废 + 禁止逐插件修复', () => {
  const r = evaluateBoot({
    plugins: [
      { name: '@michengai/dsh-automation', status: 'import_failed', family: '@michengai' },
      { name: 'dsh-sidebar-spaces', status: 'import_failed', family: 'local' },
      { name: 'dsh-restart-button', status: 'ok', family: 'local' },
    ],
    services: REQUIRED_CORE_SERVICES.map((name) => ({ name, ready: false, timedOut: true })),
    sharedModules: [{ name: 'web-boot', loaded: false }],
    moduleRequests: [{ url: '/plugins/x.js', status: 404, contentType: 'text/plain' }],
    loaderException: null,
    bootCompleted: false,
  });

  assert.equal(r.status, 'BOOT_FAILED');
  assert.equal(r.candidate_action, 'CURRENT_CANDIDATE_REJECTED');
  assert.ok(r.triggers.some((t) => t.rule === 'two_unrelated_plugins_import_failed'));
  assert.ok(r.triggers.some((t) => t.rule === 'core_service_not_ready'));
  assert.ok(r.triggers.some((t) => t.rule === 'module_url_404'));
  assert.ok(r.triggers.some((t) => t.rule === 'shared_module_not_loaded'));
  assert.ok(r.triggers.some((t) => t.rule === 'web_boot_not_completed'));

  assert.ok(r.forbidden_remedies.includes('fix_plugins_one_by_one'), '必须显式禁止逐个修插件');
  assert.ok(r.forbidden_remedies.includes('downgrade_required_to_optional'));
  assert.ok(r.forbidden_remedies.includes('lower_boot_gate'));
  assert.deepEqual(r.recovery_plan.slice(0, 2), ['freeze_candidate', 'stop_business_changes']);
  assert.ok(r.recovery_plan.includes('rollback_stable'));
  assert.ok(r.recovery_plan.includes('bisect_shared_root_cause'));

  // 第一条真实错误必须是「第一条」，不是任意一条
  assert.equal(r.first_error.plugin, '@michengai/dsh-automation');
  assert.equal(r.first_failed_request.url, '/plugins/x.js');
});

test('T9b: 同族两个插件失败不算「两个无关插件」（避免误熔断）', () => {
  const r = evaluateBoot({
    plugins: [
      { name: '@michengai/dsh-automation', status: 'import_failed', family: '@michengai' },
      { name: '@michengai/dsh-btw', status: 'import_failed', family: '@michengai' },
    ],
    services: REQUIRED_CORE_SERVICES.map((name) => ({ name, ready: true })),
    bootCompleted: true,
  });
  assert.equal(r.status, 'OK');
  assert.equal(r.triggers.length, 0);
});

test('T9c: required core plugin 单独失败即熔断；模块返回 HTML 也算', () => {
  const a = evaluateBoot({
    plugins: [{ name: '@deepseek-ai/dsh-base', status: 'import_failed', required: true }],
    services: REQUIRED_CORE_SERVICES.map((name) => ({ name, ready: true })),
    bootCompleted: true,
  });
  assert.equal(a.status, 'BOOT_FAILED');
  assert.ok(a.triggers.some((t) => t.rule === 'required_core_plugin_import_failed'));

  const b = evaluateBoot({
    plugins: [],
    services: REQUIRED_CORE_SERVICES.map((name) => ({ name, ready: true })),
    moduleRequests: [{ url: '/client.js', status: 200, contentType: 'text/html; charset=utf-8' }],
    bootCompleted: true,
  });
  assert.equal(b.status, 'BOOT_FAILED');
  assert.ok(b.triggers.some((t) => t.rule === 'module_request_returned_html'));
});
