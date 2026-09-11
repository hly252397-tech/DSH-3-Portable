import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
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
  assert.throws(() => buildWorkbench(source + '\n// unexpected upstream change', extension), /Unsupported automation client/)
  assert.throws(() => buildWorkbench('// PORTABLE_AUTOMATION_WORKBENCH_BEGIN\n', extension), /Incomplete/)
})

test('workbench registers reversibly, shares runtime and keeps Settings a navigation link', async () => {
  const registrations = new Map<string, any>()
  const cleanup: Array<() => void> = []
  const events = new Map<string, any>()
  let removedStyles = 0, hiddenDetails = 0
  const ctx = {
    get: (name: string) => name === 'layout' ? { closeDetails() { hiddenDetails++ } } : undefined,
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    effect: (effect: () => void | (() => void)) => { const dispose = effect(); if (dispose) cleanup.push(dispose) },
    slots: {
      inject: (_name: string, effect: () => void | (() => void)) => { const dispose = effect(); if (dispose) cleanup.push(dispose) },
      register: (options: any, component: any) => {
        registrations.set(options.id, { options, component })
        return () => { registrations.delete(options.id) }
      },
    },
  }
  const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props, children }), useSyncExternalStore: (_subscribe: any, snapshot: any) => snapshot() }
  const sandbox: any = {
    document: {
      activeElement: null, querySelector: () => null,
      createElement: () => ({ dataset: {}, remove() { removedStyles++ } }),
      head: { appendChild() {} },
      addEventListener: (name: string, listener: any) => events.set(name, listener),
      removeEventListener: (name: string) => events.delete(name),
    },
  }
  runInNewContext((await readFile(extensionPath, 'utf8')) + '\nthis.install = installPortableAutomationWorkbench;', sandbox)
  const runtime = { sentinel: 'one existing runtime' }
  const workbench = sandbox.install(ctx, { React, createPortal: () => {}, View: () => {}, runtime, t() {}, permissionT() {}, modelT() {}, Icon() {} })
  const entry = registrations.get('dsh-automation')
  assert.equal(entry.options.priority, -100)
  assert.equal(entry.component({ wide: true }).props['aria-pressed'], false)
  workbench.open(); workbench.open()
  assert.equal(hiddenDetails, 1)
  assert.equal(entry.component({ wide: true }).props['aria-pressed'], true)
  assert.equal(registrations.get('portable-automation-workbench').options.name, 'shell.overlay')
  const link = workbench.SettingsLink({ close() {} })
  assert.equal(link.children[2].type, 'button')
  for (const dispose of cleanup.reverse()) dispose()
  assert.equal(registrations.size, 0)
  assert.equal(events.size, 0)
  assert.equal(removedStyles, 1)
  workbench.open()
  assert.equal(hiddenDetails, 1, 'disposed navigation cannot reopen a page')
})
