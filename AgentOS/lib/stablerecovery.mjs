// Stable Recovery Broker —— 任务单第十一/十二/十四/十八节 + 目标硬约束「Stable 永不直接修改」。
//
// 为什么需要它：Stable Shield 保护 `current.json` 不被任何写操作碰 —— 这是对的。
// 但**合法恢复**（Boot Gate 失败后切回 Stable）也必须能改这个指针，否则保护机制会把
// 唯一合法的恢复路径一起封死。解法不是"给 Agent 开个后门"，而是：
//
//   普通 Agent / File Broker：**永久无权**改指针（Stable Shield 继续拦）
//   Recovery Broker：只有**满足确定性恢复条件**时才拿到一次性 capability 并执行
//
// 每次恢复必须留下：为什么切、从哪切到哪、触发的 Boot Verdict、操作前后指针指纹、结果。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, atomicWriteJson, readJsonIfExists, nowIso, sha256Text, canonicalJson } from './paths.mjs';

export const STABLE_LEDGER_REL = 'runtime/stable-promotions.jsonl';
export const RECOVERY_JOURNAL_REL = 'supervisor/recovery/journal.jsonl';

export function stableLedgerFile({ root }) {
  return path.join(path.resolve(root), STABLE_LEDGER_REL);
}

export function recoveryJournalFile({ root }) {
  return path.join(path.resolve(root), RECOVERY_JOURNAL_REL);
}

function appendJsonl(file, rec) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify({ ...rec, recorded_at: nowIso() }) + '\n', 'utf8');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ type: 'BROKEN_RECORD', raw: line });
    }
  }
  return out;
}

function fingerprintOf(value) {
  return 'sha256:' + sha256Text(canonicalJson(value ?? null));
}

/**
 * 记一条晋升记录。**Stable 的定义来源就是这里**，不是"目录里上一个"。
 * @param {object} o
 * @param {string} o.runtime_slot  形如 Harness/slots/<ver>-<hash>
 * @param {'PASS'|'FAIL'|'INVALID'} o.boot_verdict
 */
export function recordPromotion({
  root,
  stable_version,
  runtime_slot,
  boot_verdict,
  verdict_run_id = null,
  workspace_fingerprint = null,
  validator_fingerprint = null,
  promoted_by = 'supervisor',
  note = null,
} = {}) {
  if (!root) throw new Error('recordPromotion: root is required');
  if (!stable_version) throw new Error('recordPromotion: stable_version is required');
  if (!runtime_slot) throw new Error('recordPromotion: runtime_slot is required');
  if (!['PASS', 'FAIL', 'INVALID'].includes(boot_verdict)) {
    throw new Error('recordPromotion: boot_verdict must be PASS|FAIL|INVALID');
  }
  const rec = {
    type: 'STABLE_PROMOTION',
    schema_version: 1,
    stable_version,
    runtime_slot,
    status: boot_verdict === 'PASS' ? 'STABLE' : 'REJECTED',
    boot_verdict,
    verdict_run_id,
    workspace_fingerprint,
    validator_fingerprint,
    promoted_by,
    note,
  };
  appendJsonl(stableLedgerFile({ root }), rec);
  return rec;
}

/**
 * 从晋升台账解析当前 Stable。
 * 判据（缺一不可）：status=STABLE、boot_verdict=PASS、runtime_slot 在便携盘上真实存在。
 * **不**等于 current.json 的 previous，也**不**等于目录里最新的一个。
 */
export function resolveStable({ root, portableRoot = null } = {}) {
  if (!root) throw new Error('resolveStable: root is required');
  const base = portableRoot ? path.resolve(portableRoot) : path.resolve(root);
  const rows = readJsonl(stableLedgerFile({ root })).filter((r) => r.type === 'STABLE_PROMOTION');
  const candidates = rows.filter((r) => r.status === 'STABLE' && r.boot_verdict === 'PASS');

  const evaluated = candidates.map((r) => {
    const slotDir = path.join(base, 'Data', 'Runtime', String(r.runtime_slot).split('/').join(path.sep));
    return { ...r, slot_dir: slotDir, reachable: fs.existsSync(slotDir) };
  });
  const valid = evaluated.filter((r) => r.reachable);

  return {
    found: valid.length > 0,
    stable: valid.length ? valid[valid.length - 1] : null,
    considered: evaluated,
    rejected_for_unreachable: evaluated.filter((r) => !r.reachable).map((r) => ({ runtime_slot: r.runtime_slot, slot_dir: r.slot_dir })),
    total_promotions: rows.length,
    ledger: stableLedgerFile({ root }),
  };
}

/** 确定性恢复触发条件，逐条给结果（不是"看情况"）。 */
export function evaluateRecoveryConditions({
  root,
  pointer = null,
  bootVerdict = null,
  stableResolution = null,
  externalIrreversible = false,
  portableRoot = null,
} = {}) {
  const resolution = stableResolution ?? resolveStable({ root, portableRoot });
  const cur = pointer?.current ?? null;
  // 「跑的是不是候选」只能由**真实数据**判定：current 槽 ≠ 台账解析出的 Stable 槽。
  // 之前这里读了一个我凭空发明的 pointer.stable 字段 —— 真实 current.json 里根本没有它。
  const runningIsCandidate = Boolean(cur && resolution.found && cur.relativePath !== resolution.stable.runtime_slot);

  const conditions = [
    {
      id: 'running_object_is_candidate',
      ok: runningIsCandidate,
      detail: !cur
        ? '没有 current 指针'
        : !resolution.found
          ? '无法判定：晋升台账里没有有效 Stable 可比对'
          : runningIsCandidate
            ? `current=${cur.relativePath} ≠ stable=${resolution.stable.runtime_slot}`
            : `当前跑的就是 Stable（${cur.relativePath}）`,
    },
    {
      id: 'boot_gate_failed',
      ok: Boolean(bootVerdict) && bootVerdict.status !== 'OK',
      detail: bootVerdict ? `boot=${bootVerdict.status}` + ((bootVerdict.triggers || []).length ? `:${bootVerdict.triggers.map((t) => t.rule).join(',')}` : '') : '没有 boot verdict',
    },
    { id: 'valid_stable_exists', ok: resolution.found, detail: resolution.found ? resolution.stable.runtime_slot : '晋升台账里没有可达的 STABLE+PASS 记录' },
    { id: 'no_external_irreversible_op', ok: externalIrreversible !== true, detail: externalIrreversible === true ? '存在外部不可逆操作，暂停自动恢复' : 'ok' },
  ];

  const blockers = conditions.filter((c) => !c.ok).map((c) => c.id);
  return { allowed: blockers.length === 0, conditions, blockers, stable: resolution.stable };
}

/**
 * 铸造一次性恢复凭证。只有 `evaluateRecoveryConditions` 通过才会给。
 * 这是"专用能力"的凭据，普通写路径拿不到（也就不可能绕过 Stable Shield）。
 */
export function mintRecoveryCapability({ conditionsResult, root, ttlMs = 60_000, now = () => Date.now() } = {}) {
  if (!conditionsResult || conditionsResult.allowed !== true) {
    return { ok: false, error: 'recovery_conditions_not_met', blockers: conditionsResult?.blockers ?? ['no_conditions'] };
  }
  const issuedAt = now();
  return {
    ok: true,
    capability: {
      kind: 'recovery-broker-capability',
      root: path.resolve(root),
      issued_at: new Date(issuedAt).toISOString(),
      expires_at: new Date(issuedAt + ttlMs).toISOString(),
      expires_at_ms: issuedAt + ttlMs,
      for_slot: conditionsResult.stable.runtime_slot,
    },
  };
}

const POINTER_ROLES = new Set(['user', 'agent-worker', 'file-broker', 'candidate']);

/**
 * 受控写运行时指针。
 * **只有持有效 recovery capability 的调用才允许**；其它任何角色一律拒绝（即使叫它"recovery"）。
 */
export function writeRuntimePointer({ pointerFile, pointer, capability, reason, bootVerdict, now = () => Date.now() } = {}) {
  if (!pointerFile) throw new Error('writeRuntimePointer: pointerFile is required');
  if (!capability || capability.kind !== 'recovery-broker-capability') {
    return { ok: false, error: 'capability_required', detail: '普通写路径无权修改运行时指针（Stable Shield 仍然生效）' };
  }
  if (capability.expires_at_ms && now() > capability.expires_at_ms) {
    return { ok: false, error: 'capability_expired' };
  }
  const rootOf = path.resolve(capability.root ?? '');
  if (rootOf && !path.resolve(pointerFile).toLowerCase().startsWith(rootOf.toLowerCase())) {
    return { ok: false, error: 'capability_root_mismatch', capability_root: rootOf, pointer_file: path.resolve(pointerFile) };
  }
  if (!pointer || !pointer.current || !pointer.previous) {
    return { ok: false, error: 'pointer_shape_invalid' };
  }

  const before = readJsonIfExists(pointerFile) ?? null;
  const beforeFp = fingerprintOf(before);
  const at = new Date(now()).toISOString();

  const next = {
    ...pointer,
    schema: pointer.schema ?? before?.schema ?? 1,
    activatedAt: at,
    recovery: {
      reason: reason ?? null,
      at,
      boot_verdict: bootVerdict
        ? { status: bootVerdict.status, triggers: (bootVerdict.triggers || []).map((t) => t.rule) }
        : null,
      by: 'recovery-broker',
    },
  };
  atomicWriteJson(pointerFile, next, { keepBak: true });
  const after = readJsonIfExists(pointerFile);
  const afterFp = fingerprintOf(after);

  return {
    ok: true,
    pointer_file: pointerFile,
    before: { current: before?.current?.relativePath ?? null, previous: before?.previous?.relativePath ?? null, fingerprint: beforeFp },
    after: { current: after?.current?.relativePath ?? null, previous: after?.previous?.relativePath ?? null, fingerprint: afterFp },
    changed: beforeFp !== afterFp,
  };
}

/** 普通写路径的显式拒绝入口 —— 便于测试与其它模块直接调用。 */
export function refusePointerWrite({ role = 'agent-worker' } = {}) {
  return {
    ok: false,
    error: 'pointer_write_forbidden',
    role,
    detail: POINTER_ROLES.has(role) ? '只有 Recovery Broker 的受控通道能改运行时指针' : '未知角色，一律拒绝',
    remedy: '走 evaluateRecoveryConditions -> mintRecoveryCapability -> executeRecovery',
  };
}

/**
 * 完整恢复：冻结候选 -> 判废 -> 保存证据 -> 切指针 -> 留档。
 * **不删除任何数据**：槽、tasks、verdicts、candidates、事件账本一概保留。
 */
export function executeRecovery({
  root,
  portableRoot,
  candidateId = null,
  rejectCandidate = null,
  bootVerdict = null,
  reason = 'boot_gate_failed',
  now = () => Date.now(),
} = {}) {
  if (!root) throw new Error('executeRecovery: root is required');
  const base = portableRoot ? path.resolve(portableRoot) : path.resolve(root);
  const pointerFile = path.join(base, 'Data', 'Runtime', 'Harness', 'current.json');
  const pointer = readJsonIfExists(pointerFile);
  if (!pointer) return { ok: false, error: 'pointer_not_found', pointer_file: pointerFile };

  const conditionsResult = evaluateRecoveryConditions({ root, pointer, bootVerdict, portableRoot: base });
  const minted = mintRecoveryCapability({ conditionsResult, root: base, now });
  if (!minted.ok) {
    appendJsonl(recoveryJournalFile({ root }), { type: 'RECOVERY_REFUSED', reason, blockers: minted.blockers, candidate_id: candidateId });
    return { ok: false, error: 'conditions_not_met', blockers: minted.blockers, conditions: conditionsResult.conditions };
  }

  const stable = conditionsResult.stable;
  const target = { relativePath: stable.runtime_slot, version: stable.stable_version, fingerprint: stable.workspace_fingerprint ?? null };

  // 候选判废（由调用方注入，避免本模块依赖 candidate.mjs 造成环）
  let rejection = null;
  if (candidateId && typeof rejectCandidate === 'function') {
    rejection = rejectCandidate({ candidateId, reason: `recovery:${reason}` });
  }

  const write = writeRuntimePointer({
    pointerFile,
    pointer: { ...pointer, previous: pointer.current, current: target },
    capability: minted.capability,
    reason,
    bootVerdict,
    now,
  });
  if (!write.ok) {
    appendJsonl(recoveryJournalFile({ root }), { type: 'RECOVERY_WRITE_REFUSED', reason, candidate_id: candidateId, detail: write });
    return { ok: false, error: write.error, detail: write };
  }

  const journal = {
    type: 'RECOVERY_EXECUTED',
    reason,
    candidate_id: candidateId,
    boot_verdict: bootVerdict ? bootVerdict.status : null,
    boot_triggers: (bootVerdict?.triggers || []).map((t) => t.rule),
    stable_version: stable.stable_version,
    stable_slot: stable.runtime_slot,
    from_slot: write.before.current,
    to_slot: write.after.current,
    pointer_before_fingerprint: write.before.fingerprint,
    pointer_after_fingerprint: write.after.fingerprint,
    candidate_rejection: rejection,
    deletions: [],
    note: '只恢复运行指针；不删除槽位、不清空任务、不覆盖事故记录',
  };
  appendJsonl(recoveryJournalFile({ root }), journal);
  return { ok: true, ...journal, pointer_file: pointerFile, journal_file: recoveryJournalFile({ root }) };
}

export function readRecoveryJournal({ root }) {
  return readJsonl(recoveryJournalFile({ root }));
}
