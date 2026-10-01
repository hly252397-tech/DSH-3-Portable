import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

type Element = { type: unknown; props: Record<string, any>; children: unknown[] }
const state = (owned = false) => ({ online: true, owned, stats: { total: 0, active: 0, by_state: {} }, runs: [] })

// Run the actual classic client factory and component, not a copy of its policy.
// React/HTTP are isolated doubles here; the separate Electron probe covers real
// slots, DOM hit targets and responsive geometry.
function harness(initial: any = state()) {
  let plugin: any, component: any, cursor = 0, mounted = false
  const hooks: any[] = [], effects: Array<() => (() => void)> = []
  const disposers: Array<() => void> = [], calls: string[] = []
  let bridge = initial
  let outcome: any = { ok: true }
  let rejected = false
  const react = {
    createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initialValue: unknown) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = initialValue
      return [hooks[index], (value: any) => { hooks[index] = value }]
    },
    useRef(initialValue: unknown) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initialValue }
      return hooks[index]
    },
    useEffect(fn: () => (() => void)) { if (!mounted) effects.push(fn) },
  }
  vm.runInNewContext(readFileSync(resolve('customizations/agent-mcp/lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: (spec: any) => { plugin = spec.factory((name: string) => { assert.equal(name, 'react'); return react }) } } },
    AbortController, AbortSignal,
    document: { hidden: false, addEventListener() {}, removeEventListener() {}, createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (_url: string, options: any) => {
      const { operation } = JSON.parse(options.body)
      calls.push(operation)
      if (operation === 'bridge.status' && rejected) throw new Error('isolated refresh failure')
      const value = operation === 'status'
        ? { running: true, url: 'http://127.0.0.1:1/mcp', tools: [], bridgeConfigured: true }
        : operation === 'bridge.status' ? bridge : outcome
      return { ok: true, json: async () => ({ value }) }
    },
  })
  plugin.apply({
    effect: (fn: () => unknown) => fn(),
    locale: { register() {}, bind: () => (key: string) => key },
    slots: { inject: (_name: string, fn: () => unknown) => fn(), register: (_options: any, value: any) => { component = value } },
  })
  const render = () => { cursor = 0; return component({ t: (key: string) => key }) as Element }
  render()
  mounted = true
  for (const effect of effects) disposers.push(effect())
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)) }
  const all = (node: unknown): Element[] => {
    if (!node || typeof node !== 'object' || !('children' in node)) return []
    const value = node as Element
    return [value, ...value.children.flatMap(all)]
  }
  const find = (key: string, value: string) => {
    const matches = all(render()).filter(node => node.props[key] === value)
    assert.equal(matches.length, 1, `${key}=${value}`)
    return matches[0]!
  }
  return { calls, render, find, settle, setBridge: (value: any) => { bridge = value },
    setOutcome: (value: any) => { outcome = value }, rejectStatus: () => { rejected = true },
    dispose: () => { for (const disposer of disposers) disposer() } }
}

test('Bridge client only enables Stop for a positively owned online instance', async () => {
  for (const bridge of [null, { online: false, owned: true }, state(false), state(), { ...state(), owned: undefined }]) {
    const fixture = harness(bridge)
    try {
      await fixture.settle()
      assert.equal(fixture.find('data-mcp-bridge', 'stop').props.disabled, true)
      assert.equal(fixture.calls.filter(op => op === 'bridge.status').length, 1, 'one refresh must not issue a duplicate status request')
    } finally { fixture.dispose() }
  }
  const fixture = harness(state(true))
  try {
    await fixture.settle()
    assert.equal(fixture.find('data-mcp-bridge', 'stop').props.disabled, false)
    assert.equal(fixture.find('data-mcp-bridge-ownership', 'owned').children[0], null)
  } finally { fixture.dispose() }
})

test('Bridge client distinguishes online external ownership from unreachable state', async () => {
  const external = harness(state(false))
  const offline = harness({ online: false, owned: false, reason: 'UNREACHABLE' })
  try {
    await Promise.all([external.settle(), offline.settle()])
    assert.equal(external.find('data-mcp-bridge-ownership', 'external').children[0], 'bridgeExternal')
    assert.equal(offline.find('data-mcp-bridge-unreachable', '1').children[0], 'bridgeUnavailable')
  } finally { external.dispose(); offline.dispose() }
})

test('Bridge client disables Start as well as Stop when another service owns the port', async () => {
  const fixture = harness({ online: false, reason: 'PORT_NOT_BRIDGE', owned: false })
  try {
    await fixture.settle()
    assert.equal(fixture.find('data-mcp-bridge', 'start').props.disabled, true)
    assert.equal(fixture.find('data-mcp-bridge', 'stop').props.disabled, true)
  } finally { fixture.dispose() }
})

test('Bridge client invalidates an old stop permission after failed refresh', async () => {
  const fixture = harness(state(true))
  try {
    await fixture.settle()
    assert.equal(fixture.find('data-mcp-bridge', 'stop').props.disabled, false)
    fixture.rejectStatus()
    fixture.find('data-mcp-bridge', 'status').props.onClick()
    await fixture.settle()
    assert.equal(fixture.find('data-mcp-bridge', 'stop').props.disabled, true)
    assert.equal(fixture.find('data-mcp-bridge-notice', '1').children[0], 'failed')
  } finally { fixture.dispose() }
})

test('Bridge client reports stop failure without claiming exit and refreshes its permission', async () => {
  for (const error of ['BRIDGE_STOP_FAILED', 'BRIDGE_STOP_TIMEOUT', 'NOT_OWNED']) {
    const fixture = harness(state(true))
    try {
      await fixture.settle()
      fixture.setOutcome({ ok: false, error })
      fixture.setBridge(state(false))
      fixture.find('data-mcp-bridge', 'stop').props.onClick()
      await fixture.settle()
      assert.equal(fixture.find('data-mcp-bridge-notice', '1').children[0], error === 'NOT_OWNED' ? 'bridgeNotOwned' : 'bridgeStopFailed')
      assert.equal(fixture.find('data-mcp-bridge', 'stop').props.disabled, true)
      assert.deepEqual(fixture.calls.slice(-2), ['bridge.stop', 'bridge.status'])
    } finally { fixture.dispose() }
  }
})

test('Bridge client does not claim rejected cancellation succeeded', async () => {
  const fixture = harness({ ...state(), runs: [{ run_id: 'isolated-run', agent_id: 'fixture' }] })
  try {
    await fixture.settle()
    fixture.setOutcome({ ok: false, error_code: 'CANCEL_UNCONFIRMED' })
    fixture.find('data-mcp-cancel', 'isolated-run').props.onClick()
    await fixture.settle()
    assert.equal(fixture.find('data-mcp-bridge-notice', '1').children[0], 'failed')
    assert.deepEqual(fixture.calls.slice(-2), ['bridge.cancel', 'bridge.status'])
  } finally { fixture.dispose() }
})
