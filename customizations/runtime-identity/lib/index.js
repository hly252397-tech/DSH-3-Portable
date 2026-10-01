// dsh-runtime-identity —— P0 运行时身份、能力发现与模型切换交接（宿主半侧薄适配）
//
// 接入点（全部复用 DSH 已有机制，不建平行系统）：
//   1) systemPrompt.context()  — 每请求自动注入运行时身份（system-awareness 同款钩子）
//   2) system-prompt/assemble  — 从 installModelSelection 注入的 {{provider}}/{{model}} 取真实路由
//   3) ctx.tools.register      — get_runtime_context / describe_capability 两个查询入口
//
// 防回退铁律：
//   - 命名导出 name + inject + apply；apply 内不抛
//   - inject 只声明已验证存在的服务（systemPrompt / tools）
//   - 所有 hook try/catch，观测失败绝不冒泡
//   - 不写 client.js（零 UI、零客户端 bundle）
//   - 拿不到的字段写 unknown，不编造
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  buildRuntimeIdentity,
  buildCapabilityMatrix,
  renderRuntimeContext,
  describeCapability,
} from './identity.js'

export const name = 'dsh-runtime-identity'
export const inject = ['systemPrompt', 'tools']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  contextOrder: Schema.number().default(125).description('runtime context 顺序（sandbox=110 approval=115 之后）'),
  maxContextBytes: Schema.number().min(512).max(16384).default(4096),
  maxResultBytes: Schema.number().min(2048).max(262144).default(65536),
})

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const maxContextBytes = config.maxContextBytes ?? 4096
  const maxResultBytes = config.maxResultBytes ?? 65536
  // 缓存上一次 assemble 的身份快照，供工具查询（与 context 同源）
  let lastIdentity = null
  let lastMatrix = null
  let lastAssembledAt = null

  /** 从一次 assemble 中提取身份与能力（无 IO，全在内存）。 */
  function harvest(assembly, assembleCtx) {
    const vars = assembly?.variables ?? {}
    // installModelSelection 在 system-prompt/assemble 注入 provider/model
    const provider = typeof vars.provider === 'string' ? vars.provider : null
    const model = typeof vars.model === 'string' ? vars.model : null
    // provider_reported_model_id：网关回报链路未接线时保持 unknown（P0 要求）
    const providerReportedModel = typeof vars.provider_reported_model_id === 'string'
      ? vars.provider_reported_model_id
      : null

    const wireSchemas = Array.isArray(assembly?.tools) ? assembly.tools : []
    const wireNames = new Set(wireSchemas.map((t) => t.name))

    const identity = buildRuntimeIdentity({
      provider,
      model,
      providerReportedModel,
      agentId: assembleCtx?.agent?.id ?? null,
      profileName: typeof vars.profile === 'string' ? vars.profile : null,
      workspace: typeof vars.workspace === 'string' ? vars.workspace : (assembleCtx?.workspace ?? null),
      sessionId: assembleCtx?.agent?.id ?? (typeof vars.session_id === 'string' ? vars.session_id : null),
      runtimeRevision: typeof vars.runtime_revision === 'string' ? vars.runtime_revision : null,
      capabilitiesRevision: typeof vars.capabilities_revision === 'string' ? vars.capabilities_revision : null,
      reasoningEffort: typeof vars.reasoning_effort === 'string' ? vars.reasoning_effort : null,
    })

    // 原生看图 / 视觉桥接：从 wire 工具与已知桥接工具推断，不编造
    const hasVisionBridge = wireNames.has('vision_bridge') || wireNames.has('dsh_vision_bridge')
      || wireNames.has('analyze_image') || wireNames.has('read_image')
    const matrix = buildCapabilityMatrix(
      wireSchemas.map((t) => ({
        name: t.name,
        description: t.description,
        whenToUse: undefined,
        invocation: 'direct',
      })),
      {
        nativeImage: 'unknown', // 原生图像能力由适配器层判定，此处不冒充
        visionBridge: hasVisionBridge ? 'supported' : 'unknown',
        wireNames,
        health: 'ready', // 出现在本 assembly 的 wire 上即 ready
      },
    )
    return { identity, matrix }
  }

  // ---------- 1) systemPrompt.context：每请求自动注入 ----------
  // text 是函数：每次 assemble 调用；从上一次 harvest 的快照渲染。
  // 首次 assemble 前返回占位，不编造。
  ctx.systemPrompt.context({
    name: 'dsh:runtime-identity',
    order: config.contextOrder,
    text: () => {
      try {
        if (!lastIdentity) {
          return '## 运行时身份（宿主提供）\n（本轮首次组装中；身份以实际请求变量为准，unknown 不冒充）'
        }
        return renderRuntimeContext(lastIdentity, lastMatrix ?? [], maxContextBytes)
      } catch (e) {
        return `## 运行时身份\n（组装异常已跳过：${String(e?.message ?? e).slice(0, 80)}）`
      }
    },
  })

  // ---------- 2) system-prompt/assemble：收割真实路由与工具面 ----------
  // 与 installModelSelection 同一 waterfall：它先把 provider/model 写进 variables，
  // 本监听器在其后（或 next() 之后）读取，拿到的是「本次请求实际路由」。
  ctx.on('system-prompt/assemble', async (_assembly, assembleCtx, next) => {
    const assembly = await next()
    try {
      const harvested = harvest(assembly, assembleCtx)
      lastIdentity = harvested.identity
      lastMatrix = harvested.matrix
      lastAssembledAt = new Date().toISOString()
    } catch {
      /* 收割失败保留上次快照，绝不冒泡 */
    }
    return assembly
  })

  // ---------- 3) 查询入口 ----------
  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'get_runtime_context',
      description:
        '只读返回当前运行时身份、环境、会话与能力摘要。' +
        '切换模型、压缩恢复、不确定「我是谁/我在哪/能用什么」时先调用。' +
        '字段为 unknown 表示宿主尚未取得，不表示不存在。',
      parameters: {
        detail: {
          type: 'boolean',
          description: 'true 时附带完整能力矩阵（五维）。默认 false 只返回摘要。',
        },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args, exec) {
        exec.signal?.throwIfAborted?.()
        if (!lastIdentity) {
          // 工具被调用但尚未有 assemble 快照：现场组装一次（只读 tools schemas）
          try {
            const schemas = ctx.tools.schemas(exec.agent)
            const { identity, matrix } = harvest({ tools: schemas, variables: {} }, { agent: exec.agent })
            lastIdentity = identity
            lastMatrix = matrix
            lastAssembledAt = new Date().toISOString()
          } catch {
            /* 保持 null，下面如实报 */
          }
        }
        if (!lastIdentity) {
          return { ok: false, error: 'runtime_identity_not_ready', hint: '宿主尚未完成一次模型调用组装' }
        }
        const base = {
          ok: true,
          assembled_at: lastAssembledAt,
          identity: lastIdentity,
          capability_summary: {
            total: (lastMatrix ?? []).length,
            tool_exposed: (lastMatrix ?? []).filter((m) => m.route === 'tool' && m.exposure === 'exposed').length,
            native_image: (lastMatrix ?? []).find((m) => m.id === 'image_input_native')?.support ?? 'unknown',
            vision_bridge: (lastMatrix ?? []).find((m) => m.id === 'image_input_vision_bridge')?.support ?? 'unknown',
          },
        }
        if (args?.detail) base.capabilities = lastMatrix
        const encoded = JSON.stringify(base)
        if (Buffer.byteLength(encoded, 'utf8') > maxResultBytes) {
          return { ok: true, truncated: true, assembled_at: lastAssembledAt, identity: lastIdentity, capability_summary: base.capability_summary }
        }
        return base
      },
    })),
  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'describe_capability',
      description:
        '只读返回单项能力的真实用途、五维状态（support/exposure/permission/health/route）与调用入口。' +
        'id 来自 get_runtime_context(detail) 或本轮 wireTools。',
      parameters: {
        capability_id: { type: 'string', description: '能力 id，例如某个工具名或 image_input_native' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args, exec) {
        exec.signal?.throwIfAborted?.()
        const id = String(args?.capability_id ?? '').trim()
        if (!id) return { ok: false, error: 'capability_id_required' }
        if (!lastMatrix) {
          return {
            ok: false,
            error: 'capability_matrix_not_ready',
            hint: '宿主尚未完成一次模型调用组装；先调 get_runtime_context',
          }
        }
        return describeCapability(lastMatrix, id)
      },
    })),
  )
}
