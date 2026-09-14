import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const extensionPath = resolve('Customize/Automation-Workbench/workbench.js')
const clientPath = resolve('Data/DSH/profiles/web/node_modules/@michengai/dsh-automation/lib/client.js')
const buildModule = pathToFileURL(resolve('Customize/Automation-Workbench/build.mjs')).href

test('automation adapter is pinned, repeatable and rejects an unreviewed update', async t => {
  if (!existsSync(clientPath)) return t.skip('实机 @michengai/dsh-automation 产物缺失（CI 全新检出）')
  const { buildWorkbench } = await import(buildModule)
  const [source, extension] = await Promise.all([readFile(clientPath, 'utf8'), readFile(extensionPath, 'utf8')])
  const once = buildWorkbench(source, extension)
  assert.equal(buildWorkbench(once, extension), once)
  assert.ok(!once.includes('installPortableAutomationWorkbench'))
  assert.ok(!once.includes('data-daw-launcher'))
  assert.ok(once.includes('AutomationView, { t, permissionT, modelT, runtime,'))
  assert.throws(() => buildWorkbench(source + '\n// unexpected upstream change', extension), /Unsupported automation client/)
  assert.throws(() => buildWorkbench('// PORTABLE_AUTOMATION_WORKBENCH_BEGIN\n', extension), /Incomplete/)
})

