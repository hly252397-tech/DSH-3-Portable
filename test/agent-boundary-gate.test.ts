import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 实机产物依赖守卫（AGENTS.md：CI 是全新检出，禁止无守卫地读取 Data/ 产物）。
// 核心用例是源码级策略断言，只有需要真正 import 实机插件时才跳过。
const pluginEntry = join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-agent-boundary/lib/index.js')
const haveLivePlugin = existsSync(pluginEntry)

interface GateConfig {
  enabled: boolean
  gatedTools: string[]
  minOptions: number
  maxQuestions: number
  requireRecommendedOption: boolean
  recommendedMarkers: string[]
  exemptPatterns: string[]
}

interface GateModule {
  name: string
  inject: string[]
  DEFAULTS: GateConfig
  Config: unknown
  evaluateAsk(args: unknown, cfg: GateConfig): string[]
  denyReason(problems: string[], cfg: GateConfig): string
  apply(ctx: { on: (event: string, listener: unknown) => void }, config?: Partial<GateConfig>): void
}

type Listener = (
  exec: { name?: string; arguments?: unknown },
  next: () => Promise<{ kind: string; reason?: string }>,
) => Promise<{ kind: string; reason?: string }>

async function loadGate(t: { skip: (reason: string) => void }): Promise<GateModule | undefined> {
  if (!haveLivePlugin) {
    t.skip('实机本地插件 dsh-agent-boundary 缺失（CI 全新检出）')
    return undefined
  }
  return (await import(pathToFileURL(pluginEntry).href)) as GateModule
}

const compliantArgs = {
  questions: [
    { id: 'pick', question: '用哪种口径？', options: [{ label: '口径A (Recommended)' }, { label: '口径B' }] },
  ],
}

test('插件导出形态符合命名导出三件套（name/inject/apply）', async (t) => {
  const gate = await loadGate(t)
  if (gate === undefined) return
  assert.equal(gate.name, 'dsh-agent-boundary')
  assert.deepEqual(gate.inject, ['tools'])
  assert.equal(typeof gate.apply, 'function')
  assert.equal(typeof gate.Config, 'function', 'Config 必须是 Schemastery schema（可调参数不许硬编码）')
})

test('策略：无选项的开放式提问被拒绝', async (t) => {
  const gate = await loadGate(t)
  if (gate === undefined) return
  const problems = gate.evaluateAsk({ questions: [{ id: 'a', question: '你看怎么办？' }] }, gate.DEFAULTS)
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? '', /没有提供 options/)
})

test('策略：选项不足与缺推荐标注都被拒绝', async (t) => {
  const gate = await loadGate(t)
  if (gate === undefined) return
  const oneOption = gate.evaluateAsk(
    { questions: [{ id: 'a', question: '选哪个', options: [{ label: 'A (Recommended)' }] }] },
    gate.DEFAULTS,
  )
  assert.match(oneOption.join(' '), /少于要求的 2 个/)
  const noMarker = gate.evaluateAsk(
    { questions: [{ id: 'a', question: '选哪个', options: [{ label: 'A' }, { label: 'B' }] }] },
    gate.DEFAULTS,
  )
  assert.match(noMarker.join(' '), /没有任何选项标注推荐/)
})

test('策略：合规提问放行，凭据类提问豁免', async (t) => {
  const gate = await loadGate(t)
  if (gate === undefined) return
  assert.deepEqual(gate.evaluateAsk(compliantArgs, gate.DEFAULTS), [])
  const credential = gate.evaluateAsk({ questions: [{ id: 'a', question: '请在浏览器窗口输入密码后继续' }] }, gate.DEFAULTS)
  assert.deepEqual(credential, [], '凭据/身份类提问按全局规则允许找用户')
})

test('策略：一次问全（问题数上限）与空问题集都被拒绝', async (t) => {
  const gate = await loadGate(t)
  if (gate === undefined) return
  const many = {
    questions: Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      question: `问题${i}`,
      options: [{ label: 'A (Recommended)' }, { label: 'B' }],
    })),
  }
  assert.match(gate.evaluateAsk(many, gate.DEFAULTS).join(' '), /超过上限 4/)
  assert.match(gate.evaluateAsk({ questions: [] }, gate.DEFAULTS).join(' '), /questions 缺失或为空数组/)
})

test('策略：可调参数经配置生效（非硬编码）', async (t) => {
  const gate = await loadGate(t)
  if (gate === undefined) return
  const strict: GateConfig = { ...gate.DEFAULTS, minOptions: 3 }
  assert.match(gate.evaluateAsk(compliantArgs, strict).join(' '), /少于要求的 3 个/)
})

test('waterfall：先调用 next()，并保持上游 deny/ask 单调不被改写', async (t) => {
  const gate = await loadGate(t)
  if (gate === undefined) return
  let listener: Listener | undefined
  let event: string | undefined
  gate.apply({ on: (name, fn) => { event = name; listener = fn as Listener } }, {})
  assert.equal(event, 'tools/pre-execute')
  assert.ok(listener, '必须注册 tools/pre-execute 门')

  let nextCalled = 0
  const allow = async () => { nextCalled += 1; return { kind: 'allow' } }
  const denied = await listener({ name: 'ask_user_question', arguments: { questions: [{ id: 'a', question: '你看怎么办' }] } }, allow)
  assert.equal(nextCalled, 1, '铁律 3：waterfall 监听器必须先调用 next()')
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason ?? '', /执行方，不是指挥方/)

  assert.equal((await listener({ name: 'ask_user_question', arguments: compliantArgs }, allow)).kind, 'allow')
  assert.equal((await listener({ name: 'bash', arguments: { command: 'x' } }, allow)).kind, 'allow', '非门禁工具不受影响')

  const upstreamDeny = await listener({ name: 'ask_user_question', arguments: { questions: [] } }, async () => ({ kind: 'deny', reason: '上游拒绝' }))
  assert.deepEqual(upstreamDeny, { kind: 'deny', reason: '上游拒绝' }, '上游 deny 必须原样透传')
  const upstreamAsk = await listener({ name: 'ask_user_question', arguments: { questions: [] } }, async () => ({ kind: 'ask', reason: '审批' }))
  assert.deepEqual(upstreamAsk, { kind: 'ask', reason: '审批' }, '上游 ask 必须原样透传，不得降级为 allow')
})

test('配置 enabled=false 时不注册任何门', async (t) => {
  const gate = await loadGate(t)
  if (gate === undefined) return
  let registered = false
  gate.apply({ on: () => { registered = true } }, { enabled: false })
  assert.equal(registered, false)
})
