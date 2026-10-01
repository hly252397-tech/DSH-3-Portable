// 验收测试 7 / 8 —— 连续回归停线 + 家族级共同规则（任务单第九、十、十四、二十一、二十八节）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStopLine, bumpCounter, resetCounters, DEFAULT_LIMITS, STOP_LINE_STEPS } from '../lib/stopline.mjs';
import {
  classifyProblem,
  buildImpactSet,
  setImpactStatus,
  impactSetComplete,
  validateFamilyGate,
  assertChangePriority,
  FAMILY_DIMENSIONS,
  CHANGE_PRIORITY,
  PROBLEM_CLASSES,
  IMPACT_STATUSES,
} from '../lib/impactset.mjs';

test('T7: 连续两个 Candidate 引入回归 -> 触发 Stop-the-Line 并给出 8 步', () => {
  assert.equal(evaluateStopLine({ counters: { consecutive_regressions: 1 } }).tripped, false, '1 次 ≤ 上限 1，不触发');

  const r = evaluateStopLine({ counters: { consecutive_regressions: 2 } });
  assert.equal(r.tripped, true);
  assert.equal(r.action, 'STOP_THE_LINE');
  assert.deepEqual(r.steps, [...STOP_LINE_STEPS]);
  assert.equal(r.steps.length, 8);
  for (const s of ['stop_patching', 'restore_last_stable', 'read_relevant_implementation_fully', 'rebuild_dependency_graph_and_dataflow', 'build_minimal_reproduction', 'rebuild_root_cause_hypothesis', 'create_fresh_candidate', 'do_not_ask_user_trivial_questions']) {
    assert.ok(r.steps.includes(s), '缺少动作 ' + s);
  }
  assert.deepEqual(r.violations, [{ counter: 'consecutive_regressions', limit: 'max_consecutive_regressions', value: 2, max: 1 }]);
});

test('T7b: 其余 4 个上限都在边界上正确触发', () => {
  assert.equal(evaluateStopLine({ counters: { same_strategy_retry: 1 } }).tripped, false);
  assert.equal(evaluateStopLine({ counters: { same_strategy_retry: 2 } }).tripped, true);

  assert.equal(evaluateStopLine({ counters: { patch_chain_depth: 1 } }).tripped, false);
  assert.equal(evaluateStopLine({ counters: { patch_chain_depth: 2 } }).tripped, true);

  assert.equal(evaluateStopLine({ counters: { no_progress_steps: 3 } }).tripped, false);
  assert.equal(evaluateStopLine({ counters: { no_progress_steps: 4 } }).tripped, true);

  assert.equal(evaluateStopLine({ counters: { self_inflicted_errors: 2 } }).tripped, false);
  assert.equal(evaluateStopLine({ counters: { self_inflicted_errors: 3 } }).tripped, true);

  assert.deepEqual({ ...DEFAULT_LIMITS }, {
    max_consecutive_regressions: 1,
    max_same_strategy_retry: 1,
    max_patch_chain_depth: 1,
    max_no_progress_steps: 3,
    max_self_inflicted_errors: 2,
  });
});

test('T7c: 多条件同时越限 -> 全部列出；bump 到阈值即翻；reset 清零点', () => {
  const multi = evaluateStopLine({ counters: { consecutive_regressions: 2, no_progress_steps: 5 } });
  assert.equal(multi.tripped, true);
  assert.equal(multi.violations.length, 2);

  let counters = {};
  let last = null;
  for (let i = 0; i < 3; i++) {
    const r = bumpCounter(counters, 'consecutive_regressions');
    counters = r.counters;
    last = r.decision;
  }
  assert.equal(counters.consecutive_regressions, 3);
  assert.equal(last.tripped, true);

  const cleared = resetCounters(counters);
  assert.equal(evaluateStopLine({ counters: cleared }).tripped, false);
});

test('T8: 改一个家族组件 -> 必须验证全部同类成员，禁止只验截图实例', () => {
  const sole = validateFamilyGate({ problem_class: 'FAMILY', members: ['ws-1', 'ws-2', 'ws-3'], validated_members: ['ws-1'] });
  assert.equal(sole.ok, false);
  assert.deepEqual(sole.missing, ['ws-2', 'ws-3']);

  const full = validateFamilyGate({ problem_class: 'FAMILY', members: ['ws-1', 'ws-2', 'ws-3'], validated_members: ['ws-1', 'ws-2', 'ws-3'] });
  assert.equal(full.ok, true);
  assert.deepEqual(full.missing, []);

  // INSTANCE 只需要当前实例
  assert.equal(validateFamilyGate({ problem_class: 'INSTANCE', members: ['empty-launcher'], validated_members: ['empty-launcher'] }).ok, true);
  assert.equal(validateFamilyGate({ problem_class: 'NOPE', members: [], validated_members: [] }).ok, false);
});

test('T8b: Impact Set 有 UNCHECKED 就不许完成；三种合法状态都可收口', () => {
  const set = buildImpactSet({ component_family: 'WorkspaceSurface', members: ['empty-launcher', 'settings-surface'], dimensions: ['all_states', 'overflow'] });
  assert.equal(set.length, 4);
  assert.equal(impactSetComplete(set).complete, false);
  assert.equal(impactSetComplete(set).unchecked.length, 4);

  for (const item of set) {
    const r = setImpactStatus(set, { id: item.id, status: 'VERIFIED', evidence: 'measured 1100px' });
    assert.equal(r.ok, true);
  }
  assert.equal(impactSetComplete(set).complete, true);

  setImpactStatus(set, { id: set[0].id, status: 'DOCUMENTED_EXCEPTION', evidence: 'why not applicable' });
  setImpactStatus(set, { id: set[1].id, status: 'NOT_APPLICABLE', evidence: 'no overflow at 2560px' });
  assert.equal(impactSetComplete(set).complete, true);

  setImpactStatus(set, { id: set[2].id, status: 'UNCHECKED' });
  assert.equal(impactSetComplete(set).complete, false);
  assert.deepEqual(impactSetComplete(set).unchecked, [set[2].id]);

  assert.equal(setImpactStatus(set, { id: 'ghost', status: 'VERIFIED' }).error, 'impact_item_not_found');
  assert.equal(setImpactStatus(set, { id: set[3].id, status: 'MADE_UP' }).error, 'unknown_status');
});

test('T8c: 第十节要求的 9 个家族维度齐全，且顺序稳定', () => {
  assert.deepEqual([...FAMILY_DIMENSIONS], [
    'all_states', 'key_window_widths', 'key_zoom_levels', 'left_right_edges',
    'root_container_width', 'panel_fit', 'drag_handle', 'overflow', 'console_errors',
  ]);
  const set = buildImpactSet({ members: ['ws-1'] });
  assert.equal(set.length, FAMILY_DIMENSIONS.length);
});

test('T8d: FAMILY/SYSTEM/GLOBAL_RUNTIME 禁止只做单实例补丁', () => {
  for (const pc of ['FAMILY', 'SYSTEM', 'GLOBAL_RUNTIME']) {
    const bad = assertChangePriority({ problem_class: pc, change_level: 'instance_patch' });
    assert.equal(bad.ok, false, pc + ' 不该允许 instance_patch');
    assert.equal(bad.error, 'instance_patch_forbidden_for_' + pc.toLowerCase());
    assert.deepEqual(bad.priority_order, [...CHANGE_PRIORITY]);
  }
  assert.equal(assertChangePriority({ problem_class: 'INSTANCE', change_level: 'instance_patch' }).ok, true, '单实例问题允许实例补丁');
  assert.equal(assertChangePriority({ problem_class: 'SYSTEM', change_level: 'design_token' }).ok, true);
  assert.equal(assertChangePriority({ problem_class: 'SYSTEM', change_level: 'layout_or_data_contract' }).ok, true);
  assert.equal(assertChangePriority({ problem_class: 'FAMILY', change_level: 'made_up' }).error, 'unknown_change_level');
});

test('T8e: 分类正确区分 INSTANCE / FAMILY / SYSTEM / GLOBAL_RUNTIME', () => {
  assert.equal(classifyProblem({ affected_components: [{ id: 'a', family: 'F' }] }).problem_class, 'INSTANCE');
  assert.equal(classifyProblem({ affected_components: [{ id: 'a', family: 'F' }, { id: 'b', family: 'F' }] }).problem_class, 'FAMILY');
  assert.equal(classifyProblem({ affected_components: [{ id: 'a', family: 'F' }, { id: 'b', family: 'G' }] }).problem_class, 'SYSTEM');
  assert.equal(classifyProblem({ affects_runtime: true, affected_components: [{ id: 'a', family: 'F' }] }).problem_class, 'GLOBAL_RUNTIME');
  assert.deepEqual([...PROBLEM_CLASSES], ['INSTANCE', 'FAMILY', 'SYSTEM', 'GLOBAL_RUNTIME']);
  assert.deepEqual([...IMPACT_STATUSES], ['VERIFIED', 'NOT_APPLICABLE', 'DOCUMENTED_EXCEPTION', 'UNCHECKED']);
});

test('T8f: 截图只是 observed_instance，不等于完整问题范围', () => {
  // 用户只截了 empty-launcher，但同类 WorkspaceSurface 还有 3 个 -> 必须是 FAMILY
  const c = classifyProblem({
    observed_instance: 'empty-launcher',
    affected_components: [
      { id: 'empty-launcher', family: 'WorkspaceSurface' },
      { id: 'settings-surface', family: 'WorkspaceSurface' },
      { id: 'files-surface', family: 'WorkspaceSurface' },
    ],
  });
  assert.equal(c.problem_class, 'FAMILY');
  assert.equal(c.observed_instance, 'empty-launcher');

  const gate = validateFamilyGate({ problem_class: c.problem_class, members: ['empty-launcher', 'settings-surface', 'files-surface'], validated_members: ['empty-launcher'] });
  assert.equal(gate.ok, false, '只验证截图实例必须被家族门禁拦住');
  assert.deepEqual(gate.missing, ['settings-surface', 'files-surface']);
});
