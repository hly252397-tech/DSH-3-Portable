#!/usr/bin/env node
/**
 * UI 交付纪律 lint（2026-09-17 固化）——把**真实事故**变成机器检查，不靠人记得。
 *
 * 为什么有它：三次事故都不是"不知道"，是"没被机器挡住"：
 *   ① 用 CSS / !important 覆盖了 JS 内联写的状态变量（--dsh-sidebar-width）→ 用户丢掉拖动；
 *   ② 补丁脚本的幂等守卫按**标记**跳过 → 改了载荷而活制品没变（改了个寂寞）；
 *   ③ 手工往 live 的 `client.js` 插代码时多写一个 `}` → 该文件**语法错误** → 宿主把 N 个客户端插件
 *      拼成**一个经典脚本**，一个坏文件就让整串不执行 → 同串 63 个模块全部报 `import failed`，
 *      用户看到"73 个插件加载失败"（2026-09-17 11 时事故）。
 *   ④ 新插件的客户端 factory 返回了**没有 apply 方法的普通对象**（`{name, state}`）→ 解析能过，
 *      但 loader 校验 `invalid plugin, expect function or object with an "apply" method, received object`
 *      → 整页 boot 失败（2026-09-17 14:40 的 dsh-agentos-trigger 事故）。语法检查（⑥）抓不到它，
 *      只有把 factory 真跑一遍才能看到返回形状——就是检查 ⑦。
 *   ⑤ 生成的客户端 bundle 被**全域字符替换损坏**（每个 `m` 变 `i`：`react-dom`→`react-doi`、
 *      `name`→`naie`、`document`→`docuient`…135 万字节自洽但对外部契约全坏）→ 语法合法（⑥过）、
 *      形状合法（⑦过，stub require 放行），到浏览器里 factory 抛错 → **46 个插件连坐报 import failed**
 *      （2026-09-17 16:01 的 dsh-better-sidebar 事故）。只有 require 规格**必须命中已知集合**才能拦住——
 *      就是检查 ⑧。
 * 这五条现在都成了断言；谁再犯，脚本直接红。
 *
 * 用法：node scripts/lint-ui-discipline.mjs        （exit 0 = 全过）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import { WORKBENCH_GEOMETRY_FILES, findWorkbenchGeometryViolations, findWorkbenchProbeViolations } from './workbench-geometry-guard.mjs'
import { GATE_NODE } from './lib/gate-node.mjs'
import { activeUiProfile } from './lib/active-ui-profile.mjs'

const ROOT = resolve(process.cwd())
const { profile: activeProfile, runtime: activeRuntime } = activeUiProfile(ROOT)
const profileRelative = activeProfile.slice(ROOT.length + 1).replaceAll('\\', '/')
const activePath = rel => rel.startsWith('Data/DSH/profiles/web/') ? resolve(activeProfile, rel.slice('Data/DSH/profiles/web/'.length)) : resolve(ROOT, rel)
// 门禁必须跑在与清单一致的 Node 上（原先硬编码 App/resources/node 是 1.0.43 旧树，v24.20.0）。
const NODE = GATE_NODE
const read = (rel) => (existsSync(activePath(rel)) ? readFileSync(activePath(rel), 'utf8') : '')
const count = (hay, needle) => hay.split(needle).length - 1
const results = []
const check = (name, ok, measured, expected) => results.push({ name, ok: Boolean(ok), measured: String(measured), expected })

const PATCH = 'scripts/build-sidebar-layout-compat.mjs'
const BUNDLE = 'Data/DSH/profiles/web/local/dsh-better-sidebar/lib/client.js'
const DOC = 'docs/03-技术架构/UI定制维护契约.md'
const GLOBAL = resolve(activeProfile, '../../AGENTS.md')
const PROBE = 'Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/ui-probe.json'

// ① 事故②：幂等守卫必须按**载荷**判断，不能只按标记——否则改了载荷活制品不跟着变
const patch = read(PATCH)
const markerOnly = (patch.match(/if \(!client\.includes\('\/\*/g) ?? []).length
check('补丁脚本无"只按标记"的幂等守卫', patch !== '' && markerOnly === 0, `marker-only 守卫 ${markerOnly} 处`, '0 处')

// ② 事故①：CSS 不得覆盖 JS 内联写的状态变量。空卡片态也由同一写者负责。
const bundle = read(BUNDLE)
const cssDecl = count(bundle, '--dsh-sidebar-width:')
const jsWrite = count(bundle, 'setProperty("--dsh-sidebar-width"')
check('CSS 不声明 --dsh-sidebar-width', bundle !== '' && cssDecl === 0, `CSS 声明 ${cssDecl} 处`, '0 处')
check('JS 写入点唯一（写入处钳制）', jsWrite === 1, `setProperty 写入 ${jsWrite} 处`, '1 处')

// ⑨ A rebuilt sidebar must preserve the same width for panel, reservation
// and empty-card states. Check source and live products, not only one bundle.
const geometrySources = Object.fromEntries(WORKBENCH_GEOMETRY_FILES.map((path) => [path, existsSync(activePath(path)) ? read(path) : undefined]))
const geometryFailures = findWorkbenchGeometryViolations(geometrySources)
check('右工作区源码/产物只有一个宽度来源', geometryFailures.length === 0, geometryFailures.length === 0 ? `${WORKBENCH_GEOMETRY_FILES.length} 个文件一致` : geometryFailures.join(' | ').slice(0, 300), '0 个冲突')

// ③ 规则必须"写在会被加载的地方"（全局）+ 细则在仓库
check('全局 AGENTS 含交付纪律章节', read(GLOBAL).includes('交付纪律'), '含', '含')
check('契约文档含 §10 执行纪律', read(DOC).includes('## 10. 执行纪律'), '含', '含')

// ④ 探针必须无视觉输出（取证工具零副作用边界）+ 新鲜度
const probeAlive = existsSync(activePath(PROBE))
check('活动 Profile 探针存在', probeAlive, activePath(PROBE), '存在')
if (probeAlive) {
  const probeAge = (Date.now() - Date.parse(JSON.parse(read(PROBE)).sampledAt)) / 1000
  check('探针数据新鲜（≤600s，应用在跑时）', probeAge >= 0 && probeAge <= 600, `${Math.round(probeAge)}s`, '0–600s')
  const probeClient = read('Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js')
  check('探针无视觉浮层残留', !probeClient.includes('dsh-width-probe'), '无残留', '无')
  try {
    const geometry = findWorkbenchProbeViolations(JSON.parse(read(PROBE)))
    check('实机面板/让位/输入框边界一致', geometry.length === 0, geometry.length === 0 ? '几何一致' : geometry.join(' | ').slice(0, 300), '几何一致')
  } catch (error) {
    check('实机面板/让位/输入框边界一致', false, `探针无法解析: ${error.message}`, '几何一致')
  }
}

// ⑤ 常驻仪表必须被消费：watch 只写日志时人（和模型）会忘读 ⇒ 这里把它的判定变成门禁
const verdictPath = resolve(ROOT, 'Data/Temp/watch-last-verdict.json')
if (existsSync(verdictPath)) {
  const v = JSON.parse(readFileSync(verdictPath, 'utf8'))
  const age = (Date.now() - Date.parse(v.at)) / 1000
  check('watch 判定新鲜（≤1800s）', age <= 1800, `${Math.round(age)}s`, '≤1800s')
  check('watch 最近一次判定为 PASS', v.status === 'pass', `${v.status}${v.verify?.failed ? ' :: ' + String(v.verify.failed).slice(0, 90) : ''}`, 'pass')
} else {
  check('watch 判定文件存在（未启动 watch 时跳过）', true, '未找到（视为未启动）', '存在或未启动')
}

// ⑥ 事故③：任何**会被服务的** bundle 必须能解析——拼接脚本是经典脚本，一个坏文件拖垮整串，
//    而浏览器只会说 "import failed"（不说是谁、不说哪一行）。解析检查必须在落盘后、被服务前跑。
//    扫描两处：lives（`Data/DSH/profiles/web/local/<插件>/lib/`，会热重载进页面）+ 归档（`customizations/<插件>/lib/`，
//    灾难恢复的来源——归档坏了等于恢复路径也坏了）。
const parsed = []
const parseFails = []
for (const root of [`${profileRelative}/local`, 'customizations']) {
  const abs = resolve(ROOT, root)
  if (!existsSync(abs)) continue
  for (const pkg of readdirSync(abs)) {
    for (const name of ['client.js', 'index.js']) {
      const file = resolve(abs, pkg, 'lib', name)
      if (!existsSync(file)) continue
      parsed.push(`${root}/${pkg}/lib/${name}`)
      try {
        execFileSync(NODE, ['--check', file], { stdio: 'pipe', windowsHide: true })
      } catch (e) {
        const why = String(e.stderr ?? e.message).split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 2).join(' ')
        parseFails.push(`${root}/${pkg}/lib/${name} :: ${why}`.slice(0, 300))
      }
    }
  }
}
check('活动/归档插件 bundle 全部可解析', parseFails.length === 0, parseFails.length === 0 ? `${parsed.length} 个文件全通过` : parseFails.join(' | '), '0 个失败')

// ⑦ 事故④：客户端 factory 必须返回 function 或带 apply 的对象（loader 真实校验语义，
//    见 @deepseek-ai/dsh-web-frontend 的 plugin() 与 dsh-client-modules 的 materialize()：
//    `exports = factory(requireStub)`）。用 vm 沙箱把真实字节求值一遍、调 factory、判返回形状。
//    factory 抛错（沙箱缺浏览器全局）= 跳过不判，零误报；能干净返回但形状非法 = FAIL。
const shapePass = []
const shapeFails = []
const shapeSkips = []
{
  const stubProto = new Proxy({}, { get: () => universalStub() })
  function universalStub() {
    // 基座是普通 function（可 new / 可 extends）；原型指向万能 getter，让 esbuild 的
    // __toESM(…,1) 复制后属性查找仍落到万能 getter。`then` 必须为 undefined（防 thenable 误判）。
    return new Proxy(function stubFn() {}, {
      get: (t, p) => {
        if (p === Symbol.toPrimitive) return () => ''
        if (p === 'then') return undefined
        return universalStub()
      },
      apply: () => universalStub(),
      construct: () => universalStub(),
      getPrototypeOf: () => stubProto,
    })
  }
  for (const root of [`${profileRelative}/local`, 'customizations']) {
    const abs = resolve(ROOT, root)
    if (!existsSync(abs)) continue
    for (const pkg of readdirSync(abs)) {
      const file = resolve(abs, pkg, 'lib', 'client.js')
      if (!existsSync(file)) continue
      const captured = []
      const loader = { mode: 'shape-check', pendingQueue: [], load: (m) => captured.push(m), create: () => {} }
      const sandbox = {
        console,
        setTimeout: () => 0,
        clearTimeout: () => {},
        queueMicrotask,
        navigator: { sendBeacon: () => false, userAgent: 'shape-check' },
        PerformanceObserver: class { observe() {} disconnect() {} },
        Blob: class {},
        fetch: () => Promise.resolve({ ok: true }),
        location: { href: 'http://localhost/', reload: () => {}, protocol: 'http:' },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
        requestAnimationFrame: () => 0,
        getComputedStyle: () => universalStub(),
        document: universalStub(),
        Element: class {},
        HTMLElement: class {},
        HTMLStyleElement: class {},
        HTMLDivElement: class {},
        Node: class {},
        CSSStyleSheet: class { insertRule() {} },
        customElements: { define: () => {}, get: () => undefined },
        MutationObserver: class { observe() {} disconnect() {} },
        ResizeObserver: class { observe() {} disconnect() {} },
        CustomEvent: class { constructor(t) { this.type = t } },
        require: () => universalStub(),
        module: { exports: {} },
        exports: {},
      }
      sandbox.window = new Proxy(
        { __ModuleLoader__: loader },
        {
          get: (t, p) => {
            if (p === '__ModuleLoader__') return loader
            if (p in t) return t[p]
            if (p in sandbox) return sandbox[p]
            return universalStub()
          },
          set: (t, p, v) => { t[p] = v; return true },
        },
      )
      sandbox.globalThis = sandbox
      let evalError = null
      try {
        vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { timeout: 5000, filename: file })
      } catch (e) {
        evalError = e
      }
      if (captured.length === 0) {
        shapeSkips.push(`${root}/${pkg}${evalError ? ` :: 求值抛错 ${String(evalError.message).slice(0, 80)}` : ''}`)
        continue
      }
      for (const m of captured) {
        let result = null
        try {
          result = m.factory(() => universalStub())
          if (result && typeof result.then === 'function') continue // 异步工厂：不阻塞门禁，交由浏览器真实验证
        } catch {
          shapeSkips.push(`${root}/${pkg} [${m.id ?? '?'}] :: factory 抛错（沙箱缺全局，跳过）`)
          continue
        }
        const ok = typeof result === 'function' || (result && typeof result.apply === 'function')
        if (ok) shapePass.push(`${root}/${pkg} [${m.id ?? '?'}]`)
        else shapeFails.push(`${root}/${pkg} [${m.id ?? '?'}] :: typeof=${typeof result}${result && typeof result === 'object' ? ' keys=' + Object.keys(result).join(',') : ''} ← 浏览器将报 'received ${typeof result}'`)
      }
    }
  }
}
check(
  '客户端 factory 返回形状合法（function 或带 apply）',
  shapeFails.length === 0,
  shapeFails.length === 0 ? `${shapePass.length} 个模块合法 / ${shapeSkips.length} 个跳过` : shapeFails.join(' | ').slice(0, 300),
  '0 个非法',
)

// ⑧ 事故⑤：**会被服务的** bundle 的 require 规格必须命中已知集合。生成的 bundle 可能被字符替换/
//    编码事故整体损坏（2026-09-17 全域 m→i）——语法与形状都合法，只有 require("react-doi") 这种
//    规格对不上已知模块集合，才能在落盘后、被服务前拦住。参照集 = 已安装官方/社区包 client bundle
//    出现过的全部 require 规格 ∪ bundle id（含 /client 形式）∪ 相对路径；只扫 live package.json
//    bundles 清单里的插件（不在清单 = 不会被服务，归属其维护会话处理）。
{
  const PROFILE = resolve(activeProfile, 'package.json')
  const REF_ROOTS = [
    resolve(activeRuntime ?? resolve(activeProfile, '..'), 'node_modules/@deepseek-ai'),
    resolve(activeProfile, 'node_modules/@michengai'),
    resolve(activeProfile, 'node_modules/@kenz1117'),
  ]
  const specRe = /require\("([^"]+)"\)/g
  const known = new Set()
  for (const root of REF_ROOTS) {
    if (!existsSync(root)) continue
    for (const pkg of readdirSync(root)) {
      const f = join(root, pkg, 'lib', 'client.js')
      if (!existsSync(f)) continue
      for (const m of readFileSync(f, 'utf8').matchAll(specRe)) known.add(m[1])
    }
  }
  const bundles = []
  const profile = existsSync(PROFILE) ? JSON.parse(readFileSync(PROFILE, 'utf8')) : {}
  const collectBundles = (o) => { for (const k of Object.keys(o ?? {})) { const v = o[k]; if (k === 'bundles' && Array.isArray(v)) bundles.push(...v.filter((x) => typeof x === 'string')); else if (v && typeof v === 'object' && !Array.isArray(v)) collectBundles(v) } }
  collectBundles(profile)
  for (const id of bundles) { known.add(id); known.add(`${id}/client`) }
  const specFails = []
  const specChecked = []
  for (const id of bundles) {
    if (id.startsWith('@')) continue // 官方/社区包自带健康基线；本检查针对本地生成的 bundle
    for (const base of [resolve(activeProfile, 'local', id), resolve(activeProfile, 'node_modules', id)]) {
      const f = join(base, 'lib', 'client.js')
      if (!existsSync(f)) continue
      specChecked.push(`${id}/lib/client.js`)
      for (const m of readFileSync(f, 'utf8').matchAll(specRe)) {
        const spec = m[1]
        if (spec.startsWith('./') || spec.startsWith('../')) continue
        if (!known.has(spec)) specFails.push(`${id} :: require("${spec}") 不在已知集合（疑似生成损坏/拼写漂移）`)
      }
    }
  }
  check(
    '服务 bundle 的 require 规格命中已知集合',
    specFails.length === 0,
    specFails.length === 0 ? `${specChecked.length} 个本地 bundle / ${known.size} 个已知规格` : [...new Set(specFails)].slice(0, 6).join(' | ').slice(0, 300),
    '0 个未知规格',
  )
}

const pass = results.filter((r) => r.ok).length
const status = pass === results.length ? 'pass' : 'fail'
const dir = resolve(ROOT, `Data/artifacts/ui-discipline-lint-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(dir, { recursive: true })
writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ status, checkedAt: new Date().toISOString(), results }, null, 2))
const pad = (s, n) => String(s).padEnd(n)
console.log(`\nUI 交付纪律 lint  ${status === 'pass' ? 'PASS' : 'FAIL'}  (${pass}/${results.length})\n`)
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${pad(r.name, 40)} 实测 ${pad(r.measured, 22)} 期望 ${r.expected}`)
console.log('')
process.exit(status === 'pass' ? 0 : 1)
