// 任务单第二十六节 —— 控制台：只读聚合、15 个字段一个不少、读不到就如实标 null
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmrf, writeFile, initAgentTree } from './helpers.mjs';
import { buildConsoleView, renderConsoleHtml, latestVerdicts, CONSOLE_FIELDS } from '../lib/console.mjs';
import { createTask } from '../lib/taskstate.mjs';
import { createGoalContract } from '../lib/goalcontract.mjs';
import { Ledger } from '../lib/ledger.mjs';
import { spawnTracked } from '../lib/processbroker.mjs';

function makeContract() {
  return createGoalContract({
    id: 'g-console',
    goal: '生成 UI 最终候选',
    success_criteria: [{ id: 'sc-1' }],
    constraints: [],
    allowed_scope: [],
    protected_invariants: [{ id: 'pi-1' }],
    known_unknowns: [{ id: 'ku-1' }],
    pending_items: [{ id: 'p-1' }],
    done_definition: [{ id: 'd-1' }],
  });
}

function writeVerdict(root, { runId, status, finishedAt, fp, failed = [] }) {
  writeFile(
    path.join(root, 'verdicts', `${runId}.json`),
    JSON.stringify(
      {
        schema_version: 1,
        run_id: runId,
        task_id: 'T-console',
        status,
        status_reason: 'x',
        finished_at: finishedAt,
        workspace_fingerprint: fp,
        checks: [{ id: 'c-ok', ok: true }, ...failed.map((id) => ({ id, ok: false }))],
      },
      null,
      2,
    ),
  );
}

function makeRoot() {
  const root = initAgentTree();
  const contract = makeContract();
  writeFile(path.join(root, 'tasks', 'active', 'T-console.json'), JSON.stringify({ task: createTask({ id: 'T-console', goal_contract_id: contract.id }), contract }, null, 2));
  writeFile(path.join(root, 'candidates', 'active', 'cand-1.json'), JSON.stringify({ id: 'cand-1', status: 'active', hypothesis: '宽度未约束', allowed_files: ['sub/a.js'], can_continue_development: true }, null, 2));
  writeFile(path.join(root, 'workspaces', 'T-console', 'run.json'), JSON.stringify({ schema_version: 1, task_id: 'T-console', invocation: 3, satisfied: ['sc-1'], counters: { no_progress_steps: 1 }, failures: ['p-1:step_failed'], total_steps: 7, temporary_artifacts: 2, stack_depth: 2, resume_points: [{ task_id: 'T-console', state: 'PAUSED', resume_point: { queued_item_ids: ['p-1'], steps_done: 2 } }] }, null, 2));
  writeFile(path.join(root, 'memory', 'semantic', 'records.jsonl'), [
    JSON.stringify({ seq: 1, kind: 'semantic', type: 'MEMORY', id: 'HYP-old', content: '运行时缺客户端包', recorded_at: '2026-09-17T00:00:00.000Z' }),
    JSON.stringify({ seq: 2, kind: 'semantic', type: 'MEMORY_STATUS', ref: 'HYP-old', status: 'rejected', reason: '已证实由前端 import map 提供', recorded_at: '2026-09-17T00:01:00.000Z' }),
    JSON.stringify({ seq: 3, kind: 'semantic', type: 'MEMORY', id: 'FACT-x', content: '事实', recorded_at: '2026-09-17T00:02:00.000Z' }),
  ].join('\n') + '\n');
  writeVerdict(root, { runId: 'run-1', status: 'FAIL', finishedAt: '2026-09-17T01:00:00.000Z', fp: 'FP-FAIL', failed: ['regression:no_new_failures'] });
  writeVerdict(root, { runId: 'run-2', status: 'PASS', finishedAt: '2026-09-17T02:00:00.000Z', fp: 'FP-PASS' });
  return { root, contract };
}

test('§26-A: 15 个字段一个不少', () => {
  const { root } = makeRoot();
  try {
    const view = buildConsoleView({ root, taskId: 'T-console', extraFiles: { changed: 'candidates/active/cand-1.json' } });
    for (const f of CONSOLE_FIELDS) {
      assert.ok(f in view, '缺少 §26 字段: ' + f);
    }
    assert.equal(CONSOLE_FIELDS.length, 15);
  } finally {
    rmrf(root);
  }
});

test('§26-B: 字段内容取自真实制品（goal/state/pending/defects/假设/进程/resume）', () => {
  const { root } = makeRoot();
  try {
    const view = buildConsoleView({ root, taskId: 'T-console', extraFiles: { changed: 'candidates/active/cand-1.json' } });

    assert.equal(view.goal, '生成 UI 最终候选');
    assert.equal(view.task_state, 'NEW');
    assert.equal(view.task_is_terminal, false);
    assert.equal(view.task_may_stop, true); // NEW 不在"不许停"清单里

    // pending_items = 未满足的合约条目（sc-1 已满足）
    assert.deepEqual(view.pending_items.map((p) => p.id).sort(), ['d-1', 'ku-1', 'p-1']);

    assert.deepEqual(view.known_defects, ['p-1:step_failed']);
    assert.equal(view.temporary_artifacts, 2);
    assert.equal(view.stack_depth, 2);
    assert.equal(view.parent_resume_point[0].resume_point.queued_item_ids[0], 'p-1');

    // 假设 = 候选 + 记忆里标 rejected 的 HYP
    const hIds = view.hypotheses.map((h) => h.id);
    assert.ok(hIds.includes('cand-1'));
    assert.ok(hIds.includes('HYP-old'));
    assert.ok(hIds.includes('ku-1'));
    const oldHyp = view.hypotheses.find((h) => h.id === 'HYP-old');
    assert.equal(oldHyp.status, 'rejected', '被推翻的假设必须带状态，不能当成有效假设');
    assert.equal(view.hypotheses.some((h) => h.id === 'FACT-x'), false, '非假设的记忆不该混进假设列表');

    // 候选
    assert.equal(view.candidate.length, 1);
    assert.equal(view.candidate[0].hypothesis, '宽度未约束');
  } finally {
    rmrf(root);
  }
});

test('§26-C: last_pass_fingerprint 来自**最新一份 PASS**，不是任何一份 verdict', () => {
  const { root } = makeRoot();
  try {
    const v = latestVerdicts({ verdictsDir: path.join(root, 'verdicts') });
    assert.equal(v.total, 2);
    assert.equal(v.latest.run_id, 'run-2');
    assert.equal(v.latest_pass.run_id, 'run-2');

    const view = buildConsoleView({ root, taskId: 'T-console', extraFiles: { changed: 'candidates/active/cand-1.json' } });
    assert.equal(view.last_pass_fingerprint, 'FP-PASS');
    assert.equal(view.verification.status, 'PASS');
    assert.equal(view.verification.total_verdicts, 2);
  } finally {
    rmrf(root);
  }
});

test('§26-D: 未消费关键事件**按任务过滤**；别的任务的事件不该出现在我这一页', () => {
  const { root } = makeRoot();
  try {
    const ledger = new Ledger(path.join(root, 'events', 'task-events.jsonl'));
    ledger.append({ type: 'FAIL', task_id: 'T-OTHER', detail: '别人的' });
    ledger.append({ type: 'FAIL', task_id: 'T-console', detail: '我的' });

    const mine = buildConsoleView({ root, taskId: 'T-console', extraFiles: { changed: 'candidates/active/cand-1.json' } });
    assert.equal(mine.unconsumed_critical_events.length, 1);
    assert.equal(mine.unconsumed_critical_events[0].type, 'FAIL');

    // 不给 task_id -> 全局视图，两条都在
    const all = buildConsoleView({ root, extraFiles: { changed: 'candidates/active/cand-1.json' } });
    assert.equal(all.unconsumed_critical_events.length, 2);
  } finally {
    rmrf(root);
  }
});

test('§26-E: 后台进程进控制台', async () => {
  const { root } = makeRoot();
  let spawned = null;
  try {
    spawned = spawnTracked({ root, owner_task_id: 'T-console', file: process.execPath, args: ['-e', 'setTimeout(()=>{}, 30000)'], command: 'node -e idle' });
    const view = buildConsoleView({ root, taskId: 'T-console', extraFiles: { changed: 'candidates/active/cand-1.json' } });
    assert.equal(view.processes.length, 1);
    assert.equal(view.processes[0].pid, spawned.child.pid);
    assert.equal(view.processes[0].alive, true);
    assert.equal(view.processes[0].owner_task_id, 'T-console');
  } finally {
    if (spawned) {
      try {
        process.kill(spawned.child.pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
    }
    rmrf(root);
  }
});

test('§26-F: 读不到就如实标 null + warning，绝不静默省略', () => {
  const root = initAgentTree();
  try {
    const view = buildConsoleView({ root, extraFiles: { changed: 'tasks/active/none.json' } });
    assert.equal(view.goal, null);
    assert.equal(view.task_state, null);
    assert.equal(view.candidate, null);
    assert.equal(view.verification, null);
    assert.equal(view.last_pass_fingerprint, null);
    assert.equal(view.new_failures, null);
    assert.equal(view.temporary_artifacts, null);
    assert.equal(view.processes.length, 0);
    assert.ok(view.warnings.some((w) => w.includes('未指定 task_id')));
    assert.ok(view.warnings.some((w) => w.includes('未给 portable_root')));
    assert.ok(view.warnings.some((w) => w.includes('new_failures 算不出来')));
    // 零覆盖指纹必须告警
    assert.ok(view.warnings.some((w) => w.includes('degraded')) || view.workspace_fingerprint_meta.coverage > 0);
    // 每个字段都要能追到来源文件（§26 可追溯）
    assert.deepEqual(
      Object.keys(view.sources).sort(),
      ['candidates', 'ledger', 'memory', 'process_registry', 'run_state', 'task', 'verdicts', 'stable'].sort(),
    );
  } finally {
    rmrf(root);
  }
});

test('§26-G: HTML 报告自包含且转义（不许把内容当 HTML 执行）', () => {
  const { root } = makeRoot();
  try {
    // 往假设里塞一段脚本，看渲染会不会原样吐出来
    writeFile(
      path.join(root, 'candidates', 'active', 'cand-x.json'),
      JSON.stringify({ id: 'cand-x', status: 'active', hypothesis: '<script>alert(1)</script>', allowed_files: ['a'], can_continue_development: true }),
    );
    const view = buildConsoleView({ root, taskId: 'T-console', extraFiles: { changed: 'candidates/active/cand-1.json' } });
    const html = renderConsoleHtml(view);

    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('AgentOS Console'));
    assert.equal(html.includes('<script>alert(1)</script>'), false, '脚本必须被转义');
    assert.ok(html.includes('&lt;script&gt;'));
    for (const f of CONSOLE_FIELDS) assert.ok(html.includes(f), 'HTML 里应列出字段 ' + f);

    // 空值要显式可见，不能渲染成空白
    const empty = renderConsoleHtml(buildConsoleView({ root, extraFiles: { changed: 'tasks/active/none.json' } }));
    assert.ok(empty.includes('class="null"'));
  } finally {
    rmrf(root);
  }
});

test('§26-H: 终态任务也能被找到（completed/failed 目录）', () => {
  const { root } = makeRoot();
  try {
    fs.renameSync(path.join(root, 'tasks', 'active', 'T-console.json'), path.join(root, 'tasks', 'completed', 'T-console.json'));
    const view = buildConsoleView({ root, taskId: 'T-console', extraFiles: { changed: 'candidates/active/cand-1.json' } });
    assert.equal(view.task_state, 'NEW');
    assert.ok(view.sources.task.includes('completed'), '来源必须指向 tasks/completed');
  } finally {
    rmrf(root);
  }
});
