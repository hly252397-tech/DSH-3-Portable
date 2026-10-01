// Console / Status aggregation —— 任务单第二十六节（控制台 UI）。
//
// 设计原则：
//   1. **只读聚合，不新增事实源**。所有字段都从既有 append-only 制品里读，
//      不引入第二份真相（也就不存在"两边不一致"的可能）。
//   2. **读不到就如实标 null 并给 warning**，绝不静默省略 —— 缺数据也是一种状态。
//   3. 输出里带 `sources`，每个字段能追到它是从哪个文件读出来的。
import fs from 'node:fs';
import path from 'node:path';
import { readJsonIfExists, nowIso } from './paths.mjs';
import { findTaskFile, loadRunState } from './runner.mjs';
import { evaluateContractProgress } from './goalcontract.mjs';
import { isTerminal, mayStop } from './taskstate.mjs';
import { Ledger } from './ledger.mjs';
import { processBrokerStatus } from './processbroker.mjs';
import { MemoryStore } from './memory.mjs';
import { computeFingerprint } from './fingerprint.mjs';
import { resolveLiveStable } from './stableshield.mjs';

/** 第二十六节列出的字段，一个不少。 */
export const CONSOLE_FIELDS = Object.freeze([
  'goal',
  'task_state',
  'stable',
  'candidate',
  'workspace_fingerprint',
  'last_pass_fingerprint',
  'pending_items',
  'known_defects',
  'hypotheses',
  'verification',
  'new_failures',
  'unconsumed_critical_events',
  'temporary_artifacts',
  'parent_resume_point',
  'processes',
]);

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/** 最新一份 verdict（按 finished_at）。 */
export function latestVerdicts({ verdictsDir }) {
  const rows = [];
  for (const f of listJsonFiles(verdictsDir)) {
    const j = readJsonIfExists(f);
    if (j && j.run_id) rows.push({ ...j, file: f });
  }
  rows.sort((a, b) => String(a.finished_at ?? '').localeCompare(String(b.finished_at ?? '')));
  const latest = rows.length ? rows[rows.length - 1] : null;
  const passes = rows.filter((r) => r.status === 'PASS');
  return { total: rows.length, latest, latest_pass: passes.length ? passes[passes.length - 1] : null, all: rows };
}

export function buildConsoleView({ root, taskId = null, portableRoot = null, extraFiles = {}, now = () => new Date().toISOString() } = {}) {
  if (!root) throw new Error('buildConsoleView: root is required');
  const absRoot = path.resolve(root);
  const warnings = [];
  const sources = {};

  // ---- 任务与合约 ----
  let bundle = null;
  let taskFile = null;
  if (taskId) {
    const found = findTaskFile({ root: absRoot, taskId });
    if (found) {
      bundle = found.state;
      taskFile = found.file;
    } else {
      warnings.push(`任务 ${taskId} 在 tasks/{active,completed,failed} 里找不到`);
    }
  } else {
    warnings.push('未指定 task_id —— 任务域字段留空');
  }
  sources.task = taskFile;
  const task = bundle?.task ?? null;
  const contract = bundle?.contract ?? null;

  // ---- 运行/治理状态 ----
  const run = taskId ? loadRunState({ root: absRoot, taskId }) : null;
  sources.run_state = taskId ? path.join(absRoot, 'workspaces', taskId, 'run.json') : null;

  // ---- 事件账本 ----
  const ledgerFile = path.join(absRoot, 'events', 'task-events.jsonl');
  sources.ledger = ledgerFile;
  const ledger = new Ledger(ledgerFile);
  const unconsumed = taskId ? ledger.unconsumedCritical({ taskId }) : ledger.unconsumedCritical();

  // ---- 验证结果 ----
  const verdictsDir = path.join(absRoot, 'verdicts');
  sources.verdicts = verdictsDir;
  const v = latestVerdicts({ verdictsDir });

  // ---- 候选 ----
  const candidatesDir = path.join(absRoot, 'candidates', 'active');
  sources.candidates = candidatesDir;
  const activeCandidates = listJsonFiles(candidatesDir).map(readJsonIfExists).filter(Boolean);

  // ---- 进程 ----
  const proc = processBrokerStatus({ root: absRoot });
  sources.process_registry = proc.registry;

  // ---- 记忆（假设）----
  const memory = new MemoryStore({ root: absRoot });
  sources.memory = path.join(absRoot, 'memory');
  let semantic = [];
  try {
    semantic = memory.current('semantic');
  } catch {
    warnings.push('semantic memory 读不出来');
  }
  const hypotheses = [
    ...activeCandidates.map((c) => ({ source: 'candidate', id: c.id, text: c.hypothesis ?? null, status: c.status ?? 'active' })),
    ...semantic
      .filter((r) => String(r.id ?? '').startsWith('HYP-') || r.tags?.includes?.('hypothesis'))
      .map((r) => ({ source: 'memory.semantic', id: r.id, text: r.content ?? null, status: r.status })),
    ...(contract?.known_unknowns ?? []).map((k) => ({ source: 'contract.known_unknowns', id: k.id ?? String(k), text: null, status: 'open' })),
  ];

  // ---- Stable ----
  let stable = null;
  // sources 的形状要稳定：读不到也要有个键，值给 null —— 否则"缺键"和"值为空"分不清
  sources.stable = portableRoot ? path.join(path.resolve(portableRoot), 'Data', 'Runtime', 'Harness', 'current.json') : null;
  if (portableRoot) {
    stable = resolveLiveStable({ portableRoot });
  } else {
    warnings.push('未给 portable_root —— Stable 域留空');
  }

  // ---- 指纹 ----
  const fp = computeFingerprint({ root: absRoot, extraFiles });
  if (fp.degraded === true) warnings.push('当前指纹零覆盖（degraded）—— 不能作为 PASS 依据');

  // ---- 组装（§26 字段一个不少）----
  const progress = contract ? evaluateContractProgress(contract, { satisfied: run?.satisfied ?? [] }) : null;

  const view = {
    schema_version: 1,
    generated_at: now(),
    root: absRoot,
    task_id: taskId,

    goal: contract?.goal ?? null,
    task_state: task?.state ?? null,
    task_is_terminal: task ? isTerminal(task.state) : null,
    task_may_stop: task ? mayStop(task.state) : null,

    stable: stable
      ? {
          portable_root: stable.portable_root,
          harness_active_slot: stable.harness.active_slot,
          harness_slots: stable.harness.slots.length,
          harness_resolved_from: stable.harness.pointer_resolved_from,
          desktop_active_slot: stable.desktop.active_slot,
          desktop_ambiguous_slots: stable.desktop.ambiguous_slots,
          desktop_resolved_from: stable.desktop.pointer_resolved_from,
          protected_surfaces: stable.protectedPaths.map((p) => ({ id: p.id, kind: p.kind, exists: p.exists })),
        }
      : null,

    candidate: activeCandidates.length
      ? activeCandidates.map((c) => ({ id: c.id, status: c.status, hypothesis: c.hypothesis, allowed_files: c.allowed_files, can_continue_development: c.can_continue_development }))
      : null,

    workspace_fingerprint: fp.aggregate,
    workspace_fingerprint_meta: { coverage: fp.coverage, degraded: fp.degraded === true, entries: fp.counts?.entries ?? null },

    last_pass_fingerprint: v.latest_pass ? v.latest_pass.workspace_fingerprint : null,

    pending_items: progress ? progress.unmet.map((u) => ({ group: u.group, id: u.id })) : null,
    known_defects: run ? [...(run.failures ?? [])] : null,
    hypotheses,

    verification: v.latest
      ? {
          status: v.latest.status,
          run_id: v.latest.run_id,
          finished_at: v.latest.finished_at,
          workspace_fingerprint: v.latest.workspace_fingerprint,
          failed_checks: (v.latest.checks ?? []).filter((c) => !c.ok).map((c) => c.id),
          total_verdicts: v.total,
        }
      : null,

    // 基线失败没被持久化 -> 如实说"算不出来"，不编
    new_failures: null,
    unconsumed_critical_events: unconsumed.map((e) => ({ seq: e.seq, type: e.type, recorded_at: e.recorded_at })),

    temporary_artifacts: run && 'temporary_artifacts' in run ? run.temporary_artifacts : null,
    parent_resume_point: run && (run.resume_points ?? []).length ? run.resume_points : null,
    subtasks: run?.subtasks ?? null,
    stack_depth: run?.stack_depth ?? null,

    processes: proc.alive.map((p) => ({ process_id: p.process_id, pid: p.pid, owner_task_id: p.owner_task_id, alive: p.alive, stop_method: p.stop_method })),

    warnings,
    sources,
  };

  if (view.new_failures === null) warnings.push('new_failures 算不出来：基线失败集合没有被持久化（run.json 只记了 failures）');
  if (view.temporary_artifacts === null) {
    warnings.push(
      run
        ? 'temporary_artifacts 未记录：run.json 里没有这个字段（不是"没跑过 govern"）'
        : 'temporary_artifacts 未记录：该任务没有 run.json（没跑过 govern）',
    );
  }
  return view;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 自包含 HTML 报告（只读制品，随手便携盘搬移）。 */
export function renderConsoleHtml(view) {
  const rows = CONSOLE_FIELDS.map((f) => {
    const val = view[f === 'task_state' ? 'task_state' : f];
    const pretty = val === null ? '<span class="null">null</span>' : `<pre>${esc(JSON.stringify(val, null, 2))}</pre>`;
    return `<tr><th>${esc(f)}</th><td>${pretty}</td></tr>`;
  }).join('\n');

  const warns = view.warnings.length
    ? `<ul>${view.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : '<p class="ok">无告警</p>';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>AgentOS Console — ${esc(view.task_id ?? 'no-task')}</title>
<style>
 body{font:14px/1.6 system-ui,"Segoe UI",sans-serif;margin:24px;background:#0f1116;color:#e6e6e6}
 h1{font-size:20px;margin:0 0 4px} .meta{color:#9aa0a6;font-size:12px;margin-bottom:16px}
 table{border-collapse:collapse;width:100%} th,td{border:1px solid #2a2f3a;padding:6px 10px;vertical-align:top;text-align:left}
 th{width:210px;background:#171a21;font-weight:600} pre{margin:0;white-space:pre-wrap;word-break:break-word}
 .null{color:#e06c75} .ok{color:#98c379} .warn{background:#2a1f1f;border-color:#5a2f2f}
</style></head><body>
<h1>AgentOS Console</h1>
<div class="meta">root=${esc(view.root)} · task=${esc(view.task_id ?? '—')} · 生成于 ${esc(view.generated_at)}</div>
<table>${rows}</table>
<h2 style="font-size:16px">告警</h2>
${warns}
</body></html>`;
}
