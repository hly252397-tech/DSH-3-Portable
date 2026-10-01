// File Broker —— 任务单第二十节（文件写入安全）+ 第三节第 7 条（所有文件操作必须经过 Tool Broker）。
//
// 修改前必须检查（第二十节）：
//   1. 文件已读取
//   2. 读取版本哈希仍有效
//   3. 文件位于允许根目录
//   4. 最终真实路径未通过 Junction 或符号链接逃逸
//   5. 文件属于当前任务范围
//   6. 已建立检查点
// 修改后必须执行：
//   1. 重新读取最终文件  2. 检查 diff  3. 语法检查  4. 类型检查  5. 目标测试  6. 标记工作区 DIRTY
// 关键文件：tmp 写入 -> 校验 -> 原子 rename -> 保留 bak
//
// 诚实口径：做不到的检查（如类型检查）一律进 `not_run`，**绝不计入通过**。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256Text, ensureDir, nowIso, realpathOf, isUnderOrEqual, fwdKey } from './paths.mjs';
import { loadActiveCandidate, candidateScope } from './candidate.mjs';

// realpathOf / isUnderOrEqual 已下沉到 paths.mjs（Stable Shield 也要用）；此处保留再导出，
// 避免既有调用方与测试改导入路径。
export { realpathOf, isUnderOrEqual };

/** 路径守卫：允许根 / 禁止根 / 符号链接或 Junction 逃逸。 */
export function guardWritePath({ target, allowedRoots = [], forbiddenRoots = [] } = {}) {
  if (!target) return { ok: false, problems: ['no_target'], resolved: null, real: null, escaped: false };
  const resolved = path.resolve(target);
  const real = realpathOf(target);
  const realAllowed = allowedRoots.map(realpathOf);
  const realForbidden = forbiddenRoots.map(realpathOf);

  const literalUnderAllowed = realAllowed.some((a) => isUnderOrEqual(resolved, a));
  const realUnderAllowed = realAllowed.some((a) => isUnderOrEqual(real, a));
  const realUnderForbidden = realForbidden.some((a) => isUnderOrEqual(real, a));

  const problems = [];
  if (!realUnderAllowed) problems.push('outside_allowed_roots');
  if (realUnderForbidden) problems.push('inside_forbidden_roots');
  // 逃逸 = 字面路径在允许根内、解析后的真实路径却跑到外面
  const escaped = literalUnderAllowed && !realUnderAllowed;
  if (escaped) problems.push('symlink_or_junction_escape');

  return { ok: problems.length === 0, problems, resolved, real, escaped, real_allowed_roots: realAllowed };
}

export class FileBroker {
  /**
   * @param {object} o
   * @param {string} o.root                  工作区根
   * @param {string[]} [o.allowedRoots]      允许写入的根（默认 [root]）
   * @param {string[]} [o.forbiddenRoots]    明确禁止的根
   * @param {string} [o.checkpointsDir]      检查点目录（默认 <root>/checkpoints）
   */
  constructor({ root, allowedRoots = null, forbiddenRoots = [], checkpointsDir = null, candidateId = null, candidate = null } = {}) {
    if (!root) throw new Error('FileBroker: root is required');
    this.root = path.resolve(root);
    this.allowedRoots = (allowedRoots && allowedRoots.length ? allowedRoots : [this.root]).map((p) => path.resolve(p));
    this.forbiddenRoots = forbiddenRoots.map((p) => path.resolve(p));
    this.checkpointsDir = checkpointsDir ? path.resolve(checkpointsDir) : path.join(this.root, 'checkpoints');

    // 候选白名单**由 File Broker 自己认**，不给调用方遗忘的机会（§28 测试 14）。
    this.candidateId = candidateId ?? null;
    this.candidate = candidate ?? (candidateId ? loadActiveCandidate({ root: this.root, candidateId }) : null);
    if (this.candidateId && this.candidate) {
      // 候选在场时，Supervisor Stable 目录自动进禁止面（§11 Stable 不直接修改）
      const stableDir = path.join(this.root, 'supervisor', 'stable');
      if (!this.forbiddenRoots.some((p) => p.toLowerCase() === stableDir.toLowerCase())) this.forbiddenRoots.push(stableDir);
    }

    /** absPath -> { sha256, size, missing, read_at } */
    this.reads = new Map();
    this.dirty = false;
    this.journal = [];
  }

  /** 第二十节前置 1：登记"已读取"。 */
  read(target) {
    const abs = path.resolve(target);
    if (!fs.existsSync(abs)) {
      const rec = { sha256: null, size: null, missing: true, read_at: nowIso() };
      this.reads.set(abs, rec);
      return rec;
    }
    const buf = fs.readFileSync(abs);
    const rec = { sha256: sha256Text(buf), size: buf.length, missing: false, read_at: nowIso() };
    this.reads.set(abs, rec);
    return rec;
  }

  /** 第二十节前置 6：检查点必须已建立。 */
  checkpointExists(checkpointId) {
    if (!checkpointId) return false;
    if (fs.existsSync(path.join(this.checkpointsDir, `${checkpointId}.json`))) return true;
    if (fs.existsSync(path.join(this.checkpointsDir, checkpointId))) return true;
    return false;
  }

  /** 第二十节的 6 条前置检查（只判定，不写）。 */
  evaluatePreconditions({ target, taskScope = null, checkpointId = null, candidate, candidateId } = {}) {
    const abs = path.resolve(target);
    const guard = guardWritePath({ target: abs, allowedRoots: this.allowedRoots, forbiddenRoots: this.forbiddenRoots });
    const readRec = this.reads.get(abs) || null;
    const exists = fs.existsSync(abs);
    const currentHash = exists ? sha256Text(fs.readFileSync(abs)) : null;

    // 候选在场 -> 写入范围由候选的 allowed_files 说了算；否则用调用方显式给的 taskScope。
    const effCandidate = candidate !== undefined ? candidate : this.candidate;
    const effCandidateId = candidateId ?? this.candidateId;
    const scope = effCandidate ? candidateScope(effCandidate).allowed_files : taskScope;
    const scopeIsEmpty = Array.isArray(scope) && scope.length === 0;
    const inScope = (Array.isArray(scope) ? scope : []).some(
      (s) => isUnderOrEqual(abs, path.resolve(this.root, s)) || fwdKey(abs).endsWith('/' + String(s).replace(/\\/g, '/').toLowerCase()),
    );
    const scopeOk = effCandidate
      ? !scopeIsEmpty && inScope
      : !scope || scope.length === 0 || scope.includes('*') || inScope;

    const checks = [
      {
        id: 'pre:file_read',
        ok: Boolean(readRec),
        detail: readRec ? `read at ${readRec.read_at}` : '本次会话从未读取过该文件',
      },
      {
        id: 'pre:read_hash_still_valid',
        ok: readRec ? (readRec.missing ? !exists : exists && readRec.sha256 === currentHash) : false,
        detail: readRec ? `expected=${readRec.sha256} actual=${currentHash}` : 'no read version',
      },
      {
        id: 'pre:within_allowed_roots',
        ok: guard.problems.filter((p) => p !== 'symlink_or_junction_escape').length === 0,
        detail: guard.problems.join(',') || 'ok',
      },
      {
        id: 'pre:no_symlink_escape',
        ok: !guard.escaped,
        detail: guard.escaped ? `real=${guard.real}` : 'ok',
      },
      {
        id: 'pre:within_task_scope',
        ok: scopeOk,
        detail: effCandidate
          ? scopeIsEmpty
            ? '候选未声明 allowed_files（空即禁止写入）'
            : scopeOk
              ? 'ok（以候选 allowed_files 为准）'
              : '不在候选 allowed_files: ' + JSON.stringify(scope)
          : !scope || scope.length === 0 || scope.includes('*')
            ? 'ok'
            : '不在 allowed_files: ' + JSON.stringify(scope),
      },
      {
        id: 'pre:checkpoint_established',
        ok: this.checkpointExists(checkpointId),
        detail: checkpointId ? (this.checkpointExists(checkpointId) ? 'ok' : `checkpoint 不存在: ${checkpointId}`) : '未提供 checkpoint id',
      },
    ];

    if (effCandidateId) {
      checks.push({
        id: 'pre:candidate_found',
        ok: Boolean(effCandidate),
        detail: effCandidate ? `候选 ${effCandidate.id}（status=${effCandidate.status}）` : `候选 ${effCandidateId} 在 candidates/active 里不存在`,
      });
    }
    if (effCandidate) {
      const frozen = effCandidate.can_continue_development === false || effCandidate.status === 'rejected';
      checks.push({
        id: 'pre:candidate_can_develop',
        ok: !frozen,
        detail: frozen ? '候选已判废/冻结 —— 只允许取证，禁止继续开发（§13）' : 'ok',
      });
      const fscope = candidateScope(effCandidate).forbidden_extra_changes || [];
      const hits = fscope.filter((p) => isUnderOrEqual(abs, path.resolve(this.root, String(p))));
      checks.push({
        id: 'pre:not_forbidden_extra_change',
        ok: hits.length === 0,
        detail: hits.length ? '命中 forbidden_extra_changes: ' + hits.join(',') : 'ok',
      });
    }

    return {
      ok: checks.every((c) => c.ok),
      checks,
      abs,
      current_hash: currentHash,
      read_version: readRec,
      path_guard: guard,
      scope_source: effCandidate ? 'candidate.allowed_files' : taskScope ? 'task_scope' : 'none',
      candidate_id: effCandidateId ?? null,
    };
  }

  /**
   * 真正执行一次受保护写入：tmp -> 校验 -> 原子 rename -> 保留 bak，然后跑后置检查。
   * 前置不过就**不写**，并留下拒绝记录。
   */
  write({ target, content, taskScope = null, checkpointId = null, syntaxCheck = false, backup = true, targetTest = null, candidate = undefined } = {}) {
    const pre = this.evaluatePreconditions({ target, taskScope, checkpointId, candidate });
    if (!pre.ok) {
      this.journal.push({ action: 'write_denied', target: pre.abs, failed: pre.checks.filter((c) => !c.ok).map((c) => c.id), at: nowIso() });
      return { ok: false, stage: 'preconditions', target: pre.abs, checks: pre.checks, not_run: [], denied: true };
    }

    const abs = pre.abs;
    ensureDir(path.dirname(abs));
    const text = typeof content === 'string' ? content : String(content ?? '');
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}`);

    fs.writeFileSync(tmp, text, 'utf8');
    const echoed = fs.readFileSync(tmp, 'utf8');
    if (echoed !== text) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, stage: 'tmp_verify', target: abs, checks: pre.checks, not_run: [], denied: false };
    }
    if (backup && fs.existsSync(abs)) fs.copyFileSync(abs, abs + '.bak');
    fs.renameSync(tmp, abs);

    // ---- 后置 1/2 ----
    const notRun = [];
    const back = fs.readFileSync(abs, 'utf8');
    const post = [
      { id: 'post:reread_ok', ok: back === text, detail: back === text ? 'ok' : '内容往返不一致' },
      { id: 'post:diff_recorded', ok: true, detail: `before=${pre.current_hash ?? 'absent'} after=${sha256Text(back)}` },
    ];

    // ---- 后置 3：语法检查 ----
    if (syntaxCheck && /\.(mjs|js|cjs)$/i.test(abs)) {
      const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', windowsHide: true });
      post.push({ id: 'post:syntax_ok', ok: r.status === 0, detail: r.status === 0 ? 'ok' : String(r.stderr || '').trim().slice(0, 200) });
    } else {
      notRun.push({ id: 'post:syntax_ok', reason: syntaxCheck ? 'not_a_js_file' : 'syntaxCheck_disabled' });
    }

    // ---- 后置 4：类型检查（本仓没有接检查器，如实记为未跑，绝不冒充通过）----
    notRun.push({ id: 'post:type_check', reason: 'no_type_checker_wired_in_agentos' });

    // ---- 后置 5：目标测试（由调用方提供）----
    if (targetTest) post.push({ id: 'post:target_test', ok: targetTest.ok === true, detail: targetTest.detail ?? null });
    else notRun.push({ id: 'post:target_test', reason: 'no_target_test_provided' });

    // ---- 后置 6：标记工作区 DIRTY ----
    this.dirty = true;
    post.push({ id: 'post:workspace_dirty_marked', ok: this.dirty === true, detail: 'dirty=true' });

    // 写入后刷新读取版本，避免紧接着的第二次写被判成"哈希失效"
    this.reads.set(abs, { sha256: sha256Text(back), size: Buffer.byteLength(back, 'utf8'), missing: false, read_at: nowIso() });

    const rec = {
      ok: post.every((c) => c.ok),
      stage: 'written',
      target: abs,
      checks: [...pre.checks, ...post],
      not_run: notRun,
      content_sha256: sha256Text(back),
      backup: backup && fs.existsSync(abs + '.bak') ? abs + '.bak' : null,
      workspace_dirty: this.dirty,
    };
    this.journal.push({ action: 'write', ...rec, at: nowIso() });
    return rec;
  }

  status() {
    return {
      root: this.root,
      allowed_roots: [...this.allowedRoots],
      workspace_dirty: this.dirty,
      read_versions: [...this.reads.entries()].map(([p, v]) => ({ path: p, sha256: v.sha256, missing: v.missing, read_at: v.read_at })),
      journal: [...this.journal],
    };
  }
}

/** 第二十节：交付前必须确认工作区不脏。 */
export function assertCleanForDelivery(broker) {
  if (broker.dirty) {
    return { ok: false, reason: 'workspace_dirty_after_writes', hint: '需要重新验证（指纹已变，旧 PASS 失效）' };
  }
  return { ok: true, reason: 'clean' };
}
