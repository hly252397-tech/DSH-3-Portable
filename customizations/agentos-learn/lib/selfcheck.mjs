// dsh-agentos-learn 加载安全自检（不依赖 DSH 运行时）
// 目的：防止 factory 抛错 / 形状不符 → 连坐其它插件（历史事故：46 import failed）
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const pluginDir = path.join(path.dirname(path.dirname(path.resolve(import.meta.url.replace('file:///', '')))), '')
// 直接按脚本位置解析
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.resolve(here, '..')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// 1) 文件在场
for (const f of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/learnpolicy.js']) {
  check(`file:${f}`, fs.existsSync(path.join(root, f)))
}

// 2) package.json 形状
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
check('pkg.name', pkg.name === 'dsh-agentos-learn', pkg.name)
check('pkg.type=module', pkg.type === 'module')
check('pkg.main', pkg.main === 'lib/index.js', String(pkg.main))
check('pkg.dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('pkg.files includes lib', Array.isArray(pkg.files) && pkg.files.includes('lib/index.js'))

// 3) 模块形状：命名导出 name/inject/apply，且 apply 不抛
const mod = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
check('export.name', mod.name === 'dsh-agentos-learn', String(mod.name))
check('export.inject is array', Array.isArray(mod.inject), JSON.stringify(mod.inject))
check('export.apply is function', typeof mod.apply === 'function')
check('inject 只含已知服务', mod.inject.every((s) => ['systemPrompt', 'commands', 'webServer', 'tools', 'llm', 'loader', 'slots', 'locale', 'connection', 'typert', 'reflect', 'inputTriggers', 'subagents'].includes(s)), JSON.stringify(mod.inject))
check('inject 不含不存在的 command 单数', !mod.inject.includes('command'))
check('Config 是 Schemastery', typeof mod.Config === 'function' || (mod.Config && typeof mod.Config === 'object'))

// 4) apply 在 mock ctx 上跑通且不抛
const sections = []
const commands = []
const listeners = []
const effects = []
let thrown = null
const mockCtx = {
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  systemPrompt: {
    section: (s) => sections.push(s),
  },
  commands: {
    register: (c) => {
      commands.push(c)
      return () => {}
    },
  },
  on: (name, fn) => {
    listeners.push({ name, fn })
  },
  effect: (fn, label) => {
    effects.push({ fn, label })
    // 立即执行注册类 effect；disposer 也收集
    try {
      const d = fn()
      if (typeof d === 'function') effects.push({ disposer: d })
    } catch (e) {
      thrown = e
    }
  },
  get: () => null,
}

try {
  mod.apply(mockCtx, { enabled: true, maxInjectedExperiences: 3 })
} catch (e) {
  thrown = e
}
check('apply 不抛', !thrown, thrown ? String(thrown.message ?? thrown) : '')

// 5) 注册了 systemPrompt 节 + 至少 3 条命令
check('systemPrompt.section 已注册', sections.length >= 1, `sections=${sections.length}`)
check('section.name 正确', sections[0]?.name === 'agentos-learn:experiences', sections[0]?.name)
check('section.text 是函数', typeof sections[0]?.text === 'function')
check('commands ≥3', commands.length >= 3, `commands=${commands.length}`)
check('commands 含 agentos-learn', commands.some((c) => c.name === 'agentos-learn'))
check('session/event 已订阅', listeners.some((l) => l.name === 'session/event'))

// 6) section.text() 不抛（未加载 AgentOS 时应返回占位）
let text = null
let textErr = null
try {
  text = sections[0]?.text?.()
} catch (e) {
  textErr = e
}
check('section.text() 不抛', !textErr, textErr ? String(textErr.message ?? textErr) : '')
check('section.text() 返回字符串', typeof text === 'string', String(text).slice(0, 60))
check('section.text() 静态可审计', typeof text === 'string' && (text.includes('适用经验') || text.includes('未就绪') || text.includes('AgentOS')), '')

// 7) 事件回调不抛（喂畸形事件）
const sessFn = listeners.find((l) => l.name === 'session/event')?.fn
if (sessFn) {
  let evErr = null
  try {
    sessFn(null, null)
    sessFn({ id: 's1' }, { type: 'tool/result' })
    sessFn({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    sessFn({ type: 'unknown-type', data: {} })
    // 签名兼容：单参
    sessFn({ type: 'turn/start', data: { turn: 2 } })
  } catch (e) {
    evErr = e
  }
  check('session/event 畸形输入不抛', !evErr, evErr ? String(evErr.message ?? evErr) : '')
}

// 8) 策略层纯函数
const policy = await import(pathToFileURL(path.join(root, 'lib', 'learnpolicy.js')).href)
check('policy.extract 是函数', typeof policy.extractExperienceCandidate === 'function')
check('policy.select 是函数', typeof policy.selectRelevantExperiences === 'function')
check('policy.render 是函数', typeof policy.renderExperienceSection === 'function')

const cand = policy.extractExperienceCandidate({
  sessionId: 's',
  turn: 1,
  turnReason: 'completed',
  tools: [
    { callId: '1', name: 'Read', status: 'failed', isError: true },
    { callId: '2', name: 'Write', status: 'completed', isError: false },
    { callId: '3', name: 'Bash', status: 'completed', isError: false },
  ],
  responseChars: 100,
})
check('extract 失败轮产出候选', Boolean(cand) && cand.kind === 'episodic' && Boolean(cand.hypothesis), cand?.kind)
check('extract 不编造 tools', cand?.evidence?.tools?.length === 3)

const empty = policy.extractExperienceCandidate({
  sessionId: 's',
  turn: 2,
  turnReason: 'completed',
  tools: [],
  responseChars: 10,
})
check('extract 空闲轮返回 null', empty === null)

const picked = policy.selectRelevantExperiences(
  [
    { kind: 'procedural', status: 'active', content: 'A', tags: ['procedure'], hypothesis: 'h1', recorded_at: '2026-01-01' },
    { kind: 'episodic', status: 'active', content: 'B', tags: ['failure'], hypothesis: 'h2', recorded_at: '2026-01-02' },
    { kind: 'semantic', status: 'rejected', content: 'C', tags: [] },
    { kind: 'procedural', status: 'active', content: 'D', tags: ['procedure'], hypothesis: 'h3', recorded_at: '2026-01-03' },
  ],
  { limit: 5, tags: ['failure', 'procedure'] },
)
check('select 排除 rejected', !picked.some((r) => r.content === 'C'), `picked=${picked.map((r) => r.content).join(',')}`)
check('select 失败优先', picked[0]?.content === 'B', picked[0]?.content)

const rendered = policy.renderExperienceSection(picked)
check('render 含标题', typeof rendered === 'string' && rendered.includes('适用经验'))
check('render 不把观察写成结论', rendered.includes('不替代验证'))

// 9) 可摘除：enabled:false 时不注册业务副作用（section.text 返回空）
const sections2 = []
const commands2 = []
const mockCtx2 = {
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  systemPrompt: { section: (s) => sections2.push(s) },
  commands: {
    register: (c) => {
      commands2.push(c)
      return () => {}
    },
  },
  on: () => {},
  effect: (fn) => {
    try {
      fn()
    } catch {
      /* ignore */
    }
  },
  get: () => null,
}
mod.apply(mockCtx2, { enabled: false })
const disabledText = sections2[0]?.text?.()
check('enabled:false 时注入为空', disabledText === '' || disabledText == null, String(disabledText).slice(0, 40))

// 10) cordis.patch.yml 稳定 id
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
check('patch 含稳定 id', patch.includes('id: agentos-learn'), '')
check('patch 只 insert 新插件', patch.includes('name: dsh-agentos-learn') && !patch.includes('disabled: true'), '')

const failed = results.filter((r) => !r.ok)
console.log('\n---')
console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`)
if (failed.length) {
  process.exitCode = 1
  console.log('FAILED:', failed.map((f) => f.name).join(', '))
}
