const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const core = path.join(__dirname, 'Health.Core.ps1');
const entry = path.join(__dirname, 'Check-DSH-Health.ps1');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const fixtureParent = path.join(root, '.tmp/health-check-tests');
fs.mkdirSync(fixtureParent, { recursive: true });
const fixture = fs.mkdtempSync(path.join(fixtureParent, 'run-'));
after(() => {
  const resolved = path.resolve(fixture);
  assert.ok(resolved.startsWith(path.resolve(fixtureParent) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
});
function run(code) {
  return new Promise((resolve, reject) => {
    // A Node child of pwsh 7 inherits that host's PSModulePath. Let Windows
    // PowerShell build its own defaults, as it does when Explorer runs the CMD.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
    const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding = New-Object Text.UTF8Encoding; $ErrorActionPreference='Stop'; . ${quote(core)}; ${code}`],
      { windowsHide: true, cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Health test exceeded 15 seconds')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function expression(code, expected) {
  const result = await run(code);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
}
test('Windows PowerShell sources have UTF-8 BOM and wrapper points to the standalone entry', () => {
  for (const file of [core, entry]) assert.equal(fs.readFileSync(file).subarray(0, 3).toString('hex'), 'efbbbf');
  const wrapper = fs.readFileSync(path.join(root, 'Check-DSH-Health.cmd'), 'ascii');
  assert.ok(wrapper.includes('%~dp0scripts\\portable-health\\Check-DSH-Health.ps1'));
  assert.ok(wrapper.includes('%SystemRoot%\\System32\\WindowsPowerShell'));
});
test('quoted options, duplicate arguments and renderer identity', async () => {
  await expression(`
    $profile = 'G:\\DSH-3-Portable\\Data\\Electron\\UserData'
    $production = [pscustomobject]@{ ExecutablePath='G:\\DSH-3-Portable\\App\\DSH Codex Desktop.exe'; CommandLine='"x.exe" --user-data-dir="G:\\DSH-3-Portable\\Data\\Electron\\UserData"'; ProcessId=11 }
    $isolated = [pscustomobject]@{ ExecutablePath=$production.ExecutablePath; CommandLine='"x.exe" --user-data-dir=G:\\DSH-3-Portable\\Data\\diagnostics\\UserData'; ProcessId=22 }
    $renderer = [pscustomobject]@{ ExecutablePath=$production.ExecutablePath; CommandLine=$production.CommandLine+' --type=renderer'; ProcessId=33 }
    $selected = @(Select-HealthDesktop @($production,$isolated,$renderer) 'G:\\DSH-3-Portable' $profile)
    if ($selected.Count -ne 1 -or $selected[0].ProcessId -ne 11) { throw 'Wrong instance selected' }
    if (Get-HealthArgument '--user-data-dir=x --user-data-dir=y' '--user-data-dir') { throw 'Duplicate option accepted' }
    'PASS'`, 'PASS');
});
test('pending transaction is waiting_activation, not completed or failed', async () => {
  await expression(`Get-HealthUpdateStatus ([pscustomobject]@{pending=[pscustomobject]@{transactionId='a'}}) ([pscustomobject]@{phase='deploying';transactionId='a'})`, 'waiting_activation');
});
test('mismatched pending transaction is not labelled waiting activation', async () => {
  await expression(`Get-HealthUpdateStatus ([pscustomobject]@{pending=[pscustomobject]@{transactionId='b'}}) ([pscustomobject]@{phase='deploying';transactionId='a'})`, 'candidate_present');
});
test('failed update remains failed even if a pending pointer exists', async () => {
  await expression(`Get-HealthUpdateStatus ([pscustomobject]@{pending=[pscustomobject]@{transactionId='a'}}) ([pscustomobject]@{phase='failed';transactionId='a'})`, 'failed');
});
test('historic, recent and unknown startup log ages are distinguished', async () => {
  await expression(`@((Get-HealthLogAge ([datetime]'2026-09-01Z') ([datetime]'2026-09-02Z')), (Get-HealthLogAge ([datetime]'2026-09-03Z') ([datetime]'2026-09-02Z')), (Get-HealthLogAge ([datetime]'2026-09-03Z') $null)) -join ','`, 'historical,since_start,unknown_age');
});
test('path traversal, absolute paths, ADS and outside network paths rejected', async () => {
  await expression(`$count=0; foreach($relative in @('..\\secret','C:\\secret','Data\\x:stream','\\\\host\\share')) { try { Resolve-HealthPath ${quote(fixture)} $relative | Out-Null } catch { $count++ } }; $count`, '4');
});
test('directory junctions are rejected before metadata is read', async () => {
  const target = path.join(fixture, 'target'), link = path.join(fixture, 'junction');
  fs.mkdirSync(target); fs.symlinkSync(target, link, 'junction');
  await expression(`try { Resolve-HealthPath ${quote(fixture)} 'junction\\secret.json'; throw 'Accepted junction' } catch { if ($_.Exception.Message -ne 'Reparse point is not inspected') { throw }; 'PASS' }`, 'PASS');
});
test('malformed JSON and oversized metadata fail closed', async () => {
  const bad = path.join(fixture, 'bad.json'), huge = path.join(fixture, 'huge.json');
  fs.writeFileSync(bad, '{broken'); fs.writeFileSync(huge, Buffer.alloc(1024 * 1024 + 1, 32));
  await expression(`$count=0; foreach($file in @(${quote(bad)},${quote(huge)})) { try { Read-HealthJson $file | Out-Null } catch { $count++ } }; $count`, '2');
});
test('missing install metadata yields parseable incomplete JSON and no repair writes', async () => {
  const empty = path.join(fixture, 'empty'); fs.mkdirSync(empty);
  const result = await run(`function Get-CimInstance { @() }; & ${quote(entry)} -PortableRoot ${quote(empty)} -AsJson; exit $LASTEXITCODE`);
  assert.equal(result.code, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.readOnly, true); assert.equal(report.overall, 'incomplete');
  assert.deepEqual(fs.readdirSync(empty), []);
});
test('invalid root is incomplete, never automatically created', async () => {
  const absent = path.join(fixture, 'absent');
  const result = await run(`& ${quote(entry)} -PortableRoot ${quote(absent)} -AsJson; exit $LASTEXITCODE`);
  assert.equal(result.code, 2, result.stderr); assert.equal(JSON.parse(result.stdout).overall, 'incomplete');
  assert.equal(fs.existsSync(absent), false);
});
test('HTTP success, authentication, server failure and redirect are observable without cookies or following redirects', async () => {
  let calls = 0;
  const codes = [200, 401, 500, 302];
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined);
    const code = codes[calls++]; res.writeHead(code, { Location: 'http://127.0.0.1:1/do-not-follow' }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await expression(`@(1..4 | ForEach-Object { Test-HealthHttp '127.0.0.1' ${server.address().port} 2 }) -join ','`, '200,401,500,302');
    assert.equal(calls, 4);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('HTTP timeout is bounded and external addresses rejected', async () => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await expression(`$count=0; try { Test-HealthHttp '127.0.0.1' ${server.address().port} 1 } catch { $count++ }; try { Test-HealthHttp 'example.com' 80 1 } catch { $count++ }; $count`, '2');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

function installFixture(name) {
  const install = path.join(fixture, name);
  const write = (relative, text) => { const file = path.join(install, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const manifest = JSON.stringify({ schema: 1, version: '1.2.3', files: {} });
  write('App/slot-manifest.json', manifest);
  write('App/DSH Codex Desktop.exe', 'test fixture, not executable');
  write('App/resources/app.asar', 'fixture');
  const slot = { relativePath: 'App', version: '1.2.3', sha256: createHash('sha256').update(manifest).digest('hex'), transactionId: 'fixture' };
  write('Data/Updates/Desktop/pointer.json', JSON.stringify({ current: slot, pending: slot }));
  write('Data/Updates/Desktop/state.json', JSON.stringify({ phase: 'deploying', overallProgress: 94, transactionId: 'fixture' }));
  write('Data/Runtime/Harness/current.json', JSON.stringify({ current: { version: '0.1.2-alpha.5' } }));
  write('Data/Electron/UserData/startup-error.log', 'secret-test-value-must-not-be-exported');
  return { install, write };
}
test('stopped production, low-space warning and corrupt slot are separately classified without exposing logs', async () => {
  const { install, write } = installFixture('status-fixture');
  const invoke = extra => run(`function Get-CimInstance { @() }; & ${quote(entry)} -PortableRoot ${quote(install)} -AsJson ${extra}; exit $LASTEXITCODE`);
  const stopped = await invoke('-MinimumFreeGB 0');
  assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
  assert.ok(!stopped.stdout.includes('secret-test-value'));
  assert.equal(JSON.parse(stopped.stdout).checks.find(x => x.id === 'update').evidence.state, 'waiting_activation');
  const low = await invoke('-MinimumFreeGB 1024');
  assert.equal(low.code, 1, low.stderr);
  assert.equal(JSON.parse(low.stdout).checks.find(x => x.id === 'disk').status, 'warning');
  write('App/slot-manifest.json', '{}');
  const corrupt = await invoke('-MinimumFreeGB 0');
  assert.equal(corrupt.code, 1, corrupt.stderr);
  assert.equal(JSON.parse(corrupt.stdout).checks.find(x => x.id === 'desktop_current').status, 'error');
});
test('production runtime pipeline reads only matching child and probes the selected loopback endpoint', async () => {
  const { install, write } = installFixture('runtime-fixture');
  write('Data/Runtime/dsh-runtime/node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ version: '0.1.2-alpha.5' }));
  write('Data/Runtime/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', 'fixture');
  const server = http.createServer((req, res) => { res.writeHead(401); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await run(`
      $fixtureRoot=${quote(install)}
      $desktop=[pscustomobject]@{Name='DSH Codex Desktop.exe';ProcessId=11;ParentProcessId=1;CreationDate=[datetime]'2026-09-01Z';ExecutablePath=(Join-Path $fixtureRoot 'App\\DSH Codex Desktop.exe');CommandLine=('"desktop.exe" --user-data-dir="'+(Join-Path $fixtureRoot 'Data\\Electron\\UserData')+'"')}
      $child=[pscustomobject]@{Name='node.exe';ProcessId=22;ParentProcessId=11;CreationDate=[datetime]'2026-09-01Z';ExecutablePath=(Join-Path $fixtureRoot 'App\\resources\\node\\node.exe');CommandLine=('"node.exe" "'+(Join-Path $fixtureRoot 'App\\resources\\bootstrap.mjs')+'" "'+(Join-Path $fixtureRoot 'Data\\Runtime\\dsh-runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')+'" web --port 0 --no-open')}
      function Get-CimInstance { param($ClassName,$Filter); if($Filter -eq 'ProcessId = 11') {$desktop} elseif($Filter -eq 'ProcessId = 22') {$child} else {@($desktop,$child)} }
      function Get-NetTCPConnection { [pscustomobject]@{OwningProcess=22;LocalAddress='127.0.0.1';LocalPort=${server.address().port}} }
      & ${quote(entry)} -PortableRoot $fixtureRoot -AsJson -MinimumFreeGB 0; exit $LASTEXITCODE`);
    const report = JSON.parse(result.stdout);
    assert.ok(report.checks, result.stdout + result.stderr);
    assert.equal(report.checks.find(x => x.id === 'runtime_process')?.evidence.version, '0.1.2-alpha.5', result.stdout + result.stderr);
    assert.equal(report.checks.find(x => x.id === 'service')?.evidence.httpStatus, 401, result.stdout);
    // The fake exe has no version resource: must not be marked fully verified.
    assert.equal(report.overall, 'incomplete');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('a concurrent pointer change produces an incomplete snapshot', async () => {
  const { install } = installFixture('changing-fixture');
  const pointer = path.join(install, 'Data/Updates/Desktop/pointer.json');
  const result = await run(`
    function Get-CimInstance { [IO.File]::WriteAllText(${quote(pointer)}, '{}'); @() }
    & ${quote(entry)} -PortableRoot ${quote(install)} -AsJson -MinimumFreeGB 0; exit $LASTEXITCODE`);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).checks.find(x => x.id === 'snapshot').status, 'unknown');
});
