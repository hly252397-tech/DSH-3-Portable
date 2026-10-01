// dsh-agentos-learn —— 宿主半侧（薄适配层）
//
// 职责只有四件：
//   1) turn/end → 从事件提取经验候选 → AgentOS memory-remember + learning-evaluate
//   2) systemPrompt.section → 每轮注入「适用经验」（内容只来自记忆库，可审计）
//   3) 斜杠命令：/agentos-learn（状态）/agentos-learn-remember（手记）/agentos-learn-recall（召回）
//   4) GET /agentos-learn/status 便于人查
//
// 防回退铁律（本插件加载绝不能拖垮 DSH）：
//   - 命名导出形态：name + inject + apply；apply 内不抛异常
//   - inject 只声明已验证存在的服务（systemPrompt / commands）；缺失即 PENDING，不静默降级
//   - AgentOS 模块加载失败只降级为「学习未就绪」，不影响插件装载
//   - 所有 hook/事件体一律 try/catch（46 插件连坐 import failed 的成因就是 factory 抛错）
//   - 不写 client.js（避免客户端 bundle 形状事故；本功能纯宿主侧）
//   - 配置走 Schemastery；enabled:false 可一键摘除功能而不删文件
import Schema from 'schemastery'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-agentos-learn'

/** 只注入已验证存在的服务。webServer 本 MVP 不用，故不写——多写不存在的服务会导致 PENDING。 */
export const inject = ['systemPrompt', 'commands']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关；false 时不记不注入，命令只报禁用'),
  systemPromptOrder: Schema.number().default(45).description('systemPrompt 节顺序（discipline=40，可在其后）'),
  maxInjectedExperiences: Schema.number().min(0).max(20).default(5).description('每轮注入的经验条数上限'),
  captureOnEveryTurn: Schema.boolean().default(false).description('true=每轮都尝试提取；false=仅失败/多步/非正常结束'),
  recallTags: Schema.array(Schema.string()).default(['failure', 'procedure', 'needs-followup']).description('召回加权 tag'),
})

const ENDPOINT_STATUS = '/agentos-learn/status'

function resolvePortableRoot() {
  const home = process.env.DSH_HOME // <root>\Data\DSH
  if (home && typeof home === 'string') return dirname(dirname(home))
  return null
}

function isLoopbackHost(host) {
  if (!host || typeof host !== 'string') return false
  const hostname = host.split(':')[0]
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** 异步加载 AgentOS 核心；失败只标记未就绪。 */
async function loadAgentOs(portableRoot) {
  if (!portableRoot) throw new Error('portable root unresolved (DSH_HOME missing)')
  const agentosRoot = join(portableRoot, 'AgentOS')
  const [memoryMod, learningMod, policyMod] = await Promise.all([
    import(pathToFileURL(join(agentosRoot, 'lib', 'memory.mjs')).href),
    import(pathToFileURL(join(agentosRoot, 'lib', 'learning.mjs')).href),
    import(pathToFileURL(new URL('./learnpolicy.js', import.meta.url).pathname).href),
  ])
  return {
    agentosRoot,
    MemoryStore: memoryMod.MemoryStore,
    MEMORY_KINDS: memoryMod.MEMORY_KINDS,
    evaluateLearningPromotion: learningMod.evaluateLearningPromotion,
    evaluateStage: learningMod.evaluateStage,
    LEARNING_STAGES: learningMod.LEARNING_STAGES,
    policy: policyMod,
  }
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const maxInject = typeof config.maxInjectedExperiences === 'number' ? config.maxInjectedExperiences : 5
  const systemPromptOrder = typeof config.systemPromptOrder === 'number' ? config.systemPromptOrder : 45
  const recallTags = Array.isArray(config.recallTags) ? config.recallTags : ['failure', 'procedure']
  const captureOnEveryTurn = config.captureOnEveryTurn === true

  const root = resolvePortableRoot()
  const state = {
    enabled,
    loaded: false,
    load_error: null,
    remembered: 0,
    last_capture_at: null,
    last_stage: null,
    injected_runs: 0,
  }

  let agentOs = null
  let store = null
  // 每个 session 的 turn 级缓冲：工具轨迹只在轮次内累积
  const turnBuf = new Map()

  const ready = (async () => {
    try {
      agentOs = await loadAgentOs(root)
      store = new agentOs.MemoryStore({ root: agentOs.agentosRoot })
      state.loaded = true
    } catch (e) {
      state.load_error = String(e?.message ?? e)
    }
  })()

  // ---------- 1) systemPrompt：每轮注入适用经验 ----------
  // text 是函数，每次 assemble 调用；内容只来自记忆库，失败返回静态占位。
  ctx.systemPrompt.section({
    name: 'agentos-learn:experiences',
    order: systemPromptOrder,
    text: () => {
      if (!enabled) return ''
      try {
        state.injected_runs++
        if (!agentOs || !store) {
          return '## 适用经验（AgentOS）\n经验库未就绪，本轮跳过注入。'
        }
        const all = []
        for (const kind of ['procedural', 'semantic', 'episodic']) {
          try {
            all.push(...store.current(kind))
          } catch {
            /* 单类读失败不影响其它类 */
          }
        }
        const picked = agentOs.policy.selectRelevantExperiences(all, { limit: maxInject, tags: recallTags })
        return agentOs.policy.renderExperienceSection(picked)
      } catch (e) {
        // 绝不让 systemPrompt 组装失败拖垮请求
        return `## 适用经验（AgentOS）\n经验注入异常，已跳过：${String(e?.message ?? e).slice(0, 120)}`
      }
    },
  })

  // ---------- 2) session 事件：turn 内攒轨迹， turn/end 落库 ----------
  // 形状来自运行时，不保证稳定：一律 try/catch，观测失败绝不冒泡。
  const onSessionEvent = (session, event) => {
    try {
      if (!enabled || !event) return
      const sessionId = session?.id ?? session?.sessionId ?? null
      const data = event.data || {}
      const turnKey = `${sessionId || 'unknown'}:${data.turn ?? ''}`

      if (event.type === 'turn/start') {
        turnBuf.set(turnKey, { sessionId, turn: data.turn ?? null, tools: [], responseChars: 0, model: null })
        return
      }

      if (event.type === 'tool/call') {
        const buf = turnBuf.get(turnKey) || { sessionId, turn: data.turn ?? null, tools: [], responseChars: 0, model: null }
        buf.tools.push({
          callId: data.callId ?? data.message?.toolCallId ?? `c${buf.tools.length}`,
          name: data.name ?? data.message?.name ?? 'unknown',
          status: 'running',
          isError: null,
        })
        turnBuf.set(turnKey, buf)
        return
      }

      if (event.type === 'tool/result') {
        const buf = turnBuf.get(turnKey) || { sessionId, turn: data.turn ?? null, tools: [], responseChars: 0, model: null }
        const msg = data.message || data || {}
        const callId = msg.toolCallId ?? msg.source?.callId ?? data.callId ?? null
        const err = agentOs?.policy?.toolResultIsError
          ? agentOs.policy.toolResultIsError(msg)
          : typeof msg.isError === 'boolean'
            ? msg.isError
            : null
        const hit = callId ? buf.tools.find((t) => t.callId === callId) : null
        if (hit) {
          hit.status = err === true ? 'failed' : err === false ? 'completed' : 'unknown'
          hit.isError = err
        }
        turnBuf.set(turnKey, buf)
        return
      }

      if (event.type === 'assistant/message') {
        const buf = turnBuf.get(turnKey)
        if (buf) {
          const blocks = data.message?.content
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b && b.type === 'text' && typeof b.text === 'string') buf.responseChars += b.text.length
            }
          }
          if (data.message?.source) {
            buf.model = { provider: data.message.source.provider ?? null, model: data.message.source.model ?? null }
          }
        }
        return
      }

      if (event.type === 'turn/end') {
        const buf = turnBuf.get(turnKey) || { sessionId, turn: data.turn ?? null, tools: [], responseChars: 0, model: null }
        turnBuf.delete(turnKey)
        const reason = data.reason?.kind ?? data.reason ?? null
        if (!captureOnEveryTurn && buf.tools.length === 0 && reason === 'completed') return
        void captureExperience(buf, reason).catch(() => {
          /* 捕获失败不冒泡 */
        })
      }
    } catch {
      /* 观测失败绝不冒泡 */
    }
  }

  // 兼容两种可能签名：(session, event) 与 (event)。用 arity 粗分，包在 try/catch。
  ctx.on('session/event', (...args) => {
    try {
      if (args.length >= 2 && args[1] && typeof args[1] === 'object') onSessionEvent(args[0], args[1])
      else if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        // 单参形状：event 可能直接挂 type/data
        const ev = args[0]
        if (ev && ev.type) onSessionEvent({ id: ev.sessionId ?? ev.session?.id ?? null }, ev)
      }
    } catch {
      /* ignore */
    }
  })

  async function captureExperience(buf, reason) {
    await ready
    if (!enabled || !agentOs || !store || !agentOs.policy) return
    const candidate = agentOs.policy.extractExperienceCandidate({
      sessionId: buf.sessionId,
      turn: buf.turn,
      turnReason: reason,
      tools: buf.tools,
      responseChars: buf.responseChars,
      model: buf.model,
    })
    if (!candidate) return
    try {
      store.remember({
        kind: candidate.kind,
        id: candidate.id,
        content: candidate.content,
        evidence: candidate.evidence,
        source: candidate.source,
        confidence: candidate.confidence,
        tags: candidate.tags,
      })
      state.remembered++
      state.last_capture_at = new Date().toISOString()
    } catch {
      return
    }
    try {
      const rec = agentOs.policy.toLearningRecord(candidate)
      const verdict = agentOs.evaluateLearningPromotion(rec)
      state.last_stage = verdict?.stage ?? null
    } catch {
      state.last_stage = state.last_stage // 保持旧值
    }
  }

  // ---------- 3) 命令族 ----------
  const ok = (text) => ({ kind: 'success', text })
  const err = (text) => ({ kind: 'error', text })

  ctx.effect(() =>
    ctx.commands.register({
      name: 'agentos-learn',
      description: '查看 AgentOS 自进化状态（经验计数 / 最近阶段 / 就绪）',
      input: { hint: '无需参数' },
      handler: async () => {
        await ready
        if (!enabled) return ok('dsh-agentos-learn 已禁用。')
        if (!state.loaded) return err(`AgentOS 未就绪：${state.load_error || 'unknown'}`)
        return ok(
          [
            'AgentOS 自进化状态',
            `- 就绪：${state.loaded}`,
            `- 本轮已记经验：${state.remembered}`,
            `- 最近阶段：${state.last_stage || '(尚无)'}`,
            `- 最近捕获：${state.last_capture_at || '(尚无)'}`,
            `- 经验注入次数：${state.injected_runs}`,
            `- 记忆根：${agentOs?.agentosRoot || '(未加载)'}`,
          ].join('\n'),
        )
      },
    }),
  )

  ctx.effect(() =>
    ctx.commands.register({
      name: 'agentos-learn-remember',
      description: '手工记一条经验（进入 OBSERVATION；带 hypothesis 才进 EXPERIENCE_CANDIDATE）',
      input: { hint: '用法：/agentos-learn-remember 内容 | hypothesis: 可选假设' },
      handler: async (invocation) => {
        await ready
        if (!enabled) return ok('dsh-agentos-learn 已禁用。')
        if (!state.loaded || !store) return err(`AgentOS 未就绪：${state.load_error || 'unknown'}`)
        const raw = String(invocation?.rawInput ?? invocation?.input ?? '').trim()
        if (!raw) return err('用法：/agentos-learn-remember 内容 | hypothesis: 可选假设')
        let content = raw
        let hypothesis = null
        const m = raw.match(/^(.*?)\s*\|\s*hypothesis:\s*(.+)$/s)
        if (m) {
          content = m[1].trim()
          hypothesis = m[2].trim()
        }
        try {
          const id = `learn-manual-${Date.now()}`
          store.remember({
            kind: hypothesis ? 'procedural' : 'episodic',
            id,
            content,
            evidence: { source_kind: 'manual/command', command: 'agentos-learn-remember' },
            source: { plugin: 'dsh-agentos-learn' },
            confidence: 'provisional',
            tags: ['manual', 'dsh'],
          })
          state.remembered++
          const rec = { id, content, hypothesis, validations: [], regression_test: null, verifier: null, benchmark: null, shadow: null, rollback: null }
          const verdict = agentOs.evaluateLearningPromotion(rec)
          state.last_stage = verdict?.stage ?? null
          return ok(`已记入经验 ${id}\n阶段：${verdict?.stage ?? '?'}\n下一级：${verdict?.next_stage ?? '(顶)'}\n缺口：${(verdict?.blockers || []).map((b) => b.requirement).join(', ') || '无'}`)
        } catch (e) {
          return err(`记忆写入失败：${String(e?.message ?? e).slice(0, 160)}`)
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.commands.register({
      name: 'agentos-learn-recall',
      description: '召回适用经验（与 systemPrompt 注入同一策略）',
      input: { hint: '可选：tag 以逗号分隔，例如 failure,procedure' },
      handler: async (invocation) => {
        await ready
        if (!enabled) return ok('dsh-agentos-learn 已禁用。')
        if (!state.loaded || !store) return err(`AgentOS 未就绪：${state.load_error || 'unknown'}`)
        let tags = recallTags
        const raw = String(invocation?.rawInput ?? invocation?.input ?? '').trim()
        if (raw) tags = raw.split(',').map((s) => s.trim()).filter(Boolean)
        try {
          const all = []
          for (const kind of ['procedural', 'semantic', 'episodic']) {
            try {
              all.push(...store.current(kind))
            } catch {
              /* ignore */
            }
          }
          const picked = agentOs.policy.selectRelevantExperiences(all, { limit: maxInject, tags })
          return ok(agentOs.policy.renderExperienceSection(picked))
        } catch (e) {
          return err(`召回失败：${String(e?.message ?? e).slice(0, 160)}`)
        }
      },
    }),
  )

  // ---------- 4) 只读状态端点（本机回环） ----------
  const disposers = []
  try {
    const web = ctx.get?.('webServer')
    if (web && typeof web.register === 'function') {
      disposers.push(
        web.register({
          kind: 'exact',
          path: ENDPOINT_STATUS,
          handler: async (req, res) => {
            try {
              if (!isLoopbackHost(req.headers?.host)) {
                res.statusCode = 403
                res.end('{"ok":false}')
                return
              }
              await ready
              res.statusCode = 200
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.setHeader('cache-control', 'no-store')
              res.end(JSON.stringify({ ok: true, ...state, agentos_root: agentOs?.agentosRoot ?? null }))
            } catch (e) {
              res.statusCode = 500
              res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
            }
          },
        }),
      )
    }
  } catch {
    /* webServer 不可用不致命 */
  }

  ctx.effect(() => () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* 卸载期不冒泡 */
      }
    }
    turnBuf.clear()
  }, 'dsh-agentos-learn: commands + capture + section')
}
