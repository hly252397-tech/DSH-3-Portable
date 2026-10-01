// Tool / Process Broker 的最小路径与进程策略 —— 任务单第四节与第十九节。
// 覆盖验收测试 13（系统盘写入被拦截并重定向）与 10（模糊查杀 Node 被拒绝）。
import path from 'node:path';

/** 第四节：系统盘禁止的写入类别。 */
export const SYSTEM_WRITE_FORBIDDEN = Object.freeze([
  'persist_project_files',
  'write_config',
  'write_cache',
  'install_global_dependency',
  'modify_registry',
  'modify_system_env',
  'create_scheduled_task',
  'elevate',
  'modify_security_settings',
]);

function norm(p) {
  return path.resolve(p).split(path.sep).join('/').toLowerCase();
}

/**
 * 路径策略。
 * @param {object} o
 * @param {string} o.target
 * @param {string} o.portableRoot     便携盘根（允许读写）
 * @param {'read'|'write'|'execute'} o.mode
 */
export function evaluatePathPolicy({ target, portableRoot, mode = 'write' } = {}) {
  if (!target) return { allowed: false, code: 'NO_TARGET', reason: 'target_required' };
  const abs = path.resolve(target);
  const rootN = norm(portableRoot || '');
  const absN = norm(abs);
  const inPortable = rootN && (absN === rootN || absN.startsWith(rootN + '/'));

  if (mode === 'read' || mode === 'execute') {
    return { allowed: true, code: 'OK', mode, in_portable: inPortable, target: abs };
  }
  if (inPortable) return { allowed: true, code: 'OK', mode: 'write', target: abs, in_portable: true };

  // 系统盘写入 -> 拦截并重定向到便携盘（第四节：启动 Agent 时重定向 HOME/TEMP/... 全部指向便携盘）
  const drive = path.parse(abs).root;
  const redirected = path.join(portableRoot || '', 'temp', 'redirected', abs.replace(/[:\\/]/g, '_'));
  return {
    allowed: false,
    code: 'SYSTEM_DISK_WRITE_DENIED',
    mode: 'write',
    target: abs,
    out_of_portable_root: true,
    drive,
    forbidden_categories: SYSTEM_WRITE_FORBIDDEN,
    redirect_to: redirected,
    reason: 'writes must stay on the portable drive; redirect instead of touching the system drive',
  };
}

/** 第十九节：停止优先级。 */
export const STOP_PRIORITY = Object.freeze([
  'host_job_id',
  'child_process_handle',
  'exact_pid',
  'local_ipc',
  'stop_sentinel',
]);

/** 第十九节：明确禁止的停止方式。 */
export const FORBIDDEN_STOP_STRATEGIES = Object.freeze([
  'by_name',
  'fuzzy',
  'commandline_pattern',
  'bulk_stop_process',
]);

/**
 * 进程停止策略判定。
 * @param {object} o
 * @param {object} o.target  { strategy, pid, name, pattern, owner_task_id }
 * @param {Array}  o.ownedProcesses [{ pid, owner_task_id, command_hash }]
 */
export function evaluateProcessStop({ target = {}, ownedProcesses = [] } = {}) {
  const reasons = [];
  const strategy = target.strategy || (target.pid ? 'exact_pid' : target.name || target.pattern ? 'by_name' : 'unknown');

  if (FORBIDDEN_STOP_STRATEGIES.includes(strategy)) reasons.push('forbidden_strategy:' + strategy);
  if (strategy === 'unknown') reasons.push('unknown_strategy');
  if (!STOP_PRIORITY.includes(strategy)) reasons.push('strategy_not_in_priority_list');

  if (strategy === 'exact_pid') {
    const owned = ownedProcesses.find(
      (p) => p.pid === target.pid && (!target.owner_task_id || p.owner_task_id === target.owner_task_id),
    );
    if (!owned) reasons.push('pid_not_owned_by_current_task');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    chosen_strategy: STOP_PRIORITY.includes(strategy) ? strategy : null,
    forbidden_strategies: FORBIDDEN_STOP_STRATEGIES,
    note: '禁止按名称/模糊命令行批量杀进程；只能停止有明确 owner 的进程',
  };
}
