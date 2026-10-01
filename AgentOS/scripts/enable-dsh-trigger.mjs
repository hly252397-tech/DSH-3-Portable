// 一次性启用脚本：登记本地插件 + 建 Junction + 语法检查。
// 幂等；改 profile package.json 前先备份。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const P = 'G:/DSH-3-Portable/Data/DSH/profiles/web';
const pkgFile = path.join(P, 'package.json');
const raw = fs.readFileSync(pkgFile, 'utf8');
const report = { steps: [] };

// ---- 1) 备份 ----
const bak = pkgFile + '.bak-before-agentos-trigger';
if (!fs.existsSync(bak)) {
  fs.writeFileSync(bak, raw);
  report.steps.push({ step: 'backup', ok: true, file: bak });
} else {
  report.steps.push({ step: 'backup', ok: true, file: bak, note: 'already exists, kept' });
}

// ---- 2) 登记 ----
if (raw.includes('"dsh-agentos-trigger"')) {
  report.steps.push({ step: 'register', ok: true, note: 'already registered' });
} else {
  let out = raw;
  const depAnchor = '"dshmarket": "1.47.0",';
  const depLine = '"dsh-agentos-trigger": "link:local\\\\dsh-agentos-trigger",\n    ';
  if (!out.includes(depAnchor)) throw new Error('dependency anchor not found: ' + depAnchor);
  out = out.replace(depAnchor, depLine + depAnchor);

  const bundleRe = /(\s*)("dsh-ui-tweaks")(\s*)\]/;
  if (!bundleRe.test(out)) throw new Error('bundle anchor not found (dsh-ui-tweaks ... ])');
  out = out.replace(bundleRe, (_m, sp, name, sp2) => `${sp}${name},${sp}${sp}"dsh-agentos-trigger"${sp}]`);

  const parsed = JSON.parse(out); // 合法性校验：非法就不写
  const inDeps = Boolean(parsed.dependencies['dsh-agentos-trigger']);
  const inBundles = parsed.dsh.profile.bundles.includes('dsh-agentos-trigger');
  if (!inDeps || !inBundles) throw new Error('post-edit verification failed: deps=' + inDeps + ' bundles=' + inBundles);

  fs.writeFileSync(pkgFile, out);
  report.steps.push({ step: 'register', ok: true, in_dependencies: inDeps, in_bundles: inBundles, bundles_count: parsed.dsh.profile.bundles.length });
}

// ---- 3) Junction ----
const nm = path.join(P, 'node_modules', 'dsh-agentos-trigger');
const target = path.join(P, 'local', 'dsh-agentos-trigger');
if (fs.existsSync(nm)) {
  report.steps.push({ step: 'junction', ok: true, note: 'already exists', realpath: fs.realpathSync(nm) });
} else {
  fs.symlinkSync(target, nm, 'junction');
  report.steps.push({ step: 'junction', ok: true, created: true, from: nm, to: target, realpath: fs.realpathSync(nm) });
}

// ---- 4) 语法检查（宿主半侧 + 客户端半侧 + AgentOS 新模块） ----
const checks = [
  path.join(target, 'lib', 'index.js'),
  path.join(target, 'lib', 'client.js'),
  'G:/DSH-3-Portable/AgentOS/lib/triggerpolicy.mjs',
  'G:/DSH-3-Portable/AgentOS/lib/stablerecovery.mjs',
  'G:/DSH-3-Portable/AgentOS/lib/bootforensics.mjs',
];
for (const f of checks) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', windowsHide: true });
  report.steps.push({ step: 'syntax', file: f, ok: r.status === 0, detail: r.status === 0 ? 'ok' : String(r.stderr || '').trim().slice(0, 200) });
}

// ---- 5) 宿主半侧能否被 import（最关键的加载风险）----
try {
  const mod = await import('file:///' + path.join(target, 'lib', 'index.js').replace(/\\/g, '/'));
  report.steps.push({ step: 'host_import', ok: true, exports: Object.keys(mod), inject: mod.inject, name: mod.name });
} catch (e) {
  report.steps.push({ step: 'host_import', ok: false, error: String(e?.message ?? e) });
}

console.log(JSON.stringify(report, null, 2));
