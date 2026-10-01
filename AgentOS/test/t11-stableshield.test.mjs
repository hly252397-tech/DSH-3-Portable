// 目标硬约束「Stable 永不直接修改」+ 任务单第十一节（Stable/Candidate 隔离）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmrf, writeFile } from './helpers.mjs';
import {
  STABLE_SURFACES,
  resolveLiveStable,
  isProtectedPath,
  stableForbiddenRoots,
  assertNotStable,
  describeStableShield,
} from '../lib/stableshield.mjs';
import { FileBroker } from '../lib/filebroker.mjs';

function makePortableRoot({ withHarnessPointer = true } = {}) {
  const root = makeTempDir('portable-');
  for (const s of ['1.0.66-local-aaaa', '1.0.66-local-bbbb']) {
    writeFile(path.join(root, 'Data', 'Updates', 'Desktop', 'slots', s, 'app.txt'), s + '\n');
  }
  writeFile(path.join(root, 'Data', 'Updates', 'Desktop', 'state.json'), JSON.stringify({ currentVersion: '1.0.66' }));

  for (const s of ['0.1.5-rc.2-cccc', '0.1.6-alpha.1-dddd']) {
    writeFile(path.join(root, 'Data', 'Runtime', 'Harness', 'slots', s, 'index.js'), 'export {};\n');
  }
  if (withHarnessPointer) {
    writeFile(
      path.join(root, 'Data', 'Runtime', 'Harness', 'current.json'),
      JSON.stringify({ current: { relativePath: 'Harness/slots/0.1.6-alpha.1-dddd', version: '0.1.6-alpha.1' } }),
    );
  }
  writeFile(path.join(root, 'Data', 'Runtime', 'Harness', 'current', 'index.js'), 'export {};\n');

  // 可变区：AgentOS 自己、profile 本地插件、普通工作区
  writeFile(path.join(root, 'AgentOS', 'lib', 'x.mjs'), 'export {};\n');
  writeFile(path.join(root, 'Data', 'DSH', 'profiles', 'web', 'local', 'plug', 'index.js'), 'export {};\n');
  writeFile(path.join(root, 'workspace', 'a.js'), 'export {};\n');
  return root;
}

test('§11-A: 保护面清单是相对便携盘根的（整盘可搬移）', () => {
  const ids = STABLE_SURFACES.map((s) => s.id);
  assert.deepEqual(ids, [
    'desktop_slots',
    'desktop_state',
    'harness_slots',
    'harness_current',
    'harness_current_dir',
    'electron_userdata',
    'electron_sessiondata',
  ]);
  for (const s of STABLE_SURFACES) {
    assert.equal(path.isAbsolute(s.rel), false, s.id + ' 必须是相对路径');
    assert.ok(!s.rel.includes('..'), s.id + ' 不许出现 ..');
  }
  // profile 绝不能被保护（本地插件就该在那里改）
  assert.equal(STABLE_SURFACES.some((s) => s.rel.includes('profiles')), false);
});

test('§11-B: 活动槽解析 —— 优先指针；无法确定时如实报歧义，绝不猜', () => {
  const root = makePortableRoot();
  try {
    const live = resolveLiveStable({ portableRoot: root });
    assert.equal(live.harness.active_slot, '0.1.6-alpha.1-dddd', '必须按 current.json 解析，不是取目录里最后一个');
    assert.equal(live.harness.pointer_resolved_from, 'current.json');
    assert.deepEqual(live.harness.slots, ['0.1.5-rc.2-cccc', '0.1.6-alpha.1-dddd']);

    // 桌面 state.json 只有 currentVersion，而两个槽都是 1.0.66-local-* -> 歧义，不许猜
    assert.equal(live.desktop.current_version, '1.0.66');
    assert.equal(live.desktop.active_slot, null, '前缀匹配到 2 个槽时不许挑一个当活动槽');
    assert.equal(live.desktop.pointer_resolved_from, 'ambiguous_version_prefix');
    assert.deepEqual(live.desktop.ambiguous_slots, ['1.0.66-local-aaaa', '1.0.66-local-bbbb']);

    // 关键：歧义**不影响**保护面 —— 所有槽都被保护
    const guard = (rel) => isProtectedPath({ target: path.join(root, rel), liveStable: live }).protected;
    assert.equal(guard('Data/Updates/Desktop/slots/1.0.66-local-aaaa/app.txt'), true);
    assert.equal(guard('Data/Updates/Desktop/slots/1.0.66-local-bbbb/app.txt'), true);

    // 存在与否不影响保护：**还不存在**的受保护路径照样拦，
    // 否则可以"先创建再写"绕过守卫。fixture 没建 Electron 目录，正好用来验这一点。
    const notYet = live.protectedPaths.find((p) => p.id === 'electron_userdata');
    assert.equal(notYet.exists, false, 'fixture 未创建 Electron 目录，应如实标 exists=false');
    assert.equal(isProtectedPath({ target: path.join(root, 'Data', 'Electron', 'UserData', 'x.json'), liveStable: live }).protected, true);
    assert.ok(live.protectedPaths.filter((p) => p.exists).length >= 5, '其余保护面应存在');
  } finally {
    rmrf(root);
  }

  // 唯一匹配 -> 能确定活动槽
  const single = makePortableRoot();
  try {
    rmrf(path.join(single, 'Data', 'Updates', 'Desktop', 'slots', '1.0.66-local-aaaa'));
    const live = resolveLiveStable({ portableRoot: single });
    assert.equal(live.desktop.active_slot, '1.0.66-local-bbbb');
    assert.equal(live.desktop.pointer_resolved_from, 'state.json');
  } finally {
    rmrf(single);
  }

  const noPointer = makePortableRoot({ withHarnessPointer: false });
  try {
    const live = resolveLiveStable({ portableRoot: noPointer });
    assert.equal(live.harness.pointer_resolved_from, 'newest_slot_fallback');
    assert.equal(live.harness.active_slot, '0.1.6-alpha.1-dddd');
  } finally {
    rmrf(noPointer);
  }

  assert.throws(() => resolveLiveStable({}), /portableRoot is required/);
});

test('§11-C: 保护判定 —— 槽与指针拦住；AgentOS / 普通工作区 / profile 放行', () => {
  const root = makePortableRoot();
  try {
    const live = resolveLiveStable({ portableRoot: root });
    const hit = (rel) => isProtectedPath({ target: path.join(root, rel), liveStable: live });

    assert.equal(hit('Data/Updates/Desktop/slots/1.0.66-local-aaaa/app.txt').protected, true);
    assert.equal(hit('Data/Updates/Desktop/slots/1.0.66-local-aaaa/app.txt').id, 'desktop_slots');
    assert.equal(hit('Data/Updates/Desktop/slots/1.0.66-local-aaaa').kind, 'immutable_slot');
    assert.equal(hit('Data/Updates/Desktop/state.json').protected, true);
    assert.equal(hit('Data/Updates/Desktop/state.json').kind, 'pointer');
    assert.equal(hit('Data/Runtime/Harness/slots/0.1.6-alpha.1-dddd/index.js').protected, true);
    assert.equal(hit('Data/Runtime/Harness/current.json').protected, true);
    assert.equal(hit('Data/Runtime/Harness/current/index.js').protected, true);

    assert.equal(hit('AgentOS/lib/x.mjs').protected, false, 'AgentOS 自己必须可写');
    assert.equal(hit('workspace/a.js').protected, false);
    assert.equal(hit('Data/DSH/profiles/web/local/plug/index.js').protected, false, 'profile 本地插件必须可写');

    assert.equal(describeStableShield({ portableRoot: root }).explicitly_not_protected.length, 1);
  } finally {
    rmrf(root);
  }
});

test('§11-D: 用真实 Junction 刺穿 —— 从可变区绕进运行时槽也必须被拦', (t) => {
  const root = makePortableRoot();
  const link = path.join(root, 'workspace', 'sneak');
  try {
    try {
      fs.symlinkSync(path.join(root, 'Data', 'Runtime', 'Harness', 'slots', '0.1.6-alpha.1-dddd'), link, 'junction');
    } catch (e) {
      rmrf(root);
      t.skip('本机不允许创建 junction: ' + e.message);
      return;
    }

    const live = resolveLiveStable({ portableRoot: root });
    const sneakTarget = path.join(link, 'index.js');
    const r = isProtectedPath({ target: sneakTarget, liveStable: live });
    assert.equal(r.protected, true, '字面路径在 workspace 内、真实路径在运行时槽内 —— 必须拦住');
    assert.equal(r.id, 'harness_slots');

    // FileBroker 侧也必须拒绝且不落盘
    const { forbiddenRoots } = stableForbiddenRoots({ portableRoot: root });
    const b = new FileBroker({ root, forbiddenRoots });
    writeFile(path.join(root, 'checkpoints', 'cp.json'), '{}\n');
    b.read(sneakTarget);
    const w = b.write({ target: sneakTarget, content: 'pwned\n', checkpointId: 'cp' });
    assert.equal(w.ok, false);
    assert.equal(fs.readFileSync(path.join(root, 'Data', 'Runtime', 'Harness', 'slots', '0.1.6-alpha.1-dddd', 'index.js'), 'utf8'), 'export {};\n');
  } finally {
    rmrf(root);
  }
});

test('§11-E: stableForbiddenRoots 接进 FileBroker —— 直接往槽里写被拒且文件未动', () => {
  const root = makePortableRoot();
  try {
    const { forbiddenRoots, live } = stableForbiddenRoots({ portableRoot: root });
    assert.equal(forbiddenRoots.length, live.protectedPaths.length);

    const slotFile = path.join(root, 'Data', 'Runtime', 'Harness', 'slots', '0.1.6-alpha.1-dddd', 'index.js');
    const before = fs.readFileSync(slotFile, 'utf8');

    const b = new FileBroker({ root, forbiddenRoots });
    writeFile(path.join(root, 'checkpoints', 'cp.json'), '{}\n');
    b.read(slotFile);
    const w = b.write({ target: slotFile, content: 'CLOBBERED\n', checkpointId: 'cp' });

    assert.equal(w.ok, false);
    assert.equal(w.stage, 'preconditions');
    const bad = w.checks.filter((c) => !c.ok).map((c) => c.id);
    assert.ok(bad.includes('pre:within_allowed_roots'), JSON.stringify(bad));
    assert.equal(fs.readFileSync(slotFile, 'utf8'), before, 'Stable 字节必须原样不动');

    // 同一 broker 写普通工作区仍然放行
    const wsFile = path.join(root, 'workspace', 'a.js');
    b.read(wsFile);
    const okWrite = b.write({ target: wsFile, content: 'export const a = 2;\n', checkpointId: 'cp' });
    assert.equal(okWrite.ok, true, JSON.stringify(okWrite.checks.filter((c) => !c.ok)));
  } finally {
    rmrf(root);
  }
});

test('§11-F: assertNotStable 抛出带 code 的硬错误', () => {
  const root = makePortableRoot();
  try {
    const live = resolveLiveStable({ portableRoot: root });
    assert.throws(
      () => assertNotStable({ target: path.join(root, 'Data', 'Updates', 'Desktop', 'state.json'), liveStable: live }),
      (e) => e.code === 'STABLE_IMMUTABLE' && e.detail.id === 'desktop_state',
    );
    assert.equal(assertNotStable({ target: path.join(root, 'AgentOS', 'lib', 'x.mjs'), liveStable: live }), true);
  } finally {
    rmrf(root);
  }
});
