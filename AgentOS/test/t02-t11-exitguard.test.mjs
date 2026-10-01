// 验收测试 2 / 11 —— Exit Guard 拒绝「说一句下一步就下班」与未清理的临时探针
// （任务单第十七、二十八节）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit, detectDeferredPhrases, checkDeferredWork, DEFERRED_PHRASES } from '../lib/exitguard.mjs';
import { cleanExitState } from './helpers.mjs';

test('T2: 答复里出现「接下来会/剩余」且工作既没入队也没在跑 -> 拒绝发送', () => {
  const r = checkDeferredWork({ text: '接下来会修复剩余的问题', queuedItems: [], runningItems: [], blockedUser: false });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'deferred_work_not_queued_must_continue');
  assert.ok(r.blocked_phrases.includes('接下来会'));
  assert.ok(r.blocked_phrases.includes('剩余'));

  // 已入队 -> 允许（因为工作确实在推进）
  const queued = checkDeferredWork({ text: '稍后处理', queuedItems: ['fix-side-chat'], runningItems: [] });
  assert.equal(queued.allowed, true);
  assert.equal(queued.reason, 'work_already_queued');

  // 正在跑 -> 允许
  const running = checkDeferredWork({ text: '下一步跑完整冷启动', runningItems: ['cold-boot-1'] });
  assert.equal(running.allowed, true);
  assert.equal(running.reason, 'work_already_running');

  // 合法用户阻塞（缺凭据 / 待拍板 / 难回滚确认）-> 允许
  const blocked = checkDeferredWork({ text: '稍后需要你确认部署切换', blockedUser: true });
  assert.equal(blocked.allowed, true);
  assert.equal(blocked.reason, 'legitimate_user_block');

  // 没有拖延措辞 -> 不干涉
  const clean = checkDeferredWork({ text: '任务已完成，证据见 verdicts/run-1.json' });
  assert.equal(clean.allowed, true);
  assert.equal(clean.reason, 'no_deferred_phrasing');
});

test('T2b: 第十七节 8 个拖延词全部可检出', () => {
  for (const p of DEFERRED_PHRASES) {
    assert.deepEqual(detectDeferredPhrases('前缀' + p + '后缀'), [p], p + ' 必须被检出');
  }
  assert.deepEqual(detectDeferredPhrases('一切都完成了'), []);
});

test('T11: 临时探针未删除 -> Completion Gate 拒绝完成', () => {
  const r = evaluateExit(cleanExitState({ temporary_artifacts: 2 }));
  assert.equal(r.status, 'EXIT_BLOCKED');
  assert.equal(r.blockers.length, 1);
  assert.equal(r.blockers[0].field, 'temporary_artifacts');
  assert.equal(r.blockers[0].actual, 2);
  assert.equal(r.blockers[0].required, 0);
});

test('T11b: 工作区脏 / 指纹不匹配 / 父任务未空 都各自阻断', () => {
  assert.equal(evaluateExit(cleanExitState()).status, 'OK');

  const dirty = evaluateExit(cleanExitState({ workspace_dirty: true }));
  assert.equal(dirty.status, 'EXIT_BLOCKED');
  assert.ok(dirty.blockers.some((b) => b.field === 'workspace_dirty'));

  const stalePass = evaluateExit(cleanExitState({ current_fingerprint: 'F2', last_pass_fingerprint: 'F' }));
  assert.equal(stalePass.status, 'EXIT_BLOCKED');
  assert.ok(stalePass.blockers.some((b) => b.field === 'current_fingerprint'));

  const nested = evaluateExit(cleanExitState({ parent_task_stack_empty: false }));
  assert.ok(nested.blockers.some((b) => b.field === 'parent_task_stack_empty'));

  const noPass = evaluateExit(cleanExitState({ current_fingerprint: 'F', last_pass_fingerprint: null }));
  assert.equal(noPass.status, 'EXIT_BLOCKED');
  assert.equal(noPass.blockers.find((b) => b.field === 'current_fingerprint').detail, 'no_last_pass');
});

test('T11c: 13 个条件一条不漏 —— 每次只破坏一条都必须被抓住', () => {
  const vectors = [
    ['pending_items', 1],
    ['executable_items', 1],
    ['known_defects', 1],
    ['new_failures', ['F']],
    ['unexpected_deltas', ['D']],
    ['unverified_changes', 1],
    ['temporary_artifacts', 1],
    ['failed_gates', 1],
    ['unconsumed_critical_events', 1],
    ['incomplete_acceptance_items', 1],
    ['workspace_dirty', true],
    ['parent_task_stack_empty', false],
    ['current_fingerprint', 'OTHER'],
  ];
  assert.equal(vectors.length, 13);
  for (const [field, value] of vectors) {
    const r = evaluateExit(cleanExitState({ [field]: value }));
    assert.equal(r.status, 'EXIT_BLOCKED', field + ' 未被拦截');
    assert.ok(r.blockers.some((b) => b.field === field || (field === 'current_fingerprint' && b.field === 'current_fingerprint')), field + ' 未出现在 blockers');
  }
});
