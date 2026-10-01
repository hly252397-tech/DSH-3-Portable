import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'

async function fixture(t: TestContext, mode: 'native' | 'ptc' = 'native') {
  const runtime = resolveActiveRuntimeDir(resolve('Data/Runtime/dsh-runtime'))
  if (!runtime || !existsSync(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'))) {
    t.skip('已安装官方运行时缺失（CI 全新检出）；纯目录测试仍执行')
    return
  }
  const official = join(runtime, 'node_modules/@deepseek-ai')
  const load = (name: string) => import(pathToFileURL(join(official, name, 'lib/index.js')).href)
  const home = await mkdtemp(join(tmpdir(), 'system-awareness-session-'))
  const dir = join(home, 'profiles/test')
  const plugin = join(dir, 'node_modules/dsh-system-awareness')
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await symlink(official, join(dir, 'node_modules/@deepseek-ai'), 'junction')
  await cp(resolve('plugins/dsh-system-awareness'), plugin, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'awareness-test', private: true, dependencies: { 'dsh-system-awareness': 'link:./node_modules/dsh-system-awareness' }, dsh: { profile: { bundles: ['dsh-system-awareness'] } } }))
  await writeFile(join(dir, 'cordis.patch.yml'), '- id: dsh-system-awareness\n  name: dsh-system-awareness\n  config:\n    metadataRefreshMs: 0\n')
  const profileContext = { name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), home, installAnchor: join(official, 'dsh/package.json'), cwd: dir, startedBundles: ['dsh-system-awareness'], overlays: [], telemetryDisabledEnv: undefined }
  const app = await load('dsh-app-boot')
  const rows = [
    ['dsh-session', {}], ['dsh-session-projection', {}], ['dsh-agent', {}], ['dsh-llm', {}],
    ['dsh-system-prompt', { includeHarnessIdentity: false }], ['dsh-tools', { mode }],
    ['dsh-agent-loop', { agents: [], maxParallelToolCalls: 1 }],
  ].map(([name, config]) => ({ id: String(name), name: pathToFileURL(join(official, String(name), 'lib/index.js')).href, config }))
  const rootConfig = join(dir, 'base.json')
  await writeFile(rootConfig, JSON.stringify(rows))
  const requests: any[] = []
  const events: any[] = []
  const ctx = await app.boot('awareness-test', rootConfig, app.readProfilePatches('awareness-test', profileContext), (host: any) => {
    host.provide('profileContext', profileContext)
    if (mode === 'ptc') host.provide('ptcRuntime', {
      language: 'typescript', isolation: 'fixture', executionInstructions: '',
      resolve(request: any) { return { ...request, cwd: dir, timeoutMs: null } },
      async run(spec: any) {
        const tools = spec.bindings.find((binding: any) => binding.global === 'tools')
        return { value: await tools.functions.dsh_capabilities({ mode: 'detail' }), logs: [] }
      },
    })
  })
  t.after(async () => { await ctx.fiber.dispose() })
  const entry = [...ctx.loader.entries()].find((entry: any) => entry.options?.name === 'dsh-system-awareness' || entry.options?.id === 'dsh-system-awareness' || entry.id === 'dsh-system-awareness') as any
  assert.equal(entry?.fiber.state, 2, 'bundle loaded through real Profile + Loader must be ACTIVE')
  const llm = await load('dsh-llm')
  class Adapter extends llm.LlmAdapter {
    async *stream(options: any) {
      requests.push(options)
      const isResult = options.messages.at(-1)?.source.kind === 'tool'
      const block = isResult ? { type: 'text', text: 'CAPABILITIES_READ' } : {
        type: 'tool-call', id: `catalog-${requests.length}`, name: mode === 'ptc' ? 'run_code' : 'dsh_capabilities',
        arguments: JSON.stringify(mode === 'ptc' ? { description: 'Read DSH capabilities', code: 'return await tools.dsh_capabilities({mode:"detail"})' } : { mode: 'detail' }),
      }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: isResult ? 'stop' : 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['fixture-a', 'fixture-b'], new Adapter())
  ctx.on('session/event', (_session: any, event: any) => events.push(event))
  const createAgent = async (id: string, provider = 'fixture-a') => ctx.agentLoop.create(id, { provider, model: 'keyless' })
  const run = async (agent: any, message = '查询当前 DSH 能力') => {
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: message }], source: { kind: 'plugin', plugin: 'awareness-fixture' } }))
    await agent.whenIdle()
  }
  const toolModule = await load('dsh-tools')
  const addTool = (name: string, description = name) => ctx.tools.register(toolModule.defineTool({ name, description, parameters: {}, output: { schema: { type: 'string' }, render: (_args: any, value: any) => [{ type: 'text', text: value }] }, async execute() { return name } }))
  return { ctx, load, requests, events, createAgent, run, entry, addTool, home, dir, app, profileContext }
}

for (const mode of ['native', 'ptc'] as const) {
  test(`awareness records identity, scoped catalog and canonical results through real ${mode} AgentLoop`, async t => {
    const f = await fixture(t, mode)
    if (!f) return
    f.addTool('private_probe', 'private_probe_secret')
    const agent = await f.createAgent('scope-a')
    agent.ctx.tools.restrict({ deny: ['private_probe'] })
    if (mode === 'ptc') agent.ctx.systemPrompt.section({ name: 'complete-fixture', order: 0, complete: true, text: 'Custom complete persona.' })
    await f.run(agent)
    assert.equal(f.requests.length, 2)
    const first = f.requests[0]
    assert.match(JSON.stringify(first.messages), /DeepSeek Harness/)
    assert.match(JSON.stringify(first.messages), /DSH 环境事实/)
    assert.doesNotMatch(JSON.stringify(first), /private_probe/)
    assert.deepEqual(first.tools.map((tool: any) => tool.name), mode === 'ptc' ? ['run_code'] : ['dsh_capabilities'])
    const recorded = join(f.home, 'recorded-session.json')
    await writeFile(recorded, JSON.stringify(f.events))
    const replay = JSON.parse(await readFile(recorded, 'utf8'))
    assert.match(JSON.stringify(replay), /DSH 环境事实/)
    assert.ok(replay.some((event: any) => event.type === 'tool/result'))
    assert.ok(replay.some((event: any) => event.type === 'request/header'))
    assert.equal(f.events.at(-1).type, 'turn/end')
    const resultMessage = f.requests[1].messages.findLast((message: any) => message.source.kind === 'tool')
    assert.equal(resultMessage.isError, false)
    const resultValue = JSON.parse(resultMessage.content[0].text)
    assert.match(resultValue.revision, /^[a-f0-9]{20}$/)
    assert.equal(resultValue.tools.find((tool: any) => tool.name === 'dsh_capabilities').parameters.type, 'object')
    assert.doesNotMatch(JSON.stringify(resultValue), /private_probe/)
    if (mode === 'ptc') {
      assert.ok(replay.some((event: any) => event.type === 'tool/ptc-dispatch'))
      assert.match(JSON.stringify(first.messages), /仅直接调用 run_code/)
      assert.equal(first.messages.find((message: any) => message.role === 'system').content[0].text, 'Custom complete persona.')
    }
    const other = await f.createAgent('scope-b', 'fixture-b')
    const assembly = await f.ctx.systemPrompt.assemble({ scope: other })
    assert.match(JSON.stringify(assembly), /private_probe/)
    await f.run(other)
    assert.equal(f.requests.length, 4)
    assert.match(JSON.stringify(f.requests[2].messages), /DSH 环境事实/)
  })
}

test('awareness follows tool changes, validates calls and disappears on Loader disposal', async t => {
  const f = await fixture(t)
  if (!f) return
  const agent = await f.createAgent('changing-agent')
  const read = async (args: any = { mode: 'detail' }) => f.ctx.tools.execute({ callId: 'catalog-check', name: 'dsh_capabilities', arguments: args, agent, signal: new AbortController().signal })
  const first = await read()
  assert.equal(first.isError, false)
  const dispose = f.addTool('new_probe', 'new capability')
  const second = await read()
  assert.notEqual(first.value.revision, second.value.revision)
  assert.ok(second.value.tools.some((tool: any) => tool.name === 'new_probe'))
  const unrestrict = agent.ctx.tools.restrict({ deny: ['new_probe'] })
  const scoped = await read()
  assert.equal(scoped.value.revision, first.value.revision, 'hidden tools must not leak through the scope revision')
  assert.doesNotMatch(JSON.stringify(scoped.value), /new_probe/)
  unrestrict()
  dispose()
  const third = await read()
  assert.equal(first.value.revision, third.value.revision)
  assert.equal((await read({ limit: -1 })).isError, true)
  assert.equal((await read({ mode: 'execute' })).isError, true)
  const before = await f.ctx.systemPrompt.assemble({ scope: agent })
  assert.ok(before.contexts.some((context: any) => context.name === 'dsh:system-awareness'))
  await f.entry.fiber.dispose()
  const after = await f.ctx.systemPrompt.assemble({ scope: agent })
  assert.ok(!after.contexts.some((context: any) => context.name === 'dsh:system-awareness'))
  assert.ok(!after.sections.some((section: any) => section.name.startsWith('dsh:system-awareness')))
  assert.ok(!after.tools.some((tool: any) => tool.name === 'dsh_capabilities'))
})
