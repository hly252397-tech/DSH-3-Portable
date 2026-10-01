// 任务单第十五节（Watcher 只能作为自动触发器）+ 第十九节（单实例锁 / 陈旧锁清理）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmrf, writeFile } from './helpers.mjs';
import {
  watchOnce,
  watchLoop,
  watchPaths,
  acquireLock,
  releaseLock,
  readLock,
  shouldStop,
  requestStop,
  clearStop,
  readWatchStatus,
  DEFAULT_INTERVAL_MS,
  DEFAULT_STALE_LOCK_MS,
} from '../lib/watcher.mjs';
import { Ledger } from '../lib/ledger.mjs';

function makeWs() {
  const d = makeTempDir('watch-');
  writeFile(path.join(d, 'a.js'), 'export const a = 1;\n');
  return d;
}

const extra = { changed: 'a.js' };

test('§15-C: 首次 RAN；指纹没变则 SKIP 且**不跑任何重活**；变了才再 RAN', async () => {
  const root = makeWs();
  try {
    let verifyCalls = 0;
    const runVerify = async () => {
      verifyCalls++;
      return { verdict_status: 'PASS' };
    };

    const first = await watchOnce({ root, extraFiles: extra, runVerify });
    assert.equal(first.action, 'RAN');
    assert.equal(first.reason, 'fingerprint_changed');
    assert.equal(first.last_result, 'PASS');
    assert.equal(first.total_runs, 1);
    assert.equal(verifyCalls, 1);

    // 没变 -> 跳过，且**没有**调用 runVerify（这就是"便宜优先"）
    const second = await watchOnce({ root, extraFiles: extra, runVerify });
    assert.equal(second.action, 'SKIP');
    assert.equal(second.reason, 'fingerprint_unchanged');
    assert.equal(verifyCalls, 1, '没变化时绝不许跑门禁');
    assert.equal(second.total_runs, 1);
    assert.equal(second.total_checks, 2);
    assert.equal(second.fingerprint, first.fingerprint);

    // 变了 -> 再跑
    writeFile(path.join(root, 'a.js'), 'export const a = 2;\n');
    const third = await watchOnce({ root, extraFiles: extra, runVerify });
    assert.equal(third.action, 'RAN');
    assert.equal(verifyCalls, 2);
    assert.notEqual(third.fingerprint, first.fingerprint);
    assert.equal(third.total_runs, 2);
  } finally {
    rmrf(root);
  }
});

test('§15-D: 冷却窗口 + force 覆盖；零覆盖会被如实标出来', async () => {
  const root = makeWs();
  try {
    let clock = 1_000_000;
    const now = () => clock;
    let calls = 0;
    const runVerify = async () => {
      calls++;
      return { verdict_status: 'PASS' };
    };

    const a = await watchOnce({ root, extraFiles: extra, runVerify, cooldownMs: 10_000, now });
    assert.equal(a.action, 'RAN');

    writeFile(path.join(root, 'a.js'), 'export const a = 3;\n');
    clock += 1_000;
    const b = await watchOnce({ root, extraFiles: extra, runVerify, cooldownMs: 10_000, now });
    assert.equal(b.action, 'SKIP');
    assert.equal(b.reason, 'cooldown');
    assert.equal(b.remaining_ms, 9_000);
    assert.equal(calls, 1, '冷却期内不许再跑');

    clock += 10_000;
    const c = await watchOnce({ root, extraFiles: extra, runVerify, cooldownMs: 10_000, now });
    assert.equal(c.action, 'RAN');
    assert.equal(calls, 2);

    const forced = await watchOnce({ root, extraFiles: extra, runVerify, force: true, now });
    assert.equal(forced.action, 'RAN');
    assert.equal(forced.reason, 'forced');
    assert.equal(calls, 3);

    // 不给 extraFiles 又不带 git -> 零覆盖，必须标出来
    const bare = await watchOnce({ root, runVerify, force: true, now });
    assert.equal(bare.coverage, 0);
    assert.equal(bare.degraded, true);
  } finally {
    rmrf(root);
  }
});

test('§19-A: 单实例锁 —— 活锁拒绝、陈旧锁自愈、释放后可再取', () => {
  const root = makeWs();
  try {
    const { lock: lockFile } = watchPaths({ root });
    const t0 = 5_000_000;

    const first = acquireLock({ lockFile, now: t0 });
    assert.equal(first.ok, true);
    assert.equal(readLock({ lockFile }).owner.pid, process.pid);

    const second = acquireLock({ lockFile, now: t0 + 1000, staleMs: 60_000 });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'held_by_live_instance');

    // 超期 -> 判为陈旧，清理后继续，并记录"清过陈旧锁"
    const third = acquireLock({ lockFile, now: t0 + DEFAULT_STALE_LOCK_MS + 1, staleMs: DEFAULT_STALE_LOCK_MS });
    assert.equal(third.ok, true);
    assert.ok(third.stale_cleared, '必须留下"清理过陈旧锁"的痕迹');
    assert.equal(third.stale_cleared.previous.owner.pid, process.pid);

    assert.equal(releaseLock({ lockFile }), true);
    assert.equal(readLock({ lockFile }), null);
    assert.equal(releaseLock({ lockFile }), false, '重复释放返回 false，不报错');
    assert.equal(acquireLock({ lockFile, now: t0 }).ok, true);
  } finally {
    rmrf(root);
  }
});

test('§15-E: 停止哨兵 —— 请求/检测/清除', () => {
  const root = makeWs();
  try {
    const { stop: stopFile } = watchPaths({ root });
    assert.equal(shouldStop({ stopFile }), false);
    requestStop({ stopFile, reason: 'test' });
    assert.equal(shouldStop({ stopFile }), true);
    assert.equal(JSON.parse(fs.readFileSync(stopFile, 'utf8')).reason, 'test');
    clearStop({ stopFile });
    assert.equal(shouldStop({ stopFile }), false);
  } finally {
    rmrf(root);
  }
});

test('§15-F: 轮询模式 —— 取锁、跑到上限、必定释放锁；锁被占时拒绝启动', async () => {
  const root = makeWs();
  try {
    let calls = 0;
    const runVerify = async () => {
      calls++;
      return { verdict_status: 'PASS' };
    };
    const sleep = async () => {};

    const loop = await watchLoop({ root, extraFiles: extra, runVerify, maxIterations: 4, intervalMs: 0, sleep });
    assert.equal(loop.ok, true);
    assert.equal(loop.iterations, 4);
    assert.equal(loop.ran, 1, '只有第一次指纹变化会跑');
    assert.equal(loop.skipped, 3);
    assert.equal(calls, 1);
    assert.equal(loop.stopped, 'max_iterations');
    assert.equal(readLock({ lockFile: loop.files.lock }), null, '无论怎么退出都必须释放锁');

    const { lock: lockFile } = watchPaths({ root });
    acquireLock({ lockFile, now: Date.now() });
    const blocked = await watchLoop({ root, maxIterations: 1, sleep });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, 'held_by_live_instance');
    releaseLock({ lockFile });
  } finally {
    rmrf(root);
  }
});

test('§15-G: 停止哨兵能在循环中途叫停；ledger 有记录；只读状态可查', async () => {
  const dir = makeTempDir('watch-led-');
  const root = makeWs();
  try {
    const ledger = new Ledger(path.join(dir, 'events.jsonl'));
    const files = watchPaths({ root });
    let n = 0;
    const sleep = async () => {
      n++;
      if (n === 2) requestStop({ stopFile: files.stop, reason: 'test-stop' });
    };

    const loop = await watchLoop({
      root,
      extraFiles: extra,
      runVerify: async () => ({ verdict_status: 'PASS' }),
      ledger,
      maxIterations: 10,
      intervalMs: 0,
      sleep,
    });
    assert.equal(loop.stopped, 'stop_sentinel');
    assert.ok(loop.iterations < 10);
    assert.ok(ledger.readAll().events.some((e) => e.type === 'PASS' && String(e.detail).startsWith('watch:')));

    clearStop({ stopFile: files.stop });
    const st = readWatchStatus({ root });
    assert.equal(st.files.state, files.state);
    assert.equal(st.stop_requested, false);
    assert.equal(st.state.total_runs, 1);
    assert.equal(DEFAULT_INTERVAL_MS, 5000);
  } finally {
    rmrf(root);
    rmrf(dir);
  }
});

test('§15-H: verify 抛错也不会把 watcher 打死，错误被如实记下', async () => {
  const root = makeWs();
  try {
    const r = await watchOnce({
      root,
      extraFiles: extra,
      runVerify: async () => {
        throw new Error('verify exploded');
      },
    });
    assert.equal(r.action, 'RAN');
    assert.equal(r.error, 'verify exploded');
    assert.equal(r.last_result, null);

    const st = readWatchStatus({ root });
    assert.equal(st.status.error, 'verify exploded');
  } finally {
    rmrf(root);
  }
});

test('§15-I: 参数校验', async () => {
  await assert.rejects(() => watchOnce({}), /root is required/);
});
