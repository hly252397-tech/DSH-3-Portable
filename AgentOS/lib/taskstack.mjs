// Parent / Child Task Stack —— 任务单第八节。
//
// 流程：父任务暂停 -> 保存 resume_point -> 创建修复子任务 -> 执行 -> 验证 -> 子任务通过
//       -> **自动**恢复父任务 -> 从 resume_point 继续。不得等待用户发送"继续"。
import { nowIso } from './paths.mjs';

export const FRAME_STATES = Object.freeze(['EXECUTING', 'PAUSED', 'RESUMING_PARENT', 'FAILED_EXHAUSTED', 'RECOVERING']);

export function createStack() {
  return { schema_version: 1, frames: [] };
}

export function topFrame(stack) {
  return stack && stack.frames && stack.frames.length ? stack.frames[stack.frames.length - 1] : null;
}

export function isStackEmpty(stack) {
  return !stack || !stack.frames || stack.frames.length === 0;
}

export function depth(stack) {
  return stack && stack.frames ? stack.frames.length : 0;
}

export function pushTask(stack, task) {
  const parent = topFrame(stack);
  const frame = {
    task_id: task.id,
    state: 'EXECUTING',
    resume_point: null,
    parent_task_id: parent ? parent.task_id : null,
    children_completed: [],
    pushed_at: nowIso(),
  };
  stack.frames.push(frame);
  return frame;
}

/** 发现阻塞问题：父任务暂停 + 保存 resume_point + 压入修复子任务。 */
export function suspendForChild(stack, { resume_point, childTask }) {
  const parent = topFrame(stack);
  if (!parent) return { ok: false, error: 'no_parent_frame' };
  if (!resume_point) return { ok: false, error: 'resume_point_required' };
  if (!childTask || !childTask.id) return { ok: false, error: 'child_task_required' };

  parent.state = 'PAUSED';
  parent.resume_point = resume_point;
  parent.paused_at = nowIso();

  const child = {
    task_id: childTask.id,
    state: 'EXECUTING',
    resume_point: null,
    parent_task_id: parent.task_id,
    children_completed: [],
    pushed_at: nowIso(),
  };
  stack.frames.push(child);
  return { ok: true, parent, child, resume_point };
}

/**
 * 子任务结束。通过 -> 父任务自动 RESUMING_PARENT 并从 resume_point 继续。
 * 不通过 -> 父任务保持 PAUSED，且必须开新子任务（next_action），**不许等用户**。
 */
export function completeChild(stack, { childTaskId = null, passed, evidence = [] } = {}) {
  const child = topFrame(stack);
  if (!child) return { ok: false, error: 'no_child_frame' };
  if (childTaskId && child.task_id !== childTaskId) {
    return { ok: false, error: 'not_top_frame', top: child.task_id, expected: childTaskId };
  }
  stack.frames.pop();
  const parent = topFrame(stack);
  if (!parent) return { ok: false, error: 'no_parent_to_resume', orphan_child: child };

  parent.children_completed.push({
    child_task_id: child.task_id,
    passed: passed === true,
    evidence,
    at: nowIso(),
  });

  if (passed === true) {
    parent.state = 'RESUMING_PARENT';
    return { ok: true, resumed: true, parent, resume_point: parent.resume_point, child };
  }
  parent.state = 'PAUSED';
  return { ok: true, resumed: false, parent, child, next_action: 'OPEN_NEW_CHILD', reason: 'child_failed' };
}

/** 恢复点读取：父任务从哪儿继续。 */
export function resumePointOf(stack) {
  const f = topFrame(stack);
  return f ? f.resume_point : null;
}
