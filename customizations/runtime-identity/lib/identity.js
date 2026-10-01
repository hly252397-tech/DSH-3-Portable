// identity.js — 纯策略层：组装运行时身份与能力维度（无 IO、无 ctx）。
// 与 index.js 分离：策略可单测；宿主半侧只做薄适配。
//
// 铁律（对照 P0 规格）：
//   - 身份由配置确定，运行事实由宿主提供，能力由真实连接验证。
//   - unknown ≠ unsupported；未连接 ≠ 模型不支持；已安装 ≠ 可调用。
//   - 不编造：拿不到的字段写 unknown，不猜。

/** 把 installModelSelection 注入的变量 + 环境事实组装成运行时身份摘要。 */
export function buildRuntimeIdentity({
  provider = null,
  model = null,
  providerReportedModel = null,
  agentId = null,
  agentName = null,
  agentRole = null,
  profileName = null,
  environment = 'DeepSeek Harness (DSH)',
  executionClient = null,
  toolEnvironment = null,
  workspace = null,
  sessionId = null,
  taskId = null,
  runtimeRevision = null,
  capabilitiesRevision = null,
  reasoningEffort = null,
  now = () => new Date().toISOString(),
} = {}) {
  const unknown = (v) => (v === null || v === undefined || v === '' ? 'unknown' : v)
  return {
    agent: {
      agent_id: unknown(agentId),
      name: unknown(agentName),
      role: unknown(agentRole),
    },
    model: {
      provider_id: unknown(provider),
      requested_model_id: unknown(model),
      provider_reported_model_id: unknown(providerReportedModel),
      reasoning_effort: unknown(reasoningEffort),
      source: provider && model ? 'installModelSelection.assembled' : 'unavailable',
      updated_at: now(),
    },
    environment: {
      platform: 'DSH',
      profile: unknown(profileName),
      execution_client: unknown(executionClient),
      tool_environment: unknown(toolEnvironment),
      workspace: unknown(workspace),
    },
    session: {
      session_id: unknown(sessionId),
      task_id: unknown(taskId),
      runtime_revision: unknown(runtimeRevision),
      capabilities_revision: unknown(capabilitiesRevision),
    },
    notes: [
      '身份由配置确定，运行事实由宿主提供，能力由真实连接验证。',
      'provider_reported_model_id 在网关不回报时保持 unknown，不冒充已确认。',
    ],
  }
}

/** 把工具 schema 列表 + 连接/授权状态映射为五维能力清单。 */
export function buildCapabilityMatrix(tools = [], {
  nativeImage = 'unknown',
  visionBridge = 'unknown',
  wireNames = null,
  permission = 'allowed',
  health = 'unverified',
} = {}) {
  const wire = wireNames instanceof Set ? wireNames : new Set(wireNames ?? tools.map((t) => t.name))
  const entries = tools.map((t) => ({
    id: t.name,
    purpose: t.description || t.whenToUse?.[0] || 'unknown',
    support: 'supported', // 在 wire 上出现即为当前接口支持暴露
    exposure: wire.has(t.name) ? 'exposed' : 'not-exposed',
    permission,
    health,
    route: wire.has(t.name) ? 'tool' : 'unavailable',
    invocation: t.invocation || (wire.has(t.name) ? 'direct' : 'not-on-current-wire'),
    whenToUse: Array.isArray(t.whenToUse) ? t.whenToUse.slice(0, 3) : [],
  }))
  // 多模态独立于工具
  entries.push({
    id: 'image_input_native',
    purpose: '原生图片输入（模型直接看图）',
    support: nativeImage,
    exposure: nativeImage === 'supported' ? 'exposed' : 'not-exposed',
    permission: 'allowed',
    health: nativeImage === 'supported' ? 'ready' : 'unverified',
    route: nativeImage === 'supported' ? 'native' : 'unavailable',
    invocation: 'attachment-native',
    whenToUse: ['原生图像输入已确认且当前接口能正确传递'],
  })
  entries.push({
    id: 'image_input_vision_bridge',
    purpose: '视觉桥接分析图片，主模型收文字结果',
    support: visionBridge,
    exposure: visionBridge === 'supported' ? 'exposed' : 'not-exposed',
    permission: 'allowed',
    health: visionBridge === 'supported' ? 'ready' : 'unverified',
    route: visionBridge === 'supported' ? 'tool' : 'unavailable',
    invocation: 'vision-bridge',
    whenToUse: ['原生路径不可用但已授权视觉桥接可用'],
  })
  return entries
}

/** 渲染 systemPrompt.context 文本：精简、可缓存、每次请求有当前有效版本。 */
export function renderRuntimeContext(identity, matrix, maxBytes = 4096) {
  const lines = [
    '## 运行时身份（宿主提供，每请求更新）',
    `模型：${identity.model.provider_id}/${identity.model.requested_model_id}` +
      (identity.model.reasoning_effort !== 'unknown' ? ` · 推理档 ${identity.model.reasoning_effort}` : '') +
      (identity.model.provider_reported_model_id !== 'unknown' ? ` · 实际回报 ${identity.model.provider_reported_model_id}` : ' · 实际回报 unknown'),
    `环境：${identity.environment.platform} · Profile ${identity.environment.profile} · 工作区 ${identity.environment.workspace}`,
    `会话：${identity.session.session_id} · 运行时 ${identity.session.runtime_revision} · 能力 ${identity.session.capabilities_revision}`,
    `调用面：${matrix.filter((m) => m.route === 'tool' && m.exposure === 'exposed').length} 个工具已暴露` +
      ` · 原生看图 ${identity.model ? matrix.find((m) => m.id === 'image_input_native')?.support ?? 'unknown' : 'unknown'}` +
      ` · 视觉桥接 ${matrix.find((m) => m.id === 'image_input_vision_bridge')?.support ?? 'unknown'}`,
    '',
    '查询入口：get_runtime_context() 全量身份与能力；describe_capability(id) 单项详情。',
    'unknown ≠ unsupported；未连接 ≠ 模型不支持；已安装 ≠ 可调用。能力以本轮 wireTools 为准。',
  ]
  let text = lines.join('\n')
  // 模板变量安全：去掉未闭合的 {{ 防止插值器报错
  text = text.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }')
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = [
      '## 运行时身份（宿主提供）',
      `模型：${identity.model.provider_id}/${identity.model.requested_model_id}`,
      `会话：${identity.session.session_id}`,
      '（摘要超预算，详情用 get_runtime_context）',
    ].join('\n')
  }
  return text
}

/** describe_capability 的返回结构。 */
export function describeCapability(matrix, capabilityId) {
  const hit = matrix.find((m) => m.id === capabilityId)
  if (!hit) {
    return {
      ok: false,
      error: 'capability_not_found',
      capability_id: capabilityId,
      hint: '用 get_runtime_context 或 dsh_capabilities 列出有效 id',
    }
  }
  return {
    ok: true,
    capability: hit,
    constraints: [
      'permission 与 health 由执行层再次校验，说明文字不能绕过。',
      'health=unverified 时不要假定可用；先做无副作用探针。',
    ],
  }
}
