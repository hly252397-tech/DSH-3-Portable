// 触发器策略 —— 去抖、单实例、强制同步验证（纯逻辑，可确定性测试）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILE_MUTATING_TOOLS,
  IGNORED_PATH_HINTS,
  isFileMutatingTool,
  shouldIgnoreByPath,
  Debouncer,
  createTriggerRunner,
} from '../lib/triggerpolicy.mjs';

function fakeTimers() {
  let id = 0;
  const pending = new Map();
  return {
    setTimeoutFn: (fn, ms) => {
      const h = ++id;
      pending.set(h, { fn, ms });
      return h;
    },
    clearTimeoutFn: (h) => pending.delete(h),
    fireAll: () => {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, v] of entries) v.fn();
      return entries.length;
    },
    pendingCount: () => pending.size,
  };
}

function fakeSpawn({ exitCode = 0, auto = true } = {}) {
  const children = [];
  const fn = (cmd, args, opts) => {
    const handlers = {};
    const child = {
      on: (ev, cb) => ((handlers[ev] = cb), child),
      args,
      cmd,
      opts,
      _exit: (code = exitCode) => handlers.exit?.(code),
      _error: (e) => handlers.error?.(e),
    };
    children.push(child);
    if (auto) queueMicrotask(() => handlers.exit?.(exitCode));
    return child;
  };
  fn.calls = children;
  fn.release = (i = 0, code = exitCode) => children[i]?._exit(code);
  return fn;
}

test('§15-J: 只对「会改文件的工具」触发；非改文件工具一律不触发', () => {
  for (const t of FILE_MUTATING_TOOLS) assert.equal(isFileMutatingTool(t), true, t);
  assert.equal(isFileMutatingTool('Write'), true, '大小写不敏感');
  assert.equal(isFileMutatingTool('mcp__fs__apply_patch'), true, '带前缀也认');
  for (const t of ['read', 'grep', 'glob', 'bash', 'pwsh', 'task', '']) assert.equal(isFileMutatingTool(t), false, t);
  assert.equal(isFileMutatingTool(null), false);
});

test('§15-K: 忽略噪声路径，避免自我触发循环', () => {
  assert.equal(shouldIgnoreByPath({ paths: ['Data/Temp/x.txt'] }), true);
  assert.equal(shouldIgnoreByPath({ paths: ['node_modules/a/b.js'] }), true);
  assert.equal(shouldIgnoreByPath({ paths: ['.git/hooks/post-commit'] }), true);
  assert.equal(shouldIgnoreByPath({ paths: ['Data\\Recovery\\inc\\x.json'] }), true, '反斜杠也要认');
  assert.equal(shouldIgnoreByPath({ paths: ['src/main.ts'] }), false);
  assert.equal(shouldIgnoreByPath({}), false);
  assert.equal(IGNORED_PATH_HINTS.length >= 3, true);
});

test('§15-L: 去抖 —— 一批内多次安排只触发**一次**；之后再改再触发', () => {
  const t = fakeTimers();
  let fired = 0;
  const d = new Debouncer({ delayMs: 1000, onFire: () => fired++, ...t });

  for (let i = 0; i < 5; i++) d.schedule('ws', { file: 'f' + i });
  assert.equal(d.scheduleCount, 5);
  assert.equal(d.pending().length, 1, '同一个 key 只保留一个挂起的计时器');
  assert.equal(fired, 0, '还没到点，不许触发');

  t.fireAll();
  assert.equal(fired, 1, '一批修改只触发一次');

  d.schedule('ws');
  t.fireAll();
  assert.equal(fired, 2, '下一批该再触发');

  // 取消
  d.schedule('ws');
  assert.equal(d.cancel('ws'), true);
  assert.equal(d.cancel('ws'), false);
  t.fireAll();
  assert.equal(fired, 2, '取消后不该触发');

  d.dispose();
  assert.equal(d.schedule('ws').ok, false);
  assert.equal(d.pending().length, 0);
});

test('§15-M: 插件只做适配 —— 按工具名与路径决定是否 schedule（走的是真逻辑）', () => {
  const t = fakeTimers();
  const spawnFn = fakeSpawn();
  const runner = createTriggerRunner({
    agentosEntry: 'G:/DSH-3-Portable/AgentOS/bin/agentos.mjs',
    agentosRoot: 'G:/DSH-3-Portable/AgentOS',
    workspaceRoot: 'G:/w',
    debounceMs: 1000,
    spawnFn,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
  });

  assert.equal(runner.onToolResult({ toolName: 'read', paths: ['a.ts'] }).reason, 'not_file_mutating_tool');
  assert.equal(runner.onToolResult({ toolName: 'write', paths: ['Data/Temp/a'] }).reason, 'ignored_path');
  const ok = runner.onToolResult({ toolName: 'edit', paths: ['src/main.ts'] });
  assert.equal(ok.scheduled, true);
  assert.equal(runner.status().pending.length, 1);

  runner.dispose();
});

test('§15-N: 单实例 —— 正在跑时再触发只计数、不并发', async () => {
  const spawnFn = fakeSpawn({ auto: false }); // 手动控制退出
  const runner = createTriggerRunner({
    agentosEntry: 'x/agentos.mjs',
    agentosRoot: 'x',
    workspaceRoot: 'w',
    debounceMs: 0,
    spawnFn,
  });

  const first = runner.forceVerify();
  await Promise.resolve();
  assert.equal(runner.status().running, true, '第一个验证应处于运行中');

  const second = await runner.forceVerify();
  assert.equal(second.ok, false);
  assert.equal(second.skipped, true);
  assert.equal(runner.status().skipped_while_running, 1, '并发被拒并计数');
  assert.equal(spawnFn.calls.length, 1, '同一时刻只能有一个子进程');

  // 校验真的调了 watch 且带 --once 语义（once 走 input JSON，不是独立参数）
  const call = spawnFn.calls[0];
  assert.equal(call.args[1], 'watch');
  const inputJson = call.args[call.args.indexOf('--input') + 1];
  const parsed = JSON.parse(inputJson);
  assert.equal(parsed.once, true, 'once 必须在 input JSON 里');
  assert.equal(parsed.root, 'w', '工作区必须传进去');
  assert.equal(parsed.task_id, 'auto-verify');

  spawnFn.release(0, 0);
  const r1 = await first;
  assert.equal(r1.ok, true);
  assert.equal(runner.status().running, false, '跑完必须释放单实例闸门');

  // 释放后又能跑
  const third = runner.forceVerify();
  await Promise.resolve();
  spawnFn.release(1, 0);
  assert.equal((await third).ok, true);
  assert.equal(runner.status().runs, 2);
  runner.dispose();
});

test('§15-O: 强制同步验证 —— 绕过 debounce 立刻跑，并记录结果与 history', async () => {
  const spawnFn = fakeSpawn({ exitCode: 0, auto: true });
  const seen = [];
  const runner = createTriggerRunner({
    agentosEntry: 'x/agentos.mjs',
    agentosRoot: 'x',
    workspaceRoot: 'w',
    debounceMs: 60000,
    spawnFn,
    onResult: (r) => seen.push(r),
  });

  const r = await runner.forceVerify();
  assert.equal(r.ok, true);
  assert.equal(spawnFn.calls.length, 1);

  const st = runner.status();
  assert.equal(st.runs, 1);
  assert.equal(st.last_result.ok, true);
  assert.equal(st.history.length, 1);
  assert.ok(st.last_started_at && st.last_finished_at);
  assert.equal(seen.length, 1);
  assert.equal(st.debounce_ms, 60000);

  // 失败也要如实记
  const failSpawn = fakeSpawn({ exitCode: 3, auto: true });
  const runner2 = createTriggerRunner({ agentosEntry: 'x', agentosRoot: 'x', debounceMs: 0, spawnFn: failSpawn });
  const r2 = await runner2.forceVerify();
  assert.equal(r2.ok, false);
  assert.equal(runner2.status().last_error, 'exit_code=3');
});

test('§15-P: 构造参数校验', () => {
  assert.throws(() => createTriggerRunner({}), /agentosEntry is required/);
  assert.throws(() => createTriggerRunner({ agentosEntry: 'x' }), /agentosRoot is required/);
  assert.throws(() => new Debouncer({}), /onFire is required/);
  assert.throws(() => new Debouncer({ onFire: () => {}, delayMs: -1 }), /delayMs/);
});
