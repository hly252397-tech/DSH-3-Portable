// learnpolicy —— 纯策略层（无 IO、无 ctx）：从 turn 事件提取经验候选 / 计算召回。
// 与 index.js 分离的目的：策略可独立单测，宿主半侧只做薄适配（与 dsh-agentos-trigger 同款纪律）。
//
// 铁律：
//   - 不修改 AgentOS 晋升门（learning.mjs）；只产**观察/候选**，晋升永远走 AgentOS 判定。
//   - 提取结果必须可从事件重放；不发明工具名、不编造成功/失败。

/** 从 tool/result 消息里尽力取出 isError（形状不保证，取不到就当未知）。 */
export function toolResultIsError(message) {
  if (!message || typeof message !== 'object') return null
  if (typeof message.isError === 'boolean') return message.isError
  if (message.source && typeof message.source.isError === 'boolean') return message.source.isError
  return null
}

/** 聚合一轮 turn 的工具轨迹（只保留稳定字段）。 */
export function summarizeTurnTools(toolCalls = [], toolResults = []) {
  const byCallId = new Map()
  for (const c of toolCalls) {
    if (!c || !c.callId) continue
    byCallId.set(c.callId, { callId: c.callId, name: c.name || c.toolName || 'unknown', status: 'running', isError: null })
  }
  for (const r of toolResults) {
    const msg = r?.message || r || {}
    const callId = msg.toolCallId ?? msg.source?.callId ?? r?.callId ?? null
    const err = toolResultIsError(msg)
    if (callId && byCallId.has(callId)) {
      const item = byCallId.get(callId)
      item.status = err === true ? 'failed' : err === false ? 'completed' : 'unknown'
      item.isError = err
    } else if (callId) {
      byCallId.set(callId, { callId, name: msg.name || 'unknown', status: err === true ? 'failed' : 'completed', isError: err })
    }
  }
  return [...byCallId.values()]
}

/**
 * 从 turn 摘要提取**一条**经验候选（OBSERVATION 或 EXPERIENCE_CANDIDATE）。
 * 返回 null 表示本轮不值得记（避免把普通闲聊灌进记忆）。
 *
 * 记录形状对齐 AgentOS MemoryStore.remember + learning.evaluateStage：
 *   kind/id/content/evidence/source/tags + hypothesis（有才进 EXPERIENCE_CANDIDATE）
 */
export function extractExperienceCandidate({
  sessionId = null,
  turn = null,
  turnReason = null, // completed | aborted | interrupted | ...
  tools = [],
  responseChars = 0,
  model = null,
  now = () => new Date().toISOString(),
} = {}) {
  const failed = tools.filter((t) => t.status === 'failed' || t.isError === true)
  const completed = tools.filter((t) => t.status === 'completed')
  const unknown = tools.filter((t) => t.status === 'unknown' || t.status === 'running')
  const interesting = failed.length > 0 || tools.length >= 3 || (turnReason && turnReason !== 'completed' && tools.length > 0)

  // 阈值：失败必记；成功但工具步数多才记；空转/纯问答不记
  if (!interesting) return null

  const id = `learn-${now().replace(/[-:.TZ]/g, '').slice(0, 14)}-${String(turn ?? 'x')}`
  const tags = ['dsh', 'auto-capture']
  let kind = 'episodic'
  let content
  let hypothesis = null

  if (failed.length > 0) {
    kind = 'episodic'
    tags.push('failure', 'needs-followup')
    const names = failed.map((t) => t.name).join(', ')
    content = `任务轮次出现工具失败：${names}（失败 ${failed.length} / 总 ${tools.length}）。结束原因：${turnReason || 'unknown'}。`
    hypothesis = `工具 ${names} 失败的可复现条件与正确处理方式；同类失败再次出现时应先查证据而不是盲改。`
  } else if (turnReason && turnReason !== 'completed') {
    kind = 'episodic'
    tags.push('interrupted')
    content = `任务轮次非正常结束（${turnReason}），工具调用 ${tools.length} 次，完成 ${completed.length}。`
    hypothesis = `非正常结束（${turnReason}）的现场保留与恢复步骤。`
  } else {
    kind = 'procedural'
    tags.push('procedure')
    const names = [...new Set(tools.map((t) => t.name))].slice(0, 8).join(', ')
    content = `多步工具流程成功完成（${tools.length} 步：${names}）。回复 ${responseChars} 字符。`
    hypothesis = `该多步流程（${names}）的适用条件与必做回归；仅验证单一路径不算完成。`
  }

  return {
    kind,
    id,
    content,
    hypothesis,
    evidence: {
      source_kind: 'turn/auto-capture',
      session_id: sessionId,
      turn,
      turn_reason: turnReason,
      tools: tools.map((t) => ({ name: t.name, status: t.status, is_error: t.isError })),
      failed_count: failed.length,
      completed_count: completed.length,
      unknown_count: unknown.length,
      response_chars: responseChars,
      model,
    },
    source: { plugin: 'dsh-agentos-learn', captured_at: now() },
    confidence: failed.length > 0 ? 'observed' : 'provisional',
    tags,
  }
}

/**
 * 从记忆列表里挑「适用经验」注入系统提示词。
 * 仅挑 active 且 procedural/semantic/episodic-failure；按 tag 命中与新鲜度粗排。
 */
export function selectRelevantExperiences(records = [], { limit = 5, tags = [] } = {}) {
  const wanted = new Set((tags || []).map((t) => String(t).toLowerCase()))
  const scored = []
  for (const r of records) {
    if (!r || r.status !== 'active') continue
    if (!['procedural', 'semantic', 'episodic'].includes(r.kind)) continue
    const recTags = (r.tags || []).map((t) => String(t).toLowerCase())
    const tagHits = recTags.filter((t) => wanted.has(t)).length
    const isFailure = recTags.includes('failure') || recTags.includes('needs-followup')
    // 失败经验永远有教学价值；procedure 次之；其余看 tag
    const base = isFailure ? 3 : r.kind === 'procedural' ? 2 : 1
    const score = base + tagHits * 2
    if (score <= 1 && wanted.size > 0 && tagHits === 0 && !isFailure) continue
    scored.push({ record: r, score, tagHits, isFailure })
  }
  scored.sort((a, b) => b.score - a.score || String(b.record.recorded_at || '').localeCompare(String(a.record.recorded_at || '')))
  return scored.slice(0, limit).map((s) => s.record)
}

/** 把选中的经验渲染成 systemPrompt 节文本（短、可跳过、不编造）。 */
export function renderExperienceSection(records = []) {
  if (!records.length) {
    return '## 适用经验（AgentOS）\n暂无经过记录的适用经验。首次踩坑后经验会自动入库。'
  }
  const lines = records.map((r, i) => {
    const hyp = r.hypothesis ? `\n  - 假设/检查项：${String(r.hypothesis).slice(0, 220)}` : ''
    const conf = r.confidence ? ` [${r.confidence}]` : ''
    return `${i + 1}. (${r.kind}${conf}) ${String(r.content || '').slice(0, 200)}${hyp}`
  })
  return `## 适用经验（AgentOS 自进化）\n以下经验来自真实任务记录，只作调查顺序与回归提醒，不替代验证：\n${lines.join('\n')}\n` +
    `未命中条件时不要硬套；已验证的解决办法才可当依据，观察≠结论。`
}

/** 给 learning-evaluate 准备最小记录（默认停在 OBSERVATION / EXPERIENCE_CANDIDATE）。 */
export function toLearningRecord(candidate) {
  if (!candidate) return null
  return {
    id: candidate.id,
    kind: candidate.kind,
    content: candidate.content,
    hypothesis: candidate.hypothesis || null,
    evidence: candidate.evidence || null,
    source: candidate.source || null,
    tags: candidate.tags || [],
    // 自动捕获阶段**不伪造**验证/回归/回滚字段 —— 全缺，evaluate 就停在早期阶段
    validations: [],
    regression_test: null,
    verifier: null,
    benchmark: null,
    shadow: null,
    rollback: null,
  }
}
