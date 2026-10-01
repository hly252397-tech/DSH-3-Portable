// Gate Verdict —— 任务单第十六节。
//
// 关键规则：
//   - 运行门禁前取 fingerprint_before，运行后取 fingerprint_after；
//   - 只有 before === after，本次 verdict 才有效；否则 status = INVALID；
//   - PASS 之后任何文件变化 -> 工作区 DIRTY，旧 PASS 自动失效。
//   - 禁止用「时间新鲜度」「30 分钟内通过」「Git HEAD」「Watcher 还在跑」判断 PASS 有效。
import path from 'node:path';
import { atomicWriteJson, nowIso, newId } from './paths.mjs';
import { fingerprintsEqual as fpEqual } from './fingerprint.mjs';

export const VERDICT_SCHEMA_VERSION = 1;

/**
 * 构造一份正式 verdict。
 * @param {object} o
 * @param {object} o.before  门禁运行前指纹
 * @param {object} o.after   门禁运行后指纹
 * @param {Array}  o.checks  [{ id, ok, detail }]
 */
export function buildVerdict({
  run_id = newId('run'),
  task_id = null,
  candidate_id = null,
  started_at = null,
  finished_at = nowIso(),
  checks = [],
  before = null,
  after = null,
  exit_code = 0,
  stdout_summary = '',
  stderr_summary = '',
  validator_fingerprint = null,
} = {}) {
  const normChecks = checks.map((c) => ({
    id: String(c.id ?? 'unnamed'),
    ok: c.ok === true,
    detail: c.detail == null ? null : String(c.detail),
  }));
  const failedChecks = normChecks.filter((c) => !c.ok);

  let status;
  let status_reason;
  if (!before || !after) {
    status = 'INVALID';
    status_reason = 'fingerprint_missing';
  } else if (before.degraded === true || after.degraded === true) {
    // 覆盖 0 文件 -> 聚合值恒定 -> 任何 PASS 都是假的。必须先于「相等」判定。
    status = 'INVALID';
    status_reason = 'fingerprint_degraded_zero_coverage';
  } else if (!fpEqual(before, after)) {
    status = 'INVALID';
    status_reason = 'workspace_changed_during_gate_run';
  } else if (exit_code !== 0) {
    status = 'FAIL';
    status_reason = 'nonzero_exit_code';
  } else if (failedChecks.length > 0) {
    status = 'FAIL';
    status_reason = 'checks_failed:' + failedChecks.map((c) => c.id).join(',');
  } else {
    status = 'PASS';
    status_reason = 'all_checks_passed_and_fingerprint_stable';
  }

  return {
    schema_version: VERDICT_SCHEMA_VERSION,
    run_id,
    task_id,
    candidate_id,
    started_at: started_at ?? after?.computed_at ?? nowIso(),
    finished_at,
    status,
    status_reason,
    workspace_fingerprint: after?.aggregate ?? null,
    validator_fingerprint,
    fingerprint_before: before?.aggregate ?? null,
    fingerprint_after: after?.aggregate ?? null,
    checks: normChecks,
    exit_code,
    stdout_summary: String(stdout_summary ?? '').slice(0, 4000),
    stderr_summary: String(stderr_summary ?? '').slice(0, 4000),
  };
}

/** 写一份 verdict 到 verdicts 目录（原子写 + 保留 bak）。 */
export function writeVerdict(verdictsDir, verdict) {
  const file = path.join(verdictsDir, `${verdict.run_id}.json`);
  atomicWriteJson(file, verdict);
  return file;
}

/**
 * 旧 PASS 是否对「当前工作区」仍然有效。
 * 这是唯一合法的有效性判据：指纹相等。不看时间、不看 Git HEAD、不看 Watcher。
 */
export function isVerdictValidFor(verdict, currentFingerprint) {
  if (!verdict) return { valid: false, reason: 'no_verdict' };
  if (verdict.status !== 'PASS') return { valid: false, reason: `verdict_status_${verdict.status}` };
  if (!currentFingerprint) return { valid: false, reason: 'no_current_fingerprint' };
  if (verdict.workspace_fingerprint !== currentFingerprint.aggregate) {
    return { valid: false, reason: 'fingerprint_mismatch' };
  }
  return { valid: true, reason: 'fingerprint_match' };
}

export { fingerprintsEqual } from './fingerprint.mjs';
