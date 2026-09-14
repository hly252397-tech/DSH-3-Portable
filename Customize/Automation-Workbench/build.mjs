import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 0.1.38（2026-09-11 矩阵升级）：三锚点逐项核对原样存在；图标导出 IconAlarmClockOutline16 已改名，
// 换用该 bundle 唯一绑定的 IconListPenOutline16（列表笔，工作台入口语义可接受）后重钉
// 0.1.40（2026-09-12 市场矩阵升级）：新增 maxConcurrentRuns 表单字段、调度粒度 5→1 分钟、
// 日程表单重构——四锚点（apply/runtime/closeSettings 返回行/IconListPenOutline16）逐项核对
// 原样存在且 import_react11 别名未漂移，与工作台挂接面无关，重钉
// 0.1.42（2026-09-14 随包矩阵对齐上游 v1.0.60，经用户明确授权）：三锚点
// apply / runtime / 原生页面返回行逐项核对各出现 1 次、import_react11 别名未漂移、
// PORTABLE_AUTOMATION_WORKBENCH / data-daw-launcher / installPortableAutomationWorkbench
// 零残留，与工作台挂接面无关，重钉（旧锚点 0.1.40 = 9319c634…，实测 0.1.42 = b4839315…）。
export const upstreamHash = 'b4839315c00b1a4b7f6a17de58e5a9b1f6cc1b274bb5e63fac9875807582ea67'
const begin = '// PORTABLE_AUTOMATION_WORKBENCH_BEGIN\n'
const end = '// PORTABLE_AUTOMATION_WORKBENCH_END\n'
const applyAnchor = 'function apply(ctx) {'
const runtimeAnchor = '  const runtime = createAutomationRuntime(ctx.connection.rpc);'
const installLine = '\n  const portableWorkbench = installPortableAutomationWorkbench(ctx, { React: import_react11, createPortal: import_react_dom.createPortal, View: AutomationView, runtime, t, permissionT, modelT, Icon: import_dsh_client_ui_primitives2.IconListPenOutline16 });'
const oldPage = 'return (0, import_react11.createElement)(AutomationView, { t, permissionT, modelT, runtime, ...props.close === void 0 ? {} : { closeSettings: props.close } });'
const newPage = 'return (0, import_react11.createElement)(portableWorkbench.SettingsLink, { close: props.close });'
export const sha256 = source => createHash('sha256').update(source).digest('hex')

// Retired by I023/31: this legacy build entry now restores the single native
// scheduled-tasks page. Never inject workbench.js or its footer launcher again.
export function buildWorkbench(source, _extension) {
  if (source.includes(begin)) {
    const start = source.indexOf(begin), finish = source.indexOf(end, start);
    if (finish < 0) throw new Error('Incomplete automation workbench patch')
    source = source.slice(0, start) + source.slice(finish + end.length)
    source = source.replace(installLine, '').replace(newPage, oldPage)
  }
  if (sha256(source) !== upstreamHash) throw new Error('Unsupported automation client: review upstream version and interface before applying this customization')
  for (const anchor of [applyAnchor, runtimeAnchor, oldPage]) {
    if (source.split(anchor).length !== 2) throw new Error('Automation contract anchor missing or ambiguous')
  }
  return source
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) throw new Error('Usage: node Customize/Automation-Workbench/build.mjs <verified-input-client.js> <candidate-client.js>')
  const extension = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), 'workbench.js'), 'utf8')
  const source = await readFile(resolve(input), 'utf8')
  const generated = buildWorkbench(source, extension)
  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(resolve(output), generated, 'utf8')
  console.log(JSON.stringify({ upstreamHash, output: resolve(output), outputHash: sha256(generated) }))
}
