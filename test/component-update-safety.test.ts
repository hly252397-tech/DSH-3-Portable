import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { ComponentUpdateSafety, harnessActivationSafety } from '../src/component-update-safety.js'

test('两个组件跨 await 互斥且失败后释放，不靠 disabled 按钮', async () => {
  const lease = new ComponentUpdateSafety()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let entered = false
  const operation = lease.run('desktop', async () => { entered = true; await held; throw new Error('expected') })
  assert.equal(entered, true)
  await assert.rejects(lease.run('harness', async () => 'unsafe'), /组件更新/)
  await assert.rejects(lease.run('desktop', async () => 'unsafe'), /组件更新/)
  release()
  await assert.rejects(operation, /expected/)
  assert.equal(await lease.run('harness', async () => 'released'), 'released')
})

test('没有真实入站与恢复保障的家园切换一律失败关闭', async () => {
  assert.equal(harnessActivationSafety().allowed, false)
  assert.match(harnessActivationSafety().reason, /入站隔离.*安全回滚.*阻止正式激活/)
  const source = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8')
  const deploy = source.slice(source.indexOf('async function deployHarnessCandidateUnlocked'), source.indexOf('async function buildCandidateWithRetries'))
  assert.ok(deploy.indexOf('harnessActivationSafety()') < deploy.indexOf('waitForHarnessIdle('))
  assert.match(deploy, /activation-safety/)
  const swap = source.slice(source.indexOf('async function switchHarnessRuntime'), source.indexOf('async function waitHarnessObservation'))
  assert.ok(swap.indexOf('harnessActivationSafety()') < swap.indexOf('previousServer.stop()'))
  assert.ok(swap.indexOf('if (committed)') < swap.indexOf('await failedServer?.stop()'))
  assert.match(source, /componentUpdateSafety\.run\('desktop'/)
  assert.match(source, /componentUpdateSafety\.run\('harness'/)
})
