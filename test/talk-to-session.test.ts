import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { resolveActiveRuntimeDir } from '../src/runtime-slots.js'

const plugin = resolve('plugins/dsh-talk-to-session/lib/index.js')
const runtime = resolveActiveRuntimeDir(resolve('Data/Runtime/dsh-runtime'))
const TOKEN = 'test-token-0123456789abcdef'

const SESSIONS = [
  { id: 'ses_alpha', title: '写手', directory: 'G:\\DSH-3-Portable', time: { created: 1, updated: 20 } },
  { id: 'ses_beta', title: '文档助手', directory: 'C:\\work\\docs', time: { created: 2, updated: 10 } },
  { id: 'ses_gamma', title: '写手', directory: 'C:\\other', time: { created: 3, updated: 30 } },
]

interface FakeOptions {
  busy?: boolean
  silentReply?: boolean
  reply?: string
  sessions?: unknown[]
}

/** 复刻 MiMo 桌面 API 的关键行为：Bearer 必需、model 必填、注入后先落空 assistant 占位。 */
async function fakeMimo(t: TestContext, options: FakeOptions = {}) {
  const messages: any[] = [{ info: { role: 'assistant', modelID: 'mimo-v2.6-flash' }, parts: [{ type: 'text', text: '旧回信' }] }]
  const requests: any[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const record = { method: req.method, path: url.pathname, authorization: req.headers.authorization ?? '', body: undefined as any }
    requests.push(record)
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { code: 'unauthorized', message: 'invalid or missing token' })
    if (url.pathname === '/v1/health') return json(200, { ok: true, api: 1 })
    if (url.pathname === '/v1/sessions') return json(200, options.sessions ?? SESSIONS)
    if (/^\/v1\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json(200, messages)
    if (/^\/v1\/sessions\/[^/]+\/turns$/.test(url.pathname) && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        record.body = body
        if (options.busy) return json(409, { code: 'busy', message: 'session busy' })
        if (typeof body.model !== 'string' || !body.model) return json(400, { code: 'bad-request', message: 'bad request' })
        messages.push({ info: { role: 'user', modelID: '' }, parts: [{ type: 'text', text: body.message }] })
        messages.push({ info: { role: 'assistant', modelID: body.model }, parts: [] })
        if (!options.silentReply) {
          messages.push({ info: { role: 'assistant', modelID: body.model }, parts: [{ type: 'text', text: options.reply ?? '回信正文' }] })
        }
        json(202, { ok: true })
      })
      return
    }
    json(404, { code: 'not-found', message: 'not found' })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  t.after(() => server.close())
  return { port: (server.address() as any).port, requests, messages }
}

async function fixture(t: TestContext, options: FakeOptions & { config?: Record<string, unknown>, missingDescriptor?: boolean } = {}) {
  if (!runtime || !existsSync(plugin)) {
    t.skip('官方运行时或插件源缺失（CI 全新检出）')
    return
  }
  const official = join(runtime, 'node_modules/@deepseek-ai')
  const { Context } = await import(pathToFileURL(join(official, 'cordis/lib/index.js')).href)
  const { Loader } = await import(pathToFileURL(join(official, 'cordis-plugin-loader/lib/index.js')).href)
  const mimo = await fakeMimo(t, options)
  const home = await mkdtemp(join(tmpdir(), 'talk-to-session-'))
  // 官方包只在运行时槽里；仓库根的 plugins/ 就地 import 解析不到 @deepseek-ai/*，
  // 插件会 import 失败并被 Loader 丢弃。按仓库既有做法（system-awareness 用例）拷进临时
  // profile 并软链官方包，才是"真实 Profile + Loader 组合"。
  const profileDir = join(home, 'profiles/test')
  const installed = join(profileDir, 'node_modules/dsh-talk-to-session')
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  await symlink(official, join(profileDir, 'node_modules/@deepseek-ai'), 'junction')
  await cp(resolve('plugins/dsh-talk-to-session'), installed, { recursive: true })
  const entryFile = join(installed, 'lib/index.js')
  const dir = home
  const descriptor = join(dir, 'desktop-api.json')
  if (!options.missingDescriptor) {
    await writeFile(descriptor, JSON.stringify({ api: 1, port: mimo.port, token: TOKEN, pid: 4242 }))
  }
  const ctx = new Context()
  const registered: any[] = []
  ctx.provide('tools', {
    register(tool: any) { registered.push(tool); return () => {} },
    schemas() { return registered.map(tool => ({ name: tool.name })) },
  })
  const loaderFiber = ctx.plugin(Loader)
  await loaderFiber
  const loader = ctx.get('loader')
  t.after(async () => {
    await loaderFiber.dispose()
    await ctx.fiber.dispose()
  })
  await loader.create({
    id: 'talk-to-session',
    name: pathToFileURL(entryFile).href,
    config: { descriptorPath: descriptor, pollIntervalMs: 250, replyTimeoutMs: 1200, ...options.config },
  })
  await loader.await()
  let entry: any
  try {
    entry = loader.resolve('talk-to-session')
  } catch {
    entry = undefined
  }
  const entryIds = [...loader.entries()].map((item: any) => item.options?.id ?? item.id).join(',')
  assert.ok(entry?.fiber, `plugin must stay loaded（当前条目：${entryIds}）`)
  assert.equal(entry.fiber.state, 2, 'plugin must be ACTIVE with tools injected')
  const tool = (name: string) => {
    const found = registered.find(entry => entry.name === name)
    assert.ok(found, `${name} must be registered`)
    return found
  }
  const run = (name: string, args: any) => tool(name).execute(args, { signal: new AbortController().signal })
  return { mimo, descriptor, registered, run, tool }
}

test('outbound plugin registers talk_to_session and talk_contacts through a real Loader', async t => {
  const f = await fixture(t)
  if (!f) return
  assert.deepEqual(f.registered.map((entry: any) => entry.name).sort(), ['talk_contacts', 'talk_to_session'])
  assert.equal(f.registered.every((entry: any) => typeof entry.execute === 'function'), true)
})

test('sync mode delivers a prefixed self-contained message and returns the reply', async t => {
  const f = await fixture(t, { reply: '结论：可以对接' })
  if (!f) return
  const result = await f.run('talk_to_session', { contact: 'ses_beta', message: '背景：验证链路。任务：回一行结论。' })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'replied')
  assert.equal(result.reply, '结论：可以对接')
  assert.equal(result.contact.id, 'ses_beta')
  assert.equal(result.model, 'mimo-v2.6-flash')
  const turn = f.mimo.requests.find(request => request.path.endsWith('/turns'))
  assert.equal(turn.authorization, `Bearer ${TOKEN}`)
  assert.equal(turn.body.origin, 'dsh-bridge')
  assert.equal(turn.body.model, 'mimo-v2.6-flash', 'MiMo 端 model 必填，必须显式发出')
  assert.match(turn.body.message, /^【会话对话\|来自会话「DSH 便携版3」】\n/)
  assert.match(turn.body.message, /背景：验证链路/)
  assert.equal(JSON.stringify(result).includes(TOKEN), false, '结果里绝不能出现令牌')
})

test('target-side model requirement surfaces as an actionable error, never a silent success', async t => {
  const f = await fixture(t, { config: { model: '' } })
  if (!f) return
  await assert.rejects(
    f.run('talk_to_session', { contact: 'ses_beta', message: 'x' }),
    (error: any) => error.code === 'MIMO_HTTP_400' && /model 非空/.test(error.message) && !error.message.includes(TOKEN),
  )
})

test('busy target is reported as retryable, not as success', async t => {
  const f = await fixture(t, { busy: true })
  if (!f) return
  await assert.rejects(
    f.run('talk_to_session', { contact: 'ses_beta', message: 'x' }),
    (error: any) => error.code === 'MIMO_HTTP_409' && /正忙/.test(error.message),
  )
})

test('an empty assistant placeholder is not accepted as a reply', async t => {
  const f = await fixture(t, { silentReply: true })
  if (!f) return
  const result = await f.run('talk_to_session', { contact: 'ses_beta', message: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'timeout')
})

test('contact resolution accepts a unique title, uses ids for collisions and reports unknown contacts', async t => {
  const f = await fixture(t)
  if (!f) return
  const byTitle = await f.run('talk_to_session', { contact: '文档助手', message: 'x', mode: 'async' })
  assert.equal(byTitle.status, 'queued')
  assert.equal(byTitle.contact.id, 'ses_beta')
  await assert.rejects(
    f.run('talk_to_session', { contact: '写手', message: 'x', mode: 'async' }),
    (error: any) => error.code === 'CONTACT_AMBIGUOUS' && /ses_alpha/.test(error.message) && /ses_gamma/.test(error.message),
  )
  await assert.rejects(
    f.run('talk_to_session', { contact: '不存在的会话', message: 'x', mode: 'async' }),
    (error: any) => error.code === 'CONTACT_NOT_FOUND',
  )
})

test('async mode acknowledges the injection without waiting', async t => {
  const f = await fixture(t, {})
  if (!f) return
  const result = await f.run('talk_to_session', { contact: 'ses_alpha', message: 'x', mode: 'async' })
  assert.equal(result.status, 'queued')
  assert.equal(f.mimo.requests.some(request => request.path.endsWith('/messages')), false, 'async 不应轮询回信')
})

test('missing descriptor reports that MiMo Desktop is not running', async t => {
  const f = await fixture(t, { missingDescriptor: true })
  if (!f) return
  await assert.rejects(
    f.run('talk_to_session', { contact: 'ses_alpha', message: 'x' }),
    (error: any) => error.code === 'MIMO_NOT_RUNNING',
  )
})

test('talk_contacts lists the address book and never mutates the target session', async t => {
  const f = await fixture(t)
  if (!f) return
  const all = await f.run('talk_contacts', {})
  assert.equal(all.count, 3)
  assert.deepEqual(all.contacts.map((contact: any) => contact.id), ['ses_alpha', 'ses_beta', 'ses_gamma'])
  const filtered = await f.run('talk_contacts', { query: 'docs' })
  assert.deepEqual(filtered.contacts.map((contact: any) => contact.id), ['ses_beta'])
  assert.equal(f.mimo.requests.some(request => request.path.endsWith('/turns')), false, '只读工具不得注入任何回合')
})

test('parameter schema rejects a missing message before any HTTP call', async t => {
  const f = await fixture(t)
  if (!f) return
  await assert.rejects(f.run('talk_to_session', { contact: 'ses_alpha' }))
  assert.equal(f.mimo.requests.length, 0, '参数校验失败时不得触达目标端')
})
