import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const scriptPath = resolve('Build-UI-Only.ps1')
const windows = { skip: process.platform !== 'win32' }
const script = readFileSync(scriptPath, 'utf8')

// Extract only declared helpers: these tests never execute the build/stage body.
function powershell(body: string, root?: string) {
  const code = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:DSH_UI_ONLY_SCRIPT, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors -join '; ') }
$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }
${body}
exit 0
`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, DSH_UI_ONLY_SCRIPT: scriptPath, DSH_UI_ONLY_TEST_ROOT: root ?? '' },
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  return result.stdout.trim()
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ui-only-protection-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('UI-only detects changed bytes even with identical length and timestamp', windows, t => {
  const root = fixture(t)
  const source = join(root, 'source.html'), target = join(root, 'target.html')
  writeFileSync(source, 'accepted')
  writeFileSync(target, 'replaced')
  const stamp = new Date('2026-09-01T00:00:00Z')
  utimesSync(source, stamp, stamp)
  utimesSync(target, stamp, stamp)
  assert.equal(powershell(`Test-NeedsCopy (Get-Item -LiteralPath (Join-Path $env:DSH_UI_ONLY_TEST_ROOT 'source.html')) (Join-Path $env:DSH_UI_ONLY_TEST_ROOT 'target.html')`, root), 'True')
})

test('UI-only skips equal content despite different timestamp and copies absent targets', windows, t => {
  const root = fixture(t)
  writeFileSync(join(root, 'source.html'), 'accepted')
  writeFileSync(join(root, 'target.html'), 'accepted')
  utimesSync(join(root, 'target.html'), new Date(0), new Date(0))
  const result = powershell(`
$source = Get-Item -LiteralPath (Join-Path $env:DSH_UI_ONLY_TEST_ROOT 'source.html')
@((Test-NeedsCopy $source (Join-Path $env:DSH_UI_ONLY_TEST_ROOT 'target.html')), (Test-NeedsCopy $source (Join-Path $env:DSH_UI_ONLY_TEST_ROOT 'missing.html'))) | ConvertTo-Json -Compress
`, root)
  assert.deepEqual(JSON.parse(result), [false, true])
})

test('UI-only preview creates neither build lock nor parent directory', windows, t => {
  const root = fixture(t)
  powershell(`$handle = Open-UIBuildLock $env:DSH_UI_ONLY_TEST_ROOT $true; if ($null -ne $handle) { throw 'preview acquired a lock' }`, root)
  assert.equal(existsSync(join(root, 'Data')), false)
})

test('UI-only shares exclusive full-build lock and releases it after failed checks', windows, t => {
  const root = fixture(t)
  const output = powershell(`
$handle = Open-UIBuildLock $env:DSH_UI_ONLY_TEST_ROOT $false
try {
  try { $unexpected = Open-UIBuildLock $env:DSH_UI_ONLY_TEST_ROOT $false; $unexpected.Dispose(); throw 'second writer accepted' }
  catch { if ($_.Exception.Message -notlike '*构建锁不可获取*') { throw } }
} finally { $handle.Dispose() }
$next = Open-UIBuildLock $env:DSH_UI_ONLY_TEST_ROOT $false
$next.Dispose()
'released'
`, root)
  assert.equal(output, 'released')
  assert.ok(existsSync(join(root, 'Data', 'Development', 'build-cache', 'build.lock')))
})

test('legacy Force cannot approve source or quality blockers', windows, () => {
  const output = powershell(`
foreach ($force in @($false, $true)) {
  try { Assert-UIBuildVerdict @('src/main.ts') $force; throw 'blocker accepted' }
  catch { if ($_.Exception.Message -notlike '*-Force 不允许绕过门禁*') { throw } }
}
Assert-UIBuildVerdict @() $true
'blocked'
`)
  assert.equal(output, 'blocked')
})

test('UI-only classifies preservation and non-TS executable inputs as full-build changes', windows, () => {
  const output = powershell(`
@('src/main.ts', 'scripts/lib/gate-node.mjs', 'scripts/check.mts', 'plugins/dsh-manual/lib/sources.js', 'customizations/preservation.json', 'package.json') | ForEach-Object { Get-DirtyVerdict $_ } | ConvertTo-Json -Compress
`)
  assert.deepEqual(JSON.parse(output), Array(6).fill('block'))
})

test('missing compiled checker or candidate preservation manifest fails closed before invoking Node', windows, t => {
  const root = fixture(t)
  const resources = join(root, 'resources')
  mkdirSync(resources)
  powershell(`
try { Invoke-UIProtectionGates $env:DSH_UI_ONLY_TEST_ROOT 'must-not-run.exe' (Join-Path $env:DSH_UI_ONLY_TEST_ROOT 'resources'); throw 'missing checker accepted' }
catch { if ($_.Exception.Message -notlike '*定制保护门禁输入缺失*') { throw } }
`, root)
  mkdirSync(join(root, 'dist', 'scripts'), { recursive: true })
  writeFileSync(join(root, 'dist', 'scripts', 'check-customization-preservation.js'), '// fixture, never executed\n')
  powershell(`
try { Invoke-UIProtectionGates $env:DSH_UI_ONLY_TEST_ROOT 'must-not-run.exe' (Join-Path $env:DSH_UI_ONLY_TEST_ROOT 'resources'); throw 'missing resource manifest accepted' }
catch { if ($_.Exception.Message -notlike '*定制保护门禁输入缺失*preservation.json*') { throw } }
`, root)
})

test('protection gates precede copying and cannot be bypassed by DryRun or SkipStage', () => {
  const gates = script.indexOf('Invoke-UIProtectionGates $portableRoot')
  const copy = script.indexOf('Copy-Item -LiteralPath $item.Src')
  const dryRun = script.indexOf('if ($DryRun)')
  const skipStage = script.indexOf('if ($SkipStage)')
  assert.ok(gates > 0 && gates < dryRun && dryRun < copy && copy < skipStage)
  assert.match(script, /assertFreshTestBuild\(process\.cwd\(\)\)/)
  assert.match(script, /ui-baseline\.mjs'\) --source-only/)
  assert.match(script, /\$checker --root \$Root --candidate-manifest \$candidateManifest/)
  assert.match(script, /未找到 git，无法执行源码改动门禁；拒绝界面快通道/)
  assert.match(script, /编译产物目录缺失.*拒绝跳过门禁/)
  assert.match(script, /finally\s*\{\s*if \(\$null -ne \$buildLockStream\) \{ \$buildLockStream\.Dispose\(\) \}/)
  assert.doesNotMatch(script, /Start-Sleep|带着.*未打包改动继续/)
})
