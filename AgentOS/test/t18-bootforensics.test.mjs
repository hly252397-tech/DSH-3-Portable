// Boot First-Error Collector —— 第一条真实错误永不覆盖；后续只统计与共同依赖分析
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmrf } from './helpers.mjs';
import {
  incidentDir,
  newIncidentId,
  openIncident,
  recordFirstError,
  recordFirstNetworkFailure,
  analyzeSharedLayer,
  planBisect,
  finalizeIncident,
  readIncident,
} from '../lib/bootforensics.mjs';

function setup() {
  const base = makeTempDir('portable-');
  return { base };
}

test('§18-J: incident id 可读且可复现', () => {
  const id = newIncidentId({ at: new Date(2026, 8, 17, 14, 31, 0) });
  assert.equal(id, 'boot-failure-20260917-143100');
  const b = setup();
  try {
    assert.throws(() => incidentDir({ incidentId: 'x' }), /portableRoot is required/);
    assert.throws(() => incidentDir({ portableRoot: b.base }), /incidentId is required/);
  } finally {
    rmrf(b.base);
  }
});

test('§18-K: 第一条错误**永不覆盖**；后续只进 append-only 统计', () => {
  const b = setup();
  try {
    openIncident({ portableRoot: b.base, incidentId: 'inc-1', runtime: '0.1.6-alpha.1', candidate: 'cand-x', workspaceFingerprint: 'sha256:aaa' });

    const first = recordFirstError({
      portableRoot: b.base,
      incidentId: 'inc-1',
      error: {
        type: 'dynamic_import_failure',
        message: "Cannot find package '@deepseek-ai/dsh-client-ui-slots'",
        module_url: '/plugins/im-connect/client.js',
        source_file: 'lib/client.js',
        line: 12,
        column: 17,
        stack: 'Error: ...\n  at ...',
        initiator: 'import()',
      },
    });
    assert.equal(first.stored, true);
    assert.equal(first.reason, 'first');

    // 后续 73 条：一条都不许覆盖第一条
    for (let i = 0; i < 73; i++) {
      const r = recordFirstError({ portableRoot: b.base, incidentId: 'inc-1', error: { type: 'dynamic_import_failure', message: 'chain failure ' + i, plugin: 'plugin-' + i } });
      assert.equal(r.stored, false);
      assert.equal(r.reason, 'already_captured');
    }

    const read = readIncident({ portableRoot: b.base, incidentId: 'inc-1' });
    assert.equal(read.first_error.first_error.message, "Cannot find package '@deepseek-ai/dsh-client-ui-slots'", '第一条必须原样保留');
    assert.equal(read.first_error.first_error.line, 12);
    assert.equal(read.first_error.first_error.column, 17);
    assert.equal(read.first_error.first_error.module_url, '/plugins/im-connect/client.js');
    assert.equal(read.first_error.first_error.initiator, 'import()');
    assert.ok(read.first_error.first_error.stack);
    assert.equal(read.subsequent_errors.length, 73);
    assert.equal(read.subsequent_errors[0].plugin, 'plugin-0');
  } finally {
    rmrf(b.base);
  }
});

test('§18-L: 第一个失败模块请求同样永不覆盖', () => {
  const b = setup();
  try {
    openIncident({ portableRoot: b.base, incidentId: 'inc-2' });
    const first = recordFirstNetworkFailure({ portableRoot: b.base, incidentId: 'inc-2', failure: { url: '/plugins/x/client.js', status: 404, content_type: 'text/html', initiator: 'script' } });
    assert.equal(first.stored, true);
    const second = recordFirstNetworkFailure({ portableRoot: b.base, incidentId: 'inc-2', failure: { url: '/plugins/y/client.js', status: 500 } });
    assert.equal(second.stored, false);

    const read = readIncident({ portableRoot: b.base, incidentId: 'inc-2' });
    assert.equal(read.first_network_failure.first_network_failure.url, '/plugins/x/client.js');
    assert.equal(read.first_network_failure.first_network_failure.status, 404);
    assert.equal(read.first_network_failure.first_network_failure.content_type, 'text/html');
    assert.equal(read.subsequent_errors.length, 1);
  } finally {
    rmrf(b.base);
  }
});

test('§18-M: 共同依赖分析 —— 73 个失败里大多数落在少数共享组，判为共享层故障', () => {
  const failures = [];
  for (let i = 0; i < 60; i++) failures.push({ plugin: 'dsh-plugin-' + i, shared_source: 'dsh-client-ui-slots' });
  for (let i = 0; i < 13; i++) failures.push({ plugin: '@michengai/dsh-x' + i, shared_source: 'dsh-client-ui-primitives' });

  const a = analyzeSharedLayer({ failures });
  assert.equal(a.total_failures, 73);
  assert.equal(a.group_count, 2);
  assert.equal(a.largest_group.family, 'dsh-client-ui-slots');
  assert.equal(a.largest_group.count, 60);
  assert.equal(a.looks_like_shared_layer_failure, true, '73 条集中在 2 个共享组 = 共享层故障');
  assert.ok(a.advice.includes('禁止逐个修插件'));

  // 两边都不靠共享层时，不该判成共享层故障
  const scattered = analyzeSharedLayer({ failures: [{ plugin: 'a1' }, { plugin: 'b2' }, { plugin: 'c3' }, { plugin: 'd4' }] });
  assert.equal(scattered.looks_like_shared_layer_failure, false);
  assert.equal(analyzeSharedLayer({ failures: [] }).looks_like_shared_layer_failure, false);
});

test('§18-N: 二分计划按共享层变更分组', () => {
  assert.deepEqual(planBisect({ changeGroups: [] }).steps, []);
  assert.ok(planBisect({ changeGroups: [] }).note.includes('重建变更集'));

  const p = planBisect({
    changeGroups: [
      { id: 'g1', files: ['lib/boot.mjs'], description: 'web boot 共享层' },
      { id: 'g2', files: ['lib/loader.mjs'], description: '插件加载器' },
    ],
  });
  assert.equal(p.strategy, 'binary_search_over_shared_layers');
  assert.equal(p.steps.length, 2);
  assert.equal(p.steps[0].group, 'g1');
  assert.ok(p.steps[1].expected.includes('BOOT_FAILED'));
});

test('§18-O: 收口 —— 写统计；第一条仍原样；后续只计数', () => {
  const b = setup();
  try {
    openIncident({ portableRoot: b.base, incidentId: 'inc-3', runtime: '0.1.6-alpha.1' });
    recordFirstError({ portableRoot: b.base, incidentId: 'inc-3', error: { type: 'syntax_error', message: 'boom', module_url: '/a.js', line: 1, column: 2 } });
    recordFirstNetworkFailure({ portableRoot: b.base, incidentId: 'inc-3', failure: { url: '/a.js', status: 404, content_type: 'text/html' } });
    for (let i = 0; i < 73; i++) recordFirstError({ portableRoot: b.base, incidentId: 'inc-3', error: { type: 'dynamic_import_failure', message: 'chain ' + i } });

    const plugins = Array.from({ length: 73 }, (_, i) => (i < 50 ? `@michengai/p${i}` : `local-p${i}`));
    const fin = finalizeIncident({
      portableRoot: b.base,
      incidentId: 'inc-3',
      affectedPlugins: plugins,
      sharedSource: 'dsh-client-ui-slots',
      changeGroups: [{ id: 'g1', files: ['boot.js'] }],
    });

    assert.equal(fin.summary.first_error.message, 'boom');
    assert.equal(fin.summary.subsequent_error_count, 73);
    assert.equal(fin.summary.failed_plugin_count, 73);
    assert.equal(fin.summary.affected_plugins.length, 73);
    assert.equal(fin.summary.shared_layer_analysis.looks_like_shared_layer_failure, true);
    assert.equal(fin.summary.bisect_plan.steps.length, 1);
    assert.equal(fin.summary.invariant_checks.find((c) => c.id === 'first_error_preserved').ok, true);
    assert.ok(fs.existsSync(fin.file));

    // 收口之后第一条依然不许被改
    const read = readIncident({ portableRoot: b.base, incidentId: 'inc-3' });
    assert.equal(read.first_error.first_error.message, 'boom');
    assert.equal(read.first_network_failure.first_network_failure.status, 404);
  } finally {
    rmrf(b.base);
  }
});

test('§18-P: openIncident 幂等（重开不覆盖已有取证）', () => {
  const b = setup();
  try {
    const first = openIncident({ portableRoot: b.base, incidentId: 'inc-4', runtime: 'r1', note: '原始' });
    assert.equal(first.reused, false);
    const again = openIncident({ portableRoot: b.base, incidentId: 'inc-4', runtime: 'r2', note: '后来的' });
    assert.equal(again.reused, true);
    assert.equal(again.meta.runtime, 'r1', '重开不得覆盖元信息');
    assert.equal(again.meta.note, '原始');
    assert.equal(readIncident({ portableRoot: b.base, incidentId: 'inc-4' }).exists, true);
  } finally {
    rmrf(b.base);
  }
});
