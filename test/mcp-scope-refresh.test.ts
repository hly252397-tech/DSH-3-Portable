import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preserveMcpRefreshPatch } from '../src/mcp-scope-refresh.js'
import test from 'node:test'
import vm from 'node:vm'
import { patchMcpScopeRefresh, patchMcpGovernanceRefresh, REVIEWED_MCP_VERSIONS } from '../scripts/patch-mcp-scope-refresh.mjs'
import { BUNDLED_PLUGINS } from '../src/bundled-plugins.js'

test('MCP installation preflights both files, preserves backups, and survives reinstall', () => {
  const profile = mkdtempSync(join(tmpdir(), 'mcp-preserve-'))
  const root = join(profile, 'node_modules/dsh-mcp-connector')
  mkdirSync(join(root, 'lib'), { recursive: true })
  const manifest = join(root, 'package.json')
  writeFileSync(manifest, JSON.stringify({ name: 'dsh-mcp-connector', version: '0.2.59' }))
  const scope = readFileSync('customizations/mcp-connector/connection-scopes-0.2.58.mjs', 'utf8')
  const governance = readFileSync('customizations/mcp-connector/governance-0.2.58.mjs', 'utf8')
  const scopePath = join(root, 'lib/connection-scopes.js'), governancePath = join(root, 'lib/governance.js')
  writeFileSync(scopePath, scope); writeFileSync(governancePath, 'unexpected upstream')
  assert.throws(() => preserveMcpRefreshPatch(profile), /implementation changed/)
  assert.equal(readFileSync(scopePath, 'utf8'), scope, 'Preflight failure must not partially patch')
  writeFileSync(governancePath, governance)
  assert.equal(preserveMcpRefreshPatch(profile).length, 2)
  assert.equal(readFileSync(scopePath + '.before-refresh-snapshot-20260927', 'utf8'), scope)
  assert.deepEqual(preserveMcpRefreshPatch(profile), [])
  writeFileSync(scopePath, scope)
  assert.equal(preserveMcpRefreshPatch(profile).length, 1)
  writeFileSync(manifest, JSON.stringify({ name: 'dsh-mcp-connector', version: '9.0.0' }))
  assert.throws(() => preserveMcpRefreshPatch(profile), /requires review/)
  const main = readFileSync('src/main.ts', 'utf8')
  assert.match(main, /preserveMcpRefreshPatch\(profileDir\)[\s\S]*?installDesktopBridge/)
  assert.match(main, /preserveMcpRefreshPatch\(seedOptions.profileDir\)[\s\S]*?startWithProfileSelfRepair/)
})

test('MCP bundled target stays on the reviewed compatibility patch version', () => {
  assert.deepEqual(REVIEWED_MCP_VERSIONS, ['0.2.58', '0.2.59'])
  assert.ok(REVIEWED_MCP_VERSIONS.some(version => version === BUNDLED_PLUGINS.find(plugin => plugin.packageName === 'dsh-mcp-connector')?.version))
})

test('MCP scope refresh shares one schema read while preserving per-agent workspace restrictions', () => {
  const source = readFileSync('customizations/mcp-connector/connection-scopes-0.2.58.mjs', 'utf8')
  const run = (code: string) => {
    const context: any = {}
    vm.runInNewContext(code.replaceAll('export ', '') + '\nthis.createController = createHostScopeController;', context)
    let reads = 0
    let names = ['mcp__private__search']
    let global = false
    const callbacks = new Map<string, () => void>()
    const denied = new Map<number, string[]>()
    const agents = Array.from({ length: 28 }, (_, id) => ({ id, ctx: { tools: {
      restrict: ({ deny }: { deny: string[] }) => {
        const value = [...deny]
        denied.set(id, value)
        return () => { if (denied.get(id) === value) denied.delete(id) }
      },
    } } }))
    let guard: ((execution: unknown) => unknown) | undefined
    const host = { tools: {
      schemas: () => { reads++; return names.map(name => ({ name })) },
      guard: (fn: typeof guard) => { guard = fn; return () => { guard = undefined } },
    } }
    const controller = context.createController(host, {
      getRecords: () => [{ key: 'private', serverName: 'private' }],
      getBindings: () => [{ connectionKey: 'private', global, projects: ['allowed'] }],
      workspaceIdForAgent: (agent: { id: number }) => agent.id % 2 === 0 ? 'allowed' : 'other',
    })
    controller.mountAgents({ agents: { list: () => agents }, on: (event: string, cb: () => void) => {
      callbacks.set(event, cb); return () => { callbacks.delete(event) }
    } })
    const firstReads = reads
    assert.equal(denied.size, 14)
    assert.equal(guard?.({ name: names[0], agent: agents[0] }), undefined)
    assert.equal(typeof guard?.({ name: names[0], agent: agents[1] }), 'string')
    names = [...names, 'mcp__private__new_tool']
    callbacks.get('tools/change')?.()
    assert.deepEqual(denied.get(1), [...names].sort(), 'Tool changes must update the next snapshot')
    const secondReads = reads - firstReads
    global = true
    controller.refresh()
    assert.equal(denied.size, 0, 'Changing a connection to global clears the previous restrictions')
    if (code.includes('const currentBindings = bindings();')) {
      assert.equal(reads, firstReads + secondReads, 'Global connections require no schema expansion')
    }
    controller.dispose()
    assert.equal(denied.size, 0)
    assert.equal(callbacks.size, 0)
    assert.equal(guard, undefined)
    return [firstReads, secondReads]
  }
  assert.deepEqual(run(source), [28, 28], 'Old implementation reproduces repeated global schema expansion')
  const fixed = patchMcpScopeRefresh(source)
  assert.deepEqual(run(fixed), [1, 1])
  assert.equal(patchMcpScopeRefresh(fixed), fixed, 'Compatibility installation is idempotent')
  assert.throws(() => patchMcpScopeRefresh('changed upstream implementation'), /implementation changed/)
})

test('MCP governance skips empty policy expansion but retains deny rules and disabled connections', () => {
  const source = readFileSync('customizations/mcp-connector/governance-0.2.58.mjs', 'utf8')
  const patched = patchMcpGovernanceRefresh(source)
  const context: any = { createHash }
  vm.runInNewContext(patched.replace("import { createHash } from 'node:crypto';", '').replaceAll('export ', '') + '\nthis.createController = createHostGovernanceController;', context)
  let reads = 0
  let enabled = true
  let rules: any[] = []
  let denial: string[] = []
  let guard: any
  const callbacks = new Map<string, () => void>()
  const agent = { id: 'agent', ctx: { tools: { restrict: ({ deny }: { deny: string[] }) => {
    denial = [...deny]; return () => { denial = [] }
  } } } }
  const controller = context.createController({ tools: {
    guard: (fn: any) => { guard = fn; return () => {} },
    schemas: () => { reads++; return [{ name: 'mcp__private__search' }] },
  } }, {
    getRules: () => rules,
    getRecords: () => [{ key: 'private', connectorId: 'connector', serverName: 'private', enabled }],
  })
  controller.mountAgents({ agents: { list: () => [agent] }, on: (name: string, fn: () => void) => {
    callbacks.set(name, fn); return () => callbacks.delete(name)
  } })
  assert.equal(reads, 0)
  enabled = false
  callbacks.get('tools/change')?.()
  assert.equal(reads, 1)
  assert.deepEqual(denial, ['mcp__private__search'])
  assert.equal(typeof guard({ name: 'mcp__private__search' }), 'string')
  enabled = true
  callbacks.get('tools/change')?.()
  assert.deepEqual(denial, [])
  rules = [{ id: 'rule', scope: 'connection', connectorId: 'connector', effect: 'deny' }]
  callbacks.get('tools/change')?.()
  assert.equal(reads, 2)
  assert.equal(typeof guard({ name: 'mcp__private__search' }), 'string')
  controller.dispose()
  assert.equal(patchMcpGovernanceRefresh(patched), patched)
})
