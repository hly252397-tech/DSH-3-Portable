// 验收测试 10 / 13 —— Tool / Process Broker 路径与进程策略（任务单第四、十九、二十八节）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { evaluatePathPolicy, evaluateProcessStop, FORBIDDEN_STOP_STRATEGIES, STOP_PRIORITY } from '../lib/broker.mjs';

test('T13: 系统盘写入被拦截并重定向到便携盘', () => {
  const portable = 'G:\\DSH-3-Portable';
  const r = evaluatePathPolicy({ target: 'C:\\Users\\someone\\AppData\\Roaming\\x\\config.json', portableRoot: portable, mode: 'write' });

  assert.equal(r.allowed, false);
  assert.equal(r.code, 'SYSTEM_DISK_WRITE_DENIED');
  assert.equal(r.out_of_portable_root, true);
  assert.equal(r.drive, 'C:\\');
  assert.ok(r.redirect_to && r.redirect_to.startsWith(portable));
  assert.ok(r.forbidden_categories.includes('modify_registry'));
  assert.ok(r.forbidden_categories.includes('create_scheduled_task'));
});

test('T13b: 便携盘内写入放行；系统盘读取/执行放行', () => {
  const portable = 'G:\\DSH-3-Portable';

  const inside = evaluatePathPolicy({ target: path.join(portable, 'AgentOS', 'events', 'e.jsonl'), portableRoot: portable, mode: 'write' });
  assert.equal(inside.allowed, true);
  assert.equal(inside.code, 'OK');

  const readSystem = evaluatePathPolicy({ target: 'C:\\Windows\\System32\\cmd.exe', portableRoot: portable, mode: 'read' });
  assert.equal(readSystem.allowed, true);

  const execSystem = evaluatePathPolicy({ target: 'C:\\Program Files\\Git\\cmd\\git.exe', portableRoot: portable, mode: 'execute' });
  assert.equal(execSystem.allowed, true);
});

test('T13c: 写便携盘根本身放行（不是「必须在子目录」）', () => {
  const portable = 'G:\\DSH-3-Portable';
  const r = evaluatePathPolicy({ target: portable, portableRoot: portable, mode: 'write' });
  assert.equal(r.allowed, true);
});

test('T10: 模糊/按名称杀 Node 被拒绝', () => {
  const owned = [{ pid: 41396, owner_task_id: 'task-A', command_hash: 'abc' }];

  const fuzzy = evaluateProcessStop({ target: { strategy: 'by_name', name: 'node.exe' }, ownedProcesses: owned });
  assert.equal(fuzzy.allowed, false);
  assert.ok(fuzzy.reasons.includes('forbidden_strategy:by_name'));
  assert.ok(fuzzy.reasons.includes('strategy_not_in_priority_list'));

  const pattern = evaluateProcessStop({ target: { strategy: 'commandline_pattern', pattern: 'node' }, ownedProcesses: owned });
  assert.equal(pattern.allowed, false);

  const bulk = evaluateProcessStop({ target: { strategy: 'bulk_stop_process' }, ownedProcesses: owned });
  assert.equal(bulk.allowed, false);

  // 只给名字、不给 pid -> 推导成 by_name，同样拒绝
  const nameOnly = evaluateProcessStop({ target: { name: 'node.exe' }, ownedProcesses: owned });
  assert.equal(nameOnly.allowed, false);
  assert.equal(nameOnly.chosen_strategy, null);
});

test('T10b: 精确 PID 且 owner 对得上才放行；owner 不对/pid 不属于本任务都拒绝', () => {
  const owned = [{ pid: 41396, owner_task_id: 'task-A' }];

  const ok = evaluateProcessStop({ target: { strategy: 'exact_pid', pid: 41396, owner_task_id: 'task-A' }, ownedProcesses: owned });
  assert.equal(ok.allowed, true);
  assert.equal(ok.chosen_strategy, 'exact_pid');

  const foreign = evaluateProcessStop({ target: { strategy: 'exact_pid', pid: 41396, owner_task_id: 'task-B' }, ownedProcesses: owned });
  assert.equal(foreign.allowed, false);
  assert.ok(foreign.reasons.includes('pid_not_owned_by_current_task'));

  const unknownPid = evaluateProcessStop({ target: { strategy: 'exact_pid', pid: 99999 }, ownedProcesses: owned });
  assert.equal(unknownPid.allowed, false);
});

test('T10c: 停止优先级与禁用方式被显式导出（防止有人「顺手」加回来）', () => {
  assert.deepEqual([...STOP_PRIORITY], ['host_job_id', 'child_process_handle', 'exact_pid', 'local_ipc', 'stop_sentinel']);
  for (const f of ['by_name', 'fuzzy', 'commandline_pattern', 'bulk_stop_process']) {
    assert.ok(FORBIDDEN_STOP_STRATEGIES.includes(f), f + ' 必须在禁用清单里');
  }
});
