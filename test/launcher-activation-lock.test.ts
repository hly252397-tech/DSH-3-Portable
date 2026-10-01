import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { acquireBuildCacheLock } from '../src/build-cache.js'
import { makeTrackedTempDirSync } from './helpers/tmp.js'

const scriptPath = resolve('Start-DSH-Portable.ps1')
const source = readFileSync(scriptPath, 'utf8')
const windows = { skip: process.platform !== 'win32' }
const producer = 'local-build-receipt-v1'
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const required = [
  'DSH Codex Desktop.exe', 'resources/app.asar', 'resources/node/node.exe',
  'resources/dsh-runtime.tgz', 'resources/dsh-runtime.tgz.sha256',
  'resources/plugins-store.tgz', 'resources/plugins-store.tgz.sha256',
  'resources/desktop-bridge/dsh-process.js', 'resources/desktop-bridge/profile-bundle-health.js',
  'resources/desktop-bridge/profile-quarantine.js', 'resources/process-control.js',
]
function put(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
function json(path: string, value: unknown) { put(path, `${JSON.stringify(value)}\n`) }
function rootFixture() { return makeTrackedTempDirSync(join(tmpdir(), 'dsh-launcher-lease-')) }
function slotFixture(root: string, version = '9.0.0', finalized = true, local = true) {
  const transactionId = randomUUID()
  const relativePath = `Data/Updates/Desktop/slots/${version}-txn-${transactionId.slice(0, 8)}`
  const directory = join(root, relativePath)
  const files: Record<string, string> = {}
  for (const path of [...required, 'resources/assets/shell.css']) {
    const content = `fixture:${version}:${path}`
    put(join(directory, path), content)
    files[path] = sha(content)
  }
  json(join(directory, 'slot-manifest.json'), {
    schema: 1, version, files,
    ...(local ? { producer, transactionId, completeFileList: true } : {}),
  })
  const reference = {
    relativePath, version, sha256: sha(readFileSync(join(directory, 'slot-manifest.json'))),
    ...(local ? { producer, transactionId } : {}),
  }
  const transactionRoot = join(root, 'Data/Updates/Desktop/transactions', transactionId)
  if (local) {
    const proof = {
      schema: 1, producer, transactionId, slotRelativePath: relativePath, version,
      slotManifestSha256: reference.sha256, inputFingerprint: sha(`input:${version}`),
      coreFingerprint: sha(`core:${version}`), asarSha256: files['resources/app.asar'],
    }
    json(join(transactionRoot, 'build-intent.json'), proof)
    json(join(transactionRoot, 'build-receipt.json'), {
      schema: 1, kind: 'dsh-desktop-build', status: 'validated', mode: 'full',
      inputs: { schema: 1, policy: 1, fingerprint: proof.inputFingerprint, coreFingerprint: proof.coreFingerprint },
      asar: { path: 'release/win-unpacked/resources/app.asar', sha256: proof.asarSha256 },
    })
    if (finalized) json(join(transactionRoot, 'build-finalized.json'), {
      ...proof, receiptSha256: sha(readFileSync(join(transactionRoot, 'build-receipt.json'))),
    })
  }
  return { reference, directory, transactionRoot, files }
}
function markSlotHealthy(slot: ReturnType<typeof slotFixture>) {
  json(join(slot.transactionRoot, 'health.json'), {
    transactionId: slot.reference.transactionId, version: slot.reference.version,
    completedAt: '2026-09-30T12:00:00.000Z',
  })
}
function pendingFixture(finalized = true) {
  const root = rootFixture()
  const old = slotFixture(root, '8.0.0', true, false)
  const candidate = slotFixture(root, '9.0.0', finalized)
  const pointer = { schema: 1, current: old.reference, pending: candidate.reference }
  json(join(root, 'Data/Updates/Desktop/pointer.json'), pointer)
  return { root, old, candidate, pointer }
}

// Load helpers only through the PowerShell parser: no launcher body, real app,
// build command, real portable Data, or deployment/restart is ever executed.
function powershell(body: string, root: string, extra: Record<string, string> = {}) {
  const code = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:DSH_LAUNCHER_SCRIPT, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors -join '; ') }
foreach ($function in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Invoke-Expression $function.Extent.Text }
$portableRoot = $env:DSH_LAUNCHER_TEST_ROOT
$desktopUpdateRoot = Join-Path $portableRoot 'Data/Updates/Desktop'
$pointerPath = Join-Path $desktopUpdateRoot 'pointer.json'
$statePath = Join-Path $desktopUpdateRoot 'state.json'
$logPath = Join-Path $desktopUpdateRoot 'launcher.log'
$portablePaths = [pscustomobject]@{ Development = (Join-Path $portableRoot 'Data/Development'); Temp = (Join-Path $portableRoot 'Data/Temp') }
$cacheRoot = Join-Path $portablePaths.Development 'build-cache'
${body}
exit 0
`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, DSH_LAUNCHER_SCRIPT: scriptPath, DSH_LAUNCHER_TEST_ROOT: root, ...extra },
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  return result.stdout.trim()
}
const verifyLeaseReleased = `
if (-not (Test-ExclusivePathAvailable (Join-Path $cacheRoot 'build.lock'))) { throw 'build lease leaked' }
if (Test-Path -LiteralPath (Join-Path $cacheRoot 'assembly.lock')) { throw 'assembly lease leaked' }
if (-not (Test-ExclusivePathAvailable (Join-Path $desktopUpdateRoot 'operation.lock'))) { throw 'pointer lease leaked' }
`
const mockedOldLaunch = `
$script:oldLaunches = 0
function Start-DesktopApplicationReliable {
  param([string]$Executable)
  if ($Executable -ne 'old-fixture') { throw 'unexpected old executable' }
  if (-not (Test-ExclusivePathAvailable (Join-Path $desktopUpdateRoot 'operation.lock'))) { throw 'D held during old start' }
  $script:oldLaunches++
}
`

test('launcher keeps BOM and pending-only L/A lease, D release before start, finally cleanup', () => {
  assert.equal(source.charCodeAt(0), 0xfeff)
  assert.match(source, /if \(\$pendingReference\) \{\s+Invoke-PendingDesktopActivation/)
  assert.match(source, /Invoke-PendingDesktopActivation[\s\S]*try \{ Clear-DesktopActivationEnvironment \} finally \{ Close-PendingDesktopActivationLease/)
  assert.match(source, /function Invoke-DesktopActivationPointerCas[\s\S]*finally \{[\s\S]*\$pointerLease\.Dispose\(\)/)
  assert.doesNotMatch(source, /\$buildBusy = -not \(Test-ExclusivePathAvailable/)
  const ordinaryStart = source.slice(source.lastIndexOf('if ($pendingReference)'))
  assert.doesNotMatch(ordinaryStart.slice(ordinaryStart.indexOf("throw '未找到")), /Open-PendingDesktopActivationLease/)
})

test('strict launcher accepts ordinary directory and file ancestors without provider-only properties', windows, () => {
  const root = rootFixture()
  put(join(root, 'ordinary/nested/deeper/asset.txt'), 'ordinary file')
  assert.equal(powershell(`
$directory = Join-Path $portableRoot 'ordinary/nested/deeper'
$file = Join-Path $directory 'asset.txt'
if (-not (Test-OrdinaryPortablePath -Path $portableRoot -Directory)) { throw 'ordinary fixture root rejected' }
if (-not (Test-OrdinaryPortablePath -Path $directory -Directory)) { throw 'ordinary nested directory rejected' }
if (-not (Test-OrdinaryPortablePath -Path $file)) { throw 'ordinary nested file rejected' }
if (Test-OrdinaryPortablePath -Path $file -Directory) { throw 'file treated as directory' }
if (Test-OrdinaryPortablePath -Path $directory) { throw 'directory treated as file' }
if (Test-OrdinaryPortablePath -Path (Join-Path $directory 'missing.txt')) { throw 'missing path accepted' }
if (Test-OrdinaryPortablePath -Path ([System.IO.Path]::GetDirectoryName($portableRoot)) -Directory) { throw 'outside fixture root accepted' }
'ordinary-pass'
`, root), 'ordinary-pass')
})

test('strict launcher rejects junction ancestors for both ordinary-looking directory and file leaves', windows, () => {
  const root = rootFixture()
  const target = join(root, 'ordinary-target')
  put(join(target, 'nested/deeper/asset.txt'), 'ordinary physical target')
  symlinkSync(target, join(root, 'linked-ancestor'), 'junction')
  assert.equal(powershell(`
$targetDirectory = Join-Path $portableRoot 'ordinary-target/nested/deeper'
if (-not (Test-OrdinaryPortablePath -Path $targetDirectory -Directory)) { throw 'physical ordinary directory rejected' }
if (-not (Test-OrdinaryPortablePath -Path (Join-Path $targetDirectory 'asset.txt'))) { throw 'physical ordinary file rejected' }
$linkedDirectory = Join-Path $portableRoot 'linked-ancestor/nested/deeper'
if (Test-OrdinaryPortablePath -Path (Join-Path $portableRoot 'linked-ancestor') -Directory) { throw 'junction leaf accepted' }
if (Test-OrdinaryPortablePath -Path $linkedDirectory -Directory) { throw 'directory beneath junction accepted' }
if (Test-OrdinaryPortablePath -Path (Join-Path $linkedDirectory 'asset.txt')) { throw 'file beneath junction accepted' }
'junction-rejected'
`, root), 'junction-rejected')
})

test('pending holds L/A atomically and real Node assembly owner protocol rejects it, D remains free', windows, () => {
  const root = rootFixture()
  const moduleUrl = new URL('../src/build-cache.js', import.meta.url).href
  const nodeCheck = `import {acquireBuildCacheLock} from ${JSON.stringify(moduleUrl)}; try { const release = await acquireBuildCacheLock(process.env.DSH_ASSEMBLY_ROOT,{waitMs:100,pollMs:5}); await release(); process.exit(42) } catch(error) { if(!String(error.message).includes('超时')) throw error; process.stdout.write('node-A-blocked') }`
  const output = powershell(`
$lease = Open-PendingDesktopActivationLease $cacheRoot
if ($null -eq $lease) { throw 'lease not acquired' }
try {
  if (Test-ExclusivePathAvailable (Join-Path $cacheRoot 'build.lock')) { throw 'L not exclusive' }
  $owner = Get-Content -LiteralPath $lease.AssemblyPath -Raw | ConvertFrom-Json
  if ($owner.pid -ne $PID -or $owner.token -ne $lease.AssemblyToken) { throw 'A owner mismatch' }
  $second = Open-PendingDesktopActivationLease $cacheRoot
  if ($null -ne $second) { Close-PendingDesktopActivationLease $second; throw 'second launcher lease allowed' }
  $d = Open-DesktopPointerLease -WaitMs 0
  if ($null -eq $d) { throw 'candidate confirmation D blocked by L/A' }; $d.Dispose()
  $env:DSH_ASSEMBLY_ROOT = $cacheRoot
  & $env:DSH_LAUNCHER_NODE --input-type=module -e 'await import(process.env.DSH_ASSEMBLY_CHECK)'
  if ($LASTEXITCODE -ne 0) { throw 'real Node assembly protocol accepted launcher lease' }
} finally { Close-PendingDesktopActivationLease $lease }
${verifyLeaseReleased}
`, root, { DSH_LAUNCHER_NODE: process.execPath, DSH_ASSEMBLY_CHECK: `data:text/javascript;base64,${Buffer.from(nodeCheck).toString('base64')}` })
  assert.equal(output, 'node-A-blocked')
})

test('live or malformed A is never stolen and failed claim releases L', windows, () => {
  const root = rootFixture()
  powershell(`
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
$a = Join-Path $cacheRoot 'assembly.lock'
foreach ($raw in @('not-json', ('{"pid":' + $PID + ',"token":"other-live-owner"}'))) {
  [IO.File]::WriteAllText($a, $raw)
  if ($null -ne (Open-PendingDesktopActivationLease $cacheRoot)) { throw 'existing owner stolen' }
  if ([IO.File]::ReadAllText($a) -ne $raw) { throw 'existing owner changed' }
  if (-not (Test-ExclusivePathAvailable (Join-Path $cacheRoot 'build.lock'))) { throw 'L leaked after rejected A' }
}
`, root)
})

test('normal owner-JSON write failure removes only self-created A and releases L', windows, () => {
  const root = rootFixture()
  powershell(`
$function = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Open-PendingDesktopActivationLease' }, $true)[0]
# Fault injection is confined to this helper-only fixture, never production.
$definition = $function.Extent.Text.Replace('$assemblyStream.Write($bytes, 0, $bytes.Length)', "throw 'fixture-owner-write-failure'")
if ($definition -eq $function.Extent.Text) { throw 'write fault not injected' }
Invoke-Expression $definition
if ($null -ne (Open-PendingDesktopActivationLease $cacheRoot)) { throw 'failed owner write returned lease' }
${verifyLeaseReleased}
`, root)
})

test('A finalizer cannot delete a successor token, crash owner can be reclaimed by real Node', windows, async () => {
  const root = rootFixture()
  powershell(`
$lease = Open-PendingDesktopActivationLease $cacheRoot
Save-JsonAtomic -Value ([ordered]@{ pid = $PID; token = 'successor' }) -Path $lease.AssemblyPath
Close-PendingDesktopActivationLease $lease
if ((Get-Content -LiteralPath (Join-Path $cacheRoot 'assembly.lock') -Raw | ConvertFrom-Json).token -ne 'successor') { throw 'successor deleted' }
if (-not (Test-ExclusivePathAvailable (Join-Path $cacheRoot 'build.lock'))) { throw 'L not released' }
`, root)
  // Remove only the exact synthetic successor in this registered fixture.
  rmSync(join(root, 'Data/Development/build-cache/assembly.lock'))
  powershell('$lease = Open-PendingDesktopActivationLease $cacheRoot; if ($null -eq $lease) { throw "no crash lease" }; exit 0', root)
  const release = await acquireBuildCacheLock(join(root, 'Data/Development/build-cache'), { waitMs: 2000, pollMs: 10 })
  await release()
  assert.equal(existsSync(join(root, 'Data/Development/build-cache/assembly.lock')), false)
})

test('pointer CAS rejects changed current, previous or transaction, and never rolls committed current back', windows, () => {
  const { root, pointer, candidate } = pendingFixture()
  const result = JSON.parse(powershell(`
$expected = Get-DesktopPointer
$statuses = @()
foreach ($field in @('current', 'previous', 'pending')) {
  $changed = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
  if ($field -eq 'previous') { $changed | Add-Member NoteProperty previous ([pscustomobject]@{ relativePath='other';version='1';sha256='changed' }) }
  else { $changed.$field.relativePath = 'other-' + $field }
  Save-JsonAtomic $changed $pointerPath
  $statuses += (Invoke-DesktopActivationPointerCas $expected { throw 'CAS action ran over changed pointer' }).Status
  Save-JsonAtomic $expected $pointerPath
}
Save-JsonAtomic ([ordered]@{ schema=1;current=$expected.pending;previous=$expected.current }) $pointerPath
Save-JsonAtomic ([ordered]@{ phase='validating';transactionId=$expected.pending.transactionId }) $statePath
$statuses += (Invoke-DesktopActivationPointerCas $expected { throw 'rolled back current candidate' }).Status
Save-JsonAtomic ([ordered]@{ phase='completed';transactionId=$expected.pending.transactionId }) $statePath
$statuses += (Invoke-DesktopActivationPointerCas $expected { throw 'rolled back completed candidate' }).Status
$statuses | ConvertTo-Json -Compress
${verifyLeaseReleased}
`, root)) as string[]
  assert.deepEqual(result, ['changed', 'changed', 'changed', 'candidate-current', 'committed'])
  assert.equal(JSON.parse(readFileSync(join(root, 'Data/Updates/Desktop/pointer.json'), 'utf8')).current.relativePath, candidate.reference.relativePath)
  assert.equal(pointer.current.version, '8.0.0')
})

test('accepted producer full closure resolves and recovery skips higher unfinalized or untested local slots', windows, () => {
  const root = rootFixture()
  const older = slotFixture(root, '8.0.0')
  markSlotHealthy(older)
  slotFixture(root, '9.0.0', false)
  slotFixture(root, '10.0.0', true)
  const output = JSON.parse(powershell(`
$selection = Resolve-BestAvailableDesktopApplication ([pscustomobject]@{ current = ([pscustomobject]@{ relativePath='broken-current' }); previous=([pscustomobject]@{ relativePath='broken-previous' }) })
if ($null -eq $selection) { throw 'healthy slot not recovered' }
$selection.Reference | ConvertTo-Json -Compress
`, root))
  assert.equal(output.relativePath, older.reference.relativePath)
  assert.equal(output.producer, producer)
  assert.equal(output.transactionId, older.reference.transactionId)
})

test('finalized but never accepted local slot is usable by current/previous/pending but not scanner', windows, () => {
  const root = rootFixture()
  const slot = slotFixture(root)
  json(join(root, 'reference.json'), slot.reference)
  powershell(`
$reference = Get-Content -LiteralPath (Join-Path $portableRoot 'reference.json') -Raw | ConvertFrom-Json
if ($null -eq (Resolve-SlotApplication $reference)) { throw 'normal candidate validation changed' }
if ((Resolve-BestAvailableDesktopApplication ([pscustomobject]@{ current=$reference })).Source -ne 'pointer-current') { throw 'current acceptance compatibility changed' }
if ((Resolve-BestAvailableDesktopApplication ([pscustomobject]@{ previous=$reference })).Source -ne 'pointer-previous') { throw 'previous acceptance compatibility changed' }
if (Test-LocalDesktopSlotHealthy $reference) { throw 'finalized treated as startup acceptance' }
if ($null -ne (Resolve-BestAvailableDesktopApplication $null)) { throw 'unaccepted candidate promoted by scan' }
`, root)
})

for (const kind of ['missing', 'malformed', 'wrong-transaction', 'wrong-version', 'invalid-time', 'missing-time', 'non-utc-time', 'oversized', 'ancestor-junction'] as const) {
  test(`scanner startup acceptance rejects ${kind} health receipt`, windows, () => {
    const root = rootFixture()
    const slot = slotFixture(root)
    markSlotHealthy(slot)
    const path = join(slot.transactionRoot, 'health.json')
    if (kind === 'missing') rmSync(path)
    if (kind === 'malformed') put(path, '{broken-json')
    if (kind === 'oversized') put(path, ' '.repeat(65537))
    if (kind === 'wrong-transaction' || kind === 'wrong-version' || kind === 'invalid-time' || kind === 'missing-time' || kind === 'non-utc-time') {
      const health = JSON.parse(readFileSync(path, 'utf8'))
      if (kind === 'wrong-transaction') health.transactionId = randomUUID()
      if (kind === 'wrong-version') health.version = 'unrelated-version'
      if (kind === 'invalid-time') health.completedAt = '2026-02-31T12:00:00.000Z'
      if (kind === 'missing-time') delete health.completedAt
      if (kind === 'non-utc-time') health.completedAt = '2026-09-30T12:00:00.000+08:00'
      json(path, health)
    }
    if (kind === 'ancestor-junction') {
      const target = join(root, 'synthetic-accepted-proof-target')
      renameSync(slot.transactionRoot, target); symlinkSync(target, slot.transactionRoot, 'junction')
    }
    json(join(root, 'reference.json'), slot.reference)
    assert.equal(powershell(`
$reference = Get-Content -LiteralPath (Join-Path $portableRoot 'reference.json') -Raw | ConvertFrom-Json
if (Test-LocalDesktopSlotHealthy $reference) { throw 'invalid health receipt accepted' }
if ($null -ne (Resolve-BestAvailableDesktopApplication $null)) { throw 'invalid health promoted by scan' }
'rejected'
`, root), 'rejected')
  })
}

test('scanner health is transaction-scoped, independent of global state, and rechecked before D recovery save', windows, () => {
  const root = rootFixture()
  const slot = slotFixture(root)
  markSlotHealthy(slot)
  json(join(root, 'reference.json'), slot.reference)
  powershell(`
$reference = Get-Content -LiteralPath (Join-Path $portableRoot 'reference.json') -Raw | ConvertFrom-Json
Save-JsonAtomic ([ordered]@{ phase='error';transactionId=[guid]::NewGuid().ToString() }) $statePath
if (-not (Test-LocalDesktopSlotHealthy $reference)) { throw 'unrelated global update hid accepted slot' }
$selection = Resolve-BestAvailableDesktopApplication $null
if ($selection.Source -ne 'slot-scan') { throw 'accepted slot not found' }
Remove-Item -LiteralPath (Join-Path $desktopUpdateRoot ('transactions/' + $reference.transactionId + '/health.json'))
if (Test-LocalDesktopSlotHealthy $selection.Reference) { throw 'changed health receipt remained cached' }
`, root)
  const recovery = source.slice(source.lastIndexOf("if ($launchSelection -and $launchSelection.Source -ne 'pointer-current')"))
  const gate = recovery.indexOf("$launchSelection.Source -eq 'slot-scan' -and -not (Test-LocalDesktopSlotHealthy")
  assert.ok(gate > recovery.indexOf('$recoveryLease = Open-DesktopPointerLease'))
  assert.ok(gate < recovery.indexOf('Save-RecoveredDesktopPointer -Reference $launchSelection.Reference'))
  assert.ok(recovery.indexOf('$recoveryLease.Dispose()') > gate)
})

for (const kind of ['missing-finalized', 'receipt-changed', 'proof-transaction', 'proof-slot', 'input-fingerprint', 'extra-file', 'missing-asset', 'changed-asset', 'directory-junction', 'proof-ancestor-junction'] as const) {
  test(`producer closure rejects ${kind} without slot-scan bypass`, windows, () => {
    const root = rootFixture()
    const slot = slotFixture(root)
    const finalizedPath = join(slot.transactionRoot, 'build-finalized.json')
    if (kind === 'missing-finalized') rmSync(finalizedPath)
    if (kind === 'receipt-changed') put(join(slot.transactionRoot, 'build-receipt.json'), '{}\n')
    if (kind === 'proof-transaction' || kind === 'proof-slot' || kind === 'input-fingerprint') {
      const proof = JSON.parse(readFileSync(finalizedPath, 'utf8'))
      if (kind === 'proof-transaction') proof.transactionId = randomUUID()
      if (kind === 'proof-slot') proof.slotRelativePath = 'Data/Updates/Desktop/slots/unrelated'
      if (kind === 'input-fingerprint') proof.inputFingerprint = '0'.repeat(64)
      json(finalizedPath, proof)
    }
    if (kind === 'extra-file') put(join(slot.directory, 'resources/assets/extra.css'), 'unexpected')
    if (kind === 'missing-asset') rmSync(join(slot.directory, 'resources/assets/shell.css'))
    if (kind === 'changed-asset') put(join(slot.directory, 'resources/assets/shell.css'), 'reverted')
    if (kind === 'directory-junction') {
      const original = join(slot.directory, 'resources/assets')
      const target = join(root, 'synthetic-assets-target')
      renameSync(original, target); symlinkSync(target, original, 'junction')
    }
    if (kind === 'proof-ancestor-junction') {
      const target = join(root, 'synthetic-proof-target')
      renameSync(slot.transactionRoot, target); symlinkSync(target, slot.transactionRoot, 'junction')
    }
    json(join(root, 'reference.json'), slot.reference)
    assert.equal(powershell(`
$reference = Get-Content -LiteralPath (Join-Path $portableRoot 'reference.json') -Raw | ConvertFrom-Json
if ($null -ne (Resolve-SlotApplication $reference)) { throw 'bad local slot resolved' }
if ($null -ne (Resolve-BestAvailableDesktopApplication $null)) { throw 'bad local slot bypassed via scan' }
'rejected'
`, root), 'rejected')
  })
}

test('full manifest paths must be canonical, bounded, ordinary and complete; legacy slots retain old rules', windows, () => {
  const root = rootFixture()
  const local = slotFixture(root)
  const legacy = slotFixture(root, '7.0.0', true, false)
  put(join(legacy.directory, 'resources/assets/legacy-extra.css'), 'legacy remains compatible')
  json(join(root, 'reference.json'), local.reference)
  json(join(root, 'legacy-reference.json'), legacy.reference)
  powershell(`
$reference = Get-Content -LiteralPath (Join-Path $portableRoot 'reference.json') -Raw | ConvertFrom-Json
$directory = Join-Path $portableRoot $reference.relativePath
$manifest = Get-Content -LiteralPath (Join-Path $directory 'slot-manifest.json') -Raw | ConvertFrom-Json
foreach ($relative in @('../escape', '/rooted', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a/CON', 'a/trailing.', 'a/space ')) {
  $copy = $manifest | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $copy.files | Add-Member NoteProperty $relative ('a' * 64)
  if (Test-CompleteDesktopSlotFiles $copy $directory) { throw ('accepted unsafe file path: ' + $relative) }
}
$manifest.completeFileList = 'true'
if (Test-CompleteDesktopSlotFiles $manifest $directory) { throw 'accepted nonboolean closure flag' }
$legacy = Get-Content -LiteralPath (Join-Path $portableRoot 'legacy-reference.json') -Raw | ConvertFrom-Json
if ($null -eq (Resolve-SlotApplication $legacy)) { throw 'legacy required-file policy regressed' }
`, root)
})

test('unfinalized local pending is preserved, no activation attempt is written and leases release', windows, () => {
  const { root, candidate } = pendingFixture(false)
  powershell(`
${mockedOldLaunch}
function Start-DesktopApplication { throw 'unfinalized candidate launched' }
$expected = Get-DesktopPointer
Invoke-PendingDesktopActivation $expected 'old-fixture'
if ($script:oldLaunches -ne 1) { throw 'old slot not started exactly once' }
if (-not (Test-DesktopReferenceMatch (Get-DesktopPointer).pending $expected.pending)) { throw 'unfinalized pending changed' }
${verifyLeaseReleased}
`, root)
  assert.equal(existsSync(join(candidate.transactionRoot, 'activation-attempt.json')), false)
})

test('candidate healthy commit uses free D while L/A remain held and all leases release afterward', windows, () => {
  const { root } = pendingFixture()
  powershell(`
${mockedOldLaunch}
function Start-DesktopApplication {
  param([string]$Executable, [switch]$PassThru)
  if (Test-ExclusivePathAvailable (Join-Path $cacheRoot 'build.lock')) { throw 'L released before health' }
  if (-not (Test-Path -LiteralPath (Join-Path $cacheRoot 'assembly.lock'))) { throw 'A released before health' }
  $commitLease = Open-DesktopPointerLease -WaitMs 0
  if ($null -eq $commitLease) { throw 'D held across candidate start' }
  try {
    $pointer = Get-DesktopPointer
    Save-JsonAtomic ([ordered]@{schema=1;current=$pointer.pending;previous=$pointer.current}) $pointerPath
    Save-JsonAtomic ([ordered]@{phase='completed';transactionId=$pointer.pending.transactionId}) $statePath
    Save-JsonAtomic ([ordered]@{transactionId=$pointer.pending.transactionId}) $env:DSH_DESKTOP_UPDATE_HEALTH_FILE
  } finally { $commitLease.Dispose() }
  return [pscustomobject]@{ HasExited=$false }
}
$expected = Get-DesktopPointer
Invoke-PendingDesktopActivation $expected 'old-fixture'
if ($script:oldLaunches -ne 0 -or -not (Test-DesktopReferenceMatch (Get-DesktopPointer).current $expected.pending)) { throw 'healthy commit regressed' }
${verifyLeaseReleased}
`, root)
})

for (const failure of ['exited', 'launch-throws', 'timeout', 'forged-health'] as const) {
  test(`candidate ${failure} withdraws exact pending before cleanup and old launch, releases L/A/D`, windows, () => {
    const { root } = pendingFixture()
    powershell(`
${mockedOldLaunch}
$script:failure = $env:DSH_FIXTURE_FAILURE
function Start-DesktopApplication {
  param([string]$Executable, [switch]$PassThru)
  if ($script:failure -eq 'launch-throws') { throw 'fixture launch cancelled' }
  if ($script:failure -eq 'forged-health') { Save-JsonAtomic ([ordered]@{transactionId='forged'}) $env:DSH_DESKTOP_UPDATE_HEALTH_FILE }
  $fake = [pscustomobject]@{ HasExited=($script:failure -ne 'timeout'); Id=0 }
  $fake | Add-Member ScriptMethod Refresh {}
  $fake | Add-Member ScriptMethod CloseMainWindow {
    if (Get-OptionalProperty -Value (Get-DesktopPointer) -Name 'pending') { throw 'candidate stopped before withdrawal' }
    if (-not (Test-ExclusivePathAvailable (Join-Path $desktopUpdateRoot 'operation.lock'))) { throw 'D held during cleanup' }
    return $true
  }
  $fake | Add-Member ScriptMethod WaitForExit { param($Milliseconds) return $true }
  return $fake
}
if ($script:failure -eq 'timeout') {
  $script:clockTick=0
  function Get-Date {
    param([string]$Format)
    if ($Format) { return '2026-09-30 00:00:00.000' }
    $script:clockTick++; return ([datetime]'2026-09-30T00:00:00Z').AddSeconds(241 * $script:clockTick)
  }
}
$expected = Get-DesktopPointer
Invoke-PendingDesktopActivation $expected 'old-fixture'
if ($script:oldLaunches -ne 1 -or (Get-OptionalProperty -Value (Get-DesktopPointer) -Name 'pending') -or -not (Test-DesktopReferenceMatch (Get-DesktopPointer).current $expected.current)) { throw 'rollback/old launch mismatch' }
${verifyLeaseReleased}
`, root, { DSH_FIXTURE_FAILURE: failure })
  })
}

test('pointer published but health/state incomplete is never rolled back or force-stopped', windows, () => {
  const { root } = pendingFixture()
  powershell(`
${mockedOldLaunch}
function Start-DesktopApplication {
  param([string]$Executable, [switch]$PassThru)
  $pointer = Get-DesktopPointer
  Save-JsonAtomic ([ordered]@{ schema=1;current=$pointer.pending;previous=$pointer.current }) $pointerPath
  $fake = [pscustomobject]@{ HasExited=$true;Id=0 }
  $fake | Add-Member ScriptMethod CloseMainWindow { throw 'committed current stopped' }
  return $fake
}
$expected = Get-DesktopPointer
$failed = $false
try { Invoke-PendingDesktopActivation $expected 'old-fixture' } catch { $failed = $true }
if (-not $failed -or $script:oldLaunches -ne 0 -or -not (Test-DesktopReferenceMatch (Get-DesktopPointer).current $expected.pending)) { throw 'incomplete commit overwritten' }
${verifyLeaseReleased}
`, root)
})

test('changed pointer after full validation is rejected by CAS without marking or launching a candidate', windows, () => {
  const { root, candidate } = pendingFixture()
  powershell(`
${mockedOldLaunch}
function Resolve-SlotApplication {
  param($Reference, [ref]$ValidatedAsarHash)
  if (-not (Test-ExclusivePathAvailable (Join-Path $desktopUpdateRoot 'operation.lock'))) { throw 'full verification held D' }
  $changed = Get-DesktopPointer
  $changed.pending.transactionId = [guid]::NewGuid().ToString()
  Save-JsonAtomic $changed $pointerPath
  return 'candidate-fixture'
}
function Start-DesktopApplication { throw 'changed transaction launched' }
$expected = Get-DesktopPointer
$failed=$false
try { Invoke-PendingDesktopActivation $expected 'old-fixture' } catch { $failed=$true }
if (-not $failed -or $script:oldLaunches -ne 0 -or (Test-DesktopReferenceMatch (Get-DesktopPointer).pending $expected.pending)) { throw 'changed pointer not preserved' }
${verifyLeaseReleased}
`, root)
  assert.equal(existsSync(join(candidate.transactionRoot, 'activation-attempt.json')), false)
})

test('stale activation attempt is withdrawn under D before one old-slot start', windows, () => {
  const { root, candidate } = pendingFixture()
  json(join(candidate.transactionRoot, 'activation-attempt.json'), { schema: 1, transactionId: candidate.reference.transactionId })
  powershell(`
${mockedOldLaunch}
function Start-DesktopApplication { throw 'stale candidate launched twice' }
Invoke-PendingDesktopActivation (Get-DesktopPointer) 'old-fixture'
if ($script:oldLaunches -ne 1 -or (Get-OptionalProperty -Value (Get-DesktopPointer) -Name 'pending')) { throw 'stale attempt not withdrawn' }
${verifyLeaseReleased}
`, root)
})
