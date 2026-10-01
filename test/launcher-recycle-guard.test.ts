import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('launcher waits for live recycle work but retained failed diagnostics do not block forever', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-launcher-recycle-'))
  const script = resolve('Start-DSH-Portable.ps1')
  // Extract only the pure guard; never execute the application launcher in tests.
  const busy = () => {
    const command = "$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:DSH_GUARD_SCRIPT,[ref]$null,[ref]$null);$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-PrepareRecycleBusy'},$true);if(-not $fn){throw 'guard missing'};Invoke-Expression $fn.Extent.Text;Write-Output (Test-PrepareRecycleBusy -Root $env:DSH_GUARD_ROOT)"
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, DSH_GUARD_SCRIPT: script, DSH_GUARD_ROOT: root },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim() === 'True'
  }
  assert.equal(busy(), false)
  await mkdir(join(root, 'runtime-node.failed.failed'))
  await writeFile(join(root, 'runtime-node.failed.json'), '{}')
  assert.equal(busy(), false)
  await writeFile(join(root, '.sweeping'), 'worker')
  assert.equal(busy(), true)
  const queue = await mkdtemp(join(tmpdir(), 'dsh-launcher-queue-'))
  await mkdir(join(queue, 'runtime-node-queued'))
  // A separate invocation checks ordinary queued work with no heartbeat.
  const command = "$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:DSH_GUARD_SCRIPT,[ref]$null,[ref]$null);$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-PrepareRecycleBusy'},$true);Invoke-Expression $fn.Extent.Text;Write-Output (Test-PrepareRecycleBusy -Root $env:DSH_GUARD_ROOT)"
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, DSH_GUARD_SCRIPT: script, DSH_GUARD_ROOT: queue },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'True')
})
