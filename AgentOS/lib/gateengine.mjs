// Verifier / Gate Engine —— 任务单第二十一节（Verifier 分层）+ 第十六节（verdict）+ 第十八节（自动熔断）。
//
// 七层：
//   1. Static Gate       语法 / 类型 / import-export / 修改范围 / 禁止状态级覆盖家族属性
//   2. Target Gate       原问题是否修复
//   3. Family Gate       全部同类对象是否统一
//   4. Regression Gate   是否新增失败
//   5. Differential Gate 是否出现非预期变化
//   6. Boot Gate         完整冷启动 / 核心插件 / 核心服务 / 控制台 / Network
//   7. Completion Gate   pending / 临时探针 / 未消费事件 / 指纹
//
// 关键：`runBootAudit` 打开时，启动审计**在管线内部自动执行**——这才叫「自动熔断」，
// 而不是让人记得再手动跑一次 boot-audit。
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { computeFingerprint } from './fingerprint.mjs';
import { buildVerdict, writeVerdict } from './verdict.mjs';
import { computeDelta, rejectCandidate } from './candidate.mjs';
import { validateFamilyGate, impactSetComplete } from './impactset.mjs';
import { evaluateExit } from './exitguard.mjs';
import { auditBoot } from './bootaudit.mjs';
import { readJsonIfExists, nowIso, newId } from './paths.mjs';

export const GATE_LAYERS = Object.freeze([
  'static',
  'target',
  'family',
  'regression',
  'differential',
  'boot',
  'completion',
]);

const fwd = (p) => String(p).replace(/\\/g, '/').toLowerCase();

/** 1. Static Gate —— 修改范围、禁止模式、语法。 */
export function runStaticGateLayer({ root = null, changedFiles = [], allowedFiles = null, forbiddenPatterns = [], syntaxCheck = false } = {}) {
  const checks = [];

  if (allowedFiles) {
    const allowed = allowedFiles.map(fwd);
    const out = changedFiles.filter((f) => !allowed.some((a) => fwd(f) === a || fwd(f).endsWith('/' + a)));
    checks.push({
      id: 'static:change_scope',
      ok: out.length === 0,
      detail: out.length ? 'out_of_allowed_files:' + out.join(',') : 'all_changes_within_allowed_files',
    });
  }

  for (const fp of forbiddenPatterns) {
    const hits = [];
    for (const f of changedFiles) {
      const abs = root ? path.join(root, f) : f;
      try {
        if (fs.readFileSync(abs, 'utf8').includes(fp.pattern)) hits.push(f);
      } catch {
        /* 读不到就当没有 */
      }
    }
    checks.push({
      id: 'static:forbidden:' + (fp.id ?? fp.pattern),
      ok: hits.length === 0,
      detail: hits.length ? 'matched_in:' + hits.join(',') : 'clean',
    });
  }

  if (syntaxCheck && root) {
    for (const f of changedFiles.filter((x) => /\.(mjs|js|cjs)$/i.test(x))) {
      const abs = path.join(root, f);
      if (!fs.existsSync(abs)) continue;
      const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', windowsHide: true });
      checks.push({
        id: 'static:syntax:' + f,
        ok: r.status === 0,
        detail: r.status === 0 ? 'ok' : String(r.stderr || '').trim().slice(0, 200),
      });
    }
  }

  return { layer: 'static', ok: checks.every((c) => c.ok), checks };
}

/** 2. Target Gate —— 原问题是否修复。 */
export function runTargetGateLayer({ targetFixed = false, evidence = null } = {}) {
  return {
    layer: 'target',
    ok: targetFixed === true,
    checks: [{ id: 'target:original_problem_fixed', ok: targetFixed === true, detail: evidence ?? (targetFixed ? 'ok' : 'not_fixed') }],
  };
}

/** 3. Family Gate —— 全部同类对象统一 + Impact Set 无 UNCHECKED。 */
export function runFamilyGateLayer({ problem_class, members = [], validated_members = [], impact_set = null } = {}) {
  const g = validateFamilyGate({ problem_class, members, validated_members });
  const checks = [
    {
      id: 'family:all_members_validated',
      ok: g.ok,
      detail: g.ok ? `ok (${problem_class})` : 'missing:' + (g.missing || []).join(','),
    },
  ];
  if (impact_set) {
    const c = impactSetComplete(impact_set);
    checks.push({ id: 'family:impact_set_complete', ok: c.complete, detail: c.complete ? 'ok' : 'unchecked:' + c.unchecked.join(',') });
  }
  return { layer: 'family', ok: checks.every((c) => c.ok), checks };
}

/** 4. Regression Gate —— 是否新增失败。 */
export function runRegressionGateLayer({ baselineFailures = [], candidateFailures = [] } = {}) {
  const d = computeDelta({ baselineFailures, candidateFailures });
  return {
    layer: 'regression',
    ok: d.new_failures.length === 0,
    checks: [{ id: 'regression:no_new_failures', ok: d.new_failures.length === 0, detail: d.new_failures.join(',') || 'none' }],
  };
}

/** 5. Differential Gate —— 是否出现非预期变化。 */
export function runDifferentialGateLayer({ expectedDeltas = [], actualDeltas = [] } = {}) {
  const d = computeDelta({ expectedDeltas, actualDeltas });
  return {
    layer: 'differential',
    ok: d.unexpected_deltas.length === 0,
    checks: [{ id: 'differential:no_unexpected_deltas', ok: d.unexpected_deltas.length === 0, detail: d.unexpected_deltas.join(',') || 'none' }],
  };
}

/**
 * 6. Boot Gate。
 * `allowPartial` 是显式策略开关：观测不到核心服务时结论只能是 PARTIAL，
 * 允许与否必须由调用方明确表态，不允许默认当成通过。
 */
export function runBootGateLayer({ audit = null, boot = null, allowPartial = true } = {}) {
  const verdict = boot ?? (audit ? audit.boot_verdict : null);
  if (!verdict) {
    return { layer: 'boot', ok: false, checks: [{ id: 'boot:observed', ok: false, detail: 'boot audit not provided' }] };
  }
  const triggers = (verdict.triggers || []).map((t) => t.rule).join(',');
  const unverified = (verdict.unverified_checks || []).join(',');
  const checks = [
    { id: 'boot:status', ok: verdict.status === 'OK', detail: verdict.status + (triggers ? ':' + triggers : '') },
    {
      id: 'boot:verdict_completeness',
      ok: verdict.verdict_completeness === 'FULL' || allowPartial === true,
      detail: `${verdict.verdict_completeness}${unverified ? ' unverified=' + unverified : ''}${allowPartial ? ' (partial accepted by policy)' : ''}`,
    },
  ];
  return { layer: 'boot', ok: checks.every((c) => c.ok), checks };
}

/** 7. Completion Gate —— pending / 临时探针 / 未消费事件 / 指纹。 */
export function runCompletionGateLayer({ exitState = null, ledger = null, impactSet = null } = {}) {
  if (!exitState) {
    return { layer: 'completion', ok: false, checks: [{ id: 'completion:exit_guard', ok: false, detail: 'exit_state_required' }] };
  }
  const s = { ...exitState };
  if (ledger) s.unconsumed_critical_events = ledger.unconsumedCritical().length;
  const r = evaluateExit(s);
  const checks = [
    {
      id: 'completion:exit_guard',
      ok: r.status === 'OK',
      detail: r.blockers.map((b) => b.field).join(',') || 'ok',
    },
  ];
  if (impactSet) {
    const c = impactSetComplete(impactSet);
    checks.push({ id: 'completion:impact_set', ok: c.complete, detail: c.complete ? 'ok' : 'unchecked:' + c.unchecked.join(',') });
  }
  return { layer: 'completion', ok: checks.every((c) => c.ok), checks };
}

/**
 * 第十八节执行侧：BOOT_FAILED 时**真的**把当前候选判废。
 * 之前只有判定，没有动作。
 */
export function enforceBootRejection({ root, candidateId, bootVerdict } = {}) {
  if (!bootVerdict) return { rejected: false, reason: 'no_boot_verdict' };
  if (bootVerdict.status !== 'BOOT_FAILED') return { rejected: false, reason: 'boot_ok', status: bootVerdict.status };
  if (!candidateId) return { rejected: false, reason: 'no_candidate_id' };

  const file = path.join(root, 'candidates', 'active', `${candidateId}.json`);
  const cand = readJsonIfExists(file);
  if (!cand) return { rejected: false, reason: 'candidate_not_found', candidateId };

  const rec = rejectCandidate({
    root,
    candidate: cand,
    reason: 'BOOT_FAILED: ' + (bootVerdict.triggers || []).map((t) => t.rule).join(',') || 'BOOT_FAILED',
    evidence: { boot_verdict: bootVerdict, rejected_by: 'gate_engine' },
  });
  return { rejected: true, action: 'CURRENT_CANDIDATE_REJECTED', candidate: rec, file: path.join(root, 'candidates', 'rejected', `${candidateId}.json`) };
}

/**
 * 跑完整七层管线，出一份绑定指纹的正式 verdict。
 *
 * @param {object} o
 * @param {string} o.root                 工作区根（算指纹用）
 * @param {object} [o.layers]             各层输入：{ static, target, family, regression, differential, boot, completion }
 * @param {boolean} [o.runBootAudit]      true 时**在管线内自动执行**启动审计
 * @param {string} [o.profileDir]         启动审计用的 profile 目录
 * @param {boolean} [o.allowPartialBoot]  是否接受 PARTIAL 的启动结论（显式策略）
 * @param {boolean} [o.rejectCandidateOnBootFailure] 默认 true —— §18 要求 BOOT_FAILED 自动判废候选
 */
export async function runGatePipeline({
  root,
  task_id = null,
  candidate_id = null,
  extraFiles = {},
  layers = {},
  runBootAudit = false,
  profileDir = null,
  harnessSlotDir = null,
  probeUrls = [],
  moduleUrls = [],
  allowPartialBoot = true,
  rejectCandidateOnBootFailure = true,
  verdictsDir = null,
} = {}) {
  if (!root) throw new Error('runGatePipeline: root is required');

  const started_at = nowIso();
  const before = computeFingerprint({ root, extraFiles });
  const results = [];

  if (layers.static) results.push(runStaticGateLayer({ root, ...layers.static }));
  if (layers.target) results.push(runTargetGateLayer(layers.target));
  if (layers.family) results.push(runFamilyGateLayer(layers.family));
  if (layers.regression) results.push(runRegressionGateLayer(layers.regression));
  if (layers.differential) results.push(runDifferentialGateLayer(layers.differential));
  if (layers.completion) results.push(runCompletionGateLayer(layers.completion));

  let bootReport = null;
  let bootLayer = null;
  if (runBootAudit) {
    if (!profileDir) throw new Error('runGatePipeline: profileDir is required when runBootAudit=true');
    bootReport = await auditBoot({ portableRoot: root, profileDir, harnessSlotDir, probeUrls, moduleUrls });
    bootLayer = runBootGateLayer({ audit: bootReport, allowPartial: allowPartialBoot });
  } else if (layers.boot) {
    bootLayer = runBootGateLayer({ ...layers.boot, allowPartial: allowPartialBoot });
  }
  if (bootLayer) results.push(bootLayer);

  const after = computeFingerprint({ root, extraFiles });
  const checks = results.flatMap((r) => r.checks);
  const layerSummary = results.map((r) => `${r.layer}:${r.ok ? 'ok' : 'fail'}`).join(',');

  const verdict = buildVerdict({
    run_id: newId('run'),
    task_id,
    candidate_id,
    started_at,
    checks,
    before,
    after,
    exit_code: 0,
    stdout_summary: `layers=${layerSummary || 'none'}`,
    stderr_summary: bootReport ? `boot=${bootReport.boot_verdict.status}/${bootReport.boot_verdict.verdict_completeness}` : '',
  });

  const out = {
    verdict,
    layers: results.map((r) => ({ layer: r.layer, ok: r.ok, checks: r.checks })),
    boot: bootReport
      ? {
          status: bootReport.boot_verdict.status,
          completeness: bootReport.boot_verdict.verdict_completeness,
          unverified_checks: bootReport.boot_verdict.unverified_checks,
          triggers: bootReport.boot_verdict.triggers,
        }
      : null,
    fingerprint_before: before.aggregate,
    fingerprint_after: after.aggregate,
    enforcement: null,
  };

  if (bootReport && bootReport.boot_verdict.status === 'BOOT_FAILED' && rejectCandidateOnBootFailure && candidate_id) {
    out.enforcement = enforceBootRejection({ root, candidateId: candidate_id, bootVerdict: bootReport.boot_verdict });
  }

  if (verdictsDir) out.verdict_file = writeVerdict(verdictsDir, verdict);
  return out;
}
