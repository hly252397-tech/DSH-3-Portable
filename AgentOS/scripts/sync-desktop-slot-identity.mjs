#!/usr/bin/env node
// 桌面槽身份同步器
// 背景：Data/Updates/Desktop/state.json 的 currentVersion 是【应用版本】(app.getVersion())，
//       由 src/portable-desktop-update.ts::sanitizePortableDesktopUpdateState 用 exactVersion() 校验，
//       且 sanitize 只产出固定字段 —— 所以槽 ID 不能放进 currentVersion（会被回退），
//       加进去的自定义字段也会在下次 state 写入时被丢弃。
// 因此：槽身份的唯一权威是 pointer.json（current/previous），state.json 里只做【附加、尽力而为】的镜像。
// 本脚本负责：按 pointer.json 重新断言 state.json.currentSlotId，并支持 --check 检测漂移。
// 用法：node AgentOS/scripts/sync-desktop-slot-identity.mjs [--check] [--root <便携根>]
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const rootArgIdx = argv.indexOf('--root');
const PORTABLE = rootArgIdx >= 0 && argv[rootArgIdx + 1] ? path.resolve(argv[rootArgIdx + 1]) : path.resolve(import.meta.dirname, '..', '..');

const pointerPath = path.join(PORTABLE, 'Data', 'Updates', 'Desktop', 'pointer.json');
const statePath = path.join(PORTABLE, 'Data', 'Updates', 'Desktop', 'state.json');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

if (!existsSync(pointerPath)) {
  console.error(`SYNC: 找不到 ${pointerPath}`);
  process.exit(2);
}
const pointer = readJson(pointerPath);
// pointer.current / previous 是对象：{relativePath, version, sha256, transactionId}
// 槽 ID 取 relativePath 的 basename（与 slot-registry.mjs 口径一致）。
const slotIdOf = (p) =>
  p == null ? null : typeof p === 'string' ? p : p.relativePath ? path.basename(p.relativePath) : (p.slotId ?? null);
const slotId = slotIdOf(pointer.current);
const previousSlotId = slotIdOf(pointer.previous);
if (!slotId) {
  console.error('SYNC: pointer.json 缺 current（无法断言槽身份）');
  process.exit(2);
}

const before = existsSync(statePath) ? readJson(statePath) : {};
const drift = before.currentSlotId !== slotId;

console.log(`SYNC pointer.current = ${slotId}`);
console.log(`SYNC state.before    = ${before.currentSlotId ?? '(缺失)'}`);
console.log(`SYNC drift           = ${drift ? 'YES' : 'no'}`);

if (CHECK) {
  const ok = !drift && before.schema === 1;
  console.log(`SYNC ${ok ? 'PASS' : 'FAIL'} (--check 不写入)`);
  process.exit(ok ? 0 : 1);
}

if (!drift && before.currentSlotIdSource) {
  console.log('SYNC noop：state.json 已与 pointer.json 一致');
  process.exit(0);
}

const next = {
  schema: before.schema ?? 1,
  phase: before.phase ?? 'none',
  currentVersion: before.currentVersion,
  updatedAt: before.updatedAt,
  overallProgress: before.overallProgress,
  stageProgress: before.stageProgress,
  detail: before.detail,
  lastCheckedAt: before.lastCheckedAt,
  // ↓ 附加镜像字段（非 schema 字段；更新器下次写 state 时可能丢弃，届时重跑本脚本即可）
  currentSlotId: slotId,
  previousSlotId,
  currentSlotIdSource: 'pointer.json',
  currentSlotIdWrittenAt: new Date().toISOString(),
};
for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];

const tmp = `${statePath}.tmp`;
writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
renameSync(tmp, statePath);

const after = readJson(statePath);
if (after.currentSlotId !== slotId) {
  console.error('SYNC FAIL：写入后校验不一致');
  process.exit(1);
}
console.log(`SYNC state.after     = ${after.currentSlotId} (previous=${after.previousSlotId ?? 'null'})`);
console.log('SYNC PASS：currentSlotId 已与 pointer.json 对齐');