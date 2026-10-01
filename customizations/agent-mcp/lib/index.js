import Schema from 'schemastery'
import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve as resolvePath, dirname } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ensureToken } from './credentials.js'
import { registerMcpSettings } from './settings-api.js'

export const name = 'dsh-agent-mcp'
export const inject = ['sessionController']
export const Config = Schema.object({
  port: Schema.number().min(0).max(65535).step(1).default(9801).description('本机 MCP HTTP 端口，0 自动分配'),
  timeoutMs: Schema.number().min(1).max(3600000).step(1).default(600000).description('任务超时毫秒数'),
  maxTasks: Schema.number().min(1).max(1000).step(1).default(100).description('最多保留的任务数'),
  // Resolve the Bridge by folder, never by a baked-in drive letter: the whole
  // point of the portable layout is that the drive can change.
  bridgeDir: Schema.string().default('').description('外部 Agent Bridge 目录（含 start.py）；留空表示未配置，换盘只改这里'),
  bridgePort: Schema.number().min(1).max(65535).step(1).default(8765).description('外部 Agent Bridge 的本机端口'),
})

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed-out', 'interrupted'])
const maxBodyBytes = 65536
const maxResponseChars = 1024 * 1024
// 服务器支持的 MCP 协议版本，降序（最新优先）。客户端请求未知版本时回退最新。
const protocolVersions = ['2025-06-18', '2025-03-26', '2024-11-05']
const maxMcpSessions = 64

export async function* apply(ctx, config) {
  const log = ctx.logger(name)
  const tasks = new Map()
  const activeTurns = new Map()
  const mcpSessions = new Set()
  // 令牌持久化：MCP 客户端（ZCode 等）的 Authorization 头是静态配置，
  // 与 dsh-agent-bridge 的每次随机不同，这里复用上次生成的令牌，重启不失效。
  const descriptor = join(process.env.DSH_HOME || process.cwd(), 'agent-mcp.json')
  const token = ensureToken(process.env.DSH_HOME || process.cwd())
  const lifetime = new AbortController()
  let stopping = false
  let pendingSubmissions = 0
  let authority

  function view(task) {
    const { agent, stopTimer, cancelStatus, ...result } = task
    return result
  }

  function finish(task, status, reason) {
    if (terminal.has(task.status)) return
    task.status = status
    task.reason = reason?.error ? { kind: reason.kind, error: { code: reason.error.code, message: String(reason.error.message).slice(0, 500) } } : reason
    task.finishedAt = Date.now()
    task.stopTimer?.()
    task.stopTimer = undefined
  }

  function cancel(task, status = 'cancelled') {
    if (terminal.has(task.status) || task.status === 'cancelling') return
    task.cancelStatus = status
    if (task.agent.inbox.remove(task.messageId)) {
      finish(task, status, { kind: status })
    } else if (task.turn !== undefined && activeTurns.get(task.sessionId) === task.turn) {
      task.status = 'cancelling'
      task.agent.cancel({ kind: 'hook', reason: `agent-mcp:${status}` }, { keepInbox: true })
    } else {
      finish(task, 'interrupted', { kind: 'ownership-lost' })
    }
  }

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    for (const task of tasks.values()) {
      if (task.agent === agent && task.messageId === message.id && !terminal.has(task.status)) {
        task.turn = turn
        task.status = 'running'
      }
    }
  })
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    for (const task of tasks.values()) {
      if (task.agent === agent && task.messageId === message.id) {
        finish(task, task.cancelStatus || 'cancelled', { kind: 'discarded' })
      }
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    activeTurns.delete(agent.id)
    for (const task of tasks.values()) {
      if (task.agent === agent) finish(task, 'interrupted', { kind: 'agent-disposed' })
    }
  })
  ctx.on('session/event', (session, event) => {
    const data = event.data
    if (event.type === 'turn/start') activeTurns.set(session.id, data.turn)
    for (const task of tasks.values()) {
      if (task.agent.session !== session || task.turn === undefined || task.turn !== data.turn || terminal.has(task.status)) continue
      if (event.type === 'assistant/message') {
        const text = data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        const response = task.response + text
        task.response = response.slice(0, maxResponseChars)
        if (response.length > maxResponseChars) task.truncated = true
        task.model = { provider: data.message.source.provider, model: data.message.source.model }
      } else if (event.type === 'tool/call') {
        if (task.tools.length < 100) task.tools.push({ callId: data.callId, name: data.name, status: 'running' })
        else task.truncated = true
      } else if (event.type === 'tool/result') {
        // v4 契约：toolCallId/isError 在消息层（createToolResultMessage），不在 content[0] 的
        // 已退役 tool-result 包装块里（dsh-llm/lib/types/message.js:92-100）。
        const message = data.message
        const callId = message.toolCallId ?? message.source?.callId
        const tool = task.tools.find(item => item.callId === callId)
        if (tool) tool.status = message.isError ? 'failed' : 'completed'
      } else if (event.type === 'turn/end') {
        const kind = data.reason.kind
        const status = kind === 'completed' ? 'succeeded' : kind === 'aborted' ? task.cancelStatus || 'cancelled' : kind === 'interrupted' ? 'interrupted' : 'failed'
        finish(task, status, data.reason)
      }
    }
    if (event.type === 'turn/end' && activeTurns.get(session.id) === data.turn) activeTurns.delete(session.id)
  })

  async function submit(sessionId, messageText) {
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200 ||
      typeof messageText !== 'string' || !messageText.trim()) {
      throw httpError(400, '仅接受非空的 sessionId 与 message；模型沿用会话选择')
    }
    if (tasks.size + pendingSubmissions >= config.maxTasks) {
      for (const [id, task] of tasks) {
        if (terminal.has(task.status)) { tasks.delete(id); break }
      }
    }
    if (tasks.size + pendingSubmissions >= config.maxTasks) throw httpError(429, '任务已满，请等待现有任务结束')
    pendingSubmissions++
    try {
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if (stopping) throw httpError(503, 'MCP 接口正在停止')
      if (resolved.error) {
        throw httpError(resolved.error.code === 'session/not-found' ? 404 : 409, resolved.error.code)
      }
      const message = createUserMessage({
        content: [{ type: 'text', text: messageText }],
        // v4 契约：source.kind 不再接受裸 'plugin'（会被 session 格式校验拒绝：
        // "format v4 message requires a producer-owned source kind"）。官方迁移器 producerKind()
        // 对第三方插件产出 `plugin:<包名>`（dsh-session-format-v3-to-v4/lib/index.js:87-93）；
        // form:'relay' 保留"另一个 agent 发给本会话"的语义（铁律 1：模型可见即已记录）。
        source: { kind: `plugin:${name}`, form: 'relay' },
      })
      const task = {
        taskId: randomUUID(), sessionId, messageId: message.id,
        status: 'queued', response: '', tools: [], createdAt: Date.now(), agent: resolved.agent,
      }
      tasks.set(task.taskId, task)
      task.stopTimer = ctx.effect(() => {
        const timer = setTimeout(() => cancel(task, 'timed-out'), config.timeoutMs)
        timer.unref()
        return () => clearTimeout(timer)
      }, 'agent-mcp: task deadline')
      try {
        resolved.agent.followup(message)
      } catch (error) {
        cancel(task)
        throw error
      }
      return view(task)
    } finally {
      pendingSubmissions--
    }
  }

  function readStateFile(file) {
    if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(file)) {
      throw httpError(400, 'file 必须是 DSH home 顶层的 *.json 文件名')
    }
    const home = resolvePath(process.env.DSH_HOME || process.cwd())
    const target = resolvePath(join(home, file))
    if (dirname(target) !== home) throw httpError(400, '仅允许 home 顶层文件，不接受路径穿越')
    return JSON.parse(readFileSync(target, 'utf8'))
  }

  const toolCatalog = [
    {
      name: 'dsh_capabilities',
      description: '列出本 MCP 服务器的全部工具、中继语义与使用约束。首次接入先调用。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'dsh_list_sessions',
      description: '列出 DSH 现有会话（sessionId、更新时间、是否运行中），用于选择任务投递目标。绝不新建会话。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'dsh_send_task',
      description: '把一条任务消息投递给指定 DSH 会话（中继模式）：会话沿用其已选模型、定制工具与审批策略执行，回合结束时得出结果。任务异步进行，用 dsh_task_status 查询。',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 ID（来自 dsh_list_sessions）' },
          message: { type: 'string', description: '任务指令文本（清晰、一次说全）' },
        },
        required: ['sessionId', 'message'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_task_status',
      description: '查询已投递任务的状态与产出（响应文本、工具调用轨迹、实际所用模型）。',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string', description: 'dsh_send_task 返回的任务 ID' } },
        required: ['taskId'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_cancel_task',
      description: '取消一个尚未结束的任务。',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
        additionalProperties: false,
      },
    },
    {
      name: 'dsh_read_state',
      description: '读取 DSH home 目录顶层的 JSON 状态文件（如 agent-bridge.json、agent-mcp.json），用于了解本机受控端点的发现信息。不接受路径穿越。',
      inputSchema: {
        type: 'object',
        properties: { file: { type: 'string', description: '文件名，如 agent-bridge.json' } },
        required: ['file'],
        additionalProperties: false,
      },
    },
  ]
  const toolRuns = {
    dsh_capabilities: async () => ({
      server: name,
      mode: 'relay',
      semantics: '任务经 DSH 会话中继执行：投递给既有会话，由会话已选模型用其定制工具完成；本服务器不直接执行业务功能，也不新建会话、不重启应用。',
      flow: 'dsh_list_sessions → dsh_send_task → dsh_task_status（必要时 dsh_cancel_task）',
      tools: toolCatalog.map(({ name: toolName, description }) => ({ name: toolName, description })),
      notes: [
        '任务继承目标会话的模型、工具与审批策略（approvalPolicy: DSH-native）',
        '投递消息以 source plugin:dsh-agent-mcp / form relay 记录进会话（模型可见即已记录）',
        '无重启/退出类工具（无限重启护栏铁律）',
      ],
    }),
    dsh_list_sessions: async () => ctx.sessionController.list({}, lifetime.signal),
    dsh_send_task: async args => {
      if (!args || typeof args !== 'object') throw httpError(400, '需要 arguments 对象')
      return submit(args.sessionId, args.message)
    },
    dsh_task_status: async args => {
      const task = args && tasks.get(args.taskId)
      if (!task) throw httpError(404, '此实例没有该任务；请查原 DSH 会话，不要自动重交')
      return view(task)
    },
    dsh_cancel_task: async args => {
      const task = args && tasks.get(args.taskId)
      if (!task) throw httpError(404, '此实例没有该任务；请查原 DSH 会话，不要自动重交')
      cancel(task)
      return view(task)
    },
    dsh_read_state: async args => readStateFile(args?.file),
  }

  function errorResponse(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } }
  }

  async function handleRpc(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.jsonrpc !== 'string' || message.jsonrpc !== '2.0') {
      return { response: errorResponse(null, -32600, '请求不是合法的 JSON-RPC 2.0 消息') }
    }
    const { id, method, params } = message
    const isNotification = id === undefined || id === null
    try {
      switch (method) {
        case 'initialize': {
          const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : protocolVersions[0]
          const version = protocolVersions.includes(requested) ? requested : protocolVersions[0]
          const sessionId = randomUUID()
          mcpSessions.add(sessionId)
          if (mcpSessions.size > maxMcpSessions) mcpSessions.delete(mcpSessions.values().next().value)
          return {
            response: {
              jsonrpc: '2.0', id,
              result: {
                protocolVersion: version,
                capabilities: { tools: {} },
                serverInfo: { name, version: '1.0.0' },
                instructions: 'DSH Agent MCP（中继模式）：先 dsh_list_sessions 选目标会话，再 dsh_send_task 投递任务，用 dsh_task_status 查询结果。任务由会话已选模型执行。',
              },
            },
            sessionId,
          }
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return { response: null }
        case 'ping':
          return { response: { jsonrpc: '2.0', id, result: {} } }
        case 'tools/list':
          return { response: { jsonrpc: '2.0', id, result: { tools: toolCatalog } } }
        case 'tools/call': {
          const toolName = params?.name
          const tool = toolRuns[toolName]
          if (!tool) return { response: errorResponse(id, -32602, `未知工具：${toolName}`) }
          try {
            const result = await tool(params?.arguments || {})
            return { response: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } } }
          } catch (error) {
            if (error.status) {
              return { response: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }], isError: true } } }
            }
            throw error
          }
        }
        default:
          if (isNotification) return { response: null }
          return { response: errorResponse(id, -32601, `未知方法：${method}`) }
      }
    } catch (error) {
      if (!error.status) log.error(error)
      if (isNotification) return { response: null }
      return { response: errorResponse(id, -32603, 'DSH 请求失败，请查看宿主日志') }
    }
  }

  async function handle(req, res) {
    try {
      if (req.headers.host !== authority || req.headers.origin !== undefined ||
        (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'none')) {
        throw httpError(403, '仅允许本机 Agent 请求')
      }
      if (req.url.split('?')[0] !== '/mcp') throw httpError(404, '接口不存在：POST /mcp')
      if (req.method === 'GET') throw httpError(405, '本服务器不提供 SSE 监听流，请用 POST 请求')
      if (req.method === 'DELETE') {
        const provided0 = Buffer.from(req.headers.authorization || '')
        const expected0 = Buffer.from(`Bearer ${token}`)
        if (provided0.length !== expected0.length || !timingSafeEqual(provided0, expected0)) throw httpError(401, '需要本机 MCP 令牌')
        const sid = req.headers['mcp-session-id']
        if (typeof sid === 'string') mcpSessions.delete(sid)
        res.writeHead(204).end()
        return
      }
      if (req.method !== 'POST') throw httpError(405, '仅支持 POST /mcp')
      const provided = Buffer.from(req.headers.authorization || '')
      const expected = Buffer.from(`Bearer ${token}`)
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw httpError(401, '需要本机 MCP 令牌')
      if (stopping) throw httpError(503, 'MCP 接口正在停止')
      const sid = req.headers['mcp-session-id']
      if (sid !== undefined && !mcpSessions.has(String(sid))) {
        // MCP 规范：未知会话返回 404，客户端应重新 initialize
        throw httpError(404, 'MCP 会话已过期或不存在，请重新 initialize')
      }
      const body = await readJsonBody(req)
      const { response, sessionId } = await handleRpc(body)
      if (!response) {
        res.writeHead(202, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      if (sessionId) headers['mcp-session-id'] = sessionId
      if (res.destroyed || res.writableEnded) return
      res.writeHead(200, headers)
      res.end(JSON.stringify(response))
    } catch (error) {
      if (!error.status) log.error(error)
      sendJson(res, error.status || 500, { error: error.status ? error.message : 'DSH 请求失败，请查看宿主日志' })
    }
  }

  const server = http.createServer((req, res) => { void handle(req, res) })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', () => {
      authority = `127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  // 建连与写发现文件必须先于第一次 yield 完成：async generator 的 yield 点交出的是"处置器"，
  // 其后代码不属于加载阶段。实测教训（agent-bridge 条目 13）：放在 yield 之后时 create() 返回时
  // fiber 仍 LOADING 且发现文件尚未落盘；EADDRINUSE 也只在 yield 之后才抛，"失败关闭"失效。
  try {
    await listening
  } catch (error) {
    log.error('Agent MCP 无法监听 127.0.0.1:%s：%s', config.port, error.message)
    server.close()
    throw error
  }
  server.on('error', error => log.error(error))
  try {
    writeFileSync(descriptor, JSON.stringify({ url: `http://${authority}/mcp`, token, pid: process.pid }), { mode: 0o600 })
  } catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error }
  log.info('Agent MCP 已监听 %s', authority)
  // The 9800 HTTP channel belongs to dsh-agent-bridge, which this plugin does
  // not own. Only its discovery file is read for display; the bearer token it
  // holds is never surfaced, and nothing here starts or stops that process.
  const bridgeHomePath = process.env.DSH_HOME || process.cwd()
  let httpChannel = { url: '', pid: 0, online: false, reason: 'NO_DESCRIPTOR' }
  let httpProbeAt = 0, httpProbePending = null
  const probeHttpChannel = () => {
    if (Date.now() - httpProbeAt < 5000) return
    httpProbeAt = Date.now()
    if (httpProbePending) return
    httpProbePending = (async () => {
      try {
        const raw = JSON.parse(readFileSync(join(bridgeHomePath, 'agent-bridge.json'), 'utf8'))
        const url = String(raw.url || '')
        let online = false
        try { online = (await fetch(new URL('/health', url), { signal: AbortSignal.timeout(800), redirect: 'error' })).ok }
        catch { online = false }
        httpChannel = { url, pid: Number(raw.pid) || 0, online, reason: online ? '' : 'UNREACHABLE' }
      } catch { httpChannel = { url: '', pid: 0, online: false, reason: 'NO_DESCRIPTOR' } }
      httpProbePending = null
    })()
  }
  probeHttpChannel()
  registerMcpSettings(ctx, {
    httpChannel: () => { probeHttpChannel(); return httpChannel },
    status: () => ({ running: server.listening && !stopping, url: `http://${authority}/mcp`, mode: 'relay',
      configuredPort: config.port, timeoutMs: config.timeoutMs, maxTasks: config.maxTasks,
      tools: toolCatalog.map(({ name, description }) => ({ name, description })) }),
    credentials: () => ({ url: `http://${authority}/mcp`, token }),
  }, { dir: typeof config?.bridgeDir === 'string' ? config.bridgeDir.trim() : '', port: Number(config?.bridgePort) || 8765 })
  yield async () => {
    stopping = true
    lifetime.abort()
    for (const task of tasks.values()) cancel(task, 'interrupted')
    const closed = new Promise(resolve => server.close(resolve))
    server.closeAllConnections()
    await closed
    try {
      const owned = JSON.parse(readFileSync(descriptor, 'utf8'))
      if (owned.token === token && owned.pid === process.pid && owned.url === `http://${authority}/mcp`) unlinkSync(descriptor)
    } catch (error) {
      if (error.code !== 'ENOENT') log.warn('MCP 发现文件清理失败：%s', error.message)
    }
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

function sendJson(res, status, data) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

async function readJsonBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw httpError(415, '需要 application/json')
  const chunks = []
  let bytes = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > maxBodyBytes) {
      req.resume()
      throw httpError(413, '请求体不能超过 64 KiB')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'JSON 格式不正确')
  }
}
