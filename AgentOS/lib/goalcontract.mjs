// Goal Contract —— 任务单第七节。
//
// 铁律：禁止因为修好了一个子问题就将父任务视为完成。
// Task Engine 必须持续检查「当前操作是否推动 Goal Contract」。
import { nowIso, newId } from './paths.mjs';

export const REQUIRED_CONTRACT_FIELDS = Object.freeze([
  'goal',
  'success_criteria',
  'constraints',
  'allowed_scope',
  'protected_invariants',
  'known_unknowns',
  'pending_items',
  'done_definition',
]);

const idOf = (x) => (typeof x === 'string' ? x : x && x.id);

function idsOf(list) {
  return (list || []).map(idOf).filter(Boolean);
}

export function createGoalContract({
  id = newId('goal'),
  goal,
  success_criteria = [],
  constraints = [],
  allowed_scope = [],
  protected_invariants = [],
  known_unknowns = [],
  pending_items = [],
  done_definition = [],
} = {}) {
  const contract = {
    schema_version: 1,
    id,
    created_at: nowIso(),
    goal,
    success_criteria,
    constraints,
    allowed_scope,
    protected_invariants,
    known_unknowns,
    pending_items,
    done_definition,
  };
  const v = validateGoalContract(contract);
  if (!v.ok) {
    const e = new Error('createGoalContract: ' + JSON.stringify(v.problems));
    e.problems = v.problems;
    throw e;
  }
  return contract;
}

export function validateGoalContract(c) {
  const problems = [];
  if (!c || typeof c !== 'object') return { ok: false, problems: [{ problem: 'not_an_object' }] };
  const missing = REQUIRED_CONTRACT_FIELDS.filter((f) => !(f in c));
  if (missing.length) problems.push({ problem: 'missing_fields', missing });
  if ('goal' in c && (typeof c.goal !== 'string' || !c.goal.trim())) {
    problems.push({ problem: 'goal_must_be_non_empty_string' });
  }
  if ('success_criteria' in c && (!Array.isArray(c.success_criteria) || c.success_criteria.length === 0)) {
    problems.push({ problem: 'success_criteria_must_be_non_empty' });
  }
  for (const f of ['success_criteria', 'constraints', 'allowed_scope', 'protected_invariants', 'known_unknowns', 'pending_items', 'done_definition']) {
    if (f in c && !Array.isArray(c[f])) problems.push({ problem: 'must_be_array', field: f });
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 完成度评估。`satisfied` 是已被验证满足的条目 id 列表。
 * done_definition 里的「全部测试、验证、清理和打包条件」只有全部满足才算完成。
 */
export function evaluateContractProgress(contract, { satisfied = [] } = {}) {
  const sat = new Set(satisfied);
  const groups = {
    success_criteria: idsOf(contract.success_criteria),
    pending_items: idsOf(contract.pending_items),
    known_unknowns: idsOf(contract.known_unknowns),
    done_definition: idsOf(contract.done_definition),
  };
  const required = [];
  for (const [group, ids] of Object.entries(groups)) {
    for (const id of ids) required.push({ group, id });
  }
  const unmet = required.filter((r) => !sat.has(r.id));
  return {
    done: unmet.length === 0 && required.length > 0,
    total: required.length,
    satisfied: required.filter((r) => sat.has(r.id)),
    unmet,
  };
}

export function allContractIds(contract) {
  return [
    ...idsOf(contract.success_criteria),
    ...idsOf(contract.pending_items),
    ...idsOf(contract.known_unknowns),
    ...idsOf(contract.done_definition),
    ...idsOf(contract.protected_invariants),
  ];
}

/**
 * 第七节：当前操作是否推动 Goal Contract。
 * addresses 为本操作声称推进的条目 id；引用不存在的条目 = 跑偏。
 */
export function evaluateActionAlignment(contract, { action = null, addresses = [] } = {}) {
  const known = new Set(allContractIds(contract));
  const valid = addresses.filter((a) => known.has(a));
  const unknownRefs = addresses.filter((a) => !known.has(a));
  return {
    action,
    aligned: valid.length > 0 && unknownRefs.length === 0,
    valid,
    unknownRefs,
    reason: addresses.length === 0
      ? 'action_addresses_nothing_in_contract'
      : unknownRefs.length
        ? 'action_references_unknown_contract_items'
        : 'aligned',
  };
}
