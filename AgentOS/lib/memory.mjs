// Experience Memory —— 任务单第二十三节（记忆分类）+ 第二十五节（append-only、错误结论保留但标记）。
//
// 铁律：
//   - 记忆是 append-only。过去记录不得覆盖。
//   - 错误结论保留，只标记 rejected / superseded / deprecated / questionable。
//   - 未经验证的经验不得直接成为正式知识或正式 Skill（晋升链在 lib/learning.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso, canonicalJson, sha256Text } from './paths.mjs';

/** 第二十三节的记忆种类（与第五节目录一一对应）。 */
export const MEMORY_KINDS = Object.freeze([
  'episodic',
  'semantic',
  'procedural',
  'self_model',
  'world_model',
  'project_model',
]);

export const MEMORY_KIND_DIRS = Object.freeze({
  episodic: 'memory/episodic',
  semantic: 'memory/semantic',
  procedural: 'memory/procedural',
  self_model: 'memory/self-model',
  world_model: 'memory/world-model',
  project_model: 'memory/project-model',
});

/** 第五节目录里没有 working —— 工作记忆就是当前任务记录本身。 */
export const WORKING_MEMORY_LOCATION = 'tasks/active';

/** 第二十五节：错误结论保留，但要标记。 */
export const MEMORY_STATUSES = Object.freeze(['active', 'rejected', 'superseded', 'deprecated', 'questionable']);

export class MemoryStore {
  constructor({ root } = {}) {
    if (!root) throw new Error('MemoryStore: root is required');
    this.root = root;
  }

  fileFor(kind) {
    const d = MEMORY_KIND_DIRS[kind];
    if (!d) {
      const e = new Error('MemoryStore: unknown kind ' + kind);
      e.kinds = [...MEMORY_KINDS];
      throw e;
    }
    return path.join(this.root, d, 'records.jsonl');
  }

  /** 追加一条记录（不改、不删）。 */
  append(kind, partial) {
    const file = this.fileFor(kind);
    ensureDir(path.dirname(file));
    const existing = this.readAll(kind).length;
    const rec = { seq: existing + 1, kind, recorded_at: nowIso(), ...partial };
    rec.seq = existing + 1;
    rec.kind = kind;
    rec.integrity = sha256Text(canonicalJson({ ...rec, integrity: undefined }));
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  }

  readAll(kind) {
    const file = this.fileFor(kind);
    if (!fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // 损坏行不静默丢弃：以占位记录暴露出来
        out.push({ type: 'BROKEN_RECORD', raw: line, kind });
      }
    }
    return out;
  }

  /** 记一条经验/知识。 */
  remember({ kind, id, content, evidence = null, source = null, confidence = null, tags = [] } = {}) {
    if (!kind) throw new Error('remember: kind is required');
    if (!id) throw new Error('remember: id is required');
    return this.append(kind, { type: 'MEMORY', id, content, evidence, source, confidence, tags });
  }

  /** 改状态不改原文：追加一条 MEMORY_STATUS 引用原记录。 */
  setStatus({ kind, id, status, reason = null } = {}) {
    if (!MEMORY_STATUSES.includes(status)) {
      return { ok: false, error: 'unknown_status', status, allowed: [...MEMORY_STATUSES] };
    }
    const target = this.find(kind, id);
    if (!target) return { ok: false, error: 'memory_not_found', kind, id };
    const rec = this.append(kind, { type: 'MEMORY_STATUS', ref: id, status, reason });
    return { ok: true, record: rec };
  }

  /** 重放出当前有效视图（记录原文 + 最新状态）。 */
  current(kind) {
    const byId = new Map();
    for (const r of this.readAll(kind)) {
      if (r.type === 'MEMORY_STATUS') {
        const t = byId.get(r.ref);
        if (t) {
          t.status = r.status;
          t.status_reason = r.reason;
          t.status_at = r.recorded_at;
        }
        continue;
      }
      if (r.type === 'MEMORY' && r.id) {
        byId.set(r.id, { ...r, status: 'active', status_reason: null, status_at: null });
      }
    }
    return [...byId.values()];
  }

  find(kind, id) {
    return this.current(kind).find((r) => r.id === id) || null;
  }

  byStatus(kind, status) {
    return this.current(kind).filter((r) => r.status === status);
  }

  /** 第二十三节 5：Self Model —— 能力、工具、局限和历史表现。 */
  recordCapability({ capability, outcome, context, evidence = null } = {}) {
    if (!capability) throw new Error('recordCapability: capability is required');
    if (!['success', 'failure'].includes(outcome)) throw new Error('recordCapability: outcome must be success|failure');
    return this.append('self_model', { type: 'CAPABILITY', capability, outcome, context, evidence });
  }

  capabilitySummary() {
    const recs = this.readAll('self_model').filter((r) => r.type === 'CAPABILITY');
    const byName = new Map();
    for (const r of recs) {
      const e = byName.get(r.capability) || { capability: r.capability, attempts: 0, successes: 0, failures: 0, contexts: new Set() };
      e.attempts++;
      if (r.outcome === 'success') e.successes++;
      else if (r.outcome === 'failure') e.failures++;
      if (r.context) e.contexts.add(r.context);
      byName.set(r.capability, e);
    }
    return [...byName.values()].map((e) => ({
      capability: e.capability,
      attempts: e.attempts,
      successes: e.successes,
      failures: e.failures,
      success_rate: e.attempts ? Number((e.successes / e.attempts).toFixed(4)) : null,
      distinct_contexts: e.contexts.size,
    }));
  }

  /** 第二十三节 6：World / Project Model 快照（目标、架构、版本、依赖、约束、路线图）。 */
  snapshot({ kind, data, source = null } = {}) {
    if (!['world_model', 'project_model'].includes(kind)) {
      return { ok: false, error: 'snapshot_kind_must_be_world_or_project_model', kind };
    }
    return this.append(kind, { type: 'SNAPSHOT', id: `${kind}-${nowIso()}`, data, source });
  }

  latestSnapshot(kind) {
    const snaps = this.readAll(kind).filter((r) => r.type === 'SNAPSHOT');
    return snaps.length ? snaps[snaps.length - 1] : null;
  }
}

export function createMemoryStore(root) {
  return new MemoryStore({ root });
}
