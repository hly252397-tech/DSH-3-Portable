import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 所有测试统一在 AGENTOS_TEST_TMP 下建目录，退出时由调用方清理。 */
export function makeTempDir(prefix = 'case-') {
  const base = process.env.AGENTOS_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

export function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

export function makeWorkspace(extraFiles = {}) {
  const dir = makeTempDir('ws-');
  for (const [rel, content] of Object.entries(extraFiles)) writeFile(path.join(dir, rel), content);
  return dir;
}

export function initAgentTree() {
  const root = makeTempDir('agentos-');
  // 与任务单第五节的目录树对齐（之前缺 tasks/*，导致"终态任务归位"这类测试没法做）
  const dirs = [
    'tasks/active',
    'tasks/completed',
    'tasks/failed',
    'candidates/active',
    'candidates/rejected',
    'candidates/promoted',
    'verdicts',
    'events',
    'incidents',
    'checkpoints',
    'workspaces',
    'processes',
    'logs',
    'memory/episodic',
    'memory/semantic',
    'memory/procedural',
    'memory/self-model',
    'memory/world-model',
    'memory/project-model',
    'supervisor/stable',
    'supervisor/candidate',
  ];
  for (const rel of dirs) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
  }
  return root;
}

/** 一个「全部退出门条件都满足」的基线状态，便于在单点注入失败。 */
export function cleanExitState(overrides = {}) {
  return {
    pending_items: 0,
    executable_items: 0,
    known_defects: 0,
    new_failures: [],
    unexpected_deltas: [],
    unverified_changes: 0,
    temporary_artifacts: 0,
    failed_gates: 0,
    unconsumed_critical_events: 0,
    incomplete_acceptance_items: 0,
    workspace_dirty: false,
    parent_task_stack_empty: true,
    current_fingerprint: 'F',
    last_pass_fingerprint: 'F',
    ...overrides,
  };
}
