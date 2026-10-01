#!/usr/bin/env node
// AgentOS CLI —— 第 0/1 阶段的可用入口。
// 所有子命令只读写 AgentOS 目录树，绝不触碰活动 Stable 槽。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AGENTOS_ROOT, initTree, nowIso, newId, canonicalJson, ensureDir, atomicWriteJson, readJsonIfExists } from '../lib/paths.mjs';
import { computeFingerprint } from '../lib/fingerprint.mjs';
import { buildVerdict, writeVerdict, isVerdictValidFor } from '../lib/verdict.mjs';
import { Ledger, validateJobRegistration } from '../lib/ledger.mjs';
import { evaluateBoot } from '../lib/bootbreaker.mjs';
import { evaluateExit } from '../lib/exitguard.mjs';
import { declareCandidate, evaluatePromotion, evaluatePatchChain, attributeNewDefect } from '../lib/candidate.mjs';
import { evaluateIncidentClosure } from '../lib/incident.mjs';
import { createTask, transition, mayStop, isTerminal, TERMINAL_STATES, terminalDirFor } from '../lib/taskstate.mjs';
import { createGoalContract, evaluateContractProgress } from '../lib/goalcontract.mjs';
import { evaluateStopLine, DEFAULT_LIMITS } from '../lib/stopline.mjs';
import { classifyProblem, buildImpactSet, impactSetComplete, validateFamilyGate, assertChangePriority } from '../lib/impactset.mjs';
import { MemoryStore, MEMORY_KINDS, MEMORY_STATUSES } from '../lib/memory.mjs';
import { LEARNING_STAGES, DEFAULT_PROMOTION_POLICY, evaluateLearningPromotion, assertNoShortcut, evaluateArtifactCandidate } from '../lib/learning.mjs';
import { auditBoot } from '../lib/bootaudit.mjs';
import { Supervisor, decideNext, MAX_STEPS_DEFAULT } from '../lib/supervisor.mjs';
import { validateGoalContract } from '../lib/goalcontract.mjs';
import { runGatePipeline } from '../lib/gateengine.mjs';
import { FileBroker } from '../lib/filebroker.mjs';
import { governOnce, readGovernorStatus, DEFAULT_STEP_BUDGET } from '../lib/runner.mjs';
import { stableForbiddenRoots, describeStableShield, isProtectedPath, resolveLiveStable } from '../lib/stableshield.mjs';
import { watchOnce, watchLoop, readWatchStatus, DEFAULT_INTERVAL_MS } from '../lib/watcher.mjs';
import { spawnTracked, registerProcess, stopProcess, processBrokerStatus, reconcile, listRegistered } from '../lib/processbroker.mjs';
import { buildConsoleView, renderConsoleHtml, CONSOLE_FIELDS } from '../lib/console.mjs';
import { recordPromotion, resolveStable, evaluateRecoveryConditions, executeRecovery, readRecoveryJournal, refusePointerWrite } from '../lib/stablerecovery.mjs';
import { openIncident, newIncidentId, recordFirstError, recordFirstNetworkFailure, finalizeIncident, readIncident, analyzeSharedLayer, planBisect } from '../lib/bootforensics.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readJsonArg(args, key) {
  if (!args[key] || args[key] === true) return null;
  const raw = String(args[key]);
  const trimmed = raw.trim();
  // 先按内联 JSON 解析（--extra '{"a":"b"}'），否则当作文件路径
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(stripBom(trimmed));
  // Windows 上用 PowerShell 写出的 JSON 常带 BOM，必须吃掉
  return JSON.parse(stripBom(fs.readFileSync(raw, 'utf8')));
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

const LEDGER_FILE = path.join(AGENTOS_ROOT, 'events', 'task-events.jsonl');
const VERDICTS_DIR = path.join(AGENTOS_ROOT, 'verdicts');

// 便携盘根 = AgentOS 的上级；不硬编码盘符，整盘可搬移
const PORTABLE_ROOT = path.resolve(AGENTOS_ROOT, '..');
const DEFAULT_PROFILE_DIR = path.join(PORTABLE_ROOT, 'Data', 'DSH', 'profiles', 'web');

// 第五节：tasks/active | tasks/completed | tasks/failed
const TASK_DIRS = Object.freeze({
  active: path.join(AGENTOS_ROOT, 'tasks', 'active'),
  completed: path.join(AGENTOS_ROOT, 'tasks', 'completed'),
  failed: path.join(AGENTOS_ROOT, 'tasks', 'failed'),
});

/** 终态归属目录统一由 lib/taskstate.mjs 提供（避免与 runner 各写一份漂移）。 */

function findTaskFile(id, root = AGENTOS_ROOT) {
  for (const d of ['active', 'completed', 'failed']) {
    const f = path.join(root, 'tasks', d, `${id}.json`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** 允许 --root / input.root 指向任意工作区；显式 null 必须回退，不能被覆盖。 */
function resolveRoot(args, input = {}) {
  return (args.root && args.root !== true ? args.root : null) || input.root || AGENTOS_ROOT;
}

/** 读取登记必须跨 CLI 调用持久化，否则「文件已读取」这条前置等于没查。 */
const READS_FILE = path.join(AGENTOS_ROOT, 'cache', 'file-broker-reads.json');

function loadBrokerReads(broker) {
  const j = readJsonIfExists(READS_FILE);
  if (j && j.reads) for (const [p, v] of Object.entries(j.reads)) broker.reads.set(p, v);
  return broker;
}

function saveBrokerReads(broker) {
  atomicWriteJson(READS_FILE, { schema: 1, updated_at: nowIso(), reads: Object.fromEntries(broker.reads) }, { keepBak: false });
}

/**
 * 脚本化 Worker —— 可确定性复现，不依赖大模型。
 * 脚本值可以是对象，也可以是**数组**（按第 N 次调用取第 N 项，越界取最后一项），
 * 这样才能从命令行表达"第一次阻塞、修好后成功"这类有状态行为。
 */
function makeScriptedWorker(script = {}) {
  const counts = {};
  return {
    calls: counts,
    act: async ({ item }) => {
      const n = counts[item.id] ?? 0;
      counts[item.id] = n + 1;
      let r = script[item.id];
      if (r === undefined || r === null) {
        return { ok: false, evidence: 'no script entry for ' + item.id, self_inflicted: true };
      }
      if (Array.isArray(r)) r = r[Math.min(n, r.length - 1)];
      return r;
    },
  };
}

function makeBroker(input, args) {
  const root = (args.root && args.root !== true ? args.root : null) || input.root || AGENTOS_ROOT;
  // Stable 保护面**永远**并入 forbiddenRoots —— 目标硬约束是"Stable 永不直接修改"，
  // 所以这里**不提供关闭开关**。
  const shield = stableForbiddenRoots({ portableRoot: input.portable_root || PORTABLE_ROOT });
  const forbiddenRoots = [...new Set([...(input.forbidden_roots || []), ...shield.forbiddenRoots])];
  return new FileBroker({
    root,
    allowedRoots: input.allowed_roots || null,
    forbiddenRoots,
    checkpointsDir: input.checkpoints_dir || null,
    // 候选白名单由 Broker 自己加载并强制（§28 测试 14）；不给就是无候选模式。
    candidateId: input.candidate_id || null,
  });
}

const commands = {
  init() {
    const r = initTree(AGENTOS_ROOT);
    emit({ ok: true, ...r });
  },

  fingerprint(args) {
    const root = args.root && args.root !== true ? args.root : process.cwd();
    const extra = readJsonArg(args, 'extra') || {};
    const fp = computeFingerprint({ root, extraFiles: extra });
    if (args.out && args.out !== true) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, JSON.stringify(fp, null, 2) + '\n', 'utf8');
    }
    emit(fp);
  },

  'ledger-append'(args) {
    const ledger = new Ledger(LEDGER_FILE);
    const payload = args.payload && args.payload !== true ? JSON.parse(args.payload) : {};
    const ev = ledger.append({ type: args.type || 'NOTE', critical: args.critical === true, ...payload });
    emit(ev);
  },

  'ledger-status'() {
    const ledger = new Ledger(LEDGER_FILE);
    emit({
      file: LEDGER_FILE,
      integrity: ledger.verifyIntegrity(),
      unconsumed_critical: ledger.unconsumedCritical().map((e) => ({ seq: e.seq, type: e.type, at: e.recorded_at })),
      total: ledger.readAll().events.length,
    });
  },

  'boot-check'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit(evaluateBoot(input));
  },

  'exit-check'(args) {
    const state = readJsonArg(args, 'state') || {};
    emit(evaluateExit(state));
  },

  'incident-check'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit(evaluateIncidentClosure(input));
  },

  'candidate-declare'(args) {
    const input = readJsonArg(args, 'input') || {};
    // 允许 --root 或 input.root 指向任意工作区；显式 null/空值必须回退到 AgentOS 根，
    // 否则 { root: AGENTOS_ROOT, ...input } 会被 null 覆盖并直接抛错（已实测）。
    const { root: inputRoot, ...rest } = input;
    const root = (args.root && args.root !== true ? args.root : null) || inputRoot || AGENTOS_ROOT;
    emit(declareCandidate({ root, ...rest }));
  },

  'candidate-promote'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit(evaluatePromotion(input));
  },

  'patch-chain'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit(evaluatePatchChain(input));
  },

  'job-check'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit(validateJobRegistration(input));
  },

  /**
   * gate —— 正式门禁执行器。
   * 取 before 指纹 -> 跑被测命令 -> 取 after 指纹 -> 出 verdict。
   * Watcher 完全停止也不影响本命令（它不依赖任何 Watcher）。
   */
  gate(args) {
    const root = args.root && args.root !== true ? args.root : process.cwd();
    const cmd = args.cmd;
    if (!cmd || cmd === true) throw new Error('gate: --cmd is required');
    const taskId = args.task || null;
    const candidateId = args.candidate || null;
    // --extra '{"gate":"scripts/gates.mjs"}' 用来把门禁脚本/配置/manifest 纳入指纹
    const extra = readJsonArg(args, 'extra') || {};
    const startedAt = nowIso();
    const before = computeFingerprint({ root, extraFiles: extra });
    const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const after = computeFingerprint({ root, extraFiles: extra });
    const verdict = buildVerdict({
      run_id: args.run || newId('run'),
      task_id: taskId,
      candidate_id: candidateId,
      started_at: startedAt,
      checks: [{ id: 'gate_command_exit_zero', ok: r.status === 0, detail: `exit=${r.status}` }],
      before,
      after,
      exit_code: r.status ?? 1,
      stdout_summary: r.stdout || '',
      stderr_summary: r.stderr || '',
    });
    const file = writeVerdict(path.join(root, 'verdicts'), verdict);
    const ledger = new Ledger(LEDGER_FILE);
    ledger.append({ type: verdict.status, task_id: taskId, candidate_id: candidateId, run_id: verdict.run_id, detail: verdict.status_reason });
    emit({ verdict, file, valid_now: isVerdictValidFor(verdict, after) });
  },

  'task-create'(args) {
    const input = readJsonArg(args, 'input') || {};
    if (!input.id) throw new Error('task-create: input.id is required');
    const root = resolveRoot(args, input);
    const contract = input.contract ? createGoalContract(input.contract) : null;
    const task = createTask({ id: input.id, goal_contract_id: contract ? contract.id : null });
    const dir = ensureDir(path.join(root, 'tasks', 'active'));
    const file = path.join(dir, `${task.id}.json`);
    atomicWriteJson(file, { task, contract });
    emit({ ok: true, task, contract, file, may_stop: mayStop(task.state) });
  },

  'task-show'(args) {
    const id = args.task;
    if (!id || id === true) throw new Error('task-show: --task is required');
    const root = resolveRoot(args, readJsonArg(args, 'input') || {});
    const file = findTaskFile(id, root);
    const rec = file ? readJsonIfExists(file) : null;
    if (!rec) {
      emit({ ok: false, error: 'task_not_found', id });
      return;
    }
    const satisfied = args.satisfied && args.satisfied !== true ? String(args.satisfied).split(',') : [];
    const progress = rec.contract ? evaluateContractProgress(rec.contract, { satisfied }) : null;
    emit({ ok: true, file, task: rec.task, contract_progress: progress, may_stop: mayStop(rec.task.state), is_terminal: isTerminal(rec.task.state) });
  },

  'task-transition'(args) {
    const id = args.task;
    const to = args.to;
    if (!id || id === true) throw new Error('task-transition: --task is required');
    if (!to || to === true) throw new Error('task-transition: --to is required');
    const root = resolveRoot(args, readJsonArg(args, 'input') || {});
    const file = findTaskFile(id, root);
    if (!file) throw new Error('task-transition: task not found ' + id);
    const rec = readJsonIfExists(file);
    const guard = readJsonArg(args, 'guard');
    const r = transition(rec.task, to, { reason: args.reason || 'cli', guard });
    if (!r.ok) {
      emit({ ok: false, ...r, current: rec.task.state, may_stop: mayStop(rec.task.state) });
      return;
    }
    const moved = terminalDirFor(r.record.state);
    let outFile = file;
    atomicWriteJson(file, { ...rec, task: r.record });
    if (moved) {
      outFile = path.join(root, 'tasks', moved, `${id}.json`);
      ensureDir(path.dirname(outFile));
      fs.renameSync(file, outFile);
    }
    emit({ ok: true, state: r.record.state, file: outFile, may_stop: mayStop(r.record.state), is_terminal: isTerminal(r.record.state) });
  },

  'stopline-check'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit(evaluateStopLine({ counters: input.counters || input, limits: input.limits || DEFAULT_LIMITS }));
  },

  'impact-check'(args) {
    const input = readJsonArg(args, 'input') || {};
    const classification = input.affected_components || input.affects_runtime !== undefined ? classifyProblem(input) : null;
    const set = input.members ? buildImpactSet(input) : null;
    emit({
      classification,
      impact_set_size: set ? set.length : 0,
      completion: set ? impactSetComplete(set) : null,
      change_priority: input.change_level ? assertChangePriority({ problem_class: (classification && classification.problem_class) || input.problem_class, change_level: input.change_level }) : null,
    });
  },

  'family-gate'(args) {
    emit(validateFamilyGate(readJsonArg(args, 'input') || {}));
  },

  'candidate-attribute'(args) {
    emit(attributeNewDefect(readJsonArg(args, 'input') || {}));
  },

  'memory-remember'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit(new MemoryStore({ root: AGENTOS_ROOT }).remember(input));
  },

  'memory-status'(args) {
    const input = readJsonArg(args, 'input') || {};
    const r = new MemoryStore({ root: AGENTOS_ROOT }).setStatus(input);
    emit(r);
    if (!r.ok) process.exit(1);
  },

  'memory-list'(args) {
    const store = new MemoryStore({ root: AGENTOS_ROOT });
    if (args.all === true || !args.kind || args.kind === true) {
      const out = {};
      for (const k of MEMORY_KINDS) out[k] = store.current(k).map((r) => ({ id: r.id, status: r.status, content: r.content ?? null }));
      emit({ kinds: [...MEMORY_KINDS], statuses: [...MEMORY_STATUSES], memory: out });
      return;
    }
    emit({ kind: args.kind, records: store.current(args.kind) });
  },

  'memory-capability'(args) {
    const store = new MemoryStore({ root: AGENTOS_ROOT });
    const input = readJsonArg(args, 'input');
    if (input) {
      emit(store.recordCapability(input));
      return;
    }
    emit({ summary: store.capabilitySummary() });
  },

  'memory-snapshot'(args) {
    emit(new MemoryStore({ root: AGENTOS_ROOT }).snapshot(readJsonArg(args, 'input') || {}));
  },

  'learning-evaluate'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit(evaluateLearningPromotion(input, input.policy || DEFAULT_PROMOTION_POLICY));
  },

  'learning-shortcut'(args) {
    const input = readJsonArg(args, 'input') || {};
    const { target, policy, ...record } = input;
    const r = assertNoShortcut(record, target, policy || DEFAULT_PROMOTION_POLICY);
    emit(r);
    if (!r.ok) process.exit(1);
  },

  'artifact-candidate'(args) {
    emit(evaluateArtifactCandidate(readJsonArg(args, 'input') || {}));
  },

  'learning-stages'() {
    emit({ stages: [...LEARNING_STAGES], policy: { ...DEFAULT_PROMOTION_POLICY } });
  },

  async 'boot-audit'(args) {
    const profileDir = args.profile && args.profile !== true ? args.profile : DEFAULT_PROFILE_DIR;
    const harnessSlotDir = args.harness && args.harness !== true ? args.harness : null;
    const probeUrls = args.probe && args.probe !== true ? String(args.probe).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const moduleUrls = args.module && args.module !== true ? String(args.module).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const report = await auditBoot({ portableRoot: PORTABLE_ROOT, profileDir, harnessSlotDir, probeUrls, moduleUrls, timeoutMs: 5000 });
    const dir = ensureDir(path.join(AGENTOS_ROOT, 'logs'));
    const file = path.join(dir, `boot-audit-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15)}.json`);
    atomicWriteJson(file, report, { keepBak: false });
    emit({
      file,
      boot_verdict: report.boot_verdict,
      bundles: report.bundles,
      quarantine: { total: report.quarantine.total, unresolved: report.quarantine.unresolved.length, newest_created_at: report.quarantine.newest?.createdAt ?? null },
      client_alive_evidence: report.client_alive_evidence,
      probes: report.probes.map((p) => ({ url: p.url, status: p.status, reachable: p.reachable })),
    });
  },

  'decide'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit(decideNext(input));
  },

  /**
   * supervise —— 真的跑一遍 Supervisor 调度循环。
   * Worker 由 `worker_script` 提供（{ 条目id: {ok, evidence, ...} }），
   * 因此这条命令是可确定性复现的，不依赖任何大模型。
   */
  async 'supervise'(args) {
    const input = readJsonArg(args, 'input') || {};
    const contract = input.contract;
    const v = validateGoalContract(contract);
    if (!v.ok) {
      emit({ ok: false, error: 'invalid_contract', problems: v.problems });
      process.exit(1);
    }
    const task = createTask({ id: input.task_id || 'cli-task', goal_contract_id: contract.id ?? null, state: input.task_state || 'NEW' });
    const worker = makeScriptedWorker(input.worker_script);
    const sup = new Supervisor({
      task,
      contract,
      worker,
      policy: input.policy || {},
      limits: input.limits || DEFAULT_LIMITS,
    });
    const r = await sup.run({ maxSteps: input.max_steps || MAX_STEPS_DEFAULT });
    r.worker_calls = { ...worker.calls };
    if (args.out && args.out !== true) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, JSON.stringify(r, null, 2) + '\n', 'utf8');
    }
    emit(r);
  },

  /**
   * verify —— 跑第二十一节的完整七层管线。
   * input.run_boot_audit = true 时，**启动审计在管线内部自动执行**（这就是"自动熔断"）。
   * verdict 状态同时写入事件账本（§15：FAIL 必须进 Event Bus）。
   */
  async 'verify'(args) {
    const input = readJsonArg(args, 'input') || {};
    const root = args.root && args.root !== true ? args.root : process.cwd();
    const runBootAudit = input.run_boot_audit === true;
    const r = await runGatePipeline({
      root,
      task_id: input.task_id ?? null,
      candidate_id: input.candidate_id ?? null,
      extraFiles: input.extra_files || {},
      layers: input.layers || {},
      runBootAudit,
      profileDir: input.profile_dir || (runBootAudit ? DEFAULT_PROFILE_DIR : null),
      harnessSlotDir: input.harness_slot_dir || (args.harness && args.harness !== true ? args.harness : null),
      probeUrls: input.probe_urls || [],
      moduleUrls: input.module_urls || [],
      allowPartialBoot: input.allow_partial_boot !== false,
      rejectCandidateOnBootFailure: input.reject_candidate_on_boot_failure !== false,
      // verdict 跟着被验证的工作区走（console 从 <root>/verdicts 读），否则两边对不上
      verdictsDir: input.verdicts_dir || path.join(root, 'verdicts'),
    });
    const ledger = new Ledger(LEDGER_FILE);
    ledger.append({
      type: r.verdict.status,
      run_id: r.verdict.run_id,
      task_id: input.task_id ?? null,
      candidate_id: input.candidate_id ?? null,
      detail: r.verdict.status_reason,
    });
    emit({
      verdict_status: r.verdict.status,
      verdict_reason: r.verdict.status_reason,
      verdict_file: r.verdict_file ?? null,
      layers: r.layers.map((l) => ({ layer: l.layer, ok: l.ok })),
      failed_checks: r.verdict.checks.filter((c) => !c.ok),
      boot: r.boot,
      enforcement: r.enforcement,
      fingerprint: r.fingerprint_after,
    });
  },

  'file-read'(args) {
    const input = readJsonArg(args, 'input') || {};
    const target = input.target || (args.path && args.path !== true ? args.path : null);
    if (!target) throw new Error('file-read: --path 或 input.target 必填');
    const b = loadBrokerReads(makeBroker(input, args));
    const rec = b.read(target);
    saveBrokerReads(b);
    emit({ target: path.resolve(target), read_version: rec });
  },

  'file-write'(args) {
    const input = readJsonArg(args, 'input') || {};
    if (!input.target) throw new Error('file-write: input.target 必填');
    const b = loadBrokerReads(makeBroker(input, args));
    const r = b.write({
      target: input.target,
      content: input.content,
      taskScope: input.task_scope ?? null,
      checkpointId: input.checkpoint_id ?? null,
      syntaxCheck: input.syntax_check === true,
      backup: input.backup !== false,
      targetTest: input.target_test ?? null,
    });
    saveBrokerReads(b);
    emit(r);
    if (!r.ok) process.exit(1);
  },

  'file-status'(args) {
    const input = readJsonArg(args, 'input') || {};
    const b = loadBrokerReads(makeBroker(input, args));
    emit(b.status());
  },

  async 'govern'(args) {
    const input = readJsonArg(args, 'input') || {};
    const root = resolveRoot(args, input);
    const taskId = input.task_id || (args.task && args.task !== true ? args.task : null);
    if (!taskId) throw new Error('govern: --task 或 input.task_id 必填');
    const worker = makeScriptedWorker(input.worker_script);
    const res = await governOnce({
      root,
      taskId,
      worker,
      stepBudget: input.step_budget ?? DEFAULT_STEP_BUDGET,
      policy: input.policy || {},
      limits: input.limits || DEFAULT_LIMITS,
      ledger: new Ledger(LEDGER_FILE),
      verify: input.verify || null,
    });
    emit(res);
    if (!res.ok) process.exit(1);
  },

  'governor-status'(args) {
    const input = readJsonArg(args, 'input') || {};
    const root = resolveRoot(args, input);
    const taskId = input.task_id || (args.task && args.task !== true ? args.task : null);
    if (!taskId) throw new Error('governor-status: --task 必填');
    emit(readGovernorStatus({ root, taskId }));
  },

  'stable-shield'(args) {
    const input = readJsonArg(args, 'input') || {};
    const portableRoot =
      input.portable_root ||
      (args.portable && args.portable !== true ? args.portable : null) ||
      (args.root && args.root !== true ? args.root : null) ||
      PORTABLE_ROOT;
    const probe = input.probe ?? null;
    const out = describeStableShield({ portableRoot });
    if (probe) {
      const live = resolveLiveStable({ portableRoot });
      out.probe = { target: probe, ...isProtectedPath({ target: probe, liveStable: live }) };
    }
    emit(out);
  },

  /**
   * watch —— **触发无关**的入口。
   * 任何触发方式（git hook / DSH 插件 / 计划任务 / 人手）都只需调 `watch --once`：
   * 先比工作区指纹，没变直接跳过（本盘实测 git status ≈118ms），变了才跑门禁。
   * 不带 --once 时进入有上限的轮询模式（默认 12 轮，避免误常驻）。
   */
  async 'watch'(args) {
    const input = readJsonArg(args, 'input') || {};
    const root = resolveRoot(args, input);
    const taskId = input.task_id || 'watch';
    const ledger = new Ledger(LEDGER_FILE);

    const runVerify = input.verify
      ? async ({ fingerprint }) => {
          const g = await runGatePipeline({
            root,
            task_id: taskId,
            candidate_id: input.verify.candidateId ?? null,
            extraFiles: input.verify.extraFiles || input.extra_files || {},
            layers: input.verify.layers || {},
            runBootAudit: input.verify.runBootAudit === true,
            profileDir: input.verify.profileDir ?? null,
            harnessSlotDir: input.verify.harnessSlotDir ?? null,
            probeUrls: input.verify.probeUrls || [],
            moduleUrls: input.verify.moduleUrls || [],
            allowPartialBoot: input.verify.allowPartialBoot !== false,
            rejectCandidateOnBootFailure: input.verify.rejectCandidateOnBootFailure !== false,
            verdictsDir: input.verify.verdictsDir || input.verdicts_dir || path.join(root, 'verdicts'),
          });
          return {
            verdict_status: g.verdict.status,
            verdict_file: g.verdict_file ?? null,
            boot: g.boot,
            enforcement: g.enforcement,
            fingerprint,
          };
        }
      : null;

    if (input.once === true || args.once === true) {
      emit(await watchOnce({
        root,
        taskId,
        extraFiles: input.extra_files || {},
        runVerify,
        ledger,
        cooldownMs: input.cooldown_ms ?? 0,
        force: input.force === true,
      }));
      return;
    }

    const loop = await watchLoop({
      root,
      taskId,
      extraFiles: input.extra_files || {},
      runVerify,
      ledger,
      cooldownMs: input.cooldown_ms ?? 0,
      intervalMs: input.interval_ms ?? DEFAULT_INTERVAL_MS,
      maxIterations: input.max_iterations ?? 12,
    });
    emit(loop);
    if (!loop.ok) process.exit(1);
  },

  'watch-status'(args) {
    const input = readJsonArg(args, 'input') || {};
    const root = resolveRoot(args, input);
    emit(readWatchStatus({ root, taskId: input.task_id || 'watch' }));
  },

  'proc-spawn'(args) {
    const input = readJsonArg(args, 'input') || {};
    const root = resolveRoot(args, input);
    if (!input.owner_task_id) throw new Error('proc-spawn: input.owner_task_id 必填');
    if (!input.file) throw new Error('proc-spawn: input.file 必填');
    const { child, record } = spawnTracked({
      root,
      owner_task_id: input.owner_task_id,
      owner_job_id: input.owner_job_id ?? null,
      command: input.command ?? null,
      file: input.file,
      args: input.args || [],
      unref: input.unref !== false, // CLI 起的后台进程默认 unref，否则这个 CLI 进程不会退出
    });
    emit({ ok: true, pid: child.pid, process_id: record.process_id, stop_method: record.stop_method, owner_task_id: record.owner_task_id });
  },

  'proc-register'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit(registerProcess({ root: resolveRoot(args, input), ...input }));
  },

  async 'proc-stop'(args) {
    const input = readJsonArg(args, 'input') || {};
    const root = resolveRoot(args, input);
    if (!input.pid) throw new Error('proc-stop: input.pid 必填');
    const r = await stopProcess({
      root,
      pid: input.pid,
      owner_task_id: input.owner_task_id ?? null,
      strategy: input.strategy || 'exact_pid',
      signal: input.signal || 'SIGTERM',
      timeoutMs: input.timeout_ms ?? 8000,
    });
    emit(r);
    if (!r.ok) process.exit(1);
  },

  'proc-status'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit(processBrokerStatus({ root: resolveRoot(args, input), owner_task_id: input.owner_task_id }));
  },

  'proc-reconcile'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit(reconcile({ root: resolveRoot(args, input) }));
  },

  'proc-list'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit({ rows: listRegistered({ root: resolveRoot(args, input), owner_task_id: input.owner_task_id, includeStopped: input.include_stopped === true }) });
  },

  /** §26 控制台：只读聚合，一页看全。 */
  'console'(args) {
    const input = readJsonArg(args, 'input') || {};
    const root = resolveRoot(args, input);
    const view = buildConsoleView({
      root,
      taskId: input.task_id || (args.task && args.task !== true ? args.task : null),
      portableRoot: input.portable_root || (args.portable && args.portable !== true ? args.portable : null) || PORTABLE_ROOT,
      extraFiles: input.extra_files || {},
    });
    if (args.out && args.out !== true) {
      ensureDir(path.dirname(args.out));
      fs.writeFileSync(args.out, renderConsoleHtml(view), 'utf8');
      view.html_report = path.resolve(args.out);
    }
    emit(view);
  },

  'console-fields'() {
    emit({ fields: [...CONSOLE_FIELDS] });
  },

  /** Stable 的定义来自晋升台账，不是"上一个目录"。 */
  'stable-status'(args) {
    const input = readJsonArg(args, 'input') || {};
    const root = resolveRoot(args, input);
    const portable = input.portable_root || (args.portable && args.portable !== true ? args.portable : null) || PORTABLE_ROOT;
    const pointerFile = path.join(portable, 'Data', 'Runtime', 'Harness', 'current.json');
    const pointer = readJsonIfExists(pointerFile);
    const resolution = resolveStable({ root, portableRoot: portable });
    const conditions = evaluateRecoveryConditions({ root, pointer, bootVerdict: input.boot_verdict ?? null, portableRoot: portable });
    emit({
      portable_root: portable,
      pointer_file: pointerFile,
      pointer: pointer ? { current: pointer.current?.relativePath ?? null, previous: pointer.previous?.relativePath ?? null } : null,
      stable: resolution.stable ? { version: resolution.stable.stable_version, slot: resolution.stable.runtime_slot } : null,
      found: resolution.found,
      considered: resolution.considered.map((c) => ({ slot: c.runtime_slot, status: c.status, boot: c.boot_verdict, reachable: c.reachable })),
      recovery_conditions: conditions.conditions,
      recovery_allowed: conditions.allowed,
      recovery_blockers: conditions.blockers,
      pointer_write_for_normal_roles: refusePointerWrite({ role: 'agent-worker' }).error,
    });
  },

  /** 取证：列出/读取事故目录。 */
  'incident-read'(args) {
    const input = readJsonArg(args, 'input') || {};
    const portable = input.portable_root || (args.portable && args.portable !== true ? args.portable : null) || PORTABLE_ROOT;
    if (!input.incident_id) {
      const dir = path.join(portable, 'Data', 'Recovery');
      const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('boot-failure-')) : [];
      emit({ portable_root: portable, incidents: ids });
      return;
    }
    emit(readIncident({ portableRoot: portable, incidentId: input.incident_id }));
  },

  'incident-record'(args) {
    const input = readJsonArg(args, 'input') || {};
    const portable = input.portable_root || (args.portable && args.portable !== true ? args.portable : null) || PORTABLE_ROOT;
    const incidentId = input.incident_id || newIncidentId();
    openIncident({ portableRoot: portable, incidentId, runtime: input.runtime ?? null, candidate: input.candidate ?? null, note: input.note ?? null });
    const stored = input.kind === 'network_failure'
      ? recordFirstNetworkFailure({ portableRoot: portable, incidentId, failure: input.failure ?? {} })
      : recordFirstError({ portableRoot: portable, incidentId, error: input.error ?? {} });
    if (input.finalize) {
      const fin = finalizeIncident({ portableRoot: portable, incidentId, affectedPlugins: input.affected_plugins ?? [], sharedSource: input.shared_source ?? null, changeGroups: input.change_groups ?? null });
      emit({ incident_id: incidentId, stored, summary_file: fin.file, summary: fin.summary });
      return;
    }
    emit({ incident_id: incidentId, stored });
  },

  'incident-analyze'(args) {
    const input = readJsonArg(args, 'input') || {};
    emit({ analysis: analyzeSharedLayer({ failures: input.failures ?? [] }), bisect: input.change_groups ? planBisect({ changeGroups: input.change_groups }) : null });
  },

  /**
   * 恢复：**默认只出计划（dry-run）**；真执行必须显式 execute:true。
   * 指针只能由受控通道改，Agent 普通写路径无权（Stable Shield 仍生效）。
   */
  'recovery-execute'(args) {
    const input = readJsonArg(args, 'input') || {};
    const root = resolveRoot(args, input);
    const portable = input.portable_root || (args.portable && args.portable !== true ? args.portable : null) || PORTABLE_ROOT;
    const pointerFile = path.join(portable, 'Data', 'Runtime', 'Harness', 'current.json');
    const pointer = readJsonIfExists(pointerFile);
    const conditions = evaluateRecoveryConditions({ root, pointer, bootVerdict: input.boot_verdict ?? null, portableRoot: portable });

    if (input.execute !== true) {
      const ledger = new Ledger(LEDGER_FILE);
      ledger.append({ type: 'STABLE', task_id: input.task_id ?? null, detail: 'recovery-plan(dry-run) allowed=' + conditions.allowed });
      emit({
        mode: 'dry_run',
        allowed: conditions.allowed,
        blockers: conditions.blockers,
        conditions: conditions.conditions,
        stable: conditions.stable ? { version: conditions.stable.stable_version, slot: conditions.stable.runtime_slot } : null,
        pointer_file: pointerFile,
        journal: readRecoveryJournal({ root }).slice(-3),
      });
      return;
    }

    const res = executeRecovery({ root, portableRoot: portable, candidateId: input.candidate_id ?? null, bootVerdict: input.boot_verdict ?? null, reason: input.reason ?? 'boot_gate_failed' });
    emit(res);
    if (!res.ok) process.exit(1);
  },

  help() {
    emit({ usage: Object.keys(commands).sort(), root: AGENTOS_ROOT, ledger: LEDGER_FILE, verdicts: VERDICTS_DIR });
  },
};

const argv = process.argv.slice(2);
const name = argv[0] || 'help';
const args = parseArgs(argv.slice(1));
const fn = commands[name];
if (!fn) {
  process.stderr.write(`unknown command: ${name}\n`);
  emit({ usage: Object.keys(commands).sort() });
  process.exit(2);
}
try {
  const r = fn(args);
  if (r && typeof r.then === 'function') await r;
} catch (e) {
  process.stderr.write(`agentos ${name} failed: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
}
