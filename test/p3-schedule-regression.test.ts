import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

for (const scenario of ['due', 'not-due', 'status-error', 'check-error']) {
  test(`P3 scheduled check retains its diagnostic directory: ${scenario}`, async () => {
    const source = readFileSync(resolve('plugins/dsh-p3-tiny-watch/lib/index.js'), 'utf8')
    // Run apply and its schedule together; a detached helper test misses a missing argument at the call site.
    const executable = source.replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
    const callbacks: Array<() => void> = []
    const logs: Array<{ path: string; text: string }> = []
    const warnings: unknown[][] = []
    let checks = 0
    const dataHome = resolve('Data/Temp/p3-schedule-test-no-write')
    const dataRoot = join(dataHome, 'plugin-data', 'dsh-p3-tiny-watch')
    const schema: any = new Proxy({}, { get: () => () => schema })
    const context = vm.createContext({
      Schema: schema,
      process: { env: { DSH_HOME: dataHome } },
      homedir: () => { throw new Error('Must use portable home') },
      join, dirname: () => dataRoot,
      mkdirSync: () => {},
      appendFileSync: (path: string, text: string) => { logs.push({ path, text }) },
      WatchStore: class { constructor(root: string) { assert.equal(root, dataRoot) } },
      P3TinyMonitor: class {
        async status() {
          if (scenario === 'status-error') throw new Error('status unavailable')
          return { state: {} }
        }
        async check() {
          checks += 1
          if (scenario === 'check-error') throw new Error('check failed')
        }
      },
      isScheduledCheckDue: () => scenario !== 'not-due',
    })
    const apply = vm.runInContext(executable + '\napply', context) as (ctx: unknown, config: unknown) => void
    const timer = { timeout: (callback: () => void) => callbacks.push(callback), interval: () => {} }
    apply({
      get: (key: string) => key === 'timer' ? timer : undefined,
      commands: { register: () => () => {} },
      effect: (callback: () => unknown) => callback(),
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    }, {})
    assert.equal(callbacks.length, 1)
    callbacks[0]()
    await new Promise<void>(resolvePromise => setImmediate(resolvePromise))
    assert.ok(logs.length >= 2, 'Startup and scheduled callback both write diagnostics')
    assert.ok(logs.every(entry => entry.path === join(dataRoot, 'boot-diagnostics.log')))
    assert.ok(logs.some(entry => entry.text.includes('runIfDue')))
    assert.equal(checks, scenario === 'due' || scenario === 'check-error' ? 1 : 0)
    assert.equal(warnings.length, scenario.endsWith('error') ? 1 : 0)
  })
}
