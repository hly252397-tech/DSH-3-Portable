// selfcheck.mjs — dsh-runtime-identity 加载安全 + 策略层自检（不依赖 DSH 运行时）
// 1) 策略层 identity.js 全量单测（纯函数，P0 核心语义）
// 2) 插件形状安全（命名导出 / inject / apply 不抛）
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.resolve(here, '..')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// ---- 文件在场 ----
for (const f of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/identity.js']) {
  check(`file:${f}`, fs.existsSync(path.join(root, f)))
}

// ---- package.json 形状 ----
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
check('pkg.name', pkg.name === 'dsh-runtime-identity', pkg.name)
check('pkg.dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('patch 稳定 id', fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8').includes('id: runtime-identity'))

// ---- 策略层（P0 核心）----
const identity = await import(pathToFileURL(path.join(root, 'lib', 'identity.js')).href)

const id1 = identity.buildRuntimeIdentity({
  provider: 'deepseek-official',
  model: 'deepseek-v3',
  profileName: 'web',
  workspace: 'G:/work',
  sessionId: 'sess-1',
  runtimeRevision: 'rev-1',
  capabilitiesRevision: 'cap-1',
})
check('identity.model.provider_id', id1.model.provider_id === 'deepseek-official')
check('identity.model.requested_model_id', id1.model.requested_model_id === 'deepseek-v3')
check('identity.provider_reported 默认 unknown', id1.model.provider_reported_model_id === 'unknown')
check('identity.session_id', id1.session.session_id === 'sess-1')
check('identity.workspace', id1.environment.workspace === 'G:/work')

const id2 = identity.buildRuntimeIdentity({})
check('identity 全 unknown 不编造', id2.model.provider_id === 'unknown' && id2.model.requested_model_id === 'unknown')
check('identity 无 provider 时 source=unavailable', id2.model.source === 'unavailable')

const matrix = identity.buildCapabilityMatrix(
  [
    { name: 'read', description: 'Read a file' },
    { name: 'secret_tool', description: 'Hidden', invocation: 'not-on-current-wire' },
  ],
  { wireNames: new Set(['read']), nativeImage: 'unknown', visionBridge: 'supported', health: 'ready' },
)
const readCap = matrix.find((m) => m.id === 'read')
const secretCap = matrix.find((m) => m.id === 'secret_tool')
const nativeImg = matrix.find((m) => m.id === 'image_input_native')
const bridgeImg = matrix.find((m) => m.id === 'image_input_vision_bridge')
check('matrix.exposed for wire tool', readCap.exposure === 'exposed' && readCap.route === 'tool')
check('matrix.not-exposed for non-wire', secretCap.exposure === 'not-exposed' && secretCap.route === 'unavailable')
check('matrix.native_image unknown≠unsupported', nativeImg.support === 'unknown')
check('matrix.vision_bridge supported', bridgeImg.support === 'supported' && bridgeImg.route === 'tool')
check('matrix 五维字段齐全', ['support', 'exposure', 'permission', 'health', 'route'].every((k) => k in readCap))

const ctxText = identity.renderRuntimeContext(id1, matrix, 4096)
check('render 含模型行', ctxText.includes('deepseek-official/deepseek-v3'))
check('render 含 unknown 语义', ctxText.includes('unknown ≠ unsupported'))
check('render 无未闭合模板', !ctxText.includes('{{'), ctxText.slice(0, 80))

const descHit = identity.describeCapability(matrix, 'read')
const descMiss = identity.describeCapability(matrix, 'nope')
check('describe 命中', descHit.ok === true && descHit.capability.id === 'read')
check('describe 未命中报 not_found', descMiss.ok === false && descMiss.error === 'capability_not_found')

// ---- 插件形状（mock 依赖后 import）----
// @deepseek-ai/schemastery 与 @deepseek-ai/dsh-tools 在 DSH 运行时解析；
// 自检里用 stub 模块注入 module graph 不可行（ESM），改为解析 package.json +
// 静态检查 index.js 关键契约 + 用 data URL 重写 import 测 apply。
const indexSrc = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
check('index 命名导出 name', indexSrc.includes('export const name = '))
check('index 命名导出 inject', indexSrc.includes('export const inject'))
check('index 命名导出 apply', indexSrc.includes('export function apply'))
check('index inject 只含 systemPrompt+tools', /export const inject = \['systemPrompt', 'tools'\]/.test(indexSrc))
check('index 不含 client bundle 出口', !indexSrc.includes("exports['./client']") && !indexSrc.includes('./client.js'))
check('index 不含 app-restart', !indexSrc.includes('app-restart'))
check('index 注册 get_runtime_context', indexSrc.includes("name: 'get_runtime_context'"))
check('index 注册 describe_capability', indexSrc.includes("name: 'describe_capability'"))
check('index 有 system-prompt/assemble 钩子', indexSrc.includes("system-prompt/assemble"))
check('index 有 systemPrompt.context', indexSrc.includes('systemPrompt.context'))
check('index unknown 不编造注释', indexSrc.includes('unknown'))

// 用 stub 重写 import 后真实执行 apply
const rewritten = indexSrc
  .replace(/import Schema from '@deepseek-ai\/schemastery'/, `const Schema = { object: (x) => x, boolean: () => { const o = { default: () => o, min: () => o, max: () => o, description: () => o }; return o; }, number: () => { const o = { default: () => o, min: () => o, max: () => o, description: () => o }; return o; } };`)
  .replace(/import \{ defineTool \} from '@deepseek-ai\/dsh-tools'/, `const defineTool = (t) => t;`)
  .replace(/from '\.\/identity\.js'/, `from ${JSON.stringify(pathToFileURL(path.join(root, 'lib', 'identity.js')).href)}`)

const tmp = path.join(root, 'lib', '.selfcheck-index.mjs')
fs.writeFileSync(tmp, rewritten, 'utf8')
const mod = await import(pathToFileURL(tmp).href)
check('mod.name', mod.name === 'dsh-runtime-identity')
check('mod.inject', Array.isArray(mod.inject) && mod.inject.join(',') === 'systemPrompt,tools', JSON.stringify(mod.inject))
check('mod.apply is function', typeof mod.apply === 'function')

const sections = []
const contexts = []
const tools = []
const listeners = []
const effects = []
let applyErr = null
const mockCtx = {
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  systemPrompt: {
    section: (s) => sections.push(s),
    context: (c) => contexts.push(c),
    assemble: async () => ({ tools: [], variables: {} }),
  },
  tools: {
    register: (t) => {
      tools.push(t)
      return () => {}
    },
    schemas: () => [{ name: 'read', description: 'Read a file' }],
  },
  on: (name, fn) => listeners.push({ name, fn }),
  effect: (fn) => {
    try {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
    } catch (e) {
      applyErr = e
    }
  },
  get: () => null,
}
try {
  mod.apply(mockCtx, { enabled: true })
} catch (e) {
  applyErr = e
}
check('apply 不抛', !applyErr, applyErr ? String(applyErr.message ?? applyErr) : '')
check('context 已注册', contexts.length >= 1, `contexts=${contexts.length}`)
check('context.name', contexts[0]?.name === 'dsh:runtime-identity', contexts[0]?.name)
check('context.text 是函数', typeof contexts[0]?.text === 'function')
check('tools ≥2', tools.length >= 2, `tools=${tools.length}`)
check('含 get_runtime_context', tools.some((t) => t.name === 'get_runtime_context'))
check('含 describe_capability', tools.some((t) => t.name === 'describe_capability'))
check('assemble 钩子已订阅', listeners.some((l) => l.name === 'system-prompt/assemble'))

// context.text() 首次不抛
let textErr = null
let text = null
try {
  text = contexts[0]?.text?.()
} catch (e) {
  textErr = e
}
check('context.text() 首次不抛', !textErr, textErr ? String(textErr.message ?? textErr) : '')
check('context.text() 返回字符串', typeof text === 'string')
check('context.text() 首次占位不编造', typeof text === 'string' && (text.includes('组装中') || text.includes('运行时身份')), text?.slice(0, 40))

// 触发 assemble 钩子 → 快照更新 → context.text 有真实路由
const assembleFn = listeners.find((l) => l.name === 'system-prompt/assemble')?.fn
if (assembleFn) {
  const fakeAssembly = {
    tools: [{ name: 'read', description: 'Read a file' }],
    variables: { provider: 'p1', model: 'm1' },
    sections: [],
    contexts: [],
  }
  let assembleErr = null
  try {
    const out = await assembleFn(fakeAssembly, { agent: { id: 'a1' } }, async () => fakeAssembly)
    check('assemble 钩子返回 assembly', out === fakeAssembly || typeof out === 'object')
  } catch (e) {
    assembleErr = e
  }
  check('assemble 钩子不抛', !assembleErr, assembleErr ? String(assembleErr.message ?? assembleErr) : '')
  const text2 = contexts[0]?.text?.()
  check('assemble 后 context 含真实模型', typeof text2 === 'string' && text2.includes('p1/m1'), text2?.slice(0, 80))
}

// 工具 execute：get_runtime_context / describe_capability
const getRt = tools.find((t) => t.name === 'get_runtime_context')
const descCap = tools.find((t) => t.name === 'describe_capability')
if (getRt?.execute) {
  let r = null
  try {
    r = await getRt.execute({}, { agent: { id: 'a1' }, signal: { throwIfAborted() {} } })
  } catch (e) {
    r = { error: String(e.message ?? e) }
  }
  check('get_runtime_context ok', r?.ok === true, JSON.stringify(r?.identity?.model ?? r).slice(0, 80))
  check('get_runtime_context 含 model.provider', r?.identity?.model?.provider_id === 'p1' || r?.identity?.model?.provider_id === 'unknown')
}
if (descCap?.execute) {
  let r = null
  try {
    r = await descCap.execute({ capability_id: 'read' }, { agent: { id: 'a1' }, signal: { throwIfAborted() {} } })
  } catch (e) {
    r = { error: String(e.message ?? e) }
  }
  check('describe_capability 命中', r?.ok === true && r?.capability?.id === 'read', JSON.stringify(r).slice(0, 80))
}

// enabled:false 不注册
const tools2 = []
const mockCtx2 = {
  systemPrompt: { section() {}, context() {} },
  tools: { register: (t) => (tools2.push(t), () => {}), schemas: () => [] },
  on() {},
  effect: (fn) => {
    try { fn() } catch { /* ignore */ }
  },
  get: () => null,
}
mod.apply(mockCtx2, { enabled: false })
check('enabled:false 不注册工具', tools2.length === 0, `tools=${tools2.length}`)

fs.unlinkSync(tmp)

const failed = results.filter((r) => !r.ok)
console.log('\n---')
console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`)
if (failed.length) {
  process.exitCode = 1
  console.log('FAILED:', failed.map((f) => f.name).join(', '))
}
