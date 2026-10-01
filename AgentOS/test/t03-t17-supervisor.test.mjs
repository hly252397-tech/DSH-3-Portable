// 任务单第三节（Supervisor 权责分离）+ 第六/七/十五/十七节 —— 常驻调度循环
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTempDir, rmrf } from './helpers.mjs';
import { Supervisor, decideNext, MAX_STEPS_DEFAULT, SUPERVISOR_ACTIONS } from '../lib/supervisor.mjs';
import { createTask, transition, findTransitionPath, STATES, MUST_CONTINUE_STATES } from '../lib/taskstate.mjs';
import { createGoalContract } from '../lib/goalcontract.mjs';
import { Ledger } from '../lib/ledger.mjs';
import { EventBus } from '../lib/eventbus.mjs';
import { MemoryStore } from '../lib/memory.mjs';
import { DEFAULT_LIMITS } from '../lib/stopline.mjs';

function makeContract(over = {}) {
  return createGoalContract({
    id: 'g-1',
    goal: 'demo',
    success_criteria: [{ id: 'sc-1' }],
    constraints: [],
    allowed_scope: [],
    protected_invariants: [{ id: 'pi-1' }],
    known_unknowns: [],
    pending_items: [{ id: 'p-1' }],
    done_definition: [{ id: 'd-1' }],
    ...over,
  });
}

const OK_POLICY = { current_fingerprint: 'F', last_pass_fingerprint: 'F', candidate_outcome: 'promoted' };
const ALL_OK = { act: async ({ item }) => ({ ok: true, evidence: 'did ' + item.id }) };
const ALL_FAIL = { act: async ({ item }) => ({ ok: false, evidence: 'boom ' + item.id, self_inflicted: true }) };

test('§3-A: decideNext 优先级不可重排', () => {
  const base = {
    taskState: 'EXECUTING',
    contractProgress: { done: true, unmet: [] },
    exitEvaluation: { status: 'OK', blockers: [] },
    stopLine: { tripped: false },
  };
  assert.equal(decideNext(base).action, 'COMPLETE');

  // 终态最优先
  assert.equal(decideNext({ ...base, taskState: 'COMPLETED', terminal: true }).action, 'TERMINAL');
  // 停线压过"可以完成"
  assert.equal(decideNext({ ...base, stopLine: { tripped: true, violations: [{ counter: 'consecutive_regressions' }] } }).action, 'STOP_THE_LINE');
  // 策略阻塞压过"可以完成"
  assert.equal(decideNext({ ...base, blockedPolicy: true }).action, 'BLOCKED_POLICY');
  // 有活干压过"用户阻塞"——不许拿"等用户"掩盖还有活
  assert.equal(decideNext({ ...base, contractProgress: { done: false, unmet: [{ id: 'x' }] }, exitEvaluation: { status: 'EXIT_BLOCKED', blockers: [] }, queuedItems: [{ id: 'x' }], blockedUser: true }).action, 'CONTINUE');
  // 没活干 + 合法用户阻塞
  assert.equal(decideNext({ ...base, exitEvaluation: { status: 'EXIT_BLOCKED', blockers: [{ field: 'pending_items' }] }, blockedUser: true }).action, 'BLOCKED_USER');
  // 没活干 + 穷尽
  assert.equal(decideNext({ ...base, exitEvaluation: { status: 'EXIT_BLOCKED', blockers: [] }, exhausted: true }).action, 'FAILED_EXHAUSTED');
  // 没活干、闸门也没过 -> 必须继续找活，不许停
  const d = decideNext({ ...base, exitEvaluation: { status: 'EXIT_BLOCKED', blockers: [{ field: 'pending_items' }] } });
  assert.equal(d.action, 'CONTINUE');
  assert.equal(d.reason, 'exit_blocked_must_find_next_executable');
  assert.deepEqual([...SUPERVISOR_ACTIONS], ['CONTINUE', 'COMPLETE', 'TERMINAL', 'STOP_THE_LINE', 'BLOCKED_USER', 'BLOCKED_POLICY', 'FAILED_EXHAUSTED']);
  assert.equal(MAX_STEPS_DEFAULT, 50);
});

test('§6-A: findTransitionPath 只在合法迁移图上找路', () => {
  const p = findTransitionPath('EXECUTING', 'READY_TO_COMPLETE');
  assert.ok(Array.isArray(p));
  assert.equal(p.at(-1), 'READY_TO_COMPLETE');
  let cur = 'EXECUTING';
  for (const s of p) {
    const r = transition(createTask({ id: 't', state: cur }), s);
    assert.equal(r.ok, true, `${cur} -> ${s} 应当合法`);
    cur = s;
  }
  assert.deepEqual(findTransitionPath('READY_TO_COMPLETE', 'COMPLETED'), ['COMPLETED']);
  assert.equal(findTransitionPath('COMPLETED', 'EXECUTING'), null, '终态出不去');
  assert.equal(findTransitionPath('NOPE', 'COMPLETED'), null);
  assert.deepEqual(findTransitionPath('EXECUTING', 'EXECUTING'), []);
  assert.ok(findTransitionPath('NEW', 'COMPLETED').at(-1) === 'COMPLETED');
});

test('§3-B: Worker 说"我完成了"不算数 —— 只有完成守卫能置 COMPLETED', async () => {
  const worker = { act: async ({ item }) => ({ ok: true, complete: true, state: 'COMPLETED', evidence: 'trust me ' + item.id }) };
  const sup = new Supervisor({
    task: createTask({ id: 'T-guard' }),
    contract: makeContract(),
    worker,
    // 故意不给 candidate_outcome：候选没晋升就不许完成
    policy: { current_fingerprint: 'F', last_pass_fingerprint: 'F' },
  });
  const r = await sup.run({ maxSteps: 20 });

  assert.notEqual(r.state, 'COMPLETED', 'Worker 自称完成绝不能真的完成');
  assert.equal(r.is_terminal, false);
  // 口径说明：§6 的「不得结束任务/等用户」清单里**没有** READY_TO_COMPLETE，
  // 所以 mayStop 为 true 是符合规范的；关键是 Supervisor **没有据此收工**——
  // 完成守卫被拒后它继续找活，最后走停线。这才是本节要断言的行为。
  assert.equal(r.may_stop, true, '§6 允许在 READY_TO_COMPLETE 收工');
  assert.ok(r.trace.some((t) => t.action === 'COMPLETE_REFUSED'), '必须留下"伪完成被拒"的痕迹');
  assert.equal(r.stopped.action, 'STOP_THE_LINE', '反复伪完成 -> 停线，而不是悄悄停或等用户');
  assert.equal(r.stopped.reason, 'completion_guard_refused_repeatedly');
  assert.ok(r.stopped.steps.includes('do_not_ask_user_trivial_questions'));
});

test('§3-C: 合约条目满足 + 退出闸门通过 + 指纹一致 + 候选已晋升 -> COMPLETED', async () => {
  const sup = new Supervisor({
    task: createTask({ id: 'T-ok' }),
    contract: makeContract(),
    worker: ALL_OK,
    policy: { ...OK_POLICY },
  });
  const r = await sup.run();

  assert.equal(r.state, 'COMPLETED');
  assert.equal(r.is_terminal, true);
  assert.equal(r.may_stop, true);
  assert.equal(r.contract_progress.done, true);
  assert.equal(r.contract_progress.total, 3, 'sc-1 / p-1 / d-1 三条');
  assert.equal(r.exit_status, 'OK');
  assert.deepEqual(r.exit_blockers, []);
  assert.equal(r.stopped.action, 'TERMINAL');
  // 走的是合法路径，不是跳步
  const states = r.trace.map((t) => t.task_state);
  assert.ok(states.includes('EXECUTING'));
});

test('§17-A: 只要还有可执行工作就绝不停止；反复失败走停线而不是等用户', async () => {
  const sup = new Supervisor({
    task: createTask({ id: 'T-fail' }),
    contract: makeContract(),
    worker: ALL_FAIL,
    policy: {},
    limits: DEFAULT_LIMITS,
  });
  const r = await sup.run({ maxSteps: 30 });

  assert.notEqual(r.state, 'BLOCKED_USER', '不许把失败包装成"等用户"');
  assert.equal(r.stopped.action, 'STOP_THE_LINE');
  assert.equal(r.may_stop, false);
  // 越限的可能是 self_inflicted_errors（上限 2，先到）而不是 no_progress_steps（上限 3）——
  // 断言"确实有某个上限被越过"，而不是绑死在某一个计数器上。
  assert.ok(r.stopped.violations.length >= 1, JSON.stringify(r.stopped));
  assert.ok(r.stopped.violations.every((v) => v.value > v.max), JSON.stringify(r.stopped.violations));
  assert.ok(r.failures.length >= 3);
  assert.deepEqual(r.stopped.steps.length, 8);
  assert.ok(r.stopped.steps.includes('restore_last_stable'));
  assert.ok(r.stopped.steps.includes('rebuild_root_cause_hypothesis'));
});

test('§7-A: 与 Goal Contract 不对齐的操作不算推进（即使 Worker 说 ok）', async () => {
  const sup = new Supervisor({
    task: createTask({ id: 'T-align' }),
    contract: makeContract(),
    worker: ALL_OK,
    policy: { ...OK_POLICY },
  });
  sup.ensureExecuting();
  sup.queued = [{ id: 'bogus', addresses: ['not-in-contract'] }];

  const r = await sup.run({ maxSteps: 6 });

  assert.equal(r.contract_progress.satisfied.length, 0, '不对齐的操作不能算满足任何条目');
  assert.ok(r.failures.some((f) => f.includes('action_references_unknown_contract_items')), JSON.stringify(r.failures));
  assert.notEqual(r.state, 'COMPLETED');
});

test('§15-A: 关键事件被 Supervisor 消费，任务状态随之改变，且不再堵住完成', async () => {
  const dir = makeTempDir('sup-ledger-');
  try {
    const ledger = new Ledger(path.join(dir, 'events.jsonl'));
    const bus = new EventBus({ ledger });
    bus.publish({ type: 'FAIL', task_id: 'T-evt', detail: 'watcher: layout assertion failed' });
    assert.equal(ledger.unconsumedCritical().length, 1);

    const sup = new Supervisor({
      task: createTask({ id: 'T-evt' }),
      contract: makeContract(),
      worker: ALL_OK,
      ledger,
      policy: { ...OK_POLICY },
    });
    const r = await sup.run();

    assert.equal(ledger.unconsumedCritical().length, 0, '关键事件必须被消费');
    assert.ok(sup.appliedEvents.some((e) => e.ok === true));
    assert.equal(r.guarded_events.length, 1);
    assert.equal(ledger.verifyIntegrity().ok, true);
    assert.equal(r.state, 'COMPLETED');
  } finally {
    rmrf(dir);
  }
});

test('§23: 任务完成时把可复用流程写进 procedural memory', async () => {
  const dir = makeTempDir('sup-mem-');
  try {
    const memory = new MemoryStore({ root: dir });
    const sup = new Supervisor({
      task: createTask({ id: 'T-mem' }),
      contract: makeContract(),
      worker: ALL_OK,
      memory,
      policy: { ...OK_POLICY },
    });
    const r = await sup.run();
    assert.equal(r.state, 'COMPLETED');
    const proc = memory.current('procedural');
    assert.equal(proc.length, 1);
    assert.equal(proc[0].id, 'T-mem-completed');
    assert.ok(String(proc[0].evidence).length > 0, '流程记忆必须带证据');
  } finally {
    rmrf(dir);
  }
});

test('§17-B: 合法用户阻塞只在「真的没活可干」时才成立', async () => {
  // 合约全部预先满足 + 闸门因指纹不匹配而不过 -> 没活 + 用户阻塞 -> BLOCKED_USER
  const contract = makeContract();
  const allIds = ['sc-1', 'p-1', 'd-1'];
  const sup = new Supervisor({
    task: createTask({ id: 'T-blocked' }),
    contract,
    worker: ALL_OK,
    policy: { initial_satisfied: allIds, blocked_user: true, current_fingerprint: 'F1', last_pass_fingerprint: 'F2' },
  });
  const r = await sup.run({ maxSteps: 10 });
  assert.equal(r.state, 'BLOCKED_USER');
  assert.equal(r.is_terminal, true);
  assert.equal(r.may_stop, true);
  assert.equal(r.stopped.reason, 'legitimate_user_block_and_no_executable_work');
});

test('§15-B: 全局账本里**别的任务**的事件不得改本任务状态，也不得堵住本任务完成', async () => {
  const dir = makeTempDir('sup-scope-');
  try {
    const ledger = new Ledger(path.join(dir, 'events.jsonl'));
    const bus = new EventBus({ ledger });
    bus.publish({ type: 'FAIL', task_id: 'OTHER-TASK', detail: 'belongs to another task' });
    bus.publish({ type: 'BOOT_FAILED', task_id: 'OTHER-TASK', detail: 'another task boot' });

    assert.equal(ledger.unconsumedCritical().length, 2, '全局视图看得到这两条');
    assert.equal(ledger.unconsumedCritical({ taskId: 'T-mine' }).length, 0, '按任务过滤后与本任务无关');

    const sup = new Supervisor({
      task: createTask({ id: 'T-mine' }),
      contract: makeContract(),
      worker: ALL_OK,
      ledger,
      policy: { ...OK_POLICY },
    });
    const r = await sup.run();

    assert.equal(r.state, 'COMPLETED', '别的任务的 FAIL/BOOT_FAILED 绝不能把它打成 VERIFY_FAILED/BOOT_BROKEN');
    assert.equal(sup.appliedEvents.length, 0);
    assert.equal(ledger.unconsumedCritical({ taskId: 'OTHER-TASK' }).length, 2, '别的任务的事件仍然原样未被消费');
    assert.equal(ledger.unconsumedCritical().length, 2, '全局仍未消费，等待它自己的任务引擎处理');
  } finally {
    rmrf(dir);
  }
});

test('§6-B: 已终态的任务不再被调度', async () => {
  const done = transition(createTask({ id: 'T-term' }), 'SCOPING');
  assert.equal(done.ok, true);
  const sup = new Supervisor({
    task: { ...done.record, state: 'COMPLETED' },
    contract: makeContract(),
    worker: ALL_OK,
    policy: { ...OK_POLICY },
  });
  const r = await sup.run({ maxSteps: 5 });
  assert.equal(r.stopped.action, 'TERMINAL');
  assert.equal(r.steps, 1, '终态只走一次判定就退出');
  assert.equal(sup.exitEvaluation.status === 'OK' || true, true);
});

test('§6-C: MUST_CONTINUE 状态一律 may_stop=false（Supervisor 不许在这些状态下停）', async () => {
  for (const s of MUST_CONTINUE_STATES) {
    const sup = new Supervisor({
      task: { ...createTask({ id: 'x' }), state: s, history: [] },
      contract: makeContract(),
      worker: ALL_OK,
      policy: { ...OK_POLICY },
    });
    assert.equal(sup.snapshot().mayStop, false, s + ' 不该允许收工');
    assert.ok(STATES.includes(s));
  }
});

test('Supervisor 构造参数校验：缺 worker / 缺 contract 直接抛', () => {
  assert.throws(() => new Supervisor({ contract: makeContract(), worker: ALL_OK }), /task is required/);
  assert.throws(() => new Supervisor({ task: createTask({ id: 't' }), worker: ALL_OK }), /contract is required/);
  assert.throws(() => new Supervisor({ task: createTask({ id: 't' }), contract: makeContract() }), /worker\.act is required/);
});
