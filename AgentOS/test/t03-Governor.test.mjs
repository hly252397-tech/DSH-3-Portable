// 任务单第三节 —— Runtime Governor：可反复触发、断点续跑、状态持久化
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmrf, writeFile, initAgentTree, cleanExitState } from './helpers.mjs';
import {
  governOnce,
  readGovernorStatus,
  runPaths,
  loadRunState,
  saveRunState,
  findTaskFile,
  deriveNextAction,
  DEFAULT_STEP_BUDGET,
} from '../lib/runner.mjs';
import { createTask } from '../lib/taskstate.mjs';
import { createGoalContract } from '../lib/goalcontract.mjs';
import { declareCandidate } from '../lib/candidate.mjs';
import { DEFAULT_LIMITS } from '../lib/stopline.mjs';

const OK_POLICY = { current_fingerprint: 'F', last_pass_fingerprint: 'F', candidate_outcome: 'promoted' };

function makeContract() {
  return createGoalContract({
    id: 'g-1',
    goal: 'governor demo',
    success_criteria: [{ id: 'sc-1' }],
    constraints: [],
    allowed_scope: [],
    protected_invariants: [{ id: 'pi-1' }],
    known_unknowns: [],
    pending_items: [{ id: 'p-1' }],
    done_definition: [{ id: 'd-1' }],
  });
}

function makeBundle({ root, taskId, contract = makeContract() }) {
  const task = createTask({ id: taskId, goal_contract_id: contract.id });
  writeFile(path.join(root, 'tasks', 'active', `${taskId}.json`), JSON.stringify({ task, contract }, null, 2));
  writeFile(path.join(root, 'workspaces', `${taskId}`, '.keep'), '');
  return { task, contract };
}

function countingWorker() {
  const calls = {};
  return {
    calls,
    act: async ({ item }) => {
      calls[item.id] = (calls[item.id] || 0) + 1;
      return { ok: true, evidence: 'did ' + item.id };
    },
  };
}

test('§3-D: deriveNextAction 映射 + 路径/状态默认值', () => {
  assert.equal(DEFAULT_STEP_BUDGET, 25);
  assert.equal(deriveNextAction({ stopped: { action: 'TERMINAL' }, is_terminal: true, state: 'COMPLETED' }), 'DONE');
  assert.equal(deriveNextAction({ stopped: { action: 'STOP_THE_LINE' }, is_terminal: false, state: 'EXECUTING' }), 'STOP_THE_LINE');
  assert.equal(deriveNextAction({ stopped: {}, is_terminal: false, state: 'EXECUTING' }), 'CONTINUE');
  assert.equal(deriveNextAction({ stopped: {}, is_terminal: false, state: 'EXECUTING' }, true), 'BOOT_FAILED');
  assert.equal(deriveNextAction({ stopped: {}, is_terminal: false, state: 'BLOCKED_USER' }), 'BLOCKED_USER');
  assert.equal(deriveNextAction({ stopped: {}, is_terminal: false, state: 'BLOCKED_POLICY' }), 'BLOCKED_POLICY');
  assert.equal(deriveNextAction({ stopped: {}, is_terminal: false, state: 'FAILED_EXHAUSTED' }), 'FAILED_EXHAUSTED');

  const root = initAgentTree();
  try {
    const p = runPaths({ root, taskId: 'T-x' });
    assert.equal(p.run, path.join(root, 'workspaces', 'T-x', 'run.json'));
    const s = loadRunState({ root, taskId: 'T-x' });
    assert.equal(s.invocation, 0);
    assert.deepEqual(s.satisfied, []);
    assert.equal(loadRunState({ root, taskId: 'T-missing' }).total_steps, 0);
  } finally {
    rmrf(root);
  }
});

test('§3-E: 跨调用续跑 —— 已满足的条目绝不重复执行，最终自动走到 COMPLETED', async () => {
  const root = initAgentTree();
  try {
    makeBundle({ root, taskId: 'T-resume' });
    const worker = countingWorker();

    let res = null;
    let invocations = 0;
    while (invocations < 10 && (res === null || res.next_action === 'CONTINUE')) {
      res = await governOnce({ root, taskId: 'T-resume', worker, stepBudget: 1, policy: OK_POLICY, limits: DEFAULT_LIMITS });
      invocations++;
    }

    assert.equal(res.next_action, 'DONE', JSON.stringify(res));
    assert.equal(res.state, 'COMPLETED');
    assert.equal(res.is_terminal, true);
    assert.ok(invocations > 1, '步数预算为 1 时必须靠多次调用才走完，这才叫续跑');

    // 每个合约条目只被执行一次
    assert.deepEqual(worker.calls, { 'sc-1': 1, 'p-1': 1, 'd-1': 1 });

    // 任务已归位到 tasks/completed
    assert.equal(fs.existsSync(path.join(root, 'tasks', 'active', 'T-resume.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'tasks', 'completed', 'T-resume.json')), true);

    // 进度持久化：run.json 记满 invocation 与 total_steps
    const run = loadRunState({ root, taskId: 'T-resume' });
    assert.equal(run.invocation, invocations);
    assert.equal(run.satisfied.length, 3);
    assert.equal(run.total_steps, res.total_steps);
    assert.equal(run.history.length, invocations);
  } finally {
    rmrf(root);
  }
});

test('§3-F: 心跳 status.json 存在且如实反映"下一步该干嘛"', async () => {
  const root = initAgentTree();
  try {
    makeBundle({ root, taskId: 'T-heart' });
    const worker = countingWorker();

    const first = await governOnce({ root, taskId: 'T-heart', worker, stepBudget: 1, policy: OK_POLICY });
    assert.equal(first.next_action, 'CONTINUE');

    const st = readGovernorStatus({ root, taskId: 'T-heart' });
    assert.equal(st.has_status, true);
    assert.equal(st.status.invocation, 1);
    assert.equal(st.status.next_action, 'CONTINUE');
    assert.equal(st.status.contract.done, false);
    assert.deepEqual(st.status.contract.unmet, ['p-1', 'd-1']);
    assert.equal(st.run.total_steps, 1);
    assert.ok(fs.existsSync(runPaths({ root, taskId: 'T-heart' }).status));

    // 跑到终态后再触发：不动进度、直接 DONE
    let res = first;
    for (let i = 0; i < 8 && res.next_action === 'CONTINUE'; i++) {
      res = await governOnce({ root, taskId: 'T-heart', worker, stepBudget: 1, policy: OK_POLICY });
    }
    assert.equal(res.next_action, 'DONE');
    const before = loadRunState({ root, taskId: 'T-heart' });
    const again = await governOnce({ root, taskId: 'T-heart', worker, stepBudget: 1, policy: OK_POLICY });
    assert.equal(again.next_action, 'DONE');
    assert.equal(again.steps_this_invocation, 1, '终态只走一次判定就退出');
    assert.equal(again.state, 'COMPLETED');
    assert.equal(loadRunState({ root, taskId: 'T-heart' }).satisfied.length, before.satisfied.length);
  } finally {
    rmrf(root);
  }
});

test('§3-G: 反复失败 -> 停线；下次触发仍是 STOP_THE_LINE（不许变成等用户）', async () => {
  const root = initAgentTree();
  try {
    makeBundle({ root, taskId: 'T-stop' });
    const failing = { act: async ({ item }) => ({ ok: false, evidence: 'boom ' + item.id, self_inflicted: true }) };

    const res = await governOnce({ root, taskId: 'T-stop', worker: failing, stepBudget: 20, limits: DEFAULT_LIMITS });
    assert.equal(res.next_action, 'STOP_THE_LINE');
    assert.notEqual(res.state, 'BLOCKED_USER');
    assert.equal(res.may_stop, false);
    assert.ok(res.supervisor_stopped.violations.length >= 1);
    assert.equal(res.supervisor_stopped.steps.length, 8);

    const st = readGovernorStatus({ root, taskId: 'T-stop' });
    assert.equal(st.status.next_action, 'STOP_THE_LINE');
  } finally {
    rmrf(root);
  }
});

test('§18-I: 治理调用内自动熔断 —— BOOT_FAILED 时判废候选并回报 BOOT_FAILED', async () => {
  const root = initAgentTree();
  const broken = makeTempDir('rp-');
  try {
    writeFile(path.join(broken, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@x/a', 'b'] } } }));
    for (const b of ['@x/a', 'b']) {
      writeFile(path.join(broken, 'node_modules', b, 'package.json'), JSON.stringify({ name: b, main: 'lib/index.js', exports: { '.': { default: './lib/index.js' }, './client': './lib/client.js' } }));
      writeFile(path.join(broken, 'node_modules', b, 'lib', 'index.js'), 'export {};\n');
      // client 入口故意不创建
    }

    makeBundle({ root, taskId: 'T-boot' });
    writeFile(path.join(root, 'sub', 'a.js'), 'export const a = 1;\n');
    declareCandidate({
      root,
      id: 'cand-gov',
      hypothesis: 'h',
      expected_delta: [],
      protected_invariants: [],
      allowed_files: ['sub/a.js'],
      impact_set: [{ id: 'x', status: 'VERIFIED' }],
      forbidden_extra_changes: [],
    });

    const worker = countingWorker();
    const res = await governOnce({
      root,
      taskId: 'T-boot',
      worker,
      stepBudget: 5,
      policy: OK_POLICY,
      verify: {
        runBootAudit: true,
        profileDir: broken,
        candidateId: 'cand-gov',
        extraFiles: { changed: 'sub/a.js' },
        layers: { target: { targetFixed: true }, completion: { exitState: cleanExitState() } },
      },
    });

    assert.equal(res.next_action, 'BOOT_FAILED');
    assert.equal(res.gate.boot.status, 'BOOT_FAILED');
    assert.equal(res.gate.enforcement.rejected, true);
    assert.equal(fs.existsSync(path.join(root, 'candidates', 'active', 'cand-gov.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'candidates', 'rejected', 'cand-gov.json')), true);

    const st = readGovernorStatus({ root, taskId: 'T-boot' });
    assert.equal(st.status.next_action, 'BOOT_FAILED');
    assert.equal(st.status.gate_verdict, 'FAIL');
  } finally {
    rmrf(root);
    rmrf(broken);
  }
});

test('§3-H: 参数校验与找不到任务时的行为', async () => {
  const root = initAgentTree();
  try {
    const worker = countingWorker();
    await assert.rejects(() => governOnce({ taskId: 'T', worker }), /root is required/);
    await assert.rejects(() => governOnce({ root, taskId: 'T' }), /worker\.act is required/);
    await assert.rejects(() => governOnce({ root, worker }), /taskId is required/);

    const missing = await governOnce({ root, taskId: 'nope', worker });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'task_not_found');

    // 任务文件存在但内容不完整
    writeFile(path.join(root, 'tasks', 'active', 'T-bad.json'), JSON.stringify({ task: { id: 'T-bad' } }));
    const bad = await governOnce({ root, taskId: 'T-bad', worker });
    assert.equal(bad.error, 'task_bundle_incomplete');

    assert.equal(findTaskFile({ root, taskId: 'nope' }), null);
    saveRunState({ root, taskId: 'T-x', state: { schema_version: 1, task_id: 'T-x', invocation: 7, satisfied: [], counters: {}, failures: [], total_steps: 0 } });
    assert.equal(loadRunState({ root, taskId: 'T-x' }).invocation, 7);
  } finally {
    rmrf(root);
  }
});
