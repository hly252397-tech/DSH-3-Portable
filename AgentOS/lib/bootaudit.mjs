// Boot Audit —— 把第十八节的熔断器接到**真实制品**上（第二节共享层清单 + 第二十二节事故转防线）。
//
// 目的：把「这次到底有没有 BOOT_FAILED」从人工看截图，变成可重复、可复现的机器判定。
// 观测不到的东西（locale/settingsScope/slots 就绪、web boot 完成）**绝不默认通过**，
// 一律记入 unverified_checks，快照结论降级为 PARTIAL。
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './paths.mjs';
import { evaluateBoot, REQUIRED_CORE_SERVICES } from './bootbreaker.mjs';

/** 第十八节：任一 required core plugin 失败即熔断。 */
export const CORE_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readJson(p) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
}

function entryTarget(node) {
  if (!node) return null;
  if (typeof node === 'string') return node;
  return node.default || node.import || node.require || null;
}

/**
 * 解析单个 bundle：profile 优先，其次运行时槽（官方 bundle 由运行时提供）。
 * 第二节：优先检查所有插件共同经过的共享层——package exports / 公共入口。
 */
export function resolveBundle({ bundle, profileDir, harnessSlotDir = null }) {
  const candidates = [path.join(profileDir, 'node_modules', bundle)];
  if (harnessSlotDir) candidates.push(path.join(harnessSlotDir, 'node_modules', bundle));

  for (const dir of candidates) {
    const mp = path.join(dir, 'package.json');
    if (!fs.existsSync(mp)) continue;
    const m = readJson(mp);
    if (!m) return { name: bundle, ok: false, reason: 'manifest_unreadable', dir };

    const entries = [];
    const main = m.main || entryTarget(m.exports && m.exports['.']);
    if (main) entries.push({ label: 'main', target: main, exists: fs.existsSync(path.join(dir, main)) });
    const client = entryTarget(m.exports && m.exports['./client']);
    if (client) entries.push({ label: 'client', target: client, exists: fs.existsSync(path.join(dir, client)) });

    const missing = entries.filter((e) => !e.exists);
    return {
      name: bundle,
      ok: missing.length === 0,
      reason: missing.length ? 'missing_entry:' + missing.map((e) => e.label).join(',') : 'ok',
      dir,
      version: m.version ?? null,
      entries,
    };
  }
  return { name: bundle, ok: false, reason: 'package_not_found', dir: null, entries: [] };
}

/** 读取 DSH 自愈留下的隔离清单（历史 import 失败的第一手制品）。 */
export function readQuarantine({ profileDir }) {
  const file = path.join(profileDir, '.dsh-recovery', 'quarantined-bundles.json');
  const j = readJson(file);
  if (!j) return { file, exists: false, total: 0, records: [], unresolved: [], newest: null };
  const raw = Array.isArray(j.records) ? j.records : [];
  const records = raw.map((r) => ({
    packageName: r.packageName ?? null,
    reason: String(r.reason ?? '').slice(0, 160),
    source: r.source ?? null,
    createdAt: r.createdAt ?? null,
    resolvedAt: r.resolvedAt ?? null,
  }));
  const unresolved = records.filter((r) => !r.resolvedAt);
  const newest = records.reduce((a, r) => (!a || String(r.createdAt) > String(a.createdAt) ? r : a), null);
  return { file, exists: true, total: records.length, records, unresolved, newest };
}

/** 探针：只发 GET，不改任何状态。 */
export async function probeWeb({ urls = [], timeoutMs = 4000 } = {}) {
  const out = [];
  for (const url of urls) {
    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      out.push({
        url,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        ms: Date.now() - started,
        reachable: true,
      });
    } catch (e) {
      out.push({ url, status: 0, contentType: '', ms: Date.now() - started, reachable: false, error: String(e && e.message ? e.message : e) });
    }
  }
  return out;
}

/**
 * 完整启动审计。
 * @param {object} o
 * @param {string} o.profileDir      Data\DSH\profiles\web
 * @param {string} o.harnessSlotDir  活动运行时槽（可选）
 * @param {string[]} o.probeUrls     只读探针
 */
export async function auditBoot({
  portableRoot = null,
  profileDir,
  harnessSlotDir = null,
  // 健康探针：**只**用来判断服务是否活着，绝不参与 404 / 返回 HTML 判定。
  // （服务端无法枚举客户端真实请求的模块 URL；拿自造 URL 的 404 去熔断 = 假阳性，已实测。）
  probeUrls = [],
  // 模块 URL：调用方**明确知道**的真实模块地址，才允许喂给 module_url_404 / module_request_returned_html。
  moduleUrls = [],
  timeoutMs = 4000,
} = {}) {
  if (!profileDir) throw new Error('auditBoot: profileDir is required');

  const pkg = readJson(path.join(profileDir, 'package.json'));
  const bundles = pkg?.dsh?.profile?.bundles ?? [];
  const resolved = bundles.map((b) => resolveBundle({ bundle: b, profileDir, harnessSlotDir }));
  const failed = resolved.filter((r) => !r.ok);

  const plugins = resolved.map((r) => ({
    name: r.name,
    status: r.ok ? 'ok' : 'import_failed',
    required: CORE_BUNDLES.includes(r.name),
    family: r.name.startsWith('@') ? r.name.split('/')[0] : 'local',
  }));

  const quarantine = readQuarantine({ profileDir });

  const probes = probeUrls.length ? await probeWeb({ urls: probeUrls, timeoutMs }) : [];
  const moduleProbes = moduleUrls.length ? await probeWeb({ urls: moduleUrls, timeoutMs }) : [];
  const serverAnswering = [...probes, ...moduleProbes].some((p) => p.reachable && p.status > 0 && p.status < 500);

  const boot = evaluateBoot({
    plugins,
    // 服务端观测不到客户端服务 —— 明确传 null，让熔断器记 unverified 而不是默认通过
    services: null,
    moduleRequests: moduleProbes.map((p) => ({ url: p.url, status: p.status, contentType: p.contentType })),
    sharedModules: [],
    loaderException: null,
    // 只有拿到「服务器确实在应答」这一条旁证才承认 boot 到过服务阶段
    bootCompleted: serverAnswering ? true : null,
  });

  return {
    audited_at: nowIso(),
    portable_root: portableRoot,
    profile_dir: profileDir,
    harness_slot_dir: harnessSlotDir,
    bundles: {
      total: bundles.length,
      resolved_ok: resolved.length - failed.length,
      failed: failed.length,
      failed_list: failed.map((f) => ({ name: f.name, reason: f.reason })),
    },
    resolved,
    quarantine,
    probes,
    module_probes: moduleProbes,
    note: 'probeUrls 只判存活；moduleUrls 才参与 404 / HTML 判定',
    client_alive_evidence: probes.filter((p) => p.reachable && p.status > 0 && p.status < 400).map((p) => `${p.url} -> ${p.status}`),
    unobservable: [...REQUIRED_CORE_SERVICES],
    boot_verdict: boot,
  };
}
