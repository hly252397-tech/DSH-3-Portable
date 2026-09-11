import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 0.1.38（2026-09-11 矩阵升级）：三锚点逐项核对原样存在；图标导出 IconAlarmClockOutline16 已改名，
// 换用该 bundle 唯一绑定的 IconListPenOutline16（列表笔，工作台入口语义可接受）后重钉
export const upstreamHash = '21fefb6ce8b9e6bb7d3ae0302e41e817630a708edfe7bb294cf918781b706ad1'
const begin = '// PORTABLE_AUTOMATION_WORKBENCH_BEGIN\n'
const end = '// PORTABLE_AUTOMATION_WORKBENCH_END\n'
const applyAnchor = 'function apply(ctx) {'
const runtimeAnchor = '  const runtime = createAutomationRuntime(ctx.connection.rpc);'
const installLine = '\n  const portableWorkbench = installPortableAutomationWorkbench(ctx, { React: import_react11, createPortal: import_react_dom.createPortal, View: AutomationView, runtime, t, permissionT, modelT, Icon: import_dsh_client_ui_primitives2.IconListPenOutline16 });'
const oldPage = 'return (0, import_react11.createElement)(AutomationView, { t, permissionT, modelT, runtime, ...props.close === void 0 ? {} : { closeSettings: props.close } });'
const newPage = 'return (0, import_react11.createElement)(portableWorkbench.SettingsLink, { close: props.close });'
export const sha256 = source => createHash('sha256').update(source).digest('hex')

export function buildWorkbench(source, extension) {
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
  return source.replace(applyAnchor, begin + extension + '\n' + end + applyAnchor)
    .replace(runtimeAnchor, runtimeAnchor + installLine).replace(oldPage, newPage)
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
