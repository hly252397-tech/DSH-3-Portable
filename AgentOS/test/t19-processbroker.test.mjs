// 验收测试 10（系统级）—— Process Broker：真停止器 + 只停有明确 owner 的精确 PID
// 任务单第十九节 + 第二十八节测试 10
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempDir, rmrf, writeFile } from './helpers.mjs';
import {
  registryFile,
  registerProcess,
  spawnTracked,
  listRegistered,
  stopProcess,
  isAlive,
  processBrokerStatus,
  reconcile,
} from '../lib/processbroker.mjs';

/** 起一个什么都不干的子进程，60 秒后自己退出（够测试用）。 */
function spawnIdle(root, owner = 'T-proc') {
  return spawnTracked({
    root,
    owner_task_id: owner,
    file: process.execPath,
    args: ['-e', 'setTimeout(()=>{}, 60000)'],
    command: 'node -e setIdle',
  });
}

/** 测试自净：万一断言失败，也不能留孤儿进程。 */
function killQuietly(pid) {
  try {
    if (pid && isAlive(pid)) process.kill(pid, 'SIGTERM');
  } catch {
    /* ignore */
  }
}

function readLines(root) {
  const f = registryFile({ root });
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test('§19-B: spawnTracked 必须登记（process_id/owner/command/hash/start_time/stop_method）', () => {
  const root = makeTempDir('proc-');
  let spawned = null;
  try {
    spawned = spawnIdle(root);
    const rec = spawned.record;
    assert.equal(rec.type, 'PROCESS_REGISTERED');
    assert.equal(rec.pid, spawned.child.pid);
    assert.equal(rec.owner_task_id, 'T-proc');
    assert.equal(rec.started_by_agent, true);
    assert.equal(rec.stop_method, 'child_process_handle');
    assert.ok(rec.command_hash && rec.command_hash.length === 64, 'command 必须留哈希');
    assert.ok(rec.start_time);
    assert.ok(rec.process_id);

    const live = listRegistered({ root });
    assert.equal(live.length, 1);
    assert.equal(live[0].pid, spawned.child.pid);
    assert.equal(live[0].stopped, false);

    assert.throws(() => registerProcess({ root, pid: 1, owner_task_id: null }), /owner_task_id is required/);
    assert.throws(() => registerProcess({ root, owner_task_id: 'T' }), /pid \(or child\) is required/);
  } finally {
    if (spawned) killQuietly(spawned.child.pid);
    rmrf(root);
  }
});

test('§19-C: 真的能停 —— 精确 PID + owner 对得上 -> 进程确实消失', async () => {
  const root = makeTempDir('proc-');
  let spawned = null;
  try {
    spawned = spawnIdle(root, 'T-run');
    const pid = spawned.child.pid;
    assert.equal(isAlive(pid), true);

    const r = await stopProcess({ root, pid, owner_task_id: 'T-run', strategy: 'exact_pid', timeoutMs: 8000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.killed, true);
    assert.equal(r.process_id, spawned.record.process_id);
    assert.equal(isAlive(pid), false, '进程必须真的没了');

    // 历史是 append-only：REQUESTED 与 STOPPED 都在
    const lines = readLines(root);
    const kinds = lines.map((l) => l.type);
    assert.ok(kinds.includes('PROCESS_REGISTERED'));
    assert.ok(kinds.includes('PROCESS_STOP_REQUESTED'));
    assert.ok(kinds.includes('PROCESS_STOPPED'));
    assert.equal(listRegistered({ root }).length, 0, '在册列表里不应再有它');
    assert.equal(listRegistered({ root, includeStopped: true }).length, 1);
  } finally {
    if (spawned) killQuietly(spawned.child.pid);
    rmrf(root);
  }
});

test('§10-A: 按名称查杀被拒绝，且**进程毫发无损**', async () => {
  const root = makeTempDir('proc-');
  let spawned = null;
  try {
    spawned = spawnIdle(root, 'T-victim');
    const pid = spawned.child.pid;

    for (const strategy of ['by_name', 'fuzzy', 'commandline_pattern', 'bulk_stop_process']) {
      const r = await stopProcess({ root, pid, owner_task_id: 'T-victim', strategy });
      assert.equal(r.ok, false, strategy + ' 必须被拒');
      assert.equal(r.stage, 'gate');
      assert.equal(r.killed, false);
      assert.equal(r.chosen_strategy, null);
      assert.ok(r.reasons.some((x) => x.startsWith('forbidden_strategy:')), JSON.stringify(r.reasons));
      assert.equal(isAlive(pid), true, strategy + ' 被拒后进程必须还活着');
    }

    // 拒绝也要留档
    assert.ok(readLines(root).some((l) => l.type === 'PROCESS_STOP_DENIED'));

    // 最后用合法方式收掉，证明这个进程本来就能停
    const ok = await stopProcess({ root, pid, owner_task_id: 'T-victim', strategy: 'exact_pid' });
    assert.equal(ok.ok, true);
  } finally {
    if (spawned) killQuietly(spawned.child.pid);
    rmrf(root);
  }
});

test('§10-B: owner 对不上 / pid 不在册 -> 拒绝且不碰进程', async () => {
  const root = makeTempDir('proc-');
  let spawned = null;
  try {
    spawned = spawnIdle(root, 'T-owner');
    const pid = spawned.child.pid;

    const wrongOwner = await stopProcess({ root, pid, owner_task_id: 'T-someone-else', strategy: 'exact_pid' });
    assert.equal(wrongOwner.ok, false);
    assert.ok(wrongOwner.reasons.includes('pid_not_owned_by_current_task'));
    assert.equal(isAlive(pid), true, 'owner 不匹配时绝不许动进程');

    const unknownPid = await stopProcess({ root, pid: 999999, owner_task_id: 'T-owner', strategy: 'exact_pid' });
    assert.equal(unknownPid.ok, false);
    assert.ok(unknownPid.reasons.includes('pid_not_owned_by_current_task'));
    assert.equal(isAlive(pid), true);
  } finally {
    if (spawned) killQuietly(spawned.child.pid);
    rmrf(root);
  }
});

test('§19-D: 状态视图 + 死条目对账（只留档，不删历史）', async () => {
  const root = makeTempDir('proc-');
  let spawned = null;
  try {
    spawned = spawnIdle(root, 'T-view');
    const pid = spawned.child.pid;

    let st = processBrokerStatus({ root, owner_task_id: 'T-view' });
    assert.equal(st.alive.length, 1);
    assert.equal(st.alive[0].alive, true);
    assert.deepEqual(st.dead_but_registered, []);
    assert.deepEqual(st.stop_priority, ['host_job_id', 'child_process_handle', 'exact_pid', 'local_ipc', 'stop_sentinel']);
    assert.ok(st.forbidden_strategies.includes('by_name'));

    await stopProcess({ root, pid, owner_task_id: 'T-view' });
    st = processBrokerStatus({ root, owner_task_id: 'T-view' });
    assert.equal(st.alive.length, 0);

    // 造一个"登记了但已经死了"的条目
    registerProcess({ root, pid: 999998, owner_task_id: 'T-view', command: 'ghost' });
    st = processBrokerStatus({ root, owner_task_id: 'T-view' });
    assert.equal(st.dead_but_registered.length, 1);

    const rec = reconcile({ root });
    assert.equal(rec.reconciled.length, 1);
    assert.ok(readLines(root).some((l) => l.type === 'PROCESS_RECONCILED'));
    assert.equal(listRegistered({ root }).length, 0, '对账后在册列表清空（历史仍在文件里）');
  } finally {
    if (spawned) killQuietly(spawned.child.pid);
    rmrf(root);
  }
});

test('§19-E: 登记表 append-only；**已停止的 PID 不再允许动手**（防 PID 回收误杀）', async () => {
  const root = makeTempDir('proc-');
  let spawned = null;
  try {
    spawned = spawnIdle(root, 'T-hist');
    const file = registryFile({ root });
    const first = await stopProcess({ root, pid: spawned.child.pid, owner_task_id: 'T-hist' });
    assert.equal(first.killed, true);
    assert.equal(first.was_alive_before, true);

    const before = fs.readFileSync(file, 'utf8');
    const lineCount = before.split('\n').filter((l) => l.trim()).length;
    assert.ok(lineCount >= 3);

    // 第二次：它已经不在册 -> 门禁拒绝。这是**安全优先**：
    // 已停止的 PID 可能被系统回收给别的进程，再对它动手就可能误杀。
    const second = await stopProcess({ root, pid: spawned.child.pid, owner_task_id: 'T-hist' });
    assert.equal(second.ok, false);
    assert.equal(second.stage, 'gate');
    assert.equal(second.killed, false);
    assert.ok(second.reasons.includes('pid_not_owned_by_current_task'));

    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.startsWith(before), '历史必须原样保留在前面');
    assert.ok(after.split('\n').filter((l) => l.trim()).length > lineCount, '拒绝也要留档');
    assert.ok(after.includes('PROCESS_STOP_DENIED'));
  } finally {
    if (spawned) killQuietly(spawned.child.pid);
    rmrf(root);
  }
});

test('§19-H: 自己死掉但仍在册的进程 -> 目标达成 ok=true，但**不谎报是我杀的**', async () => {
  const root = makeTempDir('proc-');
  try {
    // 起一个立刻退出的进程
    const { child, record } = spawnTracked({
      root,
      owner_task_id: 'T-selfdie',
      file: process.execPath,
      args: ['-e', 'process.exit(0)'],
      command: 'node -e exit0',
    });
    await new Promise((resolve) => {
      child.on('exit', resolve);
      child.on('error', resolve);
      setTimeout(resolve, 3000);
    });
    assert.equal(isAlive(child.pid), false, '它应当已经自己退出了');
    assert.equal(listRegistered({ root, owner_task_id: 'T-selfdie' }).length, 1, '仍在册（没人停过它）');

    const r = await stopProcess({ root, pid: child.pid, owner_task_id: 'T-selfdie', timeoutMs: 2000 });
    assert.equal(r.ok, true, '目标状态是"它不在"');
    assert.equal(r.was_alive_before, false);
    assert.equal(r.already_dead, true);
    assert.equal(r.killed, false, '本来就死的进程绝不能算我停掉的');
    assert.equal(r.process_id, record.process_id);
  } finally {
    rmrf(root);
  }
});

test('§19-G: unref 起的后台进程必须在**父进程退出后仍存活**（必须 detached）', async () => {
  const root = makeTempDir('proc-');
  const pidFile = path.join(root, 'grandchild.pid');
  const launcher = path.join(root, 'launcher.mjs');
  let pid = null;
  try {
    const libUrl = new URL('../lib/processbroker.mjs', import.meta.url).href;
    writeFile(
      launcher,
      [
        `import { spawnTracked } from ${JSON.stringify(libUrl)};`,
        `import fs from 'node:fs';`,
        `const { child } = spawnTracked({`,
        `  root: ${JSON.stringify(root)},`,
        `  owner_task_id: 'T-survive',`,
        `  file: process.execPath,`,
        `  args: ['-e', 'setTimeout(()=>{}, 30000)'],`,
        `  unref: true,`,
        `});`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      ].join('\n'),
    );

    // 启动器跑完就退出；它起的后台进程应当活下来
    await new Promise((resolve) => {
      const p = spawn(process.execPath, [launcher], { stdio: 'ignore', windowsHide: true });
      p.on('exit', resolve);
      p.on('error', resolve);
    });

    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0, '启动器必须把 pid 写出来');
    assert.equal(isAlive(pid), true, '父进程退出后该进程必须还活着（只 unref 不 detached 会死，实测过）');

    // 它也应登记在册，并可用精确 PID 合法停掉
    const rows = listRegistered({ root, owner_task_id: 'T-survive' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pid, pid);
    assert.equal(rows[0].stop_method, 'exact_pid', 'unref 后没有 handle，停止方式必须如实记为 exact_pid');

    const r = await stopProcess({ root, pid, owner_task_id: 'T-survive' });
    assert.equal(r.ok, true);
    assert.equal(r.killed, true);
    pid = null;
  } finally {
    if (pid) killQuietly(pid);
    rmrf(root);
  }
});

test('§19-F: 参数校验', async () => {
  const root = makeTempDir('proc-');
  try {
    await assert.rejects(() => stopProcess({ pid: 1 }), /root is required/);
    await assert.rejects(() => stopProcess({ root }), /pid is required/);
  } finally {
    rmrf(root);
  }
});
