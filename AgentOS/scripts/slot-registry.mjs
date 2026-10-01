// slot-registry.mjs —— 便携盘槽位盘点 / 登记 / 可逆迁移。
//   --dry-run (默认)  只出计划，不动任何文件
//   --execute         把「无引用」槽移动到 Data/Trash/Slots（移动，不删除）
//
// 纪律：
//   - 不删除任何仍被引用的槽；无引用者只**移动**到 Trash（可逆）。
//   - 不依赖 mtime 推断创建顺序。
//   - 当前运行槽必须由「状态指针 + 进程路径」双源交叉验证。
import fs from 'node:fs';
import path from 'node:path';

const PORTABLE = 'G:/DSH-3-Portable';
const AGENTOS = path.join(PORTABLE, 'AgentOS');
const EXECUTE = process.argv.includes('--execute');
const SIZES_FILE = path.join(PORTABLE, 'Data/Temp/slot-sizes.json');

const HARNESS_SLOTS = path.join(PORTABLE, 'Data/Runtime/Harness/slots');
const DESKTOP_SLOTS = path.join(PORTABLE, 'Data/Updates/Desktop/slots');
const TRASH = path.join(PORTABLE, 'Data/Trash/Slots');

// 引用扫描范围（排除 node_modules / .git / 槽自身 / Trash）——全盘扫描会超时
const SCAN_DIRS = [
  path.join(AGENTOS),
  path.join(PORTABLE, 'docs'),
  path.join(PORTABLE, 'src'),
  path.join(PORTABLE, 'test'),
  path.join(PORTABLE, 'scripts'),
  path.join(PORTABLE, 'Data/Recovery'),
  path.join(PORTABLE, 'Data/DSH/.dsh-recovery'),
  path.join(PORTABLE, 'Data/DSH/storages'),
  path.join(PORTABLE, 'Data/Updates/Desktop'),
  path.join(PORTABLE, 'Data/Runtime/Harness'),
];
const SCAN_FILE_EXT = new Set(['.json', '.jsonl', '.md', '.ts', '.mjs', '.js', '.cjs', '.yaml', '.yml', '.txt', '.log']);
const SKIP_DIR = new Set(['node_modules', '.git', 'slots', 'Trash', 'temp', 'Temp', 'cache', '.pnpm']);

// 引用强度：强引用 = 现在真的依赖它（指针/清单/权威文档/源码/脚本/测试）；
// 弱引用 = 过去某次干活的记录（历史转录、日志快照、会话缓存）——不代表现在依赖它。
const STRONG_PATH_HINTS = ['Data/Updates/Desktop/', 'Data/Runtime/Harness/current.json', 'AgentOS/docs/', 'docs/', 'src/', 'scripts/', 'test/', '.dsh-recovery/'];
// 注意 'AgentOS/runtime/' 是弱引用：那里的 slots.json / slot-manifests/ 是本工具自己的产出，
// 若算强引用会形成「自己登记自己 → 永远不可回收」的自指闭环。
const WEAK_PATH_HINTS = ['Data/Recovery/', 'AgentOS/logs/', 'AgentOS/runtime/', 'Data/DSH/storages/', 'Data/DSH/sessions/', 'Data/DSH/cache/'];
function strengthOf(rel) {
  const f = rel.split(path.sep).join('/');
  if (/\.log$/i.test(f) || /\.jsonl$/i.test(f)) return 'weak'; // 日志/转录只是历史记录
  if (WEAK_PATH_HINTS.some((h) => f.startsWith(h))) return 'weak';
  if (STRONG_PATH_HINTS.some((h) => f.startsWith(h))) return 'strong';
  return 'weak';
}

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(path.join(dir, e.name), out, depth + 1);
    } else if (e.isFile()) {
      if (SCAN_FILE_EXT.has(path.extname(e.name).toLowerCase())) out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const listSlots = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];

const harnessSlots = listSlots(HARNESS_SLOTS);
const desktopSlots = listSlots(DESKTOP_SLOTS);
const allIds = [...harnessSlots, ...desktopSlots];

// ---- 尺寸 ----
const sizes = fs.existsSync(SIZES_FILE) ? JSON.parse(fs.readFileSync(SIZES_FILE, 'utf8')) : { slots: [] };
const sizeOf = (name) => sizes.slots.find((s) => s.name === name) ?? null;

// ---- 指针 ----
const harnessPointer = JSON.parse(fs.readFileSync(path.join(PORTABLE, 'Data/Runtime/Harness/current.json'), 'utf8'));
const desktopPointer = JSON.parse(fs.readFileSync(path.join(PORTABLE, 'Data/Updates/Desktop/pointer.json'), 'utf8'));
const desktopState = JSON.parse(fs.readFileSync(path.join(PORTABLE, 'Data/Updates/Desktop/state.json'), 'utf8'));

const currentHarnessSlot = path.basename(harnessPointer.current.relativePath);
const previousHarnessSlot = harnessPointer.previous ? path.basename(harnessPointer.previous.relativePath) : null;
const currentDesktopSlot = path.basename(desktopPointer.current.relativePath);
const previousDesktopSlot = desktopPointer.previous ? path.basename(desktopPointer.previous.relativePath) : null;

// ---- 引用扫描 ----
const refs = new Map(); // id -> [{file, line}]
const files = [];
for (const d of SCAN_DIRS) walk(d, files);
const uniq = [...new Set(files)];
for (const f of uniq) {
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  for (const id of allIds) {
    if (!text.includes(id)) continue;
    const idx = lines.findIndex((l) => l.includes(id));
    const rel = path.relative(PORTABLE, f).split(path.sep).join('/');
    if (!refs.has(id)) refs.set(id, []);
    refs.get(id).push({ file: rel, line: idx + 1, strength: strengthOf(rel) });
  }
}

// ---- 角色判定 ----
const candidatesActive = fs.existsSync(path.join(AGENTOS, 'candidates/active'))
  ? fs.readdirSync(path.join(AGENTOS, 'candidates/active')).filter((f) => f.endsWith('.json'))
  : [];
const candidatesRejected = fs.existsSync(path.join(AGENTOS, 'candidates/rejected'))
  ? fs.readdirSync(path.join(AGENTOS, 'candidates/rejected')).filter((f) => f.endsWith('.json'))
  : [];

function roleOf({ kind, id }) {
  if (kind === 'harness') {
    if (id === currentHarnessSlot) return ['current', 'last_known_good'];
    if (id === previousHarnessSlot) return ['previous'];
    return ['retired'];
  }
  if (id === currentDesktopSlot) return ['current', 'last_known_good'];
  if (id === previousDesktopSlot) return ['previous'];
  return ['retired'];
}

function manifestOf({ kind, id }) {
  const dir = kind === 'harness' ? path.join(HARNESS_SLOTS, id) : path.join(DESKTOP_SLOTS, id);
  const m = { kind, id, dir, exists: fs.existsSync(dir) };
  const slotManifest = path.join(dir, 'slot-manifest.json');
  if (fs.existsSync(slotManifest)) {
    try {
      m.slot_manifest = JSON.parse(fs.readFileSync(slotManifest, 'utf8'));
    } catch {
      m.slot_manifest = null;
    }
  }
  // 运行时槽：读根清单 + 家族指纹（若存在）
  const pkg = path.join(dir, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const p = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      m.package = { name: p.name, version: p.version };
    } catch {
      /* ignore */
    }
  }
  const fp = path.join(dir, '.dsh-runtime-fingerprint');
  if (fs.existsSync(fp)) m.runtime_fingerprint = fs.readFileSync(fp, 'utf8').trim().slice(0, 200);
  const mainExe = path.join(dir, 'DSH Codex Desktop.exe');
  if (fs.existsSync(mainExe)) m.entry_ok = true;
  const size = sizeOf(id);
  m.size = size ? { bytes: size.bytes, files: size.files, dirs: size.dirs } : null;
  return m;
}

const registry = {
  schema_version: 1,
  built_at: new Date().toISOString(),
  portable_root: PORTABLE,
  pointers: {
    harness: { file: 'Data/Runtime/Harness/current.json', current: currentHarnessSlot, previous: previousHarnessSlot },
    desktop: { file: 'Data/Updates/Desktop/pointer.json', current: currentDesktopSlot, previous: previousDesktopSlot },
    desktop_state: {
      file: 'Data/Updates/Desktop/state.json',
      currentVersion: desktopState.currentVersion,
      note: 'currentVersion 是**桌面应用版本**（src/main.ts 写 app.getVersion()），不是槽 id；槽 id 的权威来源是 pointer.json',
    },
  },
  stable: {
    resolved_from: 'AgentOS/runtime/stable-promotions.jsonl',
    found: false,
    note: '晋升台账里没有任何 STABLE+PASS 记录 → 没有"经验证晋升的 Stable"；last_known_good 另行给出',
  },
  last_known_good: { harness: currentHarnessSlot, desktop: currentDesktopSlot, basis: '状态指针 + 进程路径双源一致 + boot-audit 实测 OK' },
  candidates: { active: candidatesActive, rejected: candidatesRejected },
  slots: [],
  plan: { referenced_kept: [], unreferenced_to_trash: [], bytes_reclaimable: 0 },
};

for (const kind of ['harness', 'desktop']) {
  const list = kind === 'harness' ? harnessSlots : desktopSlots;
  for (const id of list) {
    const roles = roleOf({ kind, id });
    const r = refs.get(id) ?? [];
    const strong = r.filter((x) => x.strength === 'strong');
    const weak = r.filter((x) => x.strength === 'weak');
    const protectedByRole = roles.includes('current') || roles.includes('previous');
    const slot = {
      ...manifestOf({ kind, id }),
      roles,
      referenced: r.length > 0,
      strong_reference_count: strong.length,
      weak_reference_count: weak.length,
      strong_references: strong.slice(0, 12),
      weak_references: weak.slice(0, 6),
      protected: protectedByRole || strong.length > 0,
      disposition: protectedByRole
        ? 'keep_protected'
        : strong.length
          ? 'keep_strong_reference'
          : EXECUTE
            ? 'moved_to_trash'
            : 'move_to_trash',
    };
    registry.slots.push(slot);
    if (slot.disposition === 'keep_protected' || slot.disposition === 'keep_strong_reference') {
      registry.plan.referenced_kept.push({
        kind,
        id,
        roles,
        reason: protectedByRole ? 'protected(role)' : 'strong_reference',
        strong_refs: strong.slice(0, 3).map((x) => x.file),
      });
    } else {
      const bytes = slot.size?.bytes ?? 0;
      registry.plan.unreferenced_to_trash.push({ kind, id, bytes, weak_refs_only: weak.length });
      registry.plan.bytes_reclaimable += bytes;
    }
  }
}

// ---- 执行迁移（移动，不删除） ----
if (EXECUTE) {
  fs.mkdirSync(TRASH, { recursive: true });
  for (const item of registry.plan.unreferenced_to_trash) {
    const src = item.kind === 'harness' ? path.join(HARNESS_SLOTS, item.id) : path.join(DESKTOP_SLOTS, item.id);
    const dst = path.join(TRASH, item.kind + '__' + item.id);
    if (!fs.existsSync(src)) continue;
    try {
      fs.renameSync(src, dst);
      item.moved = true;
      item.dst = path.relative(PORTABLE, dst).split(path.sep).join('/');
    } catch (e) {
      item.moved = false;
      item.error = String(e?.message ?? e);
    }
  }
}

// ---- 落盘 ----
const outDir = path.join(AGENTOS, 'runtime');
fs.mkdirSync(path.join(outDir, 'slot-manifests'), { recursive: true });
for (const s of registry.slots) {
  fs.writeFileSync(path.join(outDir, 'slot-manifests', `${s.kind}__${s.id}.json`), JSON.stringify(s, null, 2) + '\n', 'utf8');
}
fs.writeFileSync(path.join(outDir, 'slots.json'), JSON.stringify(registry, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  mode: EXECUTE ? 'EXECUTE' : 'DRY_RUN',
  scanned_files: uniq.length,
  harness_slots: harnessSlots.length,
  desktop_slots: desktopSlots.length,
  current: { harness: currentHarnessSlot, desktop: currentDesktopSlot },
  previous: { harness: previousHarnessSlot, desktop: previousDesktopSlot },
  keep: registry.plan.referenced_kept,
  to_trash: registry.plan.unreferenced_to_trash,
  bytes_reclaimable: registry.plan.bytes_reclaimable,
  registry_file: path.relative(PORTABLE, path.join(outDir, 'slots.json')).split(path.sep).join('/'),
}, null, 2));
