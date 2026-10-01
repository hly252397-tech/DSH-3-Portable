// Scope / Impact Set / Family Gate —— 任务单第九、十、二十一节。
//
// 核心原则：用户截图只是 observed_instance，**不等于** complete_problem_scope。
// FAMILY / SYSTEM / GLOBAL_RUNTIME 问题禁止只修当前实例。
import { nowIso } from './paths.mjs';

export const PROBLEM_CLASSES = Object.freeze(['INSTANCE', 'FAMILY', 'SYSTEM', 'GLOBAL_RUNTIME']);
export const IMPACT_STATUSES = Object.freeze(['VERIFIED', 'NOT_APPLICABLE', 'DOCUMENTED_EXCEPTION', 'UNCHECKED']);

/** 第九节：修改优先级（从高到低）。 */
export const CHANGE_PRIORITY = Object.freeze([
  'design_token',
  'layout_or_data_contract',
  'shared_component',
  'base_style',
  'variant',
  'instance_patch',
]);

/** 第十节：家族级修复至少验证这些维度。 */
export const FAMILY_DIMENSIONS = Object.freeze([
  'all_states',
  'key_window_widths',
  'key_zoom_levels',
  'left_right_edges',
  'root_container_width',
  'panel_fit',
  'drag_handle',
  'overflow',
  'console_errors',
]);

/**
 * 问题分类。
 * @param {object} o
 * @param {string} o.observed_instance
 * @param {Array}  o.affected_components  [{ id, family }] 或 [family]
 * @param {boolean} o.affects_runtime     是否影响启动/插件加载/任务引擎/共享运行时
 */
export function classifyProblem({ observed_instance = null, affected_components = [], affects_runtime = false } = {}) {
  const reason = [];
  if (affects_runtime) {
    reason.push('affects_boot_loader_taskengine_or_shared_runtime');
    return { problem_class: 'GLOBAL_RUNTIME', observed_instance, reason };
  }
  const comps = affected_components.map((c) => (typeof c === 'string' ? { id: c, family: c } : c));
  const families = [...new Set(comps.map((c) => c.family))];
  if (comps.length <= 1) {
    reason.push('single_component');
    return { problem_class: 'INSTANCE', observed_instance, reason };
  }
  if (families.length === 1) {
    reason.push(`one_family_${families[0]}_with_${comps.length}_members`);
    return { problem_class: 'FAMILY', observed_instance, reason };
  }
  reason.push(`${families.length}_families_${comps.length}_members`);
  return { problem_class: 'SYSTEM', observed_instance, reason };
}

/**
 * 构建 Impact Set。每个成员 x 每个维度一个对象，初始 UNCHECKED。
 */
export function buildImpactSet({ component_family = null, members = [], dimensions = FAMILY_DIMENSIONS } = {}) {
  const set = [];
  for (const m of members) {
    for (const d of dimensions) {
      set.push({
        id: `${m}::${d}`,
        member: m,
        dimension: d,
        component_family,
        status: 'UNCHECKED',
        evidence: null,
        updated_at: nowIso(),
      });
    }
  }
  return set;
}

export function setImpactStatus(impactSet, { id, status, evidence = null }) {
  const item = impactSet.find((i) => i.id === id);
  if (!item) return { ok: false, error: 'impact_item_not_found', id };
  if (!IMPACT_STATUSES.includes(status)) return { ok: false, error: 'unknown_status', status };
  item.status = status;
  item.evidence = evidence;
  item.updated_at = nowIso();
  return { ok: true, item };
}

/** 第十节完成屏障：只要存在 UNCHECKED 就不许完成。 */
export function impactSetComplete(impactSet) {
  const unchecked = impactSet.filter((i) => i.status === 'UNCHECKED').map((i) => i.id);
  const badStatus = impactSet.filter((i) => !IMPACT_STATUSES.includes(i.status)).map((i) => i.id);
  return {
    complete: unchecked.length === 0 && badStatus.length === 0,
    total: impactSet.length,
    unchecked,
    invalid_status: badStatus,
  };
}

/**
 * 第二十一节 Family Gate：FAMILY 及以上必须验证**全部同类对象**，禁止只验证截图实例。
 */
export function validateFamilyGate({ problem_class, members = [], validated_members = [] } = {}) {
  if (!PROBLEM_CLASSES.includes(problem_class)) {
    return { ok: false, error: 'unknown_problem_class', problem_class };
  }
  if (problem_class === 'INSTANCE') {
    const ok = validated_members.length >= 1;
    return { ok, required: members, validated: validated_members, missing: ok ? [] : members, note: 'instance-level fix' };
  }
  const vset = new Set(validated_members);
  const missing = members.filter((m) => !vset.has(m));
  return {
    ok: missing.length === 0,
    required: members,
    validated: validated_members,
    missing,
    note: `${problem_class} 必须验证全部同类成员`,
  };
}

/** 第九节：FAMILY/SYSTEM/GLOBAL_RUNTIME 禁止只做单实例补丁。 */
export function assertChangePriority({ problem_class, change_level } = {}) {
  if (!PROBLEM_CLASSES.includes(problem_class)) return { ok: false, error: 'unknown_problem_class', problem_class };
  if (!CHANGE_PRIORITY.includes(change_level)) return { ok: false, error: 'unknown_change_level', change_level };
  if (problem_class !== 'INSTANCE' && change_level === 'instance_patch') {
    return {
      ok: false,
      error: 'instance_patch_forbidden_for_' + problem_class.toLowerCase(),
      problem_class,
      change_level,
      remedy: '优先修共同规则（设计 Token / 布局契约 / 共享组件 / 基础样式），而不是当前实例',
      priority_order: CHANGE_PRIORITY,
    };
  }
  return { ok: true, problem_class, change_level, rank: CHANGE_PRIORITY.indexOf(change_level) };
}
