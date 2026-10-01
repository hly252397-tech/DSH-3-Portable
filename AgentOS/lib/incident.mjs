// Incident -> Machine Gate —— 任务单第二十二节。
//
// 铁律：事故没有产生机器防线，不得标记 CLOSED。
// 关闭条件 = 根因确认 + 代码修复 + 防复发门禁加入 + 回归用例通过 + Stable 晋升成功。
import path from 'node:path';
import { atomicWriteJson, ensureDir, nowIso } from './paths.mjs';

/** 允许作为「机器防线」的形态。 */
export const GATE_KINDS = Object.freeze([
  'unit_test',
  'integration_test',
  'static_lint',
  'runtime_assertion',
  'layout_invariant',
  'boot_gate',
  'task_state_rule',
  'permission_rule',
  'regression_case',
  'completion_barrier',
]);

/**
 * 判定事故能否 CLOSED。
 * @param {object} o
 * @param {object} o.incident
 * @param {Array}  o.gatesAdded  本次事故新增的门禁 [{ id, kind, path, passing }]
 */
export function evaluateIncidentClosure({ incident = {}, gatesAdded = [] } = {}) {
  const missing = [];
  if (!incident.root_cause) missing.push('root_cause_not_confirmed');
  if (!incident.code_fix) missing.push('code_fix_missing');
  const validGates = (gatesAdded || []).filter((g) => GATE_KINDS.includes(g.kind));
  if (validGates.length === 0) missing.push('no_machine_gate_added');
  const failing = validGates.filter((g) => g.passing !== true);
  if (failing.length) missing.push('regression_case_not_passing:' + failing.map((g) => g.id || g.kind).join(','));
  if (incident.stable_promoted !== true) missing.push('stable_not_promoted');

  const closable = missing.length === 0;
  return {
    incident_id: incident.id ?? null,
    status: closable ? 'CLOSED' : 'OPEN',
    closable,
    missing,
    gates_added: validGates.map((g) => ({ id: g.id, kind: g.kind })),
    rejected_gate_kinds: (gatesAdded || []).filter((g) => !GATE_KINDS.includes(g.kind)).map((g) => g.kind),
    evaluated_at: nowIso(),
  };
}

export function writeIncidentRecord(incidentsDir, incident, closure) {
  const file = path.join(incidentsDir, `${incident.id}.json`);
  ensureDir(path.dirname(file));
  atomicWriteJson(file, { ...incident, closure });
  return file;
}
