// 任务单第二十节 —— 文件写入安全（File Broker）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmrf, writeFile } from './helpers.mjs';
import { FileBroker, guardWritePath, realpathOf, assertCleanForDelivery } from '../lib/filebroker.mjs';

function makeWorkspace() {
  const ws = makeTempDir('fb-');
  writeFile(path.join(ws, 'sub', 'a.js'), 'export const a = 1;\n');
  writeFile(path.join(ws, 'sub', 'b.js'), 'export const b = 1;\n');
  writeFile(path.join(ws, 'checkpoints', 'cp-1.json'), '{"note":"checkpoint"}\n');
  return ws;
}

const readText = (p) => fs.readFileSync(p, 'utf8');
const findCheck = (r, id) => r.checks.find((c) => c.id === id);

test('§20-A: guardWritePath —— 允许根 / 越界 / 禁止根 / Junction 逃逸', () => {
  const ws = makeWorkspace();
  const outside = makeTempDir('fb-out-');
  try {
    const allowed = guardWritePath({ target: path.join(ws, 'sub', 'a.js'), allowedRoots: [ws] });
    assert.equal(allowed.ok, true);

    const outsideGuard = guardWritePath({ target: path.join(outside, 'x.txt'), allowedRoots: [ws] });
    assert.equal(outsideGuard.ok, false);
    assert.ok(outsideGuard.problems.includes('outside_allowed_roots'));

    const forbidden = guardWritePath({ target: path.join(ws, 'sub', 'a.js'), allowedRoots: [ws], forbiddenRoots: [path.join(ws, 'sub')] });
    assert.equal(forbidden.ok, false);
    assert.ok(forbidden.problems.includes('inside_forbidden_roots'));

    assert.equal(guardWritePath({}).ok, false);
    assert.equal(realpathOf(path.join(ws, 'sub', 'a.js')).toLowerCase(), path.join(fs.realpathSync(ws), 'sub', 'a.js').toLowerCase());
  } finally {
    rmrf(ws);
    rmrf(outside);
  }
});

test('§20-B: Junction 逃逸必须被拦下', (t) => {
  const ws = makeWorkspace();
  const outside = makeTempDir('fb-escape-');
  const link = path.join(ws, 'sub', 'link');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch (e) {
    rmrf(ws);
    rmrf(outside);
    t.skip('本机不允许创建 junction: ' + e.message);
    return;
  }
  try {
    const target = path.join(link, 'escaped.txt');
    const g = guardWritePath({ target, allowedRoots: [ws] });
    assert.equal(g.escaped, true, '字面路径在允许根内、真实路径在外 -> 必须判定逃逸');
    assert.ok(g.problems.includes('symlink_or_junction_escape'));
    assert.equal(g.ok, false);

    // File Broker 也必须拒绝真的写进去
    const b = new FileBroker({ root: ws });
    b.read(target);
    const r = b.write({ target, content: 'pwned\n', checkpointId: 'cp-1' });
    assert.equal(r.ok, false);
    assert.equal(findCheck(r, 'pre:no_symlink_escape').ok, false);
    assert.equal(fs.existsSync(path.join(outside, 'escaped.txt')), false, '逃逸目标目录里不能出现文件');
  } finally {
    rmrf(ws);
    rmrf(outside);
  }
});

test('§20-C: 六条前置 —— 未读取 / 哈希失效 / 越界 / 超范围 / 无检查点 全部拦下，且**不落盘**', () => {
  const ws = makeWorkspace();
  const outside = makeTempDir('fb-out2-');
  try {
    const a = path.join(ws, 'sub', 'a.js');
    const b = new FileBroker({ root: ws });
    const original = readText(a);

    // 1) 从未读取
    let r = b.write({ target: a, content: 'export const a = 9;\n', checkpointId: 'cp-1' });
    assert.equal(r.ok, false);
    assert.equal(findCheck(r, 'pre:file_read').ok, false);
    assert.equal(readText(a), original, '前置不过绝不能改文件');

    // 2) 读取后文件被外部改过 -> 哈希失效
    b.read(a);
    fs.writeFileSync(a, 'export const a = 111;\n', 'utf8');
    r = b.write({ target: a, content: 'export const a = 9;\n', checkpointId: 'cp-1' });
    assert.equal(r.ok, false);
    assert.equal(findCheck(r, 'pre:read_hash_still_valid').ok, false);
    assert.equal(readText(a), 'export const a = 111;\n');

    // 3) 越界
    const outFile = path.join(outside, 'x.txt');
    writeFile(outFile, 'x\n');
    b.read(outFile);
    r = b.write({ target: outFile, content: 'y\n', checkpointId: 'cp-1' });
    assert.equal(findCheck(r, 'pre:within_allowed_roots').ok, false);
    assert.equal(readText(outFile), 'x\n');

    // 4) 超任务范围
    const bFile = path.join(ws, 'sub', 'b.js');
    b.read(bFile);
    r = b.write({ target: bFile, content: 'z\n', checkpointId: 'cp-1', taskScope: ['sub/a.js'] });
    assert.equal(findCheck(r, 'pre:within_task_scope').ok, false);
    assert.equal(readText(bFile), 'export const b = 1;\n');

    // 5) 无检查点
    const fresh = path.join(ws, 'sub', 'c.js');
    writeFile(fresh, 'export const c = 1;\n');
    b.read(fresh);
    r = b.write({ target: fresh, content: 'export const c = 2;\n', checkpointId: 'does-not-exist' });
    assert.equal(findCheck(r, 'pre:checkpoint_established').ok, false);
    assert.equal(readText(fresh), 'export const c = 1;\n');

    // 6) 全部满足 -> 放行，且留拒绝档案
    b.read(a);
    const okWrite = b.write({ target: a, content: 'export const a = 2;\n', checkpointId: 'cp-1', syntaxCheck: true });
    assert.equal(okWrite.ok, true, JSON.stringify(okWrite.checks.filter((c) => !c.ok)));
    assert.equal(readText(a), 'export const a = 2;\n');
    assert.ok(b.status().journal.some((j) => j.action === 'write_denied'));
  } finally {
    rmrf(ws);
    rmrf(outside);
  }
});

test('§20-D: 后置 —— 原子写、留 bak、无 tmp 残留、标记 DIRTY、未跑的检查如实记录', () => {
  const ws = makeWorkspace();
  try {
    const a = path.join(ws, 'sub', 'a.js');
    const b = new FileBroker({ root: ws });
    b.read(a);
    const r = b.write({ target: a, content: 'export const a = 42;\n', checkpointId: 'cp-1', syntaxCheck: true });

    assert.equal(r.ok, true);
    assert.equal(findCheck(r, 'post:reread_ok').ok, true);
    assert.ok(findCheck(r, 'post:diff_recorded').detail.includes('after='));
    assert.equal(findCheck(r, 'post:syntax_ok').ok, true);
    assert.equal(findCheck(r, 'post:workspace_dirty_marked').ok, true);
    assert.equal(r.workspace_dirty, true);

    assert.ok(r.backup && fs.existsSync(r.backup));
    assert.equal(readText(r.backup), 'export const a = 1;\n', 'bak 必须是改动前的内容');

    const leftovers = fs.readdirSync(path.join(ws, 'sub')).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '不能留 tmp 残留');

    // 类型检查本仓没接 -> 必须进 not_run，不得混进通过清单
    assert.ok(r.not_run.some((n) => n.id === 'post:type_check'));
    assert.equal(r.checks.some((c) => c.id === 'post:type_check'), false, '未跑的检查不许混进通过列表');

    // 写完自动刷新读取版本，连续第二次写不该被判哈希失效
    const r2 = b.write({ target: a, content: 'export const a = 43;\n', checkpointId: 'cp-1' });
    assert.equal(r2.ok, true, JSON.stringify(r2.checks.filter((c) => !c.ok)));

    assert.equal(assertCleanForDelivery(b).ok, false, '写过东西的工作区必须算脏');
    assert.equal(assertCleanForDelivery(new FileBroker({ root: ws })).ok, true);
  } finally {
    rmrf(ws);
  }
});

test('§20-E: 语法检查抓得住坏文件（而且文件确实已写、bak 仍在，便于回滚）', () => {
  const ws = makeWorkspace();
  try {
    const broken = path.join(ws, 'sub', 'broken.mjs');
    writeFile(broken, 'export const ok = 1;\n');
    const b = new FileBroker({ root: ws });
    b.read(broken);
    const r = b.write({ target: broken, content: 'export const = ;\n', checkpointId: 'cp-1', syntaxCheck: true });

    assert.equal(r.ok, false);
    assert.equal(findCheck(r, 'post:syntax_ok').ok, false);
    assert.ok(fs.existsSync(r.backup), '有 bak 才能回滚');
    assert.equal(readText(r.backup), 'export const ok = 1;\n');
  } finally {
    rmrf(ws);
  }
});

test('§20-F: 目标测试由调用方提供；不提供就如实记为未跑', () => {
  const ws = makeWorkspace();
  try {
    const a = path.join(ws, 'sub', 'a.js');
    const b = new FileBroker({ root: ws });

    b.read(a);
    const without = b.write({ target: a, content: 'export const a = 5;\n', checkpointId: 'cp-1' });
    assert.ok(without.not_run.some((n) => n.id === 'post:target_test'));
    assert.equal(without.checks.some((c) => c.id === 'post:target_test'), false);

    const b2 = new FileBroker({ root: ws });
    b2.read(a);
    const failing = b2.write({ target: a, content: 'export const a = 6;\n', checkpointId: 'cp-1', targetTest: { ok: false, detail: 'assertion failed' } });
    assert.equal(failing.ok, false);
    assert.equal(failing.checks.find((c) => c.id === 'post:target_test').detail, 'assertion failed');
  } finally {
    rmrf(ws);
  }
});

test('§20-G: 构造参数校验与 status 视图', () => {
  assert.throws(() => new FileBroker({}), /root is required/);
  const ws = makeWorkspace();
  try {
    const b = new FileBroker({ root: ws });
    const s = b.status();
    assert.equal(s.root, path.resolve(ws));
    assert.deepEqual(s.allowed_roots, [path.resolve(ws)]);
    assert.equal(s.workspace_dirty, false);
    assert.deepEqual(s.journal, []);
    assert.equal(b.read(path.join(ws, 'nope.txt')).missing, true, '读不存在的文件要记 missing 而不是抛');
  } finally {
    rmrf(ws);
  }
});
