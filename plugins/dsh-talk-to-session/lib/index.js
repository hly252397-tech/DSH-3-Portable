import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-talk-to-session'
export const inject = ['tools']
export const Config = Schema.object({
  descriptorPath: Schema.string().default('').description('MiMo Desktop 发现文件；空 = %APPDATA%\\Xiaomi MiMo\\desktop-api.json'),
  model: Schema.string().default('mimo-v2.6-flash').description('目标端 model 字段（MiMo 端必填，缺失会被回 400）'),
  origin: Schema.string().default('dsh-bridge').description('目标端来源标识'),
  senderLabel: Schema.string().default('DSH 便携版3').description('消息前缀中的本会话名'),
  requestTimeoutMs: Schema.number().min(1000).max(120000).step(1).default(20000).description('单次 HTTP 超时毫秒'),
  replyTimeoutMs: Schema.number().min(1000).max(1800000).step(1).default(120000).description('sync 等待回信上限毫秒'),
  pollIntervalMs: Schema.number().min(250).max(60000).step(1).default(1500).description('回信轮询间隔毫秒'),
  maxMessageChars: Schema.number().min(64).max(200000).step(1).default(32000).description('加前缀后的正文上限字符'),
})

/** 目标端失败码 → 可操作提示。文案里绝不出现令牌。 */
const STATUS_HINT = Object.freeze({
  400: '请求体不合法（MiMo 端 /turns 要求 model 非空）',
  401: '令牌无效：MiMo Desktop 可能已重启并轮换令牌，需重读发现文件',
  403: '被拒绝：MiMo 桌面 API 只接受本机回环请求',
  404: '会话或路由不存在',
  409: '对方会话正忙（回合进行中），请稍后重试',
  413: '请求体过大',
  415: '需要 application/json',
  503: '对方引擎未就绪或未登录',
})

function bridgeError(code, message) {
  return Object.assign(new Error(message), { code })
}

function descriptorPathOf(config) {
  if (config.descriptorPath) return config.descriptorPath
  const appData = process.env.APPDATA
  if (!appData) throw bridgeError('NO_APPDATA', '缺少 APPDATA，无法定位 MiMo Desktop 发现文件')
  return join(appData, 'Xiaomi MiMo', 'desktop-api.json')
}

/** 每次调用都重读：端口与令牌随 MiMo Desktop 重启轮换，不允许跨启动缓存。 */
function discover(config) {
  const path = descriptorPathOf(config)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw bridgeError('MIMO_NOT_RUNNING', `未找到 MiMo Desktop 发现文件：${path}（MiMo Desktop 未运行？）`)
    throw bridgeError('DESCRIPTOR_UNREADABLE', `读取 MiMo Desktop 发现文件失败：${error.message}`)
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw bridgeError('DESCRIPTOR_INVALID', `MiMo Desktop 发现文件不是合法 JSON：${path}`)
  }
  const port = Number(data?.port)
  const token = typeof data?.token === 'string' ? data.token : ''
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bridgeError('DESCRIPTOR_INVALID', '发现文件缺少可用 port')
  if (!token) throw bridgeError('DESCRIPTOR_INVALID', '发现文件缺少 token')
  return { base: `http://127.0.0.1:${port}`, token, pid: data?.pid, api: data?.api }
}

async function call(config, endpoint, path, body) {
  const headers = { authorization: `Bearer ${endpoint.token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response
  try {
    response = await fetch(endpoint.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    })
  } catch (error) {
    throw bridgeError('MIMO_UNREACHABLE', `无法连接 MiMo Desktop（${endpoint.base}）：${error.message}`)
  }
  const text = await response.text().catch(() => '')
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }
  if (!response.ok) {
    const upstream = payload?.code ?? payload?.reason ?? `HTTP ${response.status}`
    throw bridgeError(`MIMO_HTTP_${response.status}`, `MiMo Desktop 拒绝请求（${upstream}）：${STATUS_HINT[response.status] ?? '未预期状态'}`)
  }
  return payload
}

function asArray(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.items)) return payload.items
  return []
}

async function listSessions(config, endpoint, limit) {
  const payload = await call(config, endpoint, `/v1/sessions?limit=${limit}`)
  return asArray(payload)
    .map(item => ({
      id: String(item?.id ?? ''),
      title: String(item?.title ?? ''),
      directory: String(item?.directory ?? ''),
      updatedAt: item?.time?.updated ?? null,
    }))
    .filter(item => item.id)
}

async function listMessages(config, endpoint, id) {
  return asArray(await call(config, endpoint, `/v1/sessions/${encodeURIComponent(id)}/messages`))
}

function messageText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  return parts
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
    .trim()
}

/** 只认 baseline 之后新出现的、正文非空的 assistant 消息——占位空壳不算回信（MiMo 端会先落一条空 assistant）。 */
function firstReply(messages, baseline) {
  for (let index = baseline; index < messages.length; index++) {
    const message = messages[index]
    if (message?.info?.role !== 'assistant') continue
    const text = messageText(message)
    if (text) return { text, model: String(message.info.modelID ?? '') }
  }
  return null
}

function toContact(session) {
  return { id: session.id, title: session.title, directory: session.directory, updatedAt: session.updatedAt }
}

function resolveContact(sessions, contact) {
  const needle = String(contact ?? '').trim()
  if (!needle) throw bridgeError('NO_CONTACT', 'contact 不能为空')
  const byId = sessions.find(session => session.id === needle)
  if (byId) return byId
  const exact = sessions.filter(session => session.title === needle)
  const pool = exact.length > 0 ? exact : sessions.filter(session => session.title.includes(needle))
  if (pool.length === 1) return pool[0]
  if (pool.length === 0) throw bridgeError('CONTACT_NOT_FOUND', `未找到匹配「${needle}」的 MiMo 会话；先用 talk_contacts 查地址簿`)
  const sample = pool.slice(0, 5).map(session => `${session.id}（${session.title}）`).join('、')
  throw bridgeError('CONTACT_AMBIGUOUS', `「${needle}」匹配到 ${pool.length} 个会话，请改用 ses_ 开头的 id：${sample}`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'talk_contacts',
    description: '列出本机 MiMo Desktop 的会话地址簿（id、标题、工作目录、更新时间），用于给 talk_to_session 选目标。只读，不会给对方会话发任何消息。',
    parameters: {
      query: { type: 'string', description: '按标题或工作目录过滤，可省略' },
      limit: { type: 'integer', description: '最多返回 1 至 100 条，默认 20' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20)))
      const endpoint = discover(config)
      const sessions = await listSessions(config, endpoint, Math.min(200, Math.max(limit, 100)))
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const contacts = sessions
        .filter(session => !query || `${session.title} ${session.directory}`.toLowerCase().includes(query))
        .slice(0, limit)
        .map(toContact)
      return { ok: true, count: contacts.length, contacts }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'talk_to_session',
    description: '把一个自包含任务投递给本机 MiMo Desktop 的某个会话，并按需等待对方回信（等价 talk_to_session；DSH 主动找外部 agent 的唯一通道）。正文会自动加【会话对话|来自会话「…」】前缀——对方看不到本会话历史，所以 message 必须自带背景与交付要求。mode=sync 等到 assistant 文本；mode=async 只确认已入队。',
    parameters: {
      contact: { type: 'string', required: true, description: '目标会话：ses_ 开头的 id，或唯一标题（重名请用 id；先用 talk_contacts 查）' },
      message: { type: 'string', required: true, description: '自包含正文：背景、任务、交付与回信格式' },
      mode: { type: 'string', enum: ['sync', 'async'], description: 'sync 等待回信（默认）；async 只回执已入队' },
      timeout_ms: { type: 'integer', description: 'sync 等待回信的最长毫秒数，默认取配置 replyTimeoutMs' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const text = String(args.message ?? '').replace(/\r\n/g, '\n').trim()
      if (!text) throw bridgeError('EMPTY_MESSAGE', 'message 不能为空')
      const wrapped = `【会话对话|来自会话「${config.senderLabel}」】\n${text}`
      if (wrapped.length > config.maxMessageChars) {
        throw bridgeError('MESSAGE_TOO_LONG', `消息加前缀后超过 ${config.maxMessageChars} 字符上限`)
      }
      const mode = args.mode === 'async' ? 'async' : 'sync'
      const endpoint = discover(config)
      const target = resolveContact(await listSessions(config, endpoint, 200), args.contact)
      // 先记基线，再注入：只把基线之后新出现的 assistant 文本当回信。
      const baseline = mode === 'sync' ? (await listMessages(config, endpoint, target.id)).length : 0
      exec.signal.throwIfAborted()
      await call(config, endpoint, `/v1/sessions/${encodeURIComponent(target.id)}/turns`, JSON.stringify({
        message: wrapped,
        model: config.model,
        origin: config.origin,
      }))
      if (mode === 'async') {
        return { ok: true, status: 'queued', contact: toContact(target), model: config.model, note: '已入队（202）；回信需稍后自行查对方会话历史' }
      }
      const timeoutMs = Number(args.timeout_ms ?? config.replyTimeoutMs)
      const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : config.replyTimeoutMs)
      while (Date.now() < deadline) {
        if (exec.signal.aborted) throw bridgeError('ABORTED', '调用已取消')
        await sleep(Math.min(config.pollIntervalMs, Math.max(250, deadline - Date.now())))
        const reply = firstReply(await listMessages(config, endpoint, target.id), baseline)
        if (reply) return { ok: true, status: 'replied', contact: toContact(target), model: reply.model || config.model, reply: reply.text }
      }
      return { ok: false, status: 'timeout', contact: toContact(target), hint: `等待 ${timeoutMs}ms 未收到非空 assistant 文本：对方会话可能仍在处理，或其引擎未产出内容` }
    },
  }))
}
