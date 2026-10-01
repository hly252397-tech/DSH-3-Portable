// Event Bus —— 任务单第十五节。
//
// 铁律：后台作业不得只写日志。事件必须 -> Event Bus -> Task Engine -> 自动改变任务状态 + 自动注入上下文。
// unconsumed_critical_events > 0 -> 禁止完成。
// Watcher 只能作为自动触发器，不得成为正确性的唯一来源。
import { validateJobRegistration } from './ledger.mjs';
import { transition, deriveStateFromCriticalEvent, isTerminal } from './taskstate.mjs';

export class EventBus {
  constructor({ ledger }) {
    if (!ledger) throw new Error('EventBus: ledger is required');
    this.ledger = ledger;
  }

  /** 登记后台作业；字段不全或「关键作业只写日志」直接拒绝。 */
  registerJob(job) {
    const v = validateJobRegistration(job);
    if (!v.ok) {
      const e = new Error('EventBus.registerJob: invalid registration ' + JSON.stringify(v.problems));
      e.problems = v.problems;
      throw e;
    }
    // 登记事件本身是信息性的：作业「关键」指的是它的 PASS/FAIL/PROCESS_EXIT 必须被消费，
    // 不是「登记这一步」要被消费，否则每次登记都会白堵一次完成闸门。
    return this.ledger.append({
      type: 'JOB_REGISTERED',
      critical: false,
      job_id: job.job_id,
      job_critical: job.critical === true,
      payload: job,
    });
  }

  /** 发布事件：进账本 + 推导目标状态 + 标记是否需要消费。 */
  publish(event) {
    const ev = this.ledger.append(event);
    return {
      event: ev,
      derived_state: deriveStateFromCriticalEvent(ev.type),
      requires_consumption: ev.critical === true,
    };
  }

  /** 未消费的关键事件 -> 需要注入 Agent 上下文的条目。 */
  pendingInjections() {
    return this.ledger.unconsumedCritical().map((e) => ({
      kind: 'context_injection',
      event_seq: e.seq,
      event_type: e.type,
      message: `未消费关键事件 #${e.seq} ${e.type}：必须先由 Task Engine 消费才能改变任务状态`,
    }));
  }

  digest() {
    const integrity = this.ledger.verifyIntegrity();
    const unconsumed = this.ledger.unconsumedCritical();
    return {
      integrity_ok: integrity.ok,
      total_events: integrity.count,
      unconsumed_critical: unconsumed.map((e) => ({ seq: e.seq, type: e.type })),
      completion_blocked: unconsumed.length > 0,
    };
  }
}

/**
 * 把一条关键事件应用到一个任务记录上：改状态 + 消费事件 + 产出上下文注入。
 * 返回 { ok, record, transitioned, injection } 或 { ok:false, ... }。
 */
export function applyCriticalEvent({ bus, taskRecord, seq, by = 'task-engine' }) {
  const events = bus.ledger.readAll().events;
  const ev = events.find((e) => e.seq === seq);
  if (!ev) return { ok: false, error: 'event_not_found', seq };

  const targetState = deriveStateFromCriticalEvent(ev.type);
  let record = taskRecord;
  let transitioned = null;
  const guardErrors = [];

  if (targetState && record) {
    if (isTerminal(record.state)) {
      guardErrors.push({ error: 'terminal_state_cannot_change', from: record.state, to: targetState });
    } else {
      const r = transition(record, targetState, { reason: `event:${ev.type}` });
      if (r.ok) {
        record = r.record;
        transitioned = targetState;
      } else if (r.error === 'illegal_transition') {
        // 当前状态不直接可达：先落到 DIRTY 再进目标（保持机器合法性，不硬塞）
        const viaDirty = transition(record, 'DIRTY', { reason: `event:${ev.type}:via` });
        if (viaDirty.ok) {
          const second = transition(viaDirty.record, targetState, { reason: `event:${ev.type}` });
          if (second.ok) {
            record = second.record;
            transitioned = targetState;
          } else guardErrors.push(second);
        } else guardErrors.push(viaDirty);
      } else {
        guardErrors.push(r);
      }
    }
  }

  if (guardErrors.length) {
    return { ok: false, error: 'state_change_failed', detail: guardErrors, target_state: targetState, event: ev };
  }

  bus.ledger.consume(seq, { by, note: `applied:${ev.type}->${transitioned ?? 'no-state-change'}` });

  return {
    ok: true,
    record,
    transitioned,
    event: ev,
    injection: {
      kind: 'context_injection',
      event_seq: seq,
      event_type: ev.type,
      task_state: record ? record.state : null,
      message: `${ev.type} 已消费：任务状态 -> ${record ? record.state : 'n/a'}`,
    },
  };
}
