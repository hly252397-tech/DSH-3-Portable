// 测试运行器：把子进程 TEMP/TMP 收口到本次运行目录；全绿即删，失败保留现场。
// 与仓库既定纪律一致（避免 tmpdir 残留堆积）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-test-'));

const env = {
  ...process.env,
  TEMP: runDir,
  TMP: runDir,
  TMPDIR: runDir,
  AGENTOS_TEST_TMP: runDir,
};

const targets = process.argv.slice(2);
let files = targets;
if (!files.length) {
  const testDir = path.join(root, 'test');
  files = fs
    .readdirSync(testDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => path.join(testDir, f));
}
const testArgs = ['--test', ...files];

const r = spawnSync(process.execPath, testArgs, { cwd: root, env, stdio: 'inherit', windowsHide: true });
const code = r.status ?? 1;

if (code === 0 && process.env.DSH_TEST_KEEP_TMP !== '1') {
  fs.rmSync(runDir, { recursive: true, force: true });
  process.stdout.write(`\n[agentos] all green; temp cleaned: ${runDir}\n`);
} else {
  process.stdout.write(`\n[agentos] non-zero (${code}); temp kept for triage: ${runDir}\n`);
}
process.exit(code);
