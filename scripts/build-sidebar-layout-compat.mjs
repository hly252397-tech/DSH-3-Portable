import { readFile, writeFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { resolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { transformSidechatComponentCompat } from './sidechat-component-compat.mjs'
import { WORKBENCH_GEOMETRY_FILES, findWorkbenchGeometryViolations } from './workbench-geometry-guard.mjs'

// The local fork ships a prebuilt client. Preserve its native-browser patch
// and lazy chunks while applying the same host compatibility as Sidebar.tsx.
const file = resolve('Data/DSH/profiles/web/local/dsh-better-sidebar/lib/client.js')
let client = await readFile(file, 'utf8')
const geometrySource = await readFile(resolve('src/workbench-geometry.ts'), 'utf8')
const geometryCode = stripTypeScriptTypes(geometrySource).replace(/^export /gm, '')
const geometryBlock = `/* portable-geometry:start */\n${geometryCode}/* portable-geometry:end */`
if (client.includes('/* portable-geometry:start */')) {
  client = client.replace(/\/\* portable-geometry:start \*\/[\s\S]*?\/\* portable-geometry:end \*\//, geometryBlock)
} else {
  const anchor = 'factory: (require) => {'
  if (client.split(anchor).length !== 2) throw new Error('Expected one sidebar factory')
  client = client.replace(anchor, anchor + '\n' + geometryBlock)
}
const before = 'document.querySelector("#root [data-slot=\\"conversation\\"]")?.parentElement'
const after = '(document.querySelector("#root [data-slot=\\"main\\"]")?.parentElement ?? document.querySelector("#root [data-slot=\\"conversation\\"]")?.parentElement ?? document.querySelector("#root [data-dsh-frame] > [data-pane=\\"conversation\\"]") ?? void 0)'
if (!client.includes(after)) {
  if (client.split(before).length !== 2) throw new Error('Sidebar locator changed; review host compatibility before rebuilding')
  client = client.replace(before, after)
}
// Apply to the embedded layout stylesheet, including dragging/reduced motion.
const oldSelector = '#root :has(> [data-slot=\\"conversation\\"])'
const newSelector = '#root :is(:has(> [data-slot=\\"conversation\\"]),:has(> [data-slot=\\"main\\"]))'
if (!client.includes(newSelector) && !client.includes(oldSelector)) throw new Error('Sidebar layout stylesheet changed')
client = client.replaceAll(oldSelector, newSelector)
// Public local-fork action for coordination with the official right panel.
const serviceAnchor = '\t\t\t\tsubscribeState,\n'
const panelAction = '\t\t\t\tsetPanelOpen: (open) => { store.reduce(state => state.panelOpen === open ? state : { ...state, panelOpen: open }); },\n'
client = client.replaceAll('\r\n', '\n')
if (!client.includes(panelAction)) {
  if (client.split(serviceAnchor).length !== 2) throw new Error('Sidebar service changed; review panel coordination before rebuilding')
  client = client.replace(serviceAnchor, serviceAnchor + panelAction)
}
// Internal diff tabs remain usable, but are not separate user feature cards.
const oldInventory = '[...service.getTabs()].sort(tabOrder)'
const newInventory = '[...service.getTabs()].filter(tab => tab.id !== "diff" && tab.id !== "space-automation").sort(tabOrder)'
if (!client.includes(newInventory)) {
  if (client.split(oldInventory).length !== 3) throw new Error('Settings tab inventory changed; review retired entries')
  client = client.replaceAll(oldInventory, newInventory)
}
// 2026-09-19：空态宽度不再由补丁脚本另写一套状态。
// 之前这里把 paneEmptyCards/editorPlaceholder 固定成 560/430px，并以
// !important 覆盖拖拽写入的 --dsh-sidebar-width，直接造成“内联值变了、面板不动”。
// 唯一的状态写入点在 better-sidebar；dsh-sidebar-spaces 只消费该值并负责边界匹配。
const staleAdaptiveCss = 'html:has(.nArs4W_panel:not(.nArs4W_panelHidden) .nArs4W_paneEmptyCards){--dsh-sidebar-width:560px!important}html:has(.nArs4W_panel:not(.nArs4W_panelHidden) .nArs4W_editorPlaceholder){--dsh-sidebar-width:430px!important}body .nArs4W_panel:has(.nArs4W_paneEmptyCards){max-width:560px!important}body .nArs4W_panel:has(.nArs4W_editorPlaceholder){max-width:430px!important}'
const staleAdaptiveCssLegacy = 'html:has(.nArs4W_paneEmptyCards){--dsh-sidebar-width:560px!important}html:has(.nArs4W_editorPlaceholder){--dsh-sidebar-width:430px!important}'
const stalePanelMaxCss = 'body .nArs4W_panel:has(.nArs4W_paneEmptyCards){max-width:560px!important}body .nArs4W_panel:has(.nArs4W_editorPlaceholder){max-width:430px!important}body .nArs4W_panel:has(.nArs4W_editorPlaceholder){max-width:420px!important}body .nArs4W_panel:has(.nArs4W_paneEmptyCards){max-width:560px!important}'
const staleSeamCss = '/* seam-exact */body .nArs4W_panel{width:var(--dsh-sidebar-width,420px)!important;min-width:286px!important;max-width:none!important}'
const staleFrameCss = 'body .pI_x6G_frame{flex:1 1 auto!important;min-width:0!important}'
client = client.replaceAll(staleAdaptiveCss, '').replaceAll(staleAdaptiveCssLegacy, '').replaceAll(stalePanelMaxCss, '').replaceAll(staleSeamCss, '').replaceAll(staleFrameCss, '')
client = client.replaceAll('body .nArs4W_panel:has(.nArs4W_paneEmptyCards){max-width:560px!important}', '').replaceAll('body .nArs4W_panel:has(.nArs4W_editorPlaceholder){max-width:430px!important}', '').replaceAll('body .nArs4W_panel:has(.nArs4W_editorPlaceholder){max-width:420px!important}', '')
// 2026-09-16 全局自适应（用户：「所有工作区边界自适应，缩放大小自适应」）：
// 钳制必须在**写入处**，不能用 CSS 覆盖 —— 拖动就是往 --dsh-sidebar-width 写状态，
// CSS 覆盖会把拖动结果立刻压回去，表现为"拖不动"（2026-09-16 用户实测）。
const writeGeometryAnchor = 'document.documentElement.style.setProperty("--dsh-sidebar-width", `${width}px`);'
// 2026-09-17 修复：本钳制会把「收起」时上游按契约传进来的 0 变成 280（Math.max(280,0)），
// 于是收起后仍写 --dsh-sidebar-width:280px，而应用侧 `#root{margin-right:var(--dsh-sidebar-width)}`
// 照抄这 280px ⇒ 右栏消失但右侧留一条 280px 空白条（用户 2026-09-17 截图为证）。
// 守卫必须加在**钳制里**（写入处）：width<=0 原样写 0，铺开时钳制语义完全不变。
const writeGeometryClamped = 'const __avail = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dsh-app-width")) || window.innerWidth; const __w = width <= 0 ? 0 : Math.max(286, Math.min(width, Math.max(286, __avail - 680))); document.documentElement.style.setProperty("--dsh-sidebar-width", `${__w}px`);'
if (!client.includes('resolveWorkbenchWidth(width, window.innerWidth') && !client.includes('__avail - 680')) {
  if (client.split(writeGeometryAnchor).length !== 2) throw new Error('writeGeometry anchor changed; review adaptive clamp')
  client = client.replace(writeGeometryAnchor, writeGeometryClamped)
}
// 2026-09-18 对话区截断根治：applyDrag 也走同一钳制。
// 根因：writeGeometry 钳制了 --dsh-sidebar-width（CSS 变量 → #root margin），
// 但 applyDrag 的 panelRef inline style.width 仍写原始拖拽值。
// seam-exact 的 width:var()!important 在无 editorPlaceholder/paneEmptyCards 时
// 被 inline style 覆盖（inline + important > stylesheet），面板实际宽 = 原始值，
// 而 #root margin = 钳制值 → 面板比预留空间宽 → 对话区被截断。
// 修在 applyDrag 入口：width/height 进来就钳制，后续 inline style + bottomPush +
// writeGeometry 全用钳制值，三处恒等。
const applyDragRaw = 'const applyDrag = (width, height) => {\n\t\t\t\tlastDragSize.current = {\n\t\t\t\t\twidth,\n\t\t\t\t\theight\n\t\t\t\t};'
const applyDragClamped = 'const applyDrag = (width, height) => {\n\t\t\t\tconst __a = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dsh-app-width")) || window.innerWidth;\n\t\t\t\twidth = width > 0 ? Math.max(286, Math.min(width, Math.max(286, __a - 680))) : 0;\n\t\t\t\theight = height > 0 ? Math.max(0, height) : 0;\n\t\t\t\tlastDragSize.current = {\n\t\t\t\t\twidth,\n\t\t\t\t\theight\n\t\t\t\t};'
if (!client.includes('resolveWorkbenchWidth(width, window.innerWidth') && !client.includes('__a - 680')) {
  if (client.split(applyDragRaw).length !== 2) throw new Error('applyDrag anchor changed; review inline-width clamp')
  client = client.replace(applyDragRaw, applyDragClamped)
}
// 2026-09-19 alpha.2 适配（用户报「右栏整个没了」）：官方 sessions.list 快照不再带 `.current`
// （重构为 retain 语义——当前主会话 = byId 里 retainedBy.mainView > 0 的那条），better-sidebar
// 按 alpha.1 契约读 `.current` 得 undefined ⇒ noSession 分支 ⇒ 面板 DOM 整个不渲染（静默、无报错）。
// 两处读点（拦截器 currentSessionId + 主组件 const current）改为兼容读：alpha.1 .current 优先，
// alpha.2 回落 retainedBy.mainView 扫描。src 源（Sidebar.tsx / intercept.tsx / state.ts helper）已同步。
const interceptCurrentOld = "currentSessionId: () => ctx.sessions.list.getSnapshot().current,"
const interceptCurrentNew = "currentSessionId: () => { const __l = ctx.sessions.list.getSnapshot(); if (__l.current !== void 0) return __l.current; for (const [__id, __r] of Object.entries(__l.byId ?? {})) if ((__r?.retainedBy?.mainView ?? 0) > 0) return __id; return void 0; },"
const sidebarCurrentOld = "const current = sessionList.current;"
const sidebarCurrentNew = "const current = (() => { if (sessionList.current !== void 0) return sessionList.current; for (const [__id, __r] of Object.entries(sessionList.byId ?? {})) if ((__r?.retainedBy?.mainView ?? 0) > 0) return __id; return void 0; })();"
if (!client.includes('__r?.retainedBy?.mainView')) {
  if (client.split(interceptCurrentOld).length !== 1 + 1) throw new Error('intercept current anchor changed; review alpha.2 session compat')
  if (client.split(sidebarCurrentOld).length !== 1 + 1) throw new Error('sidebar current anchor changed; review alpha.2 session compat')
  client = client.replace(interceptCurrentOld, interceptCurrentNew).replace(sidebarCurrentOld, sidebarCurrentNew)
}
// One owner for committed, rendered and dragged widths. Retire the old
// write-only clamp; it disagreed with both the CSS cap and the rendered width.
const replaceUnique = (oldText, newText, label) => {
  if (client.includes(newText)) return
  if (client.split(oldText).length !== 2) throw new Error(`${label}: expected unique anchor`)
  client = client.replace(oldText, newText)
}
const clampStart = client.indexOf('const clampWidth = (width) =>')
const clampEnd = client.indexOf('\n', clampStart)
if (clampStart < 0 || clampEnd < 0) throw new Error('Missing width clamp')
const clampNew = 'const clampWidth = (width) => resolveWorkbenchWidth(width, window.innerWidth, parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dsh-browser-panel-max-width")), document.documentElement.dataset.dshCompact === "1");'
client = client.slice(0, clampStart) + clampNew + client.slice(clampEnd)
const writer = client.indexOf('const writeGeometry = (width, height) => {')
const heightWriter = client.indexOf('document.documentElement.style.setProperty("--dsh-sidebar-height"', writer)
if (writer < 0 || heightWriter < 0) throw new Error('Missing geometry writer')
client = client.slice(0, writer) + 'const writeGeometry = (width, height) => {\n\t\t\t\twidth = clampWidth(width);\n\t\t\t\tif (width > 0 && panelRef.current) panelRef.current.style.width = `${width}px`;\n\t\t\t\tdocument.documentElement.style.setProperty("--dsh-sidebar-width", `${width}px`);\n\t\t\t\t' + client.slice(heightWriter)
const drag = client.indexOf('const applyDrag = (width, height) => {')
const dragBody = client.indexOf('lastDragSize.current = {', drag)
if (drag < 0 || dragBody < 0) throw new Error('Missing drag writer')
client = client.slice(0, drag) + 'const applyDrag = (width, height) => {\n\t\t\t\twidth = clampWidth(width);\n\t\t\t\t' + client.slice(dragBody)
replaceUnique('width: narrow ? "100vw" : Math.min(state.width, window.innerWidth)', 'width: narrow ? "100vw" : clampWidth(state.width)', 'render width')
client = client.replaceAll('startWidth: state.width', 'startWidth: clampWidth(state.width)')
replaceUnique('(width - (state?.width ?? 0))', '(occupiedWidth - (state?.panelOpen === true ? clampWidth(state.width) : 0))', 'bottom edge effective width')
replaceUnique('writeGeometry(width, bottomPush);\n\t\t\t};', 'writeGeometry(occupiedWidth, bottomPush);\n\t\t\t};', 'closed right panel drag reservation')
replaceUnique('bottomRef.current?.style.setProperty("right", `${window.innerWidth - centerRectRef.current.right', 'const occupiedWidth = !narrow && state?.panelOpen === true ? width : 0;\n\t\t\t\tbottomRef.current?.style.setProperty("right", `${window.innerWidth - centerRectRef.current.right', 'occupied width declaration')
client = client.replaceAll('min(max(var(--dsh-sidebar-width, 0px), 0px), calc(100% - 400px))', 'var(--dsh-sidebar-width, 0px)')
client = client.replaceAll('min(max(var(--dsh-sidebar-width,0px),0px),calc(100% - 400px))', 'var(--dsh-sidebar-width,0px)')
replaceUnique('writeGeometry(width, bottomPush);\n\t\t\t}, [', 'const syncGeometry = () => writeGeometry(width, bottomPush);\n\t\t\t\tsyncGeometry();\n\t\t\t\twindow.addEventListener("dsh:layout-context", syncGeometry);\n\t\t\t\treturn () => window.removeEventListener("dsh:layout-context", syncGeometry);\n\t\t\t}, [', 'layout context subscription')
// 2026-09-17：§10.3 第 6 条「补丁脚本硬要求」补上**结构自证** —— 写入前先证明变换后的产物能解析。
// 教训：手工编辑 live 制品曾写坏一次（多一个 `}` ⇒ 宿主拼接的整串客户端脚本解析失败 ⇒ 73 个插件全
// import failed）。锚点命中数守卫挡不住这类错，所以这里直接对**即将落盘的字符串**做经典脚本解析门禁，
// 不通过就抛错、绝不写盘 —— 本脚本从此不可能把坏串写进去。
client = transformSidechatComponentCompat(client)
const geometrySources = Object.fromEntries(await Promise.all(WORKBENCH_GEOMETRY_FILES.map(async (path) => [
  path,
  path === 'Data/DSH/profiles/web/local/dsh-better-sidebar/lib/client.js' ? client : await readFile(resolve(path), 'utf8'),
])))
const geometryFailures = findWorkbenchGeometryViolations(geometrySources)
if (geometryFailures.length > 0) {
  throw new Error(`Workbench geometry conflict; refusing to write: ${geometryFailures.join(' | ')}`)
}
try {
  new Script(client, { filename: file })
} catch (error) {
  throw new Error(`transformed client.js does not parse; refusing to write: ${error.message}`)
}
if (process.argv.includes('--check')) {
  console.log('Sidebar host layout compatibility and workbench geometry checks passed; no files written')
  process.exit(0)
}
await writeFile(file, client)
await writeFile(resolve('Data/DSH/profiles/web/local/dsh-better-sidebar/src/client/portable-geometry.ts'), '// Generated from src/workbench-geometry.ts; do not edit.\n' + geometrySource)
console.log('Updated local sidebar host layout compatibility')
