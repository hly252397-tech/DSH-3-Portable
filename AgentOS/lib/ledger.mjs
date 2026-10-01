// Task Event Ledger —— 任务单第十五节（后台作业 / Event Bus）+ 第二十五节（append-only）。
//
// 铁律：
//   - append-only。过去事件不得覆盖、不得删除、不得原地改。
//   - 消费（consume）不是修改原事件，而是**追加**一条 EVENT_CONSUMED 引用它。
//   - unconsumed_critical_events > 0 → 禁止完成（Completion Gate 直接读这里）。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso, canonicalJson, sha256Text } from './paths.mjs';

/** 任务单第十五节定义的关键事件。 */
export const CRITICAL_EVENT_TYPES = Object.freeze([
  'PASS',
  'FAIL',
  'ERROR',
  'TIMEOUT',
  'INVALID',
  'PROCESS_EXIT',
  'BOOT_FAILED',
]);

/** 后台作业必须登记的字段（第十五节）。 */
export const JOB_REQUIRED_FIELDS = Object.freeze([
  'job_id',
  'owner_task_id',
  'process_id',
  'status',
  'output_channel',
  'critical',
  'last_event_id',
  'last_event_status',
  'consumed',
]);

export class Ledger {
  constructor(file) {
    this.file = file;
    ensureDir(path.dirname(file));
  }

  /** 追加一条事件。返回写入的事件（含 seq / recorded_at / integrity）。 */
  append(partial) {
    if (!partial || typeof partial !== 'object') throw new Error('Ledger.append: event must be an object');
    if (!partial.type) throw new Error('Ledger.append: event.type is required');
    const st = this.#stat();
    const seq = st.lastSeq + 1;
    const prev = st.lastHash;
    const base = {
      seq,
      type: String(partial.type),
      recorded_at: nowIso(),
      critical: partial.critical === true || CRITICAL_EVENT_TYPES.includes(String(partial.type)),
      prev_hash: prev,
      ...partial,
    };
    base.seq = seq;
    base.type = String(partial.type);
    base.critical = partial.critical === true || CRITICAL_EVENT_TYPES.includes(String(partial.type));
    base.prev_hash = prev;
    // 完整性：整行内容的哈希（含 prev_hash），用于检测篡改
    base.integrity = sha256Text(canonicalJson({ ...base, integrity: undefined }));
    fs.appendFileSync(this.file, JSON.stringify(base) + '\n', 'utf8');
    return base;
  }

  #stat() {
    const events = this.readAll().events;
    const last = events.length ? events[events.length - 1] : null;
    return { count: events.length, lastSeq: last ? last.seq : 0, lastHash: last ? last.integrity : null };
  }

  /** 读取全部事件。损坏行不丢弃，单独报告（取证优先）。 */
  readAll() {
    if (!fs.existsSync(this.file)) return { events: [], broken: [] };
    const raw = fs.readFileSync(this.file, 'utf8');
    const events = [];
    const broken = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue; // 允许结尾空行
      try {
        events.push(JSON.parse(line));
      } catch (e) {
        broken.push({ line: i + 1, text: line, error: String(e && e.message ? e.message : e) });
      }
    }
    return { events, broken };
  }

  /** 追加一条消费记录（不改原事件）。 */
  consume(refSeq, { by = 'system', note = '' } = {}) {
    const all = this.readAll().events;
    const target = all.find((e) => e.seq === refSeq);
    if (!target) throw new Error(`Ledger.consume: no event with seq=${refSeq}`);
    if (target.type === 'EVENT_CONSUMED') throw new Error('Ledger.consume: cannot consume a consumption record');
    return this.append({ type: 'EVENT_CONSUMED', ref_seq: refSeq, consumed_by: by, note });
  }

  /**
   * 关键且未被消费的事件 —— Completion Gate 的硬闸门。
   * @param {object} [o]
   * @param {string} [o.taskId] 只统计**属于该任务**的事件。
   *   §25 的 task_events 是按任务的；全局账本里别的任务的事件不得改本任务状态、
   *   也不得堵住本任务的完成（已实测：不隔离会让 A 任务的 FAIL 把 B 任务打成 VERIFY_FAILED）。
   *   传 undefined 表示不做任务过滤（AgentOS 全局视图用）。
   */
  unconsumedCritical({ taskId } = {}) {
    const events = this.readAll().events;
    const consumed = new Set(events.filter((e) => e.type === 'EVENT_CONSUMED').map((e) => e.ref_seq));
    return events.filter((e) => {
      if (e.critical !== true || e.type === 'EVENT_CONSUMED') return false;
      if (consumed.has(e.seq)) return false;
      if (taskId !== undefined && (e.task_id ?? null) !== taskId) return false;
      return true;
    });
  }

  /** 链式完整性自检：prev_hash 必须串起来，integrity 必须对得上。 */
  verifyIntegrity() {
    const events = this.readAll().events;
    const problems = [];
    let prev = null;
    for (const e of events) {
      if (e.prev_hash !== prev) problems.push({ seq: e.seq, problem: 'prev_hash_mismatch', expected: prev, actual: e.prev_hash });
      const { integrity, ...rest } = e;
      const expect = sha256Text(canonicalJson({ ...rest, integrity: undefined }));
      if (expect !== integrity) problems.push({ seq: e.seq, problem: 'integrity_mismatch' });
      prev = e.integrity;
    }
    return { ok: problems.length === 0, problems, count: events.length };
  }
}

/** 校验后台作业登记是否齐全（第十五节：后台作业只写日志 = 没有自动化）。 */
export function validateJobRegistration(job) {
  const missing = JOB_REQUIRED_FIELDS.filter((f) => !(f in (job || {})));
  const problems = [];
  if (missing.length) problems.push({ problem: 'missing_fields', missing });
  if (job && job.critical === true && job.output_channel === 'log') {
    problems.push({ problem: 'critical_job_writes_log_only' });
  }
  return { ok: problems.length === 0, problems };
}
