// Trigger Policy —— 触发器策略（纯逻辑，可测）。
//
// 为什么把逻辑抽出来：DSH 插件的宿主半侧**必须重启才生效**，而我不想把"没验证过的逻辑"
// 直接塞进一个无法当场验证的适配层。所以：
//   本模块 = 纯函数 + 可注入调度器 → 单元测试覆盖；
//   插件 = 薄适配层，只把 ctx 事件接到这里。
import { spawn } from 'node:child_process';

/** 会改文件的工具名（命中才进入 debounce）。 */
export const FILE_MUTATING_TOOLS = Object.freeze([
  'write',
  'edit',
  'multiedit',
  'apply_patch',
  'create_file',
  'str_replace',
  'notebook_edit',
  'file_write',
]);

/** 需要跳过的工作区片段（不触发自我验证）。 */
export const IGNORED_PATH_HINTS = Object.freeze(['.git/', 'node_modules/', 'Data/Temp/', 'Data/Recovery/']);

export function isFileMutatingTool(toolName) {
  if (!toolName) return false;
  const n = String(toolName).toLowerCase();
  return FILE_MUTATING_TOOLS.some((t) => n === t || n.endsWith('/' + t) || n.includes(t));
}

/** 从路径提示判断是否值得触发（避免无意义的自触发循环）。 */
export function shouldIgnoreByPath({ paths = [] } = {}) {
  return paths.some((p) => IGNORED_PATH_HINTS.some((h) => String(p).replace(/\\/g, '/').includes(h)));
}

/**
 * 去抖器：同一批修改结束才触发一次。
 * 调度器与时钟可注入，便于测试里做确定性推进。
 */
export class Debouncer {
  constructor({ delayMs = 1000, onFire, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    if (typeof onFire !== 'function') throw new Error('Debouncer: onFire is required');
    if (typeof delayMs !== 'number' || delayMs < 0) throw new Error('Debouncer: delayMs must be >= 0');
    this.delayMs = delayMs;
    this.onFire = onFire;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.timers = new Map(); // key -> handle
    this.fireCount = 0;
    this.scheduleCount = 0;
    this.disposed = false;
  }

  /** 安排一次（同 key 会重置计时 => 一批修改只触发一次）。 */
  schedule(key = 'default', payload = null) {
    if (this.disposed) return { ok: false, error: 'disposed' };
    this.scheduleCount++;
    const existing = this.timers.get(key);
    if (existing !== undefined) this.clearTimeoutFn(existing);
    const handle = this.setTimeoutFn(() => {
      this.timers.delete(key);
      this.fireCount++;
      this.onFire({ key, payload, fire_index: this.fireCount });
    }, this.delayMs);
    this.timers.set(key, handle);
    return { ok: true, key, pending: this.timers.size };
  }

  cancel(key = 'default') {
    const h = this.timers.get(key);
    if (h === undefined) return false;
    this.clearTimeoutFn(h);
    this.timers.delete(key);
    return true;
  }

  pending() {
    return [...this.timers.keys()];
  }

  dispose() {
    for (const h of this.timers.values()) this.clearTimeoutFn(h);
    this.timers.clear();
    this.disposed = true;
  }
}

/**
 * 触发运行器：把"一批修改结束"接到 `agentos watch --once`，并保证**单实例**。
 */
export function createTriggerRunner({
  agentosEntry,
  agentosRoot,
  workspaceRoot = null,
  debounceMs = 1000,
  extraFiles = {},
  spawnFn = spawn,
  nodeExecPath = process.execPath,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => Date.now(),
  onResult = null,
  logger = null,
} = {}) {
  if (!agentosEntry) throw new Error('createTriggerRunner: agentosEntry is required');
  if (!agentosRoot) throw new Error('createTriggerRunner: agentosRoot is required');

  const state = {
    running: false,
    last_started_at: null,
    last_finished_at: null,
    runs: 0,
    skipped_while_running: 0,
    last_result: null,
    last_error: null,
    history: [],
  };

  const debouncer = new Debouncer({
    delayMs: debounceMs,
    setTimeoutFn,
    clearTimeoutFn,
    onFire: () => {
      void runOnce();
    },
  });

  function buildInput() {
    const input = { task_id: 'auto-verify', once: true, extra_files: extraFiles };
    if (workspaceRoot) input.root = workspaceRoot;
    return input;
  }

  async function runOnce() {
    if (state.running) {
      // 单实例：同一工作区同时只能有一个验证实例
      state.skipped_while_running++;
      return { ok: false, error: 'already_running', skipped: true };
    }
    state.running = true;
    state.last_started_at = new Date(now()).toISOString();
    const args = [agentosEntry, 'watch', '--root', workspaceRoot ?? agentosRoot, '--input', JSON.stringify(buildInput())];

    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawnFn(nodeExecPath, args, { stdio: 'ignore', windowsHide: true, cwd: agentosRoot });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message ? e.message : e), exit_code: null });
        return;
      }
      child.on('error', (e) => resolve({ ok: false, error: String(e && e.message ? e.message : e), exit_code: null }));
      child.on('exit', (code) => resolve({ ok: code === 0, exit_code: code, error: null }));
    });

    state.running = false;
    state.last_finished_at = new Date(now()).toISOString();
    state.runs++;
    state.last_result = result;
    if (!result.ok) state.last_error = result.error ?? `exit_code=${result.exit_code}`;
    const rec = { at: state.last_finished_at, ok: result.ok, exit_code: result.exit_code, error: result.error };
    state.history = [...state.history.slice(-19), rec];
    if (onResult) {
      try {
        onResult(rec);
      } catch (e) {
        if (logger) logger.warn?.('[agentos-trigger] onResult threw: ' + (e?.message ?? e));
      }
    }
    return result;
  }

  return {
    /** 接到 session/event 的 tool/result 上。 */
    onToolResult({ toolName, paths = [] } = {}) {
      if (!isFileMutatingTool(toolName)) return { scheduled: false, reason: 'not_file_mutating_tool' };
      if (shouldIgnoreByPath({ paths })) return { scheduled: false, reason: 'ignored_path' };
      return { scheduled: true, ...debouncer.schedule('default', { toolName }) };
    },
    /** 任务请求完成前的强制同步验证（跳过 debounce，立刻跑）。 */
    forceVerify: runOnce,
    status() {
      return { ...state, debounce_ms: debounceMs, pending: debouncer.pending(), schedule_count: debouncer.scheduleCount, fire_count: debouncer.fireCount };
    },
    dispose() {
      debouncer.dispose();
    },
  };
}
