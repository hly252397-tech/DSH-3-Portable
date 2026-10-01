#!/usr/bin/env node
// AgentOS 冷启动验证器
// 目的：在【隔离 HOME / 隔离 profile】里，用一个独立 node 进程真启动指定 harness 槽，
//       证明该槽的制品在冷启动下可加载并 apply() 成功（能抓 "cannot get property X without inject" 那类 apply 期崩溃，
//       而 --dump-config 抓不到）。
// 特性：绝不碰活动 profile / 活动 DSH_HOME；结束后清理隔离目录，只留 result.json + output.log。
// 用法：node AgentOS/scripts/coldstart-verify.mjs [--slot <槽目录名>] [--timeout 90000] [--keep]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HERE = import.meta.dirname;
const PORTABLE = path.resolve(HERE, '..', '..');

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}
const TIMEOUT_MS = Number(flag('timeout') ?? 90_000);
const KEEP = argv.includes('--keep');
// 负向对照：故意在隔离 profile 里加一个解析不到的 bundle，验证器必须报 FAIL。
// 没有这个对照，PASS 只是"没崩"，不能证明探测有效。
const BREAK = argv.includes('--break');

const currentJson = path.join(PORTABLE, 'Data', 'Runtime', 'Harness', 'current.json');
let pointer = null;
try {
  pointer = JSON.parse(readFileSync(currentJson, 'utf8'));
} catch {
  /* 无指针时只能靠 --slot */
}
const slotId = flag('slot') ?? pointer?.current ?? null;
if (!slotId) {
  console.error('COLDSTART: 无法确定槽（current.json 不可读且未传 --slot）');
  process.exit(2);
}
const slotDir = path.join(PORTABLE, 'Data', 'Runtime', 'Harness', 'slots', slotId);

const nodeExe = path.join(PORTABLE, 'App', 'resources', 'node', 'node.exe');
const bootstrap = path.join(PORTABLE, 'dist', 'src', 'dsh-bootstrap.mjs');
const pnpmEntry = path.join(PORTABLE, 'App', 'resources', 'node', 'pnpm-package', 'bin', 'pnpm.cjs');
const entry = path.join(slotDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
const runDir = path.join(PORTABLE, 'AgentOS', 'runtime', 'coldstart', `${stamp}__${slotId}`);
const home = path.join(runDir, 'Home');
const profile = path.join(home, 'profiles', 'web');

const result = {
  slot_id: slotId,
  slot_dir: slotDir,
  started_at: new Date().toISOString(),
  entry_exists: existsSync(entry),
  preflight: {},
  ready: false,
  ready_signal: null,
  exit_code: null,
  signal: null,
  duration_ms: null,
  output_bytes: 0,
  output_tail: '',
  verdict: 'FAIL',
  run_dir: runDir,
};

function finish(code) {
  result.finished_at = new Date().toISOString();
  if (!KEEP) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响判定 */
    }
  }
  writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(`COLDSTART ${result.verdict} slot=${slotId} ready=${result.ready} exit=${result.exit_code} ${result.duration_ms}ms`);
  console.log(`COLDSTART result: ${path.join(runDir, 'result.json')}`);
  process.exit(code);
}

for (const [k, p] of Object.entries({ nodeExe, bootstrap, pnpmEntry })) {
  result.preflight[k] = existsSync(p);
}
if (!result.preflight.nodeExe || !result.preflight.bootstrap || !existsSync(entry)) {
  result.failure_reason = 'preflight 缺文件（node 运行时 / bootstrap / 槽入口）';
  mkdirSync(runDir, { recursive: true });
  finish(3);
}

mkdirSync(runDir, { recursive: true });
mkdirSync(profile, { recursive: true });
writeFileSync(
  path.join(profile, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-coldstart-profile',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: BREAK ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-nonexistent-probe'] : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    },
    null,
    2,
  )}\n`,
  'utf8',
);
writeFileSync(path.join(profile, 'cordis.patch.yml'), '# coldstart probe\n[]\n', 'utf8');
writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: false\n', 'utf8');

const child = spawn(nodeExe, [bootstrap, entry, 'web', '--port', '0', '--no-open'], {
  cwd: os.homedir(),
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_PROFILE_DIR: profile,
    DSH_PROFILE_NAME: 'web',
    DSH_RUNTIME_DIR: slotDir,
    DSH_PNPM_ENTRY: pnpmEntry,
    DSH_PNPM_STORE_DIR: path.join(PORTABLE, 'Data', 'Updates', 'Harness', 'pnpm-store'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
const logFile = path.join(runDir, 'output.log');
const startedAt = Date.now();
const READY_RE = /(https?:\/\/127\.0\.0\.1:(\d+))|(\blistening\b)|(\bready\b)/i;

function onData(chunk) {
  const text = chunk.toString('utf8');
  output += text;
  appendFileSync(logFile, text, 'utf8');
  if (!result.ready) {
    const m = READY_RE.exec(text);
    if (m) {
      result.ready = true;
      result.ready_signal = m[0];
      result.verdict = 'PASS';
      result.duration_ms = Date.now() - startedAt;
      clearTimeout(timer);
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      }, 3_000);
    }
  }
}
child.stdout.on('data', onData);
child.stderr.on('data', onData);

const timer = setTimeout(() => {
  result.duration_ms = Date.now() - startedAt;
  result.failure_reason = `超时 ${TIMEOUT_MS}ms 未出现就绪信号`;
  clearTimeout(timer);
  child.kill('SIGTERM');
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
    finalizeAndExit();
  }, 3_000);
}, TIMEOUT_MS);

let finalized = false;
function finalizeAndExit() {
  if (finalized) return;
  finalized = true;
  result.output_bytes = output.length;
  result.output_tail = output.slice(-4_000);
  if (!result.ready && !result.failure_reason) result.failure_reason = `冷启动进程在就绪前退出（code=${result.exit_code}）`;
  if (output.includes('without inject')) result.failure_reason = 'apply() 期注入失败（without inject）';
  finish(result.verdict === 'PASS' ? 0 : 1);
}

child.once('exit', (code, signal) => {
  result.exit_code = code;
  result.signal = signal;
  result.duration_ms = result.duration_ms ?? Date.now() - startedAt;
  clearTimeout(timer);
  finalizeAndExit();
});