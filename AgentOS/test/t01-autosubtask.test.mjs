// 验收测试 1（系统级）—— 父任务遇阻时**自动**建子任务、修复、验证、回父任务，全程不等用户
// 任务单第八节 + 第二十八节测试 1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, rmrf } from './helpers.mjs';
import { Supervisor, decideNext } from '../lib/supervisor.mjs';
import { createTask } from '../lib/taskstate.mjs';
import { createGoalContract } from '../lib/goalcontract.mjs';
import { createStack, depth as stackDepth, topFrame } from '../lib/taskstack.mjs';
import { DEFAULT_LIMITS } from '../lib/stopline.mjs';

function makeContract() {
  return createGoalContract({
    id: 'g-sub',
    goal: '生成 UI 最终候选',
    success_criteria: [{ id: 'sc-1' }],
    constraints: [],
    allowed_scope: [],
    protected_invariants: [{ id: 'pi-1' }],
    known_unknowns: [],
    pending_items: [{ id: 'p-1' }],
    done_definition: [{ id: 'd-1' }],
  });
}

const OK_POLICY = { current_fingerprint: 'F', last_pass_fingerprint: 'F', candidate_outcome: 'promoted' };

test('§8-A: Supervisor 遇到 needs_subtask 会**自动**挂起父任务并开子任务，子任务完成后自动回续', async () => {
  let sc1Attempts = 0;
  const acted = [];
  const worker = {
    act: async ({ item }) => {
      acted.push(item.id);
      if (item.id === 'sc-1') {
        sc1Attempts++;
        if (sc1Attempts === 1) {
          return {
            ok: false,
            needs_subtask: {
              id: 'fix-side-chat',
              reason: 'side-chat undefined.length',
              items: ['child-fix', 'child-verify'],
            },
          };
        }
        return { ok: true, evidence: 'fixed after subtask' };
      }
      return { ok: true, evidence: 'did ' + item.id };
    },
  };

  const sup = new Supervisor({
    task: createTask({ id: 'T-auto' }),
    contract: makeContract(),
    worker,
    policy: { ...OK_POLICY },
    limits: DEFAULT_LIMITS,
  });

  const r = await sup.run({ maxSteps: 20 });

  assert.equal(r.state, 'COMPLETED', JSON.stringify({ stopped: r.stopped, failures: r.failures }));
  assert.equal(r.contract_progress.done, true);
  assert.equal(r.stack_depth, 1, '子任务收尾后栈必须回到只有根帧');

  // 自动开子任务 -> 自动收尾，两条痕迹都要在
  const actions = r.trace.map((t) => t.action);
  assert.ok(actions.includes('SUBTASK_OPENED'), '必须留下自动开子任务的痕迹');
  assert.ok(actions.includes('SUBTASK_CLOSED'), '必须留下自动收尾的痕迹');
  const closed = r.trace.find((t) => t.action === 'SUBTASK_CLOSED');
  assert.equal(closed.resumed, true);
  assert.ok(closed.restored_queue.includes('sc-1'), '父任务队列必须恢复，含触发子任务的那个条目');

  // 执行顺序：父条目 -> 子任务两条 -> 回到父条目重试 -> 其余
  assert.deepEqual(acted, ['sc-1', 'child-fix', 'child-verify', 'sc-1', 'p-1', 'd-1']);
  assert.equal(sc1Attempts, 2, '触发子任务的条目必须在子任务结束后重试');

  // 子任务的条目不许混进父任务的成功集合
  assert.deepEqual([...r.contract_progress.satisfied].map((s) => s.id).sort(), ['d-1', 'p-1', 'sc-1']);
  assert.equal(r.subtasks.length, 1);
  assert.equal(r.subtasks[0].id, 'fix-side-chat');
  assert.deepEqual(r.subtasks[0].items, ['child-fix', 'child-verify']);
});

test('§8-B: 子任务未跑完时不许判完成（decideNext 必须挡住）', () => {
  const base = {
    taskState: 'EXECUTING',
    contractProgress: { done: true, unmet: [] },
    exitEvaluation: { status: 'OK', blockers: [] },
    stopLine: { tripped: false },
    completionGuard: { exitOk: true, contractDone: true, fingerprintMatch: true, candidateOutcome: 'promoted' },
  };
  assert.equal(decideNext(base).action, 'COMPLETE');
  const held = decideNext({ ...base, subtaskOpen: true, queuedItems: [{ id: 'child-x' }] });
  assert.equal(held.action, 'CONTINUE');
  assert.equal(held.reason, 'subtask_in_progress_must_finish_first');
  assert.equal(held.next_item.id, 'child-x');
  // 停线优先级仍高于子任务
  assert.equal(decideNext({ ...base, subtaskOpen: true, stopLine: { tripped: true, violations: [] } }).action, 'STOP_THE_LINE');
});

test('§8-C: 嵌套子任务 —— 子任务自己再开一层，收尾顺序是后进先出', async () => {
  // 计数器必须**按条目分开**：共用一个会让第二个条目直接走进"已修好"分支（本轮踩过）
  let sc1Tries = 0;
  let outerItemTries = 0;
  const worker = {
    act: async ({ item }) => {
      if (item.id === 'sc-1') {
        sc1Tries++;
        if (sc1Tries === 1) return { ok: false, needs_subtask: { id: 'outer', reason: 'outer blocker', items: ['outer-item'] } };
        return { ok: true, evidence: 'outer fixed' };
      }
      if (item.id === 'outer-item') {
        outerItemTries++;
        // 只有第一次需要内层子任务；修完就好（否则会无限重开，测试本身就不成立）
        if (outerItemTries === 1) return { ok: false, needs_subtask: { id: 'inner', reason: 'inner blocker', items: ['inner-item'] } };
        return { ok: true, evidence: 'outer fixed after inner' };
      }
      return { ok: true, evidence: 'did ' + item.id };
    },
  };

  const sup = new Supervisor({ task: createTask({ id: 'T-nest' }), contract: makeContract(), worker, policy: { ...OK_POLICY } });
  const r = await sup.run({ maxSteps: 30 });

  assert.equal(r.state, 'COMPLETED', JSON.stringify({ stopped: r.stopped, failures: r.failures }));
  assert.deepEqual(r.subtasks.map((s) => s.id), ['outer', 'inner']);
  assert.equal(r.stack_depth, 1);
  const kinds = r.trace.filter((t) => t.action.startsWith('SUBTASK_')).map((t) => t.action);
  assert.deepEqual(kinds, ['SUBTASK_OPENED', 'SUBTASK_OPENED', 'SUBTASK_CLOSED', 'SUBTASK_CLOSED'], 'LIFO 收尾');
});

test('§8-D: 没有子任务时 closeSubtask 明确报错，不静默成功', () => {
  const sup = new Supervisor({ task: createTask({ id: 'T-x' }), contract: makeContract(), worker: { act: async () => ({ ok: true }) }, policy: { ...OK_POLICY } });
  const r = sup.closeSubtask({ passed: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_open_subtask');
  assert.equal(sup.depth(), 1);
});

test('§8-E: 父任务队列在子任务期间**不被丢**（挂起时存进帧里，收尾时原样恢复）', async () => {
  const stack = createStack();
  const worker = {
    act: async ({ item }) => {
      if (item.id === 'sc-1') return { ok: false, needs_subtask: { id: 's1', reason: 'blocked', items: ['c1'] } };
      return { ok: true, evidence: 'did ' + item.id };
    },
  };
  const sup = new Supervisor({ task: createTask({ id: 'T-q' }), contract: makeContract(), worker, policy: { ...OK_POLICY }, stack });

  sup.ensureExecuting();
  sup.queueFromContract();
  const before = sup.queued.map((q) => q.id);
  assert.deepEqual(before, ['sc-1', 'p-1', 'd-1']);

  const opened = sup.openSubtask({ id: 's1', items: ['c1'] });
  assert.equal(opened.ok, true);
  assert.deepEqual(sup.queued.map((q) => q.id), ['c1'], '子任务期间当前队列是子任务的');
  // 注意：openSubtask 之后 topFrame 是**子**帧；被暂停的是它的**父**帧（根帧）。
  const rootFrame = sup.stack.frames[0];
  assert.deepEqual(rootFrame.resume_point.queued_item_ids, before, '父任务队列必须存进 resume_point');
  assert.equal(rootFrame.state, 'PAUSED');
  assert.equal(topFrame(sup.stack).task_id, 's1', '栈顶是子任务');
  assert.equal(stackDepth(sup.stack), 2);

  const closed = sup.closeSubtask({ passed: true });
  assert.equal(closed.resumed, true);
  assert.deepEqual(closed.restored_queue, before, '收尾后父任务队列必须原样恢复');
  assert.equal(sup.depth(), 1);

  // 子任务不通过时父任务保持 PAUSED，且给出下一步动作（不是等用户）
  sup.openSubtask({ id: 's2', items: ['c2'] });
  const failed = sup.closeSubtask({ passed: false, evidence: ['nope'] });
  assert.equal(failed.resumed, false);
  assert.equal(failed.next_action, 'OPEN_NEW_CHILD');
  assert.equal(failed.parent.state, 'PAUSED');
});

test('§8-F: 子任务内失败会计入停线（不会无限重开子任务）', async () => {
  const worker = {
    act: async ({ item }) => {
      if (item.id === 'sc-1') return { ok: false, needs_subtask: { id: 's', reason: 'always blocked', items: ['c1'] } };
      return { ok: false, evidence: 'child keeps failing', self_inflicted: true };
    },
  };
  const sup = new Supervisor({ task: createTask({ id: 'T-loop' }), contract: makeContract(), worker, policy: {}, limits: DEFAULT_LIMITS });
  const r = await sup.run({ maxSteps: 40 });

  assert.notEqual(r.state, 'BLOCKED_USER', '不许把死循环包装成"等用户"');
  assert.equal(r.stopped.action, 'STOP_THE_LINE');
  assert.ok(r.stopped.violations.length >= 1);
});
