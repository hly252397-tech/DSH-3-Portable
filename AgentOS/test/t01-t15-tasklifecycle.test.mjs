// 验收测试 1 / 5 / 6 / 15 —— 任务生命周期（任务单第六、七、八、十二、十五、二十八节）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTempDir, rmrf, initAgentTree } from './helpers.mjs';
import { createStack, pushTask, suspendForChild, completeChild, topFrame, depth, resumePointOf } from '../lib/taskstack.mjs';
import { createGoalContract, evaluateContractProgress, evaluateActionAlignment, validateGoalContract } from '../lib/goalcontract.mjs';
import {
  createTask,
  transition,
  isTerminal,
  mayStop,
  deriveStateFromCriticalEvent,
  STATES,
  TERMINAL_STATES,
  MUST_CONTINUE_STATES,
} from '../lib/taskstate.mjs';
import { Ledger } from '../lib/ledger.mjs';
import { EventBus, applyCriticalEvent } from '../lib/eventbus.mjs';
import { declareCandidate, computeDelta, evaluatePromotion, rejectCandidate, attributeNewDefect } from '../lib/candidate.mjs';

function drive(task, states) {
  let t = task;
  for (const s of states) {
    const r = transition(t, s, { reason: 'drive' });
    assert.equal(r.ok, true, `transition ${t.state} -> ${s} 失败: ${JSON.stringify(r)}`);
    t = r.record;
  }
  return t;
}

test('T1: 父任务遇阻 -> 自动开子任务 -> 通过后自动回父任务续跑（全程不等用户）', () => {
  const stack = createStack();
  pushTask(stack, { id: 'parent-1' });
  assert.equal(depth(stack), 1);

  const resume = { step: 'zoom-80-verify', index: 3, remaining: ['zoom-150', 'width-1200', 'final-gate', 'final-candidate'] };
  const s = suspendForChild(stack, { resume_point: resume, childTask: { id: 'child-1', reason: 'side-chat undefined.length' } });
  assert.equal(s.ok, true);
  assert.equal(depth(stack), 2);
  assert.equal(topFrame(stack).task_id, 'child-1');
  assert.equal(stack.frames[0].state, 'PAUSED');
  assert.deepEqual(stack.frames[0].resume_point, resume);

  // 子任务第一次没过 -> 必须开新子任务，绝不能变成「等用户回复继续」
  const f1 = completeChild(stack, { childTaskId: 'child-1', passed: false, evidence: ['still throws'] });
  assert.equal(f1.resumed, false);
  assert.equal(f1.next_action, 'OPEN_NEW_CHILD');
  assert.equal(f1.parent.state, 'PAUSED');
  assert.equal(depth(stack), 1);
  assert.equal('wait_for_user' in f1, false, '不允许出现「等用户」这条路');
  assert.notEqual(f1.next_action, 'WAIT_FOR_USER');

  // 第二个子任务通过 -> 自动恢复父任务，且带上原 resume_point
  suspendForChild(stack, { resume_point: resumePointOf(stack), childTask: { id: 'child-2' } });
  const f2 = completeChild(stack, { childTaskId: 'child-2', passed: true, evidence: ['probe removed', 'no console error'] });
  assert.equal(f2.resumed, true);
  assert.equal(f2.parent.state, 'RESUMING_PARENT');
  assert.deepEqual(f2.resume_point, resume, '必须从原 resume_point 继续，不许从头再来');
  assert.equal(depth(stack), 1);
  assert.equal(f2.parent.children_completed.length, 2);
});

test('T1b: 子任务反复失败也必须有下一步动作，禁止「等用户」', () => {
  const stack = createStack();
  pushTask(stack, { id: 'p' });
  for (let i = 0; i < 3; i++) {
    const id = 'c' + i;
    suspendForChild(stack, { resume_point: { step: 'probe-' + i }, childTask: { id } });
    assert.equal(topFrame(stack).task_id, id);
    const r = completeChild(stack, { childTaskId: id, passed: false, evidence: ['still failing'] });
    assert.equal(r.ok, true);
    assert.equal(r.next_action, 'OPEN_NEW_CHILD', '子任务失败必须给出下一步动作');
    assert.equal('wait_for_user' in r, false);
    assert.equal(r.parent.state, 'PAUSED');
  }
  // 三个子任务都失败后，父任务仍在 PAUSED 等新的子任务 —— 不是「等用户」
  assert.equal(topFrame(stack).task_id, 'p');
  assert.equal(topFrame(stack).state, 'PAUSED');
  assert.equal(depth(stack), 1);
});

test('T1c: 缺少 resume_point 或子任务时拒绝挂起（不许静默丢上下文）', () => {
  const stack = createStack();
  pushTask(stack, { id: 'p' });
  assert.equal(suspendForChild(stack, { childTask: { id: 'c' } }).error, 'resume_point_required');
  assert.equal(suspendForChild(stack, { resume_point: { step: 'x' } }).error, 'child_task_required');
  assert.equal(depth(stack), 1);
});

test('T15: 只有目标/验证/清理/打包全部完成，Task Engine 才能置 COMPLETED', () => {
  const contract = createGoalContract({
    goal: '生成 UI 最终候选并完成全部验证与打包',
    success_criteria: [{ id: 'sc-1' }, { id: 'sc-2' }],
    constraints: ['禁止改 Stable'],
    allowed_scope: ['web/local'],
    protected_invariants: [{ id: 'pi-1' }],
    known_unknowns: [{ id: 'ku-1' }],
    pending_items: [{ id: 'pi-item-1' }, { id: 'pi-item-2' }],
    done_definition: [{ id: 'dd-test' }, { id: 'dd-verify' }, { id: 'dd-clean' }, { id: 'dd-package' }],
  });

  // 只修好一个子问题不能算完成
  const partial = evaluateContractProgress(contract, { satisfied: ['sc-1'] });
  assert.equal(partial.done, false);
  assert.ok(partial.unmet.some((u) => u.id === 'dd-package'));

  const all = ['sc-1', 'sc-2', 'ku-1', 'pi-item-1', 'pi-item-2', 'dd-test', 'dd-verify', 'dd-clean', 'dd-package'];
  assert.equal(evaluateContractProgress(contract, { satisfied: all }).done, true);
  assert.equal(evaluateContractProgress(contract, { satisfied: all.slice(0, 8) }).done, false, '缺 dd-package 就不算完成');

  // 走完状态机
  let t = createTask({ id: 'T-15', goal_contract_id: contract.id });
  t = drive(t, ['SCOPING', 'PLANNING', 'EXECUTING', 'DIRTY', 'VERIFYING', 'CLEANING', 'PACKAGING', 'READY_TO_COMPLETE']);
  assert.equal(t.state, 'READY_TO_COMPLETE');
  assert.equal(isTerminal('READY_TO_COMPLETE'), false, 'READY_TO_COMPLETE 不是终态');

  // 守卫不全 -> 拒绝 COMPLETED，并逐条列出原因
  const refused = transition(t, 'COMPLETED', { guard: { exitOk: true } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'completion_guard_failed');
  assert.deepEqual(
    [...refused.blockers].sort(),
    ['candidate_not_promoted', 'fingerprint_mismatch', 'goal_contract_not_done'],
  );

  // 全部满足 -> 允许；终态之后不可再迁
  const ok = transition(t, 'COMPLETED', {
    guard: { exitOk: true, contractDone: true, fingerprintMatch: true, candidateOutcome: 'promoted' },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.record.state, 'COMPLETED');
  assert.equal(isTerminal('COMPLETED'), true);
  assert.equal(transition(ok.record, 'EXECUTING').error, 'terminal_state_has_no_transitions');

  // 非法跳步同样被拒
  const fresh = createTask({ id: 'T-jump' });
  assert.equal(transition(fresh, 'COMPLETED').error, 'illegal_transition');
  assert.equal(transition(fresh, 'NOPE').error, 'unknown_target_state');
});

test('T15b: §6 的合法终态只有 4 个；MUST_CONTINUE 状态一律不许收工', () => {
  assert.deepEqual([...TERMINAL_STATES], ['COMPLETED', 'BLOCKED_USER', 'BLOCKED_POLICY', 'FAILED_EXHAUSTED']);
  for (const s of MUST_CONTINUE_STATES) {
    assert.equal(isTerminal(s), false, s + ' 不应该是终态');
    assert.equal(mayStop(s), false, s + ' 不允许收工/等用户');
  }
  for (const s of TERMINAL_STATES) {
    assert.equal(mayStop(s), true);
    assert.deepEqual([...STATES].includes(s), true);
  }
});

test('T5: Watcher FAIL -> Event Bus -> 任务自动 VERIFY_FAILED -> 禁止完成', () => {
  const dir = makeTempDir('bus-');
  try {
    const ledger = new Ledger(path.join(dir, 'events.jsonl'));
    const bus = new EventBus({ ledger });

    // 后台作业必须登记齐全（第十五节：只写日志 = 没有自动化）
    assert.throws(
      () => bus.registerJob({ job_id: 'bad', critical: true, output_channel: 'log' }),
      /invalid registration/,
    );
    bus.registerJob({
      job_id: 'watcher-1', owner_task_id: 'T', process_id: 4242, status: 'running',
      output_channel: 'event-bus', critical: true, last_event_id: 0, last_event_status: 'none', consumed: false,
    });

    let t = drive(createTask({ id: 'T' }), ['SCOPING', 'PLANNING', 'EXECUTING', 'VERIFYING']);

    const pub = bus.publish({ type: 'FAIL', task_id: 'T', detail: 'watcher: layout assertion failed' });
    assert.equal(pub.derived_state, 'VERIFY_FAILED');
    assert.equal(pub.requires_consumption, true);
    assert.equal(bus.digest().completion_blocked, true, '未消费关键事件必须阻断完成');
    assert.equal(bus.pendingInjections().length, 1);

    const applied = applyCriticalEvent({ bus, taskRecord: t, seq: pub.event.seq });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.record.state, 'VERIFY_FAILED');
    assert.equal(applied.injection.kind, 'context_injection');
    assert.equal(applied.injection.event_type, 'FAIL');
    assert.equal(mayStop(applied.record.state), false, 'VERIFY_FAILED 不许停');
    assert.equal(bus.digest().completion_blocked, false, '消费后不再阻断');
    assert.equal(bus.digest().integrity_ok, true);
  } finally {
    rmrf(dir);
  }
});

test('T5b: BOOT_FAILED 事件 -> BOOT_BROKEN；PASS/PROCESS_EXIT 不改状态', () => {
  assert.equal(deriveStateFromCriticalEvent('BOOT_FAILED'), 'BOOT_BROKEN');
  assert.equal(deriveStateFromCriticalEvent('INVALID'), 'DIRTY');
  assert.equal(deriveStateFromCriticalEvent('TIMEOUT'), 'VERIFY_FAILED');
  assert.equal(deriveStateFromCriticalEvent('PASS'), null);
  assert.equal(deriveStateFromCriticalEvent('PROCESS_EXIT'), null);

  const dir = makeTempDir('bus2-');
  try {
    const ledger = new Ledger(path.join(dir, 'events.jsonl'));
    const bus = new EventBus({ ledger });
    let t = drive(createTask({ id: 'T2' }), ['SCOPING', 'PLANNING', 'EXECUTING']);
    const pub = bus.publish({ type: 'BOOT_FAILED', task_id: 'T2', detail: 'two unrelated plugins import failed' });
    const applied = applyCriticalEvent({ bus, taskRecord: t, seq: pub.event.seq });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.record.state, 'BOOT_BROKEN');
  } finally {
    rmrf(dir);
  }
});

test('T6: 修 A 引入 B -> 先归因再回滚；Stable 也报 B 则不得归因给 Candidate', () => {
  const root = initAgentTree();
  try {
    const cand = declareCandidate({
      root,
      id: 'cand-A',
      hypothesis: '把 empty-launcher 的宽度从实例补丁改成 WorkspaceSurface 根宽度统一',
      expected_delta: ['A-fixed'],
      protected_invariants: ['sidebar-drag'],
      allowed_files: ['sub/a.js'],
      impact_set: [{ id: 'x', status: 'VERIFIED' }],
      forbidden_extra_changes: ['boot-gate'],
    });

    // 情况一：Stable 正常、Candidate 报 B -> Candidate 引入回归
    const attr1 = attributeNewDefect({ defect: 'B', reproducesInStable: false, reproducesInCandidate: true });
    assert.equal(attr1.conclusion, 'candidate_introduced_regression');
    assert.equal(attr1.blame_candidate, true);
    assert.equal(attr1.action, 'REJECT_AND_ROLLBACK');

    const delta = computeDelta({ baselineFailures: [], candidateFailures: ['B'], expectedDeltas: ['A-fixed'], actualDeltas: ['A-fixed'] });
    assert.deepEqual(delta.new_failures, ['B']);
    const ev = evaluatePromotion({
      candidate: cand, targetFixed: true, delta,
      invariants: [{ id: 'sidebar-drag', ok: true }],
      currentFingerprint: { aggregate: 'F' }, validationFingerprint: { aggregate: 'F' },
      bootOk: true, verdict: { status: 'PASS', workspace_fingerprint: 'F' },
    });
    assert.equal(ev.ok, false);
    assert.ok(ev.reasons.includes('new_failures:B'));

    const rejected = rejectCandidate({ root, candidate: cand, reason: 'introduced regression B', evidence: { new_failures: ['B'], attribution: attr1 } });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rollback_required, true);
    assert.equal(rejected.can_continue_development, false);

    // 情况二：Stable 也报 B -> 原有潜伏缺陷，不归因当前 Candidate
    const attr2 = attributeNewDefect({ defect: 'B', reproducesInStable: true, reproducesInCandidate: true });
    assert.equal(attr2.conclusion, 'preexisting_latent_defect');
    assert.equal(attr2.blame_candidate, false);
    assert.equal(attr2.action, 'CREATE_SEPARATE_DEFECT_TASK');

    const delta2 = computeDelta({ baselineFailures: ['B'], candidateFailures: ['B'], expectedDeltas: ['A-fixed'], actualDeltas: ['A-fixed'] });
    assert.deepEqual(delta2.new_failures, [], '基线里已有的 B 不是新回归');
  } finally {
    rmrf(root);
  }
});

test('Goal Contract: 字段校验 + 操作对齐检查', () => {
  assert.equal(validateGoalContract({}).ok, false);
  assert.throws(() => createGoalContract({ goal: '' }), /createGoalContract/);

  const c = createGoalContract({
    goal: 'g',
    success_criteria: [{ id: 'sc-1' }],
    constraints: [], allowed_scope: [], protected_invariants: [{ id: 'pi-1' }],
    known_unknowns: [], pending_items: [{ id: 'p-1' }], done_definition: [{ id: 'd-1' }],
  });
  assert.equal(evaluateActionAlignment(c, { addresses: ['sc-1'] }).aligned, true);
  assert.equal(evaluateActionAlignment(c, { addresses: ['nope'] }).aligned, false);
  assert.equal(evaluateActionAlignment(c, { addresses: ['nope'] }).reason, 'action_references_unknown_contract_items');
  assert.equal(evaluateActionAlignment(c, { addresses: [] }).reason, 'action_addresses_nothing_in_contract');
  assert.equal(evaluateActionAlignment(c, { addresses: ['sc-1', 'nope'] }).aligned, false);
});
