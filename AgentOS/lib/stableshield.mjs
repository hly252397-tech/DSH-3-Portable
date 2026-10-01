// Stable Shield —— 把「Stable 永不直接修改」从**口头纪律**变成**机器防线**。
//
// 目标里最硬的一条约束是：Stable 永不直接修改。但在本轮之前，没有任何机制真的拦住
// 往活动运行时槽 / 桌面候选槽写文件——全靠人记得。这不是防线，是运气。
//
// 保护面（可搬移：全部相对便携盘根）：
//   Data/Updates/Desktop/slots/**        桌面 A/B 候选槽（不可变制品，禁止原地覆盖）
//   Data/Updates/Desktop/state.json      桌面部署指针
//   Data/Runtime/Harness/slots/**        DSH 运行时槽（不可变制品）
//   Data/Runtime/Harness/current.json    运行时当前槽指针
//   Data/Runtime/Harness/current/**      运行时当前槽目录
//   Data/Electron/UserData|SessionData   桌面运行时/会话状态（宿主所有）
// 注意：Data/DSH/profiles/web **不在**保护面内 —— 本地插件就该在那里改动。
import fs from 'node:fs';
import path from 'node:path';
import { realpathOf, isUnderOrEqual, readJsonIfExists, nowIso } from './paths.mjs';

export const STABLE_SURFACES = Object.freeze([
  { id: 'desktop_slots', rel: 'Data/Updates/Desktop/slots', kind: 'immutable_slot', note: '桌面 A/B 候选槽，不可变制品' },
  { id: 'desktop_state', rel: 'Data/Updates/Desktop/state.json', kind: 'pointer', note: '桌面部署指针' },
  { id: 'harness_slots', rel: 'Data/Runtime/Harness/slots', kind: 'immutable_slot', note: 'DSH 运行时槽，不可变制品' },
  { id: 'harness_current', rel: 'Data/Runtime/Harness/current.json', kind: 'pointer', note: '运行时当前槽指针' },
  { id: 'harness_current_dir', rel: 'Data/Runtime/Harness/current', kind: 'pointer', note: '运行时当前槽目录' },
  { id: 'electron_userdata', rel: 'Data/Electron/UserData', kind: 'runtime_state', note: '桌面运行时状态（宿主所有）' },
  { id: 'electron_sessiondata', rel: 'Data/Electron/SessionData', kind: 'runtime_state', note: '桌面会话状态（宿主所有）' },
]);

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 解析当前真实 Stable 面：哪些路径受保护、活动槽是哪一个、活动槽是怎么解析出来的。
 * 指针缺失时**显式降级**到"最新槽"，并把来源写清楚，不假装知道。
 */
export function resolveLiveStable({ portableRoot } = {}) {
  if (!portableRoot) throw new Error('resolveLiveStable: portableRoot is required');
  const root = path.resolve(portableRoot);

  const protectedPaths = STABLE_SURFACES.map((s) => {
    const p = path.join(root, s.rel);
    return { ...s, path: p, exists: fs.existsSync(p) };
  });

  const harnessCurrent = readJsonIfExists(path.join(root, 'Data/Runtime/Harness/current.json'));
  const desktopState = readJsonIfExists(path.join(root, 'Data/Updates/Desktop/state.json'));

  const harnessSlots = listDirs(path.join(root, 'Data/Runtime/Harness/slots'));
  const desktopSlots = listDirs(path.join(root, 'Data/Updates/Desktop/slots'));

  const activeHarnessRel = harnessCurrent?.current?.relativePath ?? null;
  const activeHarnessSlot = activeHarnessRel
    ? path.basename(String(activeHarnessRel))
    : harnessSlots.at(-1) ?? null;

  const desktopVersion = desktopState?.currentVersion ?? null;
  // state.json 只有 currentVersion（如 "1.0.66"），同一版本可能有多个候选槽。
  // 匹配到多个时**不猜**：如实报歧义。注意保护面覆盖**所有**槽，
  // 所以这里的歧义只影响"哪个是活动的"，永远不会导致漏保护。
  const desktopMatches = desktopVersion ? desktopSlots.filter((s) => s.startsWith(String(desktopVersion) + '-')) : [];
  const activeDesktopSlot = desktopMatches.length === 1 ? desktopMatches[0] : null;
  const desktopFrom =
    desktopMatches.length === 1
      ? 'state.json'
      : desktopMatches.length > 1
        ? 'ambiguous_version_prefix'
        : desktopSlots.length
          ? 'unknown_fallback'
          : 'none';

  return {
    schema_version: 1,
    resolved_at: nowIso(),
    portable_root: root,
    protectedPaths,
    harness: {
      slots: harnessSlots,
      active_slot: activeHarnessSlot,
      pointer: harnessCurrent?.current ?? null,
      pointer_resolved_from: activeHarnessRel ? 'current.json' : harnessSlots.length ? 'newest_slot_fallback' : 'none',
    },
    desktop: {
      slots: desktopSlots,
      active_slot: activeDesktopSlot,
      ambiguous_slots: desktopMatches.length > 1 ? desktopMatches : [],
      current_version: desktopVersion,
      pointer_resolved_from: desktopFrom,
    },
  };
}

/** 目标是否落在受保护面上（按**真实路径**判定，符号链接/Junction 逃逸也拦得住）。 */
export function isProtectedPath({ target, liveStable } = {}) {
  if (!target || !liveStable) return { protected: false, reason: 'insufficient_input' };
  const real = realpathOf(target);
  for (const p of liveStable.protectedPaths) {
    if (isUnderOrEqual(real, p.path)) {
      return {
        protected: true,
        id: p.id,
        kind: p.kind,
        root: p.path,
        note: p.note,
        target: path.resolve(target),
        real,
        reason: `写入落在 ${p.id}（${p.kind}）内`,
      };
    }
  }
  return { protected: false, target: path.resolve(target), real };
}

/** 便利：直接产出 FileBroker 可用的 forbiddenRoots，杜绝"忘了传"。 */
export function stableForbiddenRoots({ portableRoot } = {}) {
  const live = resolveLiveStable({ portableRoot });
  return { live, forbiddenRoots: live.protectedPaths.map((p) => p.path) };
}

export function assertNotStable({ target, liveStable } = {}) {
  const r = isProtectedPath({ target, liveStable });
  if (r.protected) {
    const e = new Error(`STABLE_IMMUTABLE: 拒绝写入 ${r.id}（${r.kind}）-> ${r.target}`);
    e.code = 'STABLE_IMMUTABLE';
    e.detail = r;
    throw e;
  }
  return true;
}

/** 人读摘要：CLI 与文档用。 */
export function describeStableShield({ portableRoot } = {}) {
  const live = resolveLiveStable({ portableRoot });
  return {
    portable_root: live.portable_root,
    protected: live.protectedPaths.map((p) => ({ id: p.id, kind: p.kind, rel: p.rel, exists: p.exists })),
    harness: live.harness,
    desktop: live.desktop,
    explicitly_not_protected: ['Data/DSH/profiles/web（本地插件就该在这里改）'],
  };
}
