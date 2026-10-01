// 任务单第十八节（熔断器接到真实制品）+ 第二十二节（事故转防线）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { makeTempDir, rmrf, writeFile } from './helpers.mjs';
import { evaluateBoot, REQUIRED_CORE_SERVICES } from '../lib/bootbreaker.mjs';
import { resolveBundle, readQuarantine, probeWeb, auditBoot, CORE_BUNDLES } from '../lib/bootaudit.mjs';

/** 造一个假 profile：bundle 已声明，入口文件按 broken 决定缺哪个。 */
function makeProfile({ bundles = [], missing = {} } = {}) {
  const dir = makeTempDir('profile-');
  writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles } } }, null, 2));
  for (const b of bundles) {
    const pdir = path.join(dir, 'node_modules', b);
    writeFile(
      path.join(pdir, 'package.json'),
      JSON.stringify({ name: b, version: '1.0.0', main: 'lib/index.js', exports: { '.': { default: './lib/index.js' }, './client': './lib/client.js' } }, null, 2),
    );
    if (missing[b] !== 'main') writeFile(path.join(pdir, 'lib', 'index.js'), 'export {};\n');
    if (missing[b] !== 'client') writeFile(path.join(pdir, 'lib', 'client.js'), 'export {};\n');
  }
  return dir;
}

test('§18-A: 观测不到的服务必须报「未验证」，不得默认通过', () => {
  const r = evaluateBoot({ plugins: [{ name: 'a', status: 'ok' }] });
  assert.equal(r.status, 'OK');
  assert.equal(r.verdict_completeness, 'PARTIAL', '服务/boot 都观测不到时结论只能是 PARTIAL');
  assert.ok(r.unverified_checks.includes('core_service_not_ready'));
  assert.ok(r.unverified_checks.includes('web_boot_not_completed'));

  const full = evaluateBoot({
    plugins: [{ name: 'a', status: 'ok' }],
    services: REQUIRED_CORE_SERVICES.map((name) => ({ name, ready: true })),
    bootCompleted: true,
  });
  assert.equal(full.verdict_completeness, 'FULL', JSON.stringify(full.unverified_checks));
  assert.deepEqual(full.unverified_checks, []);

  // 显式给出 services 数组但缺项 -> 真的触发（不因为"没观测"而放过）
  const partialList = evaluateBoot({ plugins: [], services: [{ name: 'locale', ready: true }], bootCompleted: true });
  assert.equal(partialList.status, 'BOOT_FAILED');
  assert.ok(partialList.triggers.some((t) => t.rule === 'core_service_not_ready'));
});

test('§18-B: resolveBundle 认得出缺 main / 缺 client / 整个包不存在', () => {
  const profileDir = makeProfile({
    bundles: ['good-plugin', 'no-client-plugin', 'no-main-plugin'],
    missing: { 'no-client-plugin': 'client', 'no-main-plugin': 'main' },
  });
  try {
    const good = resolveBundle({ bundle: 'good-plugin', profileDir });
    assert.equal(good.ok, true);
    assert.equal(good.reason, 'ok');
    assert.equal(good.version, '1.0.0');
    assert.ok(good.entries.every((e) => e.exists));

    const nc = resolveBundle({ bundle: 'no-client-plugin', profileDir });
    assert.equal(nc.ok, false);
    assert.equal(nc.reason, 'missing_entry:client');

    const nm = resolveBundle({ bundle: 'no-main-plugin', profileDir });
    assert.equal(nm.reason, 'missing_entry:main');

    const gone = resolveBundle({ bundle: 'never-installed', profileDir });
    assert.equal(gone.reason, 'package_not_found');
  } finally {
    rmrf(profileDir);
  }
});

test('§18-C: 官方 bundle 在 profile 缺席但运行时槽存在 -> 视为正常（不该误报）', () => {
  const profileDir = makeProfile({ bundles: [] });
  const slot = makeProfile({ bundles: ['@deepseek-ai/dsh-base'] });
  try {
    const r = resolveBundle({ bundle: '@deepseek-ai/dsh-base', profileDir, harnessSlotDir: slot });
    assert.equal(r.ok, true);
    assert.ok(r.dir.startsWith(slot), '应当解析到运行时槽');
  } finally {
    rmrf(profileDir);
    rmrf(slot);
  }
});

test('§18-D: auditBoot —— 健康 profile 出 OK/PARTIAL；两个无关 bundle 失败出 BOOT_FAILED', async () => {
  const healthy = makeProfile({ bundles: ['@x/a-plugin', 'b-plugin'] });
  try {
    const rep = await auditBoot({ profileDir: healthy });
    assert.equal(rep.bundles.total, 2);
    assert.equal(rep.bundles.failed, 0);
    assert.equal(rep.boot_verdict.status, 'OK');
    assert.equal(rep.boot_verdict.verdict_completeness, 'PARTIAL');
    assert.ok(rep.boot_verdict.unverified_checks.includes('core_service_not_ready'));
  } finally {
    rmrf(healthy);
  }

  const broken = makeProfile({ bundles: ['@x/a-plugin', 'b-plugin'], missing: { '@x/a-plugin': 'client', 'b-plugin': 'client' } });
  try {
    const rep = await auditBoot({ profileDir: broken });
    assert.equal(rep.bundles.failed, 2);
    assert.equal(rep.boot_verdict.status, 'BOOT_FAILED');
    assert.ok(rep.boot_verdict.triggers.some((t) => t.rule === 'two_unrelated_plugins_import_failed'));
    assert.equal(rep.boot_verdict.candidate_action, 'CURRENT_CANDIDATE_REJECTED');
  } finally {
    rmrf(broken);
  }

  // required core bundle 单独失败也熔断
  const coreBroken = makeProfile({ bundles: ['@deepseek-ai/dsh-base'], missing: { '@deepseek-ai/dsh-base': 'main' } });
  try {
    const rep = await auditBoot({ profileDir: coreBroken });
    assert.equal(rep.boot_verdict.status, 'BOOT_FAILED');
    assert.ok(rep.boot_verdict.triggers.some((t) => t.rule === 'required_core_plugin_import_failed'));
    assert.deepEqual([...CORE_BUNDLES], ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  } finally {
    rmrf(coreBroken);
  }
});

test('§18-E: readQuarantine 读得出历史隔离记录与未恢复项', () => {
  const dir = makeProfile({ bundles: [] });
  try {
    const none = readQuarantine({ profileDir: dir });
    assert.equal(none.exists, false);
    assert.equal(none.total, 0);

    writeFile(
      path.join(dir, '.dsh-recovery', 'quarantined-bundles.json'),
      JSON.stringify({
        version: 1,
        records: [
          { packageName: 'a', reason: 'r1', source: 'preflight', createdAt: '2026-09-11T02:18:29.391Z', resolvedAt: '2026-09-11T10:23:27.249Z' },
          { packageName: 'b', reason: 'r2', source: 'startup', createdAt: '2026-09-12T02:18:29.391Z' },
        ],
      }),
    );
    const q = readQuarantine({ profileDir: dir });
    assert.equal(q.exists, true);
    assert.equal(q.total, 2);
    assert.equal(q.unresolved.length, 1);
    assert.equal(q.unresolved[0].packageName, 'b');
    assert.equal(q.newest.packageName, 'b', 'newest 按 createdAt 取，不是按数组顺序');
  } finally {
    rmrf(dir);
  }
});

test('§18-G: 回归 —— 健康探针的 404 不得熔断；只有显式 moduleUrls 的 404 才熔断', async () => {
  // 这条是我自己在真机上踩出来的假阳性：把「存活探针」的 404 当成模块 404。
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/missing.js' ? 404 : 200, { 'content-type': 'text/plain' });
    res.end(req.url === '/missing.js' ? 'nope' : 'ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const profileDir = makeProfile({ bundles: ['@x/a-plugin'] });
  try {
    const asProbe = await auditBoot({ profileDir, probeUrls: [`http://127.0.0.1:${port}/missing.js`] });
    assert.equal(asProbe.boot_verdict.status, 'OK', '存活探针 404 不能触发熔断');
    assert.equal(asProbe.probes[0].status, 404);
    assert.deepEqual(asProbe.module_probes, []);

    const asModule = await auditBoot({ profileDir, moduleUrls: [`http://127.0.0.1:${port}/missing.js`] });
    assert.equal(asModule.boot_verdict.status, 'BOOT_FAILED', '显式模块 URL 的 404 必须熔断');
    assert.ok(asModule.boot_verdict.triggers.some((t) => t.rule === 'module_url_404'));
  } finally {
    server.close();
    rmrf(profileDir);
  }
});

test('§18-F: probeWeb 只读探针 —— 200 / 404 / 连不上都正确分类', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const probes = await probeWeb({ urls: [`http://127.0.0.1:${port}/health`, `http://127.0.0.1:${port}/missing`], timeoutMs: 3000 });
    assert.equal(probes[0].status, 200);
    assert.equal(probes[0].reachable, true);
    assert.ok(probes[0].contentType.includes('application/json'));
    assert.equal(probes[1].status, 404);
    assert.equal(probes[1].reachable, true);
  } finally {
    server.close();
  }

  const dead = await probeWeb({ urls: ['http://127.0.0.1:1/nope'], timeoutMs: 1500 });
  assert.equal(dead[0].reachable, false);
  assert.equal(dead[0].status, 0);
});
