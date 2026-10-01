import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer as httpServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'

const plugin = resolve('Data/DSH/profiles/web/local/dsh-agent-bridge/lib/index.js')
const runtime = resolveActiveRuntimeDir(resolve('Data/Runtime/dsh-runtime'))

async function fixture(t: TestContext, timeoutMs = 60_000, realLoop = false) {
  if (!runtime || !existsSync(plugin)) {
    t.skip('实机插件/运行时缺失（CI 全新检出）')
    return
  }
  const official = join(runtime, 'node_modules/@deepseek-ai')
  const { Context } = await import(pathToFileURL(join(official, 'cordis/lib/index.js')).href)
  const { Loader } = await import(pathToFileURL(join(official, 'cordis-plugin-loader/lib/index.js')).href)
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const queued: any[] = []
  const cancels: any[] = []
  const session = { id: 'session-a' }
  let agent: any = {
    id: session.id, session, status: 'idle',
    followup(message: any) { queued.push(message) },
    inbox: {
      nextTurn: queued, nextStep: [],
      remove(id: string) {
        const index = queued.findIndex(m => m.id === id)
        if (index < 0) return false
        const [message] = queued.splice(index, 1)
        ctx.emit('agent/inbox/discarded', { agent, message })
        return true
      },
    },
    cancel(cause: any, options: any) { cancels.push({ cause, options }) },
  }
  const modelRequests: any[] = []
  const events: any[] = []
  if (realLoop) {
    for (const [name, config] of [
      ['dsh-session', {}], ['dsh-session-projection', {}], ['dsh-agent', {}], ['dsh-llm', {}],
      ['dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false }],
      ['dsh-tools', { mode: 'native' }], ['dsh-agent-loop', { agents: [], maxParallelToolCalls: 1 }],
    ] as const) {
      const module = await import(pathToFileURL(join(official, name, 'lib/index.js')).href)
      const fiber = ctx.plugin(module.default, config)
      await fiber
      assert.equal(fiber.state, 2, name + ' must be ACTIVE')
    }
    const { LlmAdapter } = await import(pathToFileURL(join(official, 'dsh-llm/lib/index.js')).href)
    class Adapter extends LlmAdapter {
      async *stream(options: any) {
        modelRequests.push(options)
        const results = options.messages.filter((m: any) => m.source.kind === 'tool')
        // v4 把 isError 放在 tool 消息层（createToolResultMessage），不在 content[0] 的已退役包装块里
        const block = results.length
          ? { type: 'text', text: results.at(-1).isError ? 'DENIED' : 'DONE' }
          : { type: 'tool-call', id: 'probe-1', name: 'probe', arguments: '{}' }
        yield { type: 'block-start', index: 0, blockType: block.type }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: results.length ? 'stop' : 'tool-calls' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Adapter())
    agent = await ctx.agentLoop.create(session.id, { provider: 'fixture', model: 'session-choice' })
    ctx.on('session/event', (_session: any, event: any) => events.push(event))
  }
  let resolveCount = 0
  ctx.provide('sessionController', {
    async resolveAgent(id: string) {
      resolveCount++
      return id === session.id ? { agent } : { error: { code: 'session/not-found' } }
    },
    async list() { return { items: [{ sessionId: session.id, updatedAt: 1, running: false, blank: false }] } },
  })
  const loaderFiber = ctx.plugin(Loader)
  await loaderFiber
  const loader = ctx.get('loader')
  t.after(async () => {
    await loaderFiber.dispose()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  await loader.create({ id: 'agent-bridge', name: pathToFileURL(plugin).href, config: { port: 0, timeoutMs } })
  await loader.await()
  assert.equal(loader.resolve('agent-bridge').fiber.state, 2, 'must load using built-in logger, with no fake logger service')
  const descriptor = join(home, 'agent-bridge.json')
  assert.ok(existsSync(descriptor), 'listening bridge must publish an authenticated endpoint descriptor')
  const { url, token } = JSON.parse(await readFile(descriptor, 'utf8'))
  assert.match(token, /^[a-f0-9]{64}$/)
  const request = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000),
    })
    return { status: response.status, headers: response.headers, body: await response.json() as any }
  }
  const emit = (type: string, data: any, target = session) => ctx.emit('session/event', target, { type, data, seq: 1, time: Date.now() })
  const claim = (message: any, turn: number) => {
    queued.splice(queued.indexOf(message), 1)
    emit('turn/start', { turn })
    ctx.emit('agent/inbox/claimed', { agent, message, turn })
  }
  return { ctx, home, loader, agent, queued, cancels, emit, claim, request, url, token, descriptor, official, events, modelRequests, resolveCount: () => resolveCount }
}

for (const denied of [false, true]) {
  test(`real AgentLoop ${denied ? 'denies' : 'executes'} a tool through the session task bridge`, async t => {
    const f = await fixture(t, 60_000, true)
    if (!f) return
    const { defineContentToolFixture } = await import(pathToFileURL(join(f.official, 'dsh-tools/lib/index.js')).href)
    let executions = 0
    f.ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: 'Read test data', parameters: {},
      async execute() {
        executions++
        return [{ type: 'text', text: JSON.stringify({ descriptorExists: existsSync(f.descriptor) }) }]
      },
    }))
    if (denied) f.agent.ctx.tools.guard(() => 'fixture-denied')
    const submitted = await f.request('/tasks', { sessionId: f.agent.id, message: 'Run probe' })
    assert.equal(submitted.status, 202)
    await f.agent.whenIdle()
    const result = (await f.request(`/tasks/${submitted.body.taskId}`)).body
    assert.equal(result.status, 'succeeded', JSON.stringify(result))
    assert.equal(result.response, denied ? 'DENIED' : 'DONE')
    assert.equal(executions, denied ? 0 : 1)
    assert.equal(result.tools[0].status, denied ? 'failed' : 'completed')
    assert.deepEqual(result.model, { provider: 'fixture', model: 'session-choice' })
    assert.equal(f.modelRequests.length, 2)
    assert.ok(f.events.some(e => e.type === 'user/message' && e.data.id === submitted.body.messageId && e.data.source.form === 'relay'))
    assert.ok(f.events.some(e => e.type === 'tool/result'))
    assert.equal(f.events.at(-1).type, 'turn/end')
  })
}

test('v4 tool results are read from the message level, not the retired content wrapper', async t => {
  const f = await fixture(t)
  if (!f) return
  const { body } = await f.request('/tasks', { sessionId: 'session-a', message: 'probe' })
  f.claim(f.queued[0], 3)
  f.emit('tool/call', { turn: 3, step: 1, name: 'probe', callId: 'call-9', arguments: '{}' })
  f.emit('tool/result', { turn: 3, step: 1, message: { role: 'tool', id: 'result-9', source: { kind: 'tool', callId: 'call-9' }, toolCallId: 'call-9', isError: true, content: [] } })
  f.emit('turn/end', { turn: 3, reason: { kind: 'completed' } })
  const result = (await f.request(`/tasks/${body.taskId}`)).body
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.tools.map((tool: any) => tool.status), ['failed'])
})

test('a busy port fails closed without publishing an endpoint descriptor', async t => {
  if (!runtime || !existsSync(plugin)) return t.skip('实机插件/运行时缺失（CI 全新检出）')
  const squatter = httpServer().listen(0, '127.0.0.1')
  await new Promise(resolve => squatter.once('listening', resolve))
  const port = (squatter.address() as any).port
  const official = join(runtime, 'node_modules/@deepseek-ai')
  const { Context } = await import(pathToFileURL(join(official, 'cordis/lib/index.js')).href)
  const { Loader } = await import(pathToFileURL(join(official, 'cordis-plugin-loader/lib/index.js')).href)
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-busy-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  ctx.provide('sessionController', {})
  try {
    const loaderFiber = ctx.plugin(Loader)
    await loaderFiber
    const loader = ctx.get('loader')
    await loader.create({ id: 'agent-bridge', name: pathToFileURL(plugin).href, config: { port } })
    await loader.await()
    // 0.1.7-rc.2 的 Loader 不再把插件异步加载失败上抛给 create()/await()，条目也不再移除，
    // 而是把 fiber 留在 FAILED（实测 state=3）。原始生成器代码在同一运行时同样如此（A/B 探针），
    // 所以"失败关闭"以可观测结果为准：fiber 必须 FAILED（绝不得 ACTIVE），且不得发布发现文件。
    assert.equal(loader.resolve('agent-bridge').fiber.state, 3, 'a bridge that cannot listen must end FAILED, never ACTIVE')
    assert.equal(existsSync(join(home, 'agent-bridge.json')), false)
  } finally {
    squatter.close()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('bridge publishes its bound port and requires authentication without CORS', async t => {
  const f = await fixture(t)
  if (!f) return
  const health = await f.request('/health', undefined, { authorization: '' })
  assert.equal(health.status, 200)
  assert.equal(health.body.status, 'ok')
  assert.equal(health.headers.get('access-control-allow-origin'), null)
  assert.equal(JSON.stringify(health.body).includes(f.token), false)
  assert.equal((await f.request('/sessions', undefined, { authorization: '' })).status, 401)
  assert.equal((await f.request('/sessions', undefined, { authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await f.request('/sessions', undefined, { origin: 'https://attacker.invalid' })).status, 403)
  const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(f.url + '/sessions', { headers: { host: '127.attacker.invalid', authorization: `Bearer ${f.token}` } }, res => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(hostileHost, 403)
  assert.equal((await f.request('/sessions', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.deepEqual((await f.request('/sessions')).body.items.map((s: any) => s.sessionId), ['session-a'])
  assert.equal(f.resolveCount(), 0)
})

test('tasks reject invalid input, missing sessions and model overrides', async t => {
  const f = await fixture(t)
  if (!f) return
  for (const body of [null, [], {}, { sessionId: 'session-a', message: ' ' }, { sessionId: 'session-a', message: 3 },
    { sessionId: 'session-a', message: 'test', model: 'other-model' }]) {
    assert.equal((await f.request('/tasks', body)).status, 400)
  }
  assert.equal((await f.request('/tasks', { sessionId: 'missing', message: 'test' })).status, 404)
  assert.equal(f.queued.length, 0)
  const badJson = await fetch(f.url + '/tasks', { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: '{' })
  assert.equal(badJson.status, 400)
  assert.equal((await f.request('/tasks', { sessionId: 'session-a', message: 'x'.repeat(70_000) })).status, 413)
})

test('task relays a recorded message and reports only its own turn and actual model', async t => {
  const f = await fixture(t)
  if (!f) return
  const submitted = await f.request('/tasks', { sessionId: 'session-a', message: '读取工作区文件' })
  assert.equal(submitted.status, 202)
  const id = submitted.body.taskId
  assert.equal(submitted.body.status, 'queued')
  // v4 拒绝裸 'plugin' source；第三方插件的生产方自有 kind 是 `plugin:<包名>`
  assert.deepEqual(f.queued[0].source, { kind: 'plugin:dsh-agent-bridge', form: 'relay' })
  assert.deepEqual(f.queued[0].content, [{ type: 'text', text: '读取工作区文件' }])
  assert.equal(submitted.body.messageId, f.queued[0].id)
  const assistant = (turn: number, text: string) => ({ turn, step: 1, stream: [], message: { content: [{ type: 'text', text }], source: { kind: 'model', provider: 'cloud-route', model: 'session-choice' } } })
  f.emit('assistant/message', assistant(4, 'unrelated'))
  assert.equal((await f.request(`/tasks/${id}`)).body.response, '')
  f.claim(f.queued[0], 5)
  f.emit('assistant/message', assistant(5, 'other session'), { id: 'session-b' })
  f.emit('tool/call', { turn: 5, step: 1, name: 'read_file', callId: 'call-1', arguments: '{}' })
  f.emit('tool/result', { turn: 5, step: 1, message: { role: 'tool', id: 'result-1', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', isError: false, content: [] } })
  f.emit('assistant/message', assistant(5, '文件内容已读取'))
  assert.equal((await f.request(`/tasks/${id}`)).body.status, 'running')
  f.emit('turn/end', { turn: 5, reason: { kind: 'completed' } })
  const result = (await f.request(`/tasks/${id}`)).body
  assert.equal(result.status, 'succeeded')
  assert.equal(result.response, '文件内容已读取')
  assert.deepEqual(result.model, { provider: 'cloud-route', model: 'session-choice' })
  assert.equal(result.tools[0].name, 'read_file')
  assert.equal(result.tools[0].status, 'completed')
})

test('blocked, failed and interrupted turns never become successful', async t => {
  const f = await fixture(t)
  if (!f) return
  for (const [kind, status] of [['blocked', 'failed'], ['error', 'failed'], ['max-tokens', 'failed'], ['interrupted', 'interrupted'], ['aborted', 'cancelled']]) {
    const { body } = await f.request('/tasks', { sessionId: 'session-a', message: 'test' })
    f.claim(f.queued[0], 1)
    f.emit('turn/end', { turn: 1, reason: kind === 'error' ? { kind, error: { message: 'provider unavailable', code: 'UNKNOWN' } } : { kind } })
    assert.equal((await f.request(`/tasks/${body.taskId}`)).body.status, status)
  }
  const overflow = (await f.request('/tasks', { sessionId: 'session-a', message: 'test' })).body
  f.claim(f.queued[0], 6)
  f.emit('turn/end', { turn: 6, reason: { kind: 'error', error: { message: 'x'.repeat(2000), code: 'UNKNOWN' } } })
  const failed = (await f.request(`/tasks/${overflow.taskId}`)).body
  assert.equal(failed.reason.error.message.length, 500)
  assert.equal(failed.reason.error.code, 'UNKNOWN')
})

test('cancelling one queued task preserves all other messages', async t => {
  const f = await fixture(t)
  if (!f) return
  const first = (await f.request('/tasks', { sessionId: 'session-a', message: 'first' })).body
  const second = (await f.request('/tasks', { sessionId: 'session-a', message: 'second' })).body
  assert.equal((await f.request(`/tasks/${first.taskId}/cancel`, {})).body.status, 'cancelled')
  assert.equal(f.queued.length, 1)
  assert.equal(f.queued[0].id, second.messageId)
  assert.equal(f.cancels.length, 0)
})

test('running cancellation preserves inbox and waits for turn end', async t => {
  const f = await fixture(t)
  if (!f) return
  const first = (await f.request('/tasks', { sessionId: 'session-a', message: 'first' })).body
  f.claim(f.queued[0], 2)
  const second = (await f.request('/tasks', { sessionId: 'session-a', message: 'second' })).body
  assert.equal((await f.request(`/tasks/${first.taskId}/cancel`, {})).body.status, 'cancelling')
  assert.equal(f.cancels.length, 1)
  assert.deepEqual(f.cancels[0].options, { keepInbox: true })
  assert.equal(f.queued[0].id, second.messageId)
  f.emit('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  assert.equal((await f.request(`/tasks/${first.taskId}`)).body.status, 'cancelled')
  await f.request(`/tasks/${first.taskId}/cancel`, {})
  assert.equal(f.cancels.length, 1)
})

test('timeout removes a queued task and disposal closes the listener', async t => {
  const f = await fixture(t, 50)
  if (!f) return
  const { body } = await f.request('/tasks', { sessionId: 'session-a', message: 'wait' })
  let status = 'queued'
  for (let i = 0; i < 30 && status === 'queued'; i++) {
    await delay(10)
    status = (await f.request(`/tasks/${body.taskId}`)).body.status
  }
  assert.equal(status, 'timed-out')
  assert.equal(f.queued.length, 0)
  await f.loader.resolve('agent-bridge').fiber.dispose()
  await assert.rejects(fetch(f.url + '/health', { signal: AbortSignal.timeout(1000) }))
  assert.equal(existsSync(f.descriptor), false)
})

test('HTTP disconnect does not cancel accepted work and disposed agents settle tasks', async t => {
  const f = await fixture(t)
  if (!f) return
  const { body } = await f.request('/tasks', { sessionId: 'session-a', message: 'work' })
  f.claim(f.queued[0], 1)
  assert.equal(f.cancels.length, 0)
  f.ctx.emit('agent/disposed', { agent: f.agent })
  assert.equal((await f.request(`/tasks/${body.taskId}`)).body.status, 'interrupted')
})
