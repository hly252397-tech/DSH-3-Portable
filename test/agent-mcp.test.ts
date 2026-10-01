import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises'
import { createServer as httpServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'

const runtime = resolveActiveRuntimeDir(resolve('Data/Runtime/dsh-runtime'))
// Test the archived candidate with current runtime peers, not the legacy
// Profile (which can still resolve dsh-llm from a retired runtime).
const source = resolve(process.env.DSH_AGENT_MCP_TEST_SOURCE || 'customizations/agent-mcp')
const { activeUiProfile } = await import(pathToFileURL(resolve('scripts/lib/active-ui-profile.mjs')).href)
const peers = join(activeUiProfile(resolve('.')).profile, 'node_modules')
let plugin = ''
if (runtime && existsSync(source) && existsSync(peers)) {
  const sandbox = await mkdtemp(join(tmpdir(), 'agent-mcp-package-'))
  await cp(source, join(sandbox, 'plugin'), { recursive: true })
  await mkdir(join(sandbox, 'node_modules'))
  await symlink(join(runtime, 'node_modules/@deepseek-ai'), join(sandbox, 'node_modules/@deepseek-ai'), 'junction')
  await symlink(join(peers, 'schemastery'), join(sandbox, 'node_modules/schemastery'), 'junction')
  plugin = join(sandbox, 'plugin/lib/index.js')
}

let nextRpcId = 0

async function fixture(t: TestContext, timeoutMs = 60_000, realLoop = false, settings = false) {
  if (!runtime || !existsSync(plugin)) {
    t.skip('实机插件/运行时缺失（CI 全新检出）')
    return
  }
  const official = join(runtime, 'node_modules/@deepseek-ai')
  const { Context } = await import(pathToFileURL(join(official, 'cordis/lib/index.js')).href)
  const { Loader } = await import(pathToFileURL(join(official, 'cordis-plugin-loader/lib/index.js')).href)
  const ctx = new Context()
  let settingsUrl = '', registered: any
  if (settings) {
    const web = httpServer((req, res) => registered ? registered.handler(req, res) : res.writeHead(404).end()).listen(0, '127.0.0.1')
    await new Promise(resolveItem => web.once('listening', resolveItem))
    settingsUrl = `http://127.0.0.1:${(web.address() as any).port}/dsh-agent-mcp/settings`
    ctx.provide('webServer', { register(route: any) { registered = route; return () => { registered = undefined } } })
    // Unit boundary only. The separate real Profile test exercises official cookie auth.
    ctx.provide('connection', { requestRejection(req: any) { return req.headers.cookie === 'fixture=authenticated' ? undefined : 401 } })
    t.after(() => { web.closeAllConnections(); web.close() })
  }
  const home = await mkdtemp(join(tmpdir(), 'agent-mcp-'))
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
  await loader.create({ id: 'agent-mcp', name: pathToFileURL(plugin).href, config: { port: 0, timeoutMs } })
  await loader.await()
  assert.equal(loader.resolve('agent-mcp').fiber.state, 2, 'must load using built-in logger, with no fake logger service')
  const descriptor = join(home, 'agent-mcp.json')
  assert.ok(existsSync(descriptor), 'listening MCP endpoint must publish an authenticated descriptor')
  const { url, token } = JSON.parse(await readFile(descriptor, 'utf8'))
  assert.match(token, /^[a-f0-9]{64}$/)
  assert.match(url, /\/mcp$/)
  const rpc = async (method: string, params?: any, opts: { notification?: boolean; sessionId?: string; headers?: Record<string, string> } = {}) => {
    const body: any = { jsonrpc: '2.0', method }
    if (!opts.notification) body.id = `rpc-${++nextRpcId}`
    if (params !== undefined) body.params = params
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(opts.sessionId ? { 'mcp-session-id': opts.sessionId } : {}),
        ...(opts.headers || {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
    const responseBody = response.status === 202 || response.status === 204 ? null : await response.json()
    return { status: response.status, headers: response.headers, body: responseBody as any }
  }
  const initialize = async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'zcode-test', version: '0' } })
    assert.equal(init.status, 200)
    return { sid: init.headers.get('mcp-session-id'), protocolVersion: init.body.result.protocolVersion as string }
  }
  const call = async (name: string, args: any, sessionId?: string) =>
    rpc('tools/call', { name, arguments: args }, sessionId ? { sessionId } : {})
  const toolJson = (result: any) => JSON.parse(result.content[0].text)
  const emit = (type: string, data: any, target = session) => ctx.emit('session/event', target, { type, data, seq: 1, time: Date.now() })
  const claim = (message: any, turn: number) => {
    queued.splice(queued.indexOf(message), 1)
    emit('turn/start', { turn })
    ctx.emit('agent/inbox/claimed', { agent, message, turn })
  }
  return { ctx, home, loader, agent, queued, cancels, emit, claim, rpc, call, toolJson, initialize, url, token, descriptor, official, events, modelRequests, settingsUrl, resolveCount: () => resolveCount }
}

test('authenticated settings expose explicit credentials and a real non-mutating MCP check', async t => {
  const f = await fixture(t, 60000, false, true)
  if (!f) return
  const request = (body: any, headers: any = {}, method = 'POST') => fetch(f.settingsUrl, { method,
    headers: { 'content-type': 'application/json', 'x-dsh-agent-mcp': '1', cookie: 'fixture=authenticated', ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) })
  assert.equal((await request({ operation: 'credentials' }, { cookie: '' })).status, 401)
  for (const headers of [{ origin: 'https://evil.invalid' }, { 'sec-fetch-site': 'cross-site' }, { 'x-dsh-agent-mcp': '' }]) {
    assert.equal((await request({ operation: 'credentials' }, headers)).status, 403, JSON.stringify(headers))
  }
  // fetch rewrites Host; raw HTTP is needed for the DNS-rebinding negative case.
  const badHost = await new Promise(resolveItem => {
    const req = httpRequest(f.settingsUrl, { method: 'POST', headers: { host: 'evil.invalid', cookie: 'fixture=authenticated', 'x-dsh-agent-mcp': '1', 'content-type': 'application/json' } }, res => { res.resume(); resolveItem(res.statusCode) })
    req.end(JSON.stringify({ operation: 'credentials' }))
  })
  assert.equal(badHost, 403)
  assert.equal((await request(null, {}, 'GET')).status, 405)
  assert.equal((await request({ operation: 'status' }, { 'content-type': 'text/plain' })).status, 415)
  for (const body of ['oops', 'null', '[]', { operation: 'restart' }, { operation: 'credentials', url: 'http://evil.invalid' }]) {
    assert.equal((await request(body)).status, 400)
  }
  assert.equal((await request(' '.repeat(1025))).status, 413)
  const response = await request({ operation: 'status' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  const status: any = await response.json()
  assert.equal(status.value.running, true)
  assert.equal(status.value.url, f.url)
  assert.equal(JSON.stringify(status).includes(f.token), false, 'status never includes secret')
  const credential: any = await (await request({ operation: 'credentials' })).json()
  assert.ok(credential.value.token === f.token, 'explicit credentials match existing MCP')
  const result: any = await (await request({ operation: 'check' })).json()
  assert.equal(result.value.tools.length, 6)
  assert.equal(f.queued.length, 0)
  assert.equal(f.resolveCount(), 0, 'check never executes task tools')
  const concurrent = await Promise.all([request({ operation: 'check' }), request({ operation: 'check' })])
  assert.deepEqual(concurrent.map(res => res.status).sort(), [200, 409], 'concurrent checks are single-flight')
  await f.loader.resolve('agent-mcp').fiber.dispose()
  assert.equal((await request({ operation: 'status' })).status, 404, 'disposal unregisters settings route')
})

test('credential migration preserves old clients and invalid durable credentials fail closed', async t => {
  const sourceModule = resolve('customizations/agent-mcp/lib/credentials.js')
  const { ensureToken } = await import(pathToFileURL(sourceModule).href)
  const home = await mkdtemp(join(tmpdir(), 'agent-mcp-credentials-'))
  const legacy = 'a'.repeat(64)
  await writeFile(join(home, 'agent-mcp.json'), JSON.stringify({ token: legacy }))
  assert.ok(ensureToken(home) === legacy)
  await writeFile(join(home, 'agent-mcp.json'), 'old disposer removed/replaced discovery')
  assert.ok(ensureToken(home) === legacy)
  await writeFile(join(home, 'agent-mcp.token'), 'corrupted')
  assert.throws(() => ensureToken(home), /Invalid persistent MCP credential/)
})

test('initialize negotiates the protocol version and issues a session id', async t => {
  const f = await fixture(t)
  if (!f) return
  const known = await f.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zcode', version: '0' } })
  assert.equal(known.status, 200)
  assert.equal(known.body.result.protocolVersion, '2025-03-26', 'an supported requested version is echoed')
  assert.equal(known.body.result.serverInfo.name, 'dsh-agent-mcp')
  assert.match(known.headers.get('mcp-session-id') || '', /^[0-9a-f-]{36}$/)
  const unknown = await f.rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {} })
  assert.equal(unknown.body.result.protocolVersion, '2025-06-18', 'an unsupported version falls back to the newest known one')
})

test('tools/list advertises the relay toolset without restart actions', async t => {
  const f = await fixture(t)
  if (!f) return
  const { sid } = await f.initialize()
  const listed = await f.rpc('tools/list', {}, { sessionId: sid! })
  assert.equal(listed.status, 200)
  const names = listed.body.result.tools.map((tool: any) => tool.name)
  assert.deepEqual(names, ['dsh_capabilities', 'dsh_list_sessions', 'dsh_send_task', 'dsh_task_status', 'dsh_cancel_task', 'dsh_read_state'])
  for (const tool of listed.body.result.tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.ok(tool.description.length > 10)
  }
  assert.equal(JSON.stringify(names).includes('restart'), false)
  assert.equal(JSON.stringify(names).includes('quit'), false)
})

test('capabilities describes the relay semantics', async t => {
  const f = await fixture(t)
  if (!f) return
  const { sid } = await f.initialize()
  const called = await f.call('dsh_capabilities', {}, sid!)
  assert.equal(called.status, 200)
  assert.equal(called.body.result.isError, undefined)
  const caps = f.toolJson(called.body.result)
  assert.equal(caps.mode, 'relay')
  assert.equal(caps.server, 'dsh-agent-mcp')
  assert.ok(caps.flow.includes('dsh_send_task'))
})

test('real AgentLoop executes a session task submitted through MCP', async t => {
  const f = await fixture(t, 60_000, true)
  if (!f) return
  const { sid } = await f.initialize()
  const { defineContentToolFixture } = await import(pathToFileURL(join(f.official, 'dsh-tools/lib/index.js')).href)
  let executions = 0
  f.ctx.tools.register(defineContentToolFixture({
    name: 'probe', description: 'Read test data', parameters: {},
    async execute() {
      executions++
      return [{ type: 'text', text: JSON.stringify({ descriptorExists: existsSync(f.descriptor) }) }]
    },
  }))
  const listed = await f.call('dsh_list_sessions', {}, sid!)
  assert.deepEqual(f.toolJson(listed.body.result).items.map((s: any) => s.sessionId), ['session-a'])
  const submitted = await f.call('dsh_send_task', { sessionId: f.agent.id, message: 'Run probe' }, sid!)
  assert.equal(submitted.status, 200)
  assert.equal(submitted.body.result.isError, undefined)
  const task = f.toolJson(submitted.body.result)
  await f.agent.whenIdle()
  const status = await f.call('dsh_task_status', { taskId: task.taskId }, sid!)
  const result = f.toolJson(status.body.result)
  assert.equal(result.status, 'succeeded', JSON.stringify(result))
  assert.equal(result.response, 'DONE')
  assert.equal(result.tools[0].status, 'completed')
  assert.deepEqual(result.model, { provider: 'fixture', model: 'session-choice' })
  assert.equal(f.modelRequests.length, 2)
  assert.ok(f.events.some(e => e.type === 'user/message' && e.data.source.kind === 'plugin:dsh-agent-mcp' && e.data.source.form === 'relay'))
  assert.equal(f.events.at(-1).type, 'turn/end')
})

test('task relays a recorded message and reports only its own turn', async t => {
  const f = await fixture(t)
  if (!f) return
  const { sid } = await f.initialize()
  const submitted = await f.call('dsh_send_task', { sessionId: 'session-a', message: '读取工作区文件' }, sid!)
  assert.equal(submitted.status, 200)
  const task = f.toolJson(submitted.body.result)
  assert.equal(task.status, 'queued')
  assert.deepEqual(f.queued[0].source, { kind: 'plugin:dsh-agent-mcp', form: 'relay' })
  assert.deepEqual(f.queued[0].content, [{ type: 'text', text: '读取工作区文件' }])
  const assistant = (turn: number, text: string) => ({ turn, step: 1, stream: [], message: { content: [{ type: 'text', text }], source: { kind: 'model', provider: 'cloud-route', model: 'session-choice' } } })
  f.emit('assistant/message', assistant(4, 'unrelated'))
  const untouched = f.toolJson((await f.call('dsh_task_status', { taskId: task.taskId }, sid!)).body.result)
  assert.equal(untouched.response, '')
  f.claim(f.queued[0], 5)
  f.emit('assistant/message', assistant(5, 'other session'), { id: 'session-b' })
  f.emit('tool/call', { turn: 5, step: 1, name: 'read_file', callId: 'call-1', arguments: '{}' })
  f.emit('tool/result', { turn: 5, step: 1, message: { role: 'tool', id: 'result-1', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', isError: false, content: [] } })
  f.emit('assistant/message', assistant(5, '文件内容已读取'))
  const running = f.toolJson((await f.call('dsh_task_status', { taskId: task.taskId }, sid!)).body.result)
  assert.equal(running.status, 'running')
  f.emit('turn/end', { turn: 5, reason: { kind: 'completed' } })
  const result = f.toolJson((await f.call('dsh_task_status', { taskId: task.taskId }, sid!)).body.result)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.response, '文件内容已读取')
  assert.deepEqual(result.model, { provider: 'cloud-route', model: 'session-choice' })
  assert.equal(result.tools[0].name, 'read_file')
  assert.equal(result.tools[0].status, 'completed')
})

test('protocol errors and tool errors are distinguishable', async t => {
  const f = await fixture(t)
  if (!f) return
  const { sid } = await f.initialize()
  const unknownTool = await f.call('dsh_restart_app', {}, sid!)
  assert.equal(unknownTool.body.error.code, -32602, 'unknown tool is a protocol-level invalid params error')
  const unknownMethod = await f.rpc('resources/list', {}, { sessionId: sid! })
  assert.equal(unknownMethod.body.error.code, -32601)
  const raw = await fetch(f.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' },
    body: 'not json at all',
    signal: AbortSignal.timeout(3000),
  })
  assert.equal(raw.status, 400, 'unparseable body is an HTTP error before JSON-RPC dispatch')
  const missingSession = await f.call('dsh_send_task', { sessionId: 'missing', message: 'x' }, sid!)
  assert.equal(missingSession.body.result.isError, true, 'a missing session is a tool-level error, not a protocol error')
  assert.ok(missingSession.body.result.content[0].text.includes('session/not-found'))
  const badArgs = await f.call('dsh_send_task', { sessionId: 'session-a' }, sid!)
  assert.equal(badArgs.body.result.isError, true)
  const note = await f.rpc('notifications/initialized', undefined, { notification: true, sessionId: sid! })
  assert.equal(note.status, 202)
  assert.equal(note.body, null)
})

test('authentication blocks non-local and anonymous callers without CORS', async t => {
  const f = await fixture(t)
  if (!f) return
  assert.equal((await f.rpc('tools/list', undefined, { headers: { authorization: '' } })).status, 401)
  assert.equal((await f.rpc('tools/list', undefined, { headers: { authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await f.rpc('tools/list', undefined, { headers: { origin: 'https://attacker.invalid' } })).status, 403)
  assert.equal((await f.rpc('tools/list', undefined, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal(f.resolveCount(), 0)
  assert.equal(f.token.length, 64)
})

test('stale MCP session ids are rejected with 404 so clients re-initialize', async t => {
  const f = await fixture(t)
  if (!f) return
  const stale = '00000000-0000-4000-8000-000000000000'
  assert.equal((await f.rpc('tools/list', {}, { sessionId: stale })).status, 404)
  const { sid } = await f.initialize()
  assert.equal((await f.rpc('tools/list', {}, { sessionId: sid! })).status, 200)
  const deleted = await fetch(f.url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${f.token}`, 'mcp-session-id': sid! },
    signal: AbortSignal.timeout(3000),
  })
  assert.equal(deleted.status, 204)
  assert.equal((await f.rpc('tools/list', {}, { sessionId: sid! })).status, 404, 'DELETE ends the session')
  assert.equal((await fetch(f.url, { method: 'GET', headers: { authorization: `Bearer ${f.token}` }, signal: AbortSignal.timeout(3000) })).status, 405, 'no SSE listening stream is offered')
})

test('read_state exposes home-level descriptors and refuses traversal', async t => {
  const f = await fixture(t)
  if (!f) return
  const { sid } = await f.initialize()
  const own = await f.call('dsh_read_state', { file: 'agent-mcp.json' }, sid!)
  const ownState = f.toolJson(own.body.result)
  assert.equal(ownState.pid, process.pid)
  assert.match(ownState.url, /\/mcp$/)
  for (const file of ['../escape.json', 'sub/dir.json', '.hidden', 'agent-mcp.json5']) {
    const refused = await f.call('dsh_read_state', { file }, sid!)
    assert.equal(refused.body.result.isError, true, file)
  }
})

test('a persisted token survives reloads and a corrupted descriptor is regenerated', async t => {
  if (!runtime || !existsSync(plugin)) return t.skip('实机插件/运行时缺失（CI 全新检出）')
  const official = join(runtime, 'node_modules/@deepseek-ai')
  const { Context } = await import(pathToFileURL(join(official, 'cordis/lib/index.js')).href)
  const { Loader } = await import(pathToFileURL(join(official, 'cordis-plugin-loader/lib/index.js')).href)
  const home = await mkdtemp(join(tmpdir(), 'agent-mcp-persist-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const descriptor = join(home, 'agent-mcp.json')
  const ctx = new Context()
  ctx.provide('sessionController', {})
  try {
    const loaderFiber = ctx.plugin(Loader)
    await loaderFiber
    const loader = ctx.get('loader')
    await writeFile(descriptor, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', token: 'corrupted', pid: 0 }), { mode: 0o600 })
    const first = await loader.create({ id: 'agent-mcp', name: pathToFileURL(plugin).href, config: { port: 0 } })
    await loader.await()
    assert.equal(loader.resolve('agent-mcp').fiber.state, 2)
    const regenerated = JSON.parse(await readFile(descriptor, 'utf8'))
    assert.match(regenerated.token, /^[a-f0-9]{64}$/, 'a corrupted persisted token is replaced')
    const persisted = regenerated.token
    await loader.resolve('agent-mcp').fiber.dispose()
    assert.equal(existsSync(descriptor), false, 'disposal removes the descriptor it owns')
    await assert.rejects(fetch(regenerated.url, { signal: AbortSignal.timeout(1000) }), 'disposal really closes the listener')
    const second = await loader.create({ id: 'agent-mcp', name: pathToFileURL(plugin).href, config: { port: 0 } })
    await loader.await()
    assert.equal(loader.resolve('agent-mcp').fiber.state, 2)
    const reused = JSON.parse(await readFile(descriptor, 'utf8'))
    assert.ok(reused.token === persisted, 'a valid persisted token survives reloads so MCP client headers stay valid')
    assert.ok((await readFile(join(home, 'agent-mcp.token'), 'utf8')).trim() === persisted, 'credentials survive without recreating discovery')
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('a busy port fails closed without publishing an endpoint descriptor', async t => {
  if (!runtime || !existsSync(plugin)) return t.skip('实机插件/运行时缺失（CI 全新检出）')
  const squatter = httpServer().listen(0, '127.0.0.1')
  await new Promise(resolveItem => squatter.once('listening', resolveItem))
  const port = (squatter.address() as any).port
  const official = join(runtime, 'node_modules/@deepseek-ai')
  const { Context } = await import(pathToFileURL(join(official, 'cordis/lib/index.js')).href)
  const { Loader } = await import(pathToFileURL(join(official, 'cordis-plugin-loader/lib/index.js')).href)
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'agent-mcp-busy-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  ctx.provide('sessionController', {})
  try {
    const loaderFiber = ctx.plugin(Loader)
    await loaderFiber
    const loader = ctx.get('loader')
    await loader.create({ id: 'agent-mcp', name: pathToFileURL(plugin).href, config: { port } })
    await loader.await()
    // 0.1.7-rc.2 的 Loader 不把插件异步加载失败上抛，而是把 fiber 留在 FAILED（state=3）。
    // "失败关闭"以可观测结果为准：fiber 必须 FAILED，且不得发布发现文件。
    assert.equal(loader.resolve('agent-mcp').fiber.state, 3, 'an MCP server that cannot listen must end FAILED, never ACTIVE')
    assert.equal(existsSync(join(home, 'agent-mcp.json')), false)
  } finally {
    squatter.close()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

// --- Agent Bridge link: the safety rules that must hold before any UI ships ---
const bridgeModule = existsSync(join(source, 'lib/bridge-link.js'))
  ? await import(pathToFileURL(join(source, 'lib/bridge-link.js')).href)
  : null

async function fakeBridge(t: TestContext, service: string, seen?: any[]) {
  const server = httpServer((req, res) => {
    seen?.push({ url: req.url, method: req.method, auth: req.headers.authorization })
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, service, instances: 2 })) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true, generated_at: 1700000000,
      runs: [{ run_id: 'run-1', task_id: 't1', agent_id: 'codex', state: 'succeeded', dispatch_state: 'DISPATCH_UNKNOWN', result: 'full transcript', error_code: '', created_at: 1, finished_at: 2, duration_s: 1, secret_note: 'must not survive' }],
      messages: [{ message_id: 'm1', msg_type: 'chat.message', sender_instance_id: 'i1', delivery_state: 'delivered', created_at: 3 }],
      workspaces: [{ workspace_id: 'w1', path: 'C:/work', writable: 1, created_at: 4 }],
      agents: [{ instance_id: 'i1', agent_id: 'codex', version: '1', capabilities: { submit: true }, last_seen_at: 5 }],
      stats: {}, adapters: { codex: { submit: true } },
    }))
  }).listen(0, '127.0.0.1')
  await new Promise(done => server.once('listening', done))
  t.after(() => { server.closeAllConnections(); server.close() })
  return (server.address() as any).port
}

test('a port answering something else is reported as not-a-Bridge, never adopted or displaced', async t => {
  if (!bridgeModule) return t.skip('实机插件缺失（CI 全新检出）')
  const squatter = await fakeBridge(t, 'some-other-service')
  const probe = await bridgeModule.probeBridge(squatter)
  assert.deepEqual(probe, { online: false, reason: 'PORT_NOT_BRIDGE' })
  const dead = httpServer().listen(0, '127.0.0.1')
  await new Promise(done => dead.once('listening', done))
  const deadPort = (dead.address() as any).port
  await new Promise(done => dead.close(done))
  assert.equal((await bridgeModule.probeBridge(deadPort)).reason, 'UNREACHABLE')
})

test('a healthy Bridge is adopted without spawning a second copy', async t => {
  if (!bridgeModule) return t.skip('实机插件缺失（CI 全新检出）')
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-adopt-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous })
  const dir = await mkdtemp(join(tmpdir(), 'agent-bridge-dir-'))
  await mkdir(join(dir, 'data'), { recursive: true })
  await writeFile(join(dir, 'start.py'), '# fixture')
  const port = await fakeBridge(t, 'agent-bridge')
  const started = await bridgeModule.startBridge({ bridgeDir: dir, port })
  assert.equal(started.ok, true)
  assert.equal(started.adopted, true, 'a reachable Bridge must be adopted, never duplicated')
  // A start request against a squatted port must refuse rather than spawn.
  const squatted = await fakeBridge(t, 'other-service')
  const refused = await bridgeModule.startBridge({ bridgeDir: dir, port: squatted })
  assert.equal(refused.ok, false)
  assert.equal(refused.error, 'PORT_NOT_BRIDGE')
})

test('stopping requires both a matching ownership record and a live child handle', async t => {
  if (!bridgeModule) return t.skip('实机插件缺失（CI 全新检出）')
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-stop-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous })
  // No record at all: nothing of ours to stop.
  assert.deepEqual(await bridgeModule.stopBridge(), { ok: false, error: 'NOT_OWNED' })
  // A record from a previous DSH run: the handle is gone, so it is not ours to kill.
  await writeFile(join(home, 'agent-bridge-ownership.json'), JSON.stringify({ token: 't', pid: 4242, port: 8765, bridgeDir: 'x', startedAt: 1, owner: 1 }))
  assert.deepEqual(await bridgeModule.stopBridge(), { ok: false, error: 'NOT_OWNED' })
  bridgeModule.forgetBridgeChild(4242)
})

test('console state is trimmed server-side and the admin token never reaches the caller', async t => {
  if (!bridgeModule) return t.skip('实机插件缺失（CI 全新检出）')
  const seen: any[] = []
  const port = await fakeBridge(t, 'agent-bridge', seen)
  const dir = await mkdtemp(join(tmpdir(), 'agent-bridge-token-'))
  await mkdir(join(dir, 'data'), { recursive: true })
  const token = 'a'.repeat(64)
  await writeFile(join(dir, 'data/admin.token'), `${token}\n`)
  const state = await bridgeModule.readBridgeState(port)
  assert.equal(JSON.stringify(state).includes(token), false, 'no credential may appear in the console payload')
  assert.equal((state.runs[0] as any).secret_note, undefined, 'unknown Bridge fields must be dropped, not forwarded')
  assert.equal(state.runs[0].verified, true, 'a run with a result is reported as unverified-but-produced, never as accepted')
  assert.equal(state.stats.active, 0)
  // Reading state must not require or send the token at all.
  assert.equal(seen.filter(call => call.url === '/console/state').every(call => !call.auth), true)
  const cancelled = await bridgeModule.cancelBridgeRun(dir, port, 'run-1')
  assert.deepEqual(cancelled, { ok: true, error_code: '' })
  const cancelCall = seen.find(call => call.url === '/console/cancel')
  assert.equal(cancelCall.auth, `Bearer ${token}`, 'control requests carry the token server-side')
  assert.equal(JSON.stringify(cancelled).includes(token), false, 'the cancel result must not echo the token')
})
