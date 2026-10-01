// Stable / Candidate 隔离 + 回归链 —— 任务单第十一、十二、十三节。
//
// 铁律：
//   1. Stable 不直接修改；所有修改进 Candidate。
//   2. 每个 Candidate 只对应一个主要根因假设。
//   3. Candidate 失败 -> REJECTED，之后**只能取证，不允许继续开发**（禁止补丁连锁）。
//   4. 修 A 带出 B 时：先归因（在 Stable 复现 B），再回滚，禁止在坏 Candidate 上修 B。
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, ensureDir, nowIso, newId, readJsonIfExists } from './paths.mjs';

export const REQUIRED_CANDIDATE_FIELDS = Object.freeze([
  'hypothesis',
  'expected_delta',
  'protected_invariants',
  'allowed_files',
  'impact_set',
  'forbidden_extra_changes',
]);

/** 单次局部机械修正白名单（第十三节：只有这些允许一次局部修正）。 */
export const MECHANICAL_FIX_KINDS = Object.freeze([
  'missing_import',
  'clear_typo',
  'clear_syntax_error',
  'clear_path_typo',
]);

export const CANDIDATE_STATUS = Object.freeze({
  ACTIVE: 'active',
  REJECTED: 'rejected',
  PROMOTED: 'promoted',
});

export function validateCandidateShape(c) {
  const missing = REQUIRED_CANDIDATE_FIELDS.filter((f) => !(f in (c || {})));
  const problems = [];
  if (missing.length) problems.push({ problem: 'missing_fields', missing });
  if (c && c.impact_set) {
    const bad = c.impact_set.filter((i) => i && i.status === 'UNCHECKED');
    if (bad.length) problems.push({ problem: 'impact_set_has_unchecked', unchecked: bad.map((i) => i.id ?? i) });
  }
  return { ok: problems.length === 0, problems };
}

export function declareCandidate({
  root,
  id = newId('cand'),
  hypothesis,
  expected_delta = [],
  protected_invariants = [],
  allowed_files = [],
  impact_set = [],
  forbidden_extra_changes = [],
  base_fingerprint = null,
  owner_task_id = null,
} = {}) {
  const candidate = {
    schema_version: 1,
    id,
    created_at: nowIso(),
    status: CANDIDATE_STATUS.ACTIVE,
    owner_task_id,
    hypothesis,
    expected_delta,
    protected_invariants,
    allowed_files,
    impact_set,
    forbidden_extra_changes,
    base_fingerprint,
    patch_chain_depth: 0,
    can_continue_development: true,
  };
  const shape = validateCandidateShape(candidate);
  if (!shape.ok) {
    const err = new Error('declareCandidate: invalid candidate shape: ' + JSON.stringify(shape.problems));
    err.problems = shape.problems;
    throw err;
  }
  const dir = ensureDir(path.join(root, 'candidates', CANDIDATE_STATUS.ACTIVE));
  atomicWriteJson(path.join(dir, `${id}.json`), candidate);
  return candidate;
}

/**
 * 回归链：计算 new_failures 与 unexpected_deltas。
 *   new_failures      = candidate_failures - baseline_failures
 *   unexpected_deltas = actual_deltas - expected_deltas
 */
export function computeDelta({ baselineFailures = [], candidateFailures = [], expectedDeltas = [], actualDeltas = [] } = {}) {
  const bset = new Set(baselineFailures);
  const new_failures = candidateFailures.filter((f) => !bset.has(f));
  const fixed = baselineFailures.filter((f) => !new Set(candidateFailures).has(f));
  const eset = new Set(expectedDeltas);
  const unexpected_deltas = actualDeltas.filter((d) => !eset.has(d));
  return { new_failures, fixed, unexpected_deltas };
}

/**
 * 晋升判定 —— 第十二节 7 个条件必须**同时**满足。
 * 返回 { ok, reasons[] }；任何一条不满足都是拒绝，不给部分通过。
 */
export function evaluatePromotion({
  candidate,
  targetFixed = false,
  delta = { new_failures: [], unexpected_deltas: [] },
  invariants = [],              // [{ id, ok }]
  currentFingerprint = null,
  validationFingerprint = null,
  bootOk = false,
  verdict = null,
} = {}) {
  const reasons = [];
  if (!targetFixed) reasons.push('target_not_fixed');
  if ((delta.new_failures || []).length) reasons.push('new_failures:' + delta.new_failures.join(','));
  if ((delta.unexpected_deltas || []).length) reasons.push('unexpected_deltas:' + delta.unexpected_deltas.join(','));
  const badInv = (invariants || []).filter((i) => !i.ok);
  if (badInv.length) reasons.push('protected_invariants_failed:' + badInv.map((i) => i.id).join(','));
  const cur = currentFingerprint?.aggregate ?? null;
  const val = validationFingerprint?.aggregate ?? validationFingerprint ?? null;
  if (!cur || !val || cur !== val) reasons.push('fingerprint_not_equal_to_validated');
  if (!bootOk) reasons.push('boot_not_ok');
  if (!verdict || verdict.status !== 'PASS') reasons.push('no_passing_verdict');
  if (verdict && cur && verdict.workspace_fingerprint !== cur) reasons.push('verdict_fingerprint_stale');
  if (candidate && candidate.can_continue_development === false) reasons.push('candidate_already_frozen');
  return { ok: reasons.length === 0, reasons };
}

export function promoteCandidate({ root, candidate, evaluation }) {
  if (!evaluation || !evaluation.ok) {
    return { promoted: false, reasons: evaluation?.reasons ?? ['no_evaluation'] };
  }
  const from = path.join(root, 'candidates', CANDIDATE_STATUS.ACTIVE, `${candidate.id}.json`);
  const to = path.join(root, 'candidates', CANDIDATE_STATUS.PROMOTED, `${candidate.id}.json`);
  ensureDir(path.dirname(to));
  const rec = { ...candidate, status: CANDIDATE_STATUS.PROMOTED, promoted_at: nowIso(), evaluation };
  atomicWriteJson(to, rec);
  if (fs.existsSync(from)) fs.rmSync(from, { force: true });
  return { promoted: true, file: to };
}

/**
 * 判废一个 Candidate —— 第三/十一/十三节。
 * 判废后 can_continue_development = false，并冻结证据，禁止叠加功能补丁。
 */
export function rejectCandidate({ root, candidate, reason, evidence = {} }) {
  const to = path.join(root, 'candidates', CANDIDATE_STATUS.REJECTED, `${candidate.id}.json`);
  ensureDir(path.dirname(to));
  const rec = {
    ...candidate,
    status: CANDIDATE_STATUS.REJECTED,
    rejected_at: nowIso(),
    rejection_reason: reason,
    evidence,
    frozen: true,
    can_continue_development: false,
    rollback_required: true,
  };
  atomicWriteJson(to, rec);
  const from = path.join(root, 'candidates', CANDIDATE_STATUS.ACTIVE, `${candidate.id}.json`);
  if (fs.existsSync(from)) fs.rmSync(from, { force: true });
  return rec;
}

/** 已判废的 Candidate 再想动手 -> 直接拒绝（第十三节：失败候选失去继续开发资格）。 */
export function assertCandidateMayDevelop(candidate) {
  if (!candidate) throw new Error('assertCandidateMayDevelop: no candidate');
  if (candidate.can_continue_development === false || candidate.status === CANDIDATE_STATUS.REJECTED) {
    const e = new Error(`candidate ${candidate.id} is REJECTED/FROZEN: development forbidden (取证 only)`);
    e.code = 'CANDIDATE_FROZEN';
    throw e;
  }
  return true;
}

/**
 * 写入守卫 —— 第十四节测试：Candidate 修改 Supervisor Stable 必须被拒绝。
 * 同时强制 allowed_files 白名单。
 */
export function guardWrite({ candidate, file, supervisorStableDirs = [], allowedRoots = [] } = {}) {
  const abs = path.resolve(file);
  const norm = (p) => path.resolve(p).toLowerCase();

  for (const dir of supervisorStableDirs) {
    const d = norm(dir);
    const a = norm(abs);
    if (a === d || a.startsWith(d + path.sep)) {
      return { allowed: false, reason: 'write_to_supervisor_stable_forbidden', code: 'STABLE_IMMUTABLE', file: abs, matched: dir };
    }
  }
  if (allowedRoots.length) {
    const okRoot = allowedRoots.some((r) => {
      const rr = norm(r);
      const a = norm(abs);
      return a === rr || a.startsWith(rr + path.sep);
    });
    if (!okRoot) return { allowed: false, reason: 'outside_allowed_roots', code: 'SCOPE_VIOLATION', file: abs };
  }
  if (candidate && Array.isArray(candidate.allowed_files) && candidate.allowed_files.length) {
    const allChange = candidate.allowed_files.includes('*');
    // 必须把两种分隔符都归一成 '/'，否则 Windows 下 endsWith 恒为 false（已实测）
    const absN = path.resolve(abs).split(/[\\/]/).join('/').toLowerCase();
    const rels = candidate.allowed_files.map((p) => String(p).replace(/\\/g, '/').toLowerCase().replace(/^\.?\//, ''));
    const hit = rels.some((r) => absN === r || absN.endsWith('/' + r));
    if (!hit && !allChange) {
      return { allowed: false, reason: 'file_not_in_allowed_files', code: 'FORBIDDEN_EXTRA_CHANGE', file: abs, allowed_files: candidate.allowed_files };
    }
  }
  return { allowed: true, reason: 'ok' };
}

/** 读取活动候选。约定位置：<root>/candidates/active/<id>.json。找不到返回 null（由调用方决定是否报错）。 */
export function loadActiveCandidate({ root, candidateId } = {}) {
  if (!root || !candidateId) return null;
  return readJsonIfExists(path.join(root, 'candidates', 'active', `${candidateId}.json`));
}

/** 候选声明的写入范围（给 Tool Broker 用）。 */
export function candidateScope(candidate) {
  if (!candidate) return { allowed_files: null, forbidden_extra_changes: [] };
  return {
    allowed_files: Array.isArray(candidate.allowed_files) ? candidate.allowed_files : [],
    forbidden_extra_changes: Array.isArray(candidate.forbidden_extra_changes) ? candidate.forbidden_extra_changes : [],
  };
}

/**
 * 第十二节归因分支：发现新问题 B 时，冻结候选、在 Stable 中复现、再下结论。
 *   Stable 正常 + Candidate 报错 -> Candidate 引入回归 -> 判废 + 回滚，禁止在坏候选上修 B
 *   Stable 也报错                -> 原有潜伏缺陷 -> 建独立缺陷任务，不归因给当前 Candidate
 */
export function attributeNewDefect({ defect, reproducesInStable = false, reproducesInCandidate = false, stableFingerprint = null, candidateFingerprint = null } = {}) {
  const base = { defect, reproduces_in_stable: reproducesInStable === true, reproduces_in_candidate: reproducesInCandidate === true, stable_fingerprint: stableFingerprint, candidate_fingerprint: candidateFingerprint };
  if (reproducesInStable === true) {
    return {
      ...base,
      conclusion: 'preexisting_latent_defect',
      blame_candidate: false,
      action: 'CREATE_SEPARATE_DEFECT_TASK',
      note: '不得错误归因给当前 Candidate；判断是否阻塞当前任务',
    };
  }
  if (reproducesInCandidate === true) {
    return {
      ...base,
      conclusion: 'candidate_introduced_regression',
      blame_candidate: true,
      action: 'REJECT_AND_ROLLBACK',
      note: 'Candidate REJECTED + 自动回滚；禁止直接在坏 Candidate 上修 B；重新设计原问题 A 的方案',
    };
  }
  return { ...base, conclusion: 'not_reproduced', blame_candidate: false, action: 'NEED_MORE_EVIDENCE', note: '两个环境都没复现，证据不足' };
}

/**
 * 补丁连锁检测 —— 第十三节。
 * 一次局部机械修正（白名单 4 类）允许；其余一律要求拒绝 Candidate 并回滚。
 */
export function evaluatePatchChain({
  patchChainDepth = 0,
  maxPatchChainDepth = 1,
  fixKind = null,
  newFunctionalDefect = false,
  newConsoleError = false,
  otherComponentBroken = false,
  previouslyPassingTestFailed = false,
  pluginBootFailed = false,
  scopeExpanding = false,
  needsMoreSharedLayerChanges = false,
  unableToAttribute = false,
} = {}) {
  const rejections = [];
  if (newFunctionalDefect) rejections.push('new_functional_defect');
  if (newConsoleError) rejections.push('new_console_error');
  if (otherComponentBroken) rejections.push('other_component_broken');
  if (previouslyPassingTestFailed) rejections.push('previously_passing_test_failed');
  if (pluginBootFailed) rejections.push('plugin_boot_failed');
  if (scopeExpanding) rejections.push('scope_expanding');
  if (needsMoreSharedLayerChanges) rejections.push('needs_more_shared_layer_changes');
  if (unableToAttribute) rejections.push('unable_to_attribute');
  if (patchChainDepth > maxPatchChainDepth) rejections.push('patch_chain_depth_exceeded');

  const mechanicalOnly = fixKind && MECHANICAL_FIX_KINDS.includes(fixKind) && rejections.length === 0;
  return {
    action: rejections.length ? 'REJECT_AND_ROLLBACK' : mechanicalOnly ? 'ALLOW_ONE_MECHANICAL_FIX' : 'NO_OP',
    rejections,
    mechanical_fix_kind: mechanicalOnly ? fixKind : null,
  };
}
