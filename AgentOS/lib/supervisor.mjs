// Supervisor / Runtime Governor —— 任务单第三节（总体架构）+ 第六节 + 第七节 + 第十五节 + 第十七节。
//
// 权责分离（第三节原文）：
//   1. Agent Worker 负责提出计划、分析和操作。
//   2. Agent Worker 无权直接设置 COMPLETED。
//   3. Agent Worker 无权直接晋升 Candidate。
//   4. Agent Worker 无权绕过 Verifier。
//   5. Agent Worker 无权修改根权限策略。
//   6. Supervisor 决定任务状态、候选晋升、回滚和完成。
//   7. 所有文件、命令、进程和网络操作必须经过 Tool Broker。
//
// 本模块只实现「决定」这一侧；Worker 通过注入的 `act()` 提供，因此可确定性测试。
import { transition, mayStop, isTerminal, findTransitionPath } from './taskstate.mjs';
import { createStack, pushTask, topFrame, depth as stackDepth, suspendForChild, completeChild } from './taskstack.mjs';
import { evaluateExit } from './exitguard.mjs';
import { evaluateContractProgress, evaluateActionAlignment } from './goalcontract.mjs';
import { evaluateStopLine, bumpCounter, DEFAULT_LIMITS, COUNTER_KEYS } from './stopline.mjs';
import { computeDelta } from './candidate.mjs';
import { applyCriticalEvent } from './eventbus.mjs';
import { nowIso } from './paths.mjs';

export const SUPERVISOR_ACTIONS = Object.freeze([
  'CONTINUE',
  'COMPLETE',
  'TERMINAL',
  'STOP_THE_LINE',
  'BLOCKED_USER',
  'BLOCKED_POLICY',
  'FAILED_EXHAUSTED',
]);

export const MAX_STEPS_DEFAULT = 50;

/**
 * 纯决策函数：只回答「下一步该干什么」，不做任何副作用。
 * 顺序即优先级，不能重排：
 *   终态 > 停线 > 策略阻塞 > 完成 > 有活干 > 用户阻塞 > 必须自己找活
 */
export function decideNext({
  taskState,
  terminal = false,
  contractProgress = { done: false, unmet: [] },
  exitEvaluation = { status: 'EXIT_BLOCKED', blockers: [] },
  stopLine = { tripped: false },
  queuedItems = [],
  runningItems = [],
  blockedUser = false,
  blockedPolicy = false,
  exhausted = false,
  subtaskOpen = false,
  completionGuard = null,
} = {}) {
  if (terminal || isTerminal(taskState)) {
    return { action: 'TERMINAL', reason: 'terminal_state', state: taskState };
  }
  if (stopLine.tripped) {
    return { action: 'STOP_THE_LINE', reason: 'limits_exceeded', violations: stopLine.violations, steps: stopLine.steps };
  }
  if (blockedPolicy) {
    return { action: 'BLOCKED_POLICY', reason: 'policy_blocks_progress' };
  }
  // §8：子任务没跑完不许结束父任务 —— 先把子问题修完再谈完成
  if (subtaskOpen) {
    return { action: 'CONTINUE', reason: 'subtask_in_progress_must_finish_first', next_item: queuedItems[0] ?? null };
  }
  if (exitEvaluation.status === 'OK' && contractProgress.done) {
    return { action: 'COMPLETE', reason: 'contract_done_and_exit_guard_ok', guard: completionGuard };
  }
  if (queuedItems.length || runningItems.length) {
    return { action: 'CONTINUE', reason: 'work_available', next_item: queuedItems[0] ?? runningItems[0] ?? null };
  }
  if (blockedUser) {
    return { action: 'BLOCKED_USER', reason: 'legitimate_user_block_and_no_executable_work' };
  }
  if (exhausted) {
    return { action: 'FAILED_EXHAUSTED', reason: 'no_executable_work_left' };
  }
  // 第十七节：只要还有可自动执行的工作就必须继续 —— 这里没有活，但退出闸门也没过，
  // 所以必须去**找**活（而不是停下等用户）。
  return {
    action: 'CONTINUE',
    reason: 'exit_blocked_must_find_next_executable',
    next_item: null,
    blockers: exitEvaluation.blockers,
  };
}

export class Supervisor {
  /**
   * @param {object} o
   * @param {object} o.task            任务状态机记录
   * @param {object} o.contract        Goal Contract
   * @param {object} o.worker          { act({task, contract, item, supervisor}) -> {ok, evidence, failures?, ...} }
   * @param {object} [o.ledger]        Ledger（事件账本）
   * @param {object} [o.memory]        MemoryStore（可写 procedural / episodic）
   * @param {object} [o.policy]        指纹、候选结论、基线失败等
   * @param {object} [o.limits]        停线上限
   */
  constructor({ task, contract, worker, ledger = null, memory = null, policy = {}, limits = DEFAULT_LIMITS, stack = null } = {}) {
    if (!task) throw new Error('Supervisor: task is required');
    if (!contract) throw new Error('Supervisor: contract is required');
    if (!worker || typeof worker.act !== 'function') throw new Error('Supervisor: worker.act is required');

    this.task = task;
    this.contract = contract;
    this.worker = worker;
    this.ledger = ledger;
    this.memory = memory;
    this.policy = { ...policy };
    this.limits = { ...limits };

    this.satisfied = new Set(policy.initial_satisfied || []);
    this.queued = [];
    this.counters = { ...(policy.initial_counters || {}) };
    this.failures = [];
    this.baselineFailures = [...(policy.baseline_failures || [])];
    this.expectedDeltas = [...(policy.expected_deltas || [])];
    this.actualDeltas = [...(policy.actual_deltas || [])];
    this.unverifiedChanges = policy.unverified_changes ?? 0;
    this.temporaryArtifacts = policy.temporary_artifacts ?? 0;
    this.trace = [];
    this.stopped = null;
    this.appliedEvents = [];

    /** 父子任务栈：根帧代表本任务；开子任务时压栈，父任务队列存进帧里（§8）。 */
    this.stack = stack ?? createStack();
    if (stackDepth(this.stack) === 0) pushTask(this.stack, { id: task.id ?? 'task' });
    this.subtasks = [];
  }

  depth() {
    return stackDepth(this.stack);
  }

  /**
   * §8：发现阻塞问题 -> 父任务暂停 + 保存 resume_point + 创建修复子任务。
   * 父任务当前队列存进帧里，子任务用**自己的**队列（绝不混用父任务范围）。
   */
  openSubtask({ id, reason = null, items = [], resume_point = null } = {}) {
    const parent = topFrame(this.stack);
    if (!parent) return { ok: false, error: 'no_parent_frame' };
    const rp = resume_point ?? {
      queued_item_ids: this.queued.map((q) => q.id),
      steps_done: this.trace.length,
      reason,
    };
    const s = suspendForChild(this.stack, { resume_point: rp, childTask: { id } });
    if (!s.ok) return s;
    parent.saved_queued = [...this.queued];
    this.queued = items.map((it) => (typeof it === 'string' ? { id: it, addresses: [it] } : it));
    this.subtasks.push({ id, reason, items: this.queued.map((q) => q.id), opened_at: nowIso(), parent_task_id: parent.task_id });
    this.record({ type: 'SUBTASK_OPENED', subtask_id: id, reason, parent_task_id: parent.task_id });
    return { ok: true, subtask_id: id, resume_point: rp, stack_depth: this.depth() };
  }

  /** 子任务收尾 -> 父任务自动 RESUMING_PARENT 并从 resume_point 恢复队列。 */
  closeSubtask({ passed = true, evidence = [] } = {}) {
    if (this.depth() < 2) return { ok: false, error: 'no_open_subtask' };
    const child = topFrame(this.stack);
    const r = completeChild(this.stack, { childTaskId: child.task_id, passed, evidence });
    if (!r.ok) return r;
    const parent = r.parent;
    this.queued = parent.saved_queued ?? [];
    delete parent.saved_queued;
    this.record({ type: passed ? 'SUBTASK_CLOSED' : 'SUBTASK_FAILED', subtask_id: child.task_id, parent_task_id: parent.task_id });
    return { ...r, restored_queue: this.queued.map((q) => q.id) };
  }

  // ---- 状态视图 ----------------------------------------------------------

  get contractProgress() {
    return evaluateContractProgress(this.contract, { satisfied: [...this.satisfied] });
  }

  get delta() {
    return computeDelta({
      baselineFailures: this.baselineFailures,
      candidateFailures: this.failures,
      expectedDeltas: this.expectedDeltas,
      actualDeltas: this.actualDeltas,
    });
  }

  get exitEvaluation() {
    return evaluateExit(this.exitState());
  }

  exitState() {
    const progress = this.contractProgress;
    const d = this.delta;
    return {
      pending_items: progress.unmet.length,
      executable_items: this.queued.length,
      known_defects: this.failures.length,
      new_failures: d.new_failures,
      unexpected_deltas: d.unexpected_deltas,
      unverified_changes: this.unverifiedChanges,
      temporary_artifacts: this.temporaryArtifacts,
      failed_gates: this.policy.failed_gates ?? 0,
      unconsumed_critical_events: this.ledger ? this.ledger.unconsumedCritical({ taskId: this.task.id ?? null }).length : 0,
      incomplete_acceptance_items: progress.unmet.length,
      workspace_dirty: this.policy.workspace_dirty === true,
      parent_task_stack_empty: this.policy.parent_task_stack_empty !== false,
      current_fingerprint: this.policy.current_fingerprint ?? null,
      last_pass_fingerprint: this.policy.last_pass_fingerprint ?? null,
    };
  }

  completionGuard() {
    const cur = this.policy.current_fingerprint ?? null;
    const last = this.policy.last_pass_fingerprint ?? null;
    return {
      exitOk: this.exitEvaluation.status === 'OK',
      contractDone: this.contractProgress.done,
      fingerprintMatch: Boolean(cur && last && cur === last),
      candidateOutcome: this.policy.candidate_outcome ?? null,
    };
  }

  snapshot() {
    return {
      taskState: this.task.state,
      terminal: isTerminal(this.task.state),
      contractProgress: this.contractProgress,
      exitEvaluation: this.exitEvaluation,
      stopLine: evaluateStopLine({ counters: this.counters, limits: this.limits }),
      queuedItems: [...this.queued],
      runningItems: [],
      blockedUser: this.policy.blocked_user === true,
      blockedPolicy: this.policy.blocked_policy === true,
      exhausted: this.policy.exhausted === true,
      subtaskOpen: this.depth() > 1,
      stack_depth: this.depth(),
      counters: { ...this.counters },
      completionGuard: this.completionGuard(),
      mayStop: mayStop(this.task.state),
    };
  }

  // ---- 队列 --------------------------------------------------------------

  /** 把 Goal Contract 里还没完成的条目排成可执行队列。 */
  queueFromContract() {
    this.queued = this.contractProgress.unmet.map((u) => ({ id: u.id, group: u.group, addresses: [u.id] }));
    return this.queued;
  }

  // ---- 事件 --------------------------------------------------------------

  /** 消费**属于本任务**的未处理关键事件，并按第十五节自动改变任务状态。 */
  drainEvents({ by = 'supervisor' } = {}) {
    if (!this.ledger) return [];
    const out = [];
    for (const ev of this.ledger.unconsumedCritical({ taskId: this.task.id ?? null })) {
      const r = applyCriticalEvent({ bus: { ledger: this.ledger }, taskRecord: this.task, seq: ev.seq, by });
      if (r.ok) this.task = r.record;
      out.push(r);
    }
    // 累积而不是覆盖：否则下一轮的「空结果」会把上一轮的审计轨迹抹掉（已实测）
    this.appliedEvents.push(...out);
    return out;
  }

  // ---- 执行 --------------------------------------------------------------

  ensureExecuting() {
    const path = ['SCOPING', 'PLANNING', 'EXECUTING'];
    for (const s of path) {
      if (this.task.state === s) continue;
      const r = transition(this.task, s, { reason: 'supervisor:start' });
      if (!r.ok) break;
      this.task = r.record;
      if (s === 'EXECUTING') break;
    }
    return this.task.state;
  }

  record(partial) {
    if (!this.ledger) return null;
    return this.ledger.append({ ...partial });
  }

  /**
   * 应用一步结果。
   * 关键：**Worker 的返回值只能影响「哪些合约条目被满足」和「有哪些失败」，
   * 绝不能直接改任务状态，也绝不能宣布完成。**
   */
  applyResult(item, result) {
    const r = result || {};
    const addresses = item.addresses && item.addresses.length ? item.addresses : [item.id];
    // 子任务的条目**不属于父任务的 Goal Contract**，拿父合约去对齐必然判成"跑偏"。
    // 子任务的推进由「开子任务时声明的条目集合」界定，所以这里只对根任务做合约对齐。
    const alignment =
      this.depth() > 1
        ? { aligned: true, reason: 'subtask_item_declared_by_open_subtask', valid: [item.id], unknownRefs: [] }
        : evaluateActionAlignment(this.contract, { action: item.id, addresses });
    const ok = r.ok === true && alignment.aligned;

    if (ok) {
      for (const a of addresses) this.satisfied.add(a);
      this.queued = this.queued.filter((q) => q.id !== item.id);
      this.failures = this.failures.filter((f) => !String(f).includes(item.id));
      this.counters = { ...this.counters, no_progress_steps: 0 };
      if (Array.isArray(r.deltas)) this.actualDeltas.push(...r.deltas);
      if (typeof r.temporary_artifacts === 'number') this.temporaryArtifacts = r.temporary_artifacts;
      if (typeof r.unverified_changes === 'number') this.unverifiedChanges = r.unverified_changes;
      if (r.regression === true) this.counters = bumpCounter(this.counters, 'consecutive_regressions').counters;
      else this.counters = { ...this.counters, consecutive_regressions: 0 };
      this.record({ type: 'STEP_OK', item_id: item.id, addresses, evidence: r.evidence ?? null });
    } else {
      this.failures.push(`${item.id}:${alignment.aligned ? 'step_failed' : alignment.reason}`);
      if (r.self_inflicted === true) this.counters = bumpCounter(this.counters, 'self_inflicted_errors').counters;
      this.counters = bumpCounter(this.counters, 'no_progress_steps').counters;
      this.record({ type: 'STEP_FAIL', item_id: item.id, alignment: alignment.reason, evidence: r.evidence ?? null });
    }
    return { ok, alignment };
  }

  async act(item) {
    return (await this.worker.act({ task: this.task, contract: this.contract, item, supervisor: this })) || {};
  }

  // ---- 主循环 ------------------------------------------------------------

  async run({ maxSteps = MAX_STEPS_DEFAULT } = {}) {
    if (!isTerminal(this.task.state)) this.ensureExecuting();

    for (let step = 0; step < maxSteps; step++) {
      this.drainEvents();

      // §8：子任务队列跑完 -> 自动收尾 -> 父任务 RESUMING_PARENT 并从 resume_point 恢复队列
      if (this.depth() > 1 && this.queued.length === 0) {
        const closed = this.closeSubtask({ passed: true, evidence: ['child queue completed'] });
        this.trace.push({
          step,
          at: nowIso(),
          task_state: this.task.state,
          action: 'SUBTASK_CLOSED',
          ok: closed.ok,
          subtask_id: closed.child?.task_id ?? null,
          resumed: closed.resumed === true,
          restored_queue: closed.restored_queue ?? null,
        });
        continue;
      }

      const snap = this.snapshot();
      const decision = decideNext(snap);
      this.trace.push({
        step,
        at: nowIso(),
        task_state: this.task.state,
        action: decision.action,
        reason: decision.reason,
        next_item_id: decision.next_item?.id ?? null,
      });

      if (decision.action === 'TERMINAL') {
        this.stopped = decision;
        return this.summary();
      }
      if (decision.action === 'STOP_THE_LINE') {
        this.stopped = decision;
        this.record({ type: 'STOP_THE_LINE', violations: decision.violations, steps: decision.steps });
        return this.summary();
      }
      if (decision.action === 'BLOCKED_POLICY' || decision.action === 'BLOCKED_USER' || decision.action === 'FAILED_EXHAUSTED') {
        const r = transition(this.task, decision.action, { reason: 'supervisor:' + decision.reason });
        if (r.ok) this.task = r.record;
        this.stopped = { ...decision, transition: r };
        return this.summary();
      }
      if (decision.action === 'COMPLETE') {
        // 先用合法路径把状态推到 READY_TO_COMPLETE，再走完成守卫（不许硬塞跳步）
        const path = findTransitionPath(this.task.state, 'READY_TO_COMPLETE');
        if (path === null) {
          this.stopped = { action: 'COMPLETE_REFUSED', error: 'no_legal_path_to_ready_to_complete', from: this.task.state };
          this.counters = bumpCounter(this.counters, 'no_progress_steps').counters;
          continue;
        }
        for (const s of path) {
          const pr = transition(this.task, s, { reason: 'supervisor:pre_complete' });
          if (!pr.ok) break;
          this.task = pr.record;
        }
        const r = transition(this.task, 'COMPLETED', { reason: 'supervisor:guard_satisfied', guard: decision.guard });
        if (!r.ok) {
          // 伪完成被守卫拦住：不改状态，继续找活（而不是悄悄停）
          this.stopped = { action: 'COMPLETE_REFUSED', error: r.error, blockers: r.blockers };
          this.counters = bumpCounter(this.counters, 'no_progress_steps').counters;
          this.trace.push({ step, action: 'COMPLETE_REFUSED', blockers: r.blockers });
          const sl = evaluateStopLine({ counters: this.counters, limits: this.limits });
          if (sl.tripped) {
            // 沿用 stopLine 的 steps，别把 8 个强制动作丢掉
            this.stopped = { ...sl, action: 'STOP_THE_LINE', reason: 'completion_guard_refused_repeatedly' };
            this.record({ type: 'STOP_THE_LINE', violations: sl.violations, steps: sl.steps });
            return this.summary();
          }
          continue;
        }
        this.task = r.record;
        this.record({ type: 'SUPERVISOR_COMPLETED', task_id: this.task.id ?? null });
        if (this.memory) {
          this.memory.remember({
            kind: 'procedural',
            id: `${this.task.id ?? 'task'}-completed`,
            content: '任务按 Goal Contract 全部条目完成并通过退出闸门',
            evidence: this.trace.map((t) => `${t.action}:${t.reason}`).join(' | '),
            source: 'supervisor',
          });
        }
        this.stopped = { action: 'TERMINAL', state: 'COMPLETED' };
        return this.summary();
      }

      // CONTINUE
      // 只有根任务才从 Goal Contract 取活；子任务队列由 openSubtask 给定。
      // 否则会把父任务的条目灌进子任务队列，父子范围就搅在一起了。
      const item = decision.next_item ?? (this.depth() === 1 ? this.queueFromContract()[0] ?? null : null);
      if (!item) {
        const b = bumpCounter(this.counters, 'no_progress_steps');
        this.counters = b.counters;
        if (b.decision.tripped) {
          this.stopped = { action: 'STOP_THE_LINE', reason: 'no_executable_work_available', steps: b.decision.steps };
          return this.summary();
        }
        continue;
      }

      const result = await this.act(item);

      // §8：Worker 报「这里得先修一个子问题」-> 自动挂起父任务并开子任务，不等用户
      if (result && result.needs_subtask) {
        const opened = this.openSubtask({
          id: result.needs_subtask.id ?? `subtask-${this.subtasks.length + 1}`,
          reason: result.needs_subtask.reason ?? null,
          items: result.needs_subtask.items ?? [],
          resume_point: result.needs_subtask.resume_point ?? null,
        });
        this.trace.push({
          step,
          at: nowIso(),
          task_state: this.task.state,
          action: 'SUBTASK_OPENED',
          ok: opened.ok,
          subtask_id: opened.subtask_id ?? null,
          reason: result.needs_subtask.reason ?? null,
          error: opened.error ?? null,
        });
        continue;
      }

      this.applyResult(item, result);
    }

    this.stopped = { action: 'MAX_STEPS_REACHED', maxSteps };
    return this.summary();
  }

  summary() {
    return {
      task_id: this.task.id ?? null,
      state: this.task.state,
      is_terminal: isTerminal(this.task.state),
      may_stop: mayStop(this.task.state),
      stopped: this.stopped,
      steps: this.trace.length,
      contract_progress: this.contractProgress,
      exit_status: this.exitEvaluation.status,
      exit_blockers: this.exitEvaluation.blockers,
      counters: { ...this.counters },
      counter_keys: [...COUNTER_KEYS],
      failures: [...this.failures],
      trace: this.trace,
      stack_depth: this.depth(),
      subtasks: this.subtasks.map((s) => ({ ...s })),
      // 被暂停的帧各自的 resume_point。注意 openSubtask 之后 topFrame 是**子**帧，
      // 它的 resume_point 是 null；真正该看的是父帧的 —— 所以这里全列出来。
      resume_points: this.stack.frames
        .filter((f) => f.resume_point)
        .map((f) => ({ task_id: f.task_id, state: f.state, resume_point: f.resume_point })),
      resume_point: topFrame(this.stack)?.resume_point ?? null,
      guarded_events: this.appliedEvents.map((e) => ({ ok: e.ok, seq: e.seq, error: e.error ?? null })),
    };
  }
}
