import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// 顶栏「设置」按钮在 0.2 内核下彻底失灵的真实原因（2026-09-29 实机取证）：
//   ① 客户端不再监听 dsh-action 的 settings 分支 —— 同一通道的 toggle-sidebar 仍生效
//      （侧栏 240px → 56px），唯独 settings 无任何反应，所以不是通道断了，是分支没了；
//   ② 壳内 dshSettingsDialogVisible 唯一的写入方是 dsh-shell:dsh-settings-visibility 上报，
//      该通道在 codex-ui 1.1.x + 0.2 下无发送方 ⇒ 标志位恒 false，「开关」逻辑永不触发。
// 修法：设置页的开关与判可见性全部改走 DSH 页面自己的控件（返回应用 / 侧栏设置触发器），
// 由壳直接驱动，壳内标志位以 DOM 为准回校。判据取「dcu-settings-back 是否在 DOM 里」——
// 实测关闭时 count=0、打开时 count=1，比 offsetParent 硬（触发器自身 offsetParent 恒为 null）。

const mainSource = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8')

/** 反引号常量体到"闭引号 + 换行"为止；`[^]` 跨行，不依赖 \s\S 转义。 */
function extractConst(name: string): string {
  const match = new RegExp('const ' + name + ' = `([^]*?)`\r?\n').exec(mainSource)
  assert.notEqual(match, null, 'src/main.ts 里找不到常量 ' + name)
  return match![1]!
}

/** 单引号常量（选择器）取值。 */
function extractSelector(name: string): string {
  const match = new RegExp("const " + name + " = '([^']*)'").exec(mainSource)
  assert.notEqual(match, null, 'src/main.ts 里找不到选择器 ' + name)
  return match![1]!
}

const backSelector = extractSelector('DSH_SETTINGS_BACK_SELECTOR')
const triggerSelector = extractSelector('DSH_SETTINGS_TRIGGER_SELECTOR')

/** 用最小 document 桩跑注入脚本：只实现脚本真正用到的那两个查询方法。
 *  选择器按 src/main.ts 里的真值传入，顺带把"壳点的是不是 DSH 真正的控件"也钉住。 */
function runToggle(options: { back: boolean; trigger: boolean }): { result: string; clicked: string[] } {
  const clicked: string[] = []
  const elements = new Map<string, { click: () => void }>()
  if (options.back) elements.set(backSelector, { click: () => clicked.push('back') })
  if (options.trigger) elements.set(triggerSelector, { click: () => clicked.push('trigger') })
  const document = {
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: (selector: string) => (elements.has(selector) ? [elements.get(selector)] : []),
  }
  // 常量本体是模板字面量，里面用 ${JSON.stringify(选择器)} 注入选择器；先按它本来的
  // 形态求值出脚本文本，再拿桩 document 跑它。选择器传真值，顺带钉住"壳点的是 DSH 真控件"。
  const body = new Function('DSH_SETTINGS_BACK_SELECTOR', 'DSH_SETTINGS_TRIGGER_SELECTOR',
    'return `' + extractConst('TOGGLE_DSH_SETTINGS_PAGE_SCRIPT') + '`')(backSelector, triggerSelector) as string
  const run = new Function('document', 'return ' + body) as (doc: unknown) => string
  return { result: run(document), clicked }
}

test('选择器指向 DSH 设置页自己的控件，不是壳臆造的类名', () => {
  assert.match(backSelector, /dcu-settings-back/)
  assert.match(triggerSelector, /dcu-settings-trigger/)
})

test('设置页已打开时切换动作为点「返回应用」，不是点触发器', () => {
  const { result, clicked } = runToggle({ back: true, trigger: true })
  assert.equal(result, 'closed')
  assert.deepEqual(clicked, ['back'])
})

test('设置页未打开时切换动作为点侧栏设置触发器', () => {
  const { result, clicked } = runToggle({ back: false, trigger: true })
  assert.equal(result, 'opened')
  assert.deepEqual(clicked, ['trigger'])
})

test('页面还没就位时切换是空操作，不误报成功', () => {
  const { result, clicked } = runToggle({ back: false, trigger: false })
  assert.equal(result, 'unavailable')
  assert.deepEqual(clicked, [])
})

test('可见性判据数的是 DOM 里的返回按钮，而不是它的可见性', () => {
  const script = extractConst('DSH_SETTINGS_OPEN_SCRIPT')
  assert.match(script, /querySelectorAll/)
  assert.match(script, /length > 0/)
  // 判据若退回 offsetParent，折叠侧栏里的触发器会把"已打开"读成 false。
  assert.doesNotMatch(script, /offsetParent/)
})

test('「设置」动作不再走 dsh-action 通道（该分支已被 0.2 客户端移除）', () => {
  const dispatch = /if \(id === 'new-chat'[^\n]*\n/.exec(mainSource)
  assert.notEqual(dispatch, null, '找不到 sendDshAction 的动作白名单')
  assert.doesNotMatch(dispatch![0], /'settings'/)
  // 开关本体在主进程就地驱动，且必须以 DOM 判据为准，不许回退到标志位。
  assert.match(mainSource, /executeJavaScript\(TOGGLE_DSH_SETTINGS_PAGE_SCRIPT\)/)
})

test('浏览器面板让位不再被恒 false 的标志位挡住', () => {
  assert.equal((mainSource.match(/if \(dshSettingsDialogVisible\) exitDshSettingsPage\(\)/g) ?? []).length, 0)
  // 其余读标志位的地方只应剩下 ESC 路由与状态快照两处语义。
  assert.match(mainSource, /isDshSettingsDialogVisible: dshSettingsDialogVisible/)
})

test('ESC 关闭设置页回落到「返回应用」，0.2 的整页设置没有 role=dialog', () => {
  assert.match(mainSource, /if \(dismissed !== true\) exitDshSettingsPage\(\)/)
  assert.match(mainSource, /\.catch\(\(\) => exitDshSettingsPage\(\)\)/)
})

test('设置页判可见性后主动回校标志位，ESC 路由与让位逻辑才有真相源', () => {
  assert.match(mainSource, /async function isDshSettingsPageOpen\(\): Promise<boolean>/)
  assert.match(mainSource, /dshSettingsDialogVisible = open === true/)
})

test('开关脚本的返回值与调用方的判据必须逐字对齐（opened 不是 open）', () => {
  const script = extractConst('TOGGLE_DSH_SETTINGS_PAGE_SCRIPT')
  // 脚本实际会返回哪些值，是判据的唯一事实源：打开走 'opened'，不是 'open'。
  const returned = [...script.matchAll(/return '([a-z]+)'/g)].map(match => match[1]!)
  assert.ok(returned.includes('opened'), '脚本必须在打开时返回 opened')
  assert.ok(!returned.includes('open'), '脚本不应再返回 open，避免与 opened 并存')

  // 调用方逐个覆盖脚本的全部返回值：漏一个就意味着该分支下标志位被静默写错。
  const assign = /dshSettingsDialogVisible = outcome === ([^\n]+)\n/.exec(mainSource)
  assert.notEqual(assign, null, '找不到开关后的标志位回写')
  const compared = [...assign![1]!.matchAll(/'([a-z]+)'/g)].map(match => match[1]!)
  for (const value of ['closed', 'opened']) {
    assert.ok(compared.includes(value), `调用方必须把 '${value}' 也算作有效返回值`)
  }
})

// 2026-09-30 实机：顶栏打开设置页后按 ESC 关不掉。证据链是"标志位说没开、DOM 明明开着"——
// F11 能切全屏、Ctrl+B 能收边栏，证明按键确实到达 before-input-event 且过了 keyDown 守卫；
// 而 ESC 时 DOM 照常收到 keydown（没被 preventDefault 吞掉），说明 escapeRoute 判了 pass-through。
// 因此 ESC 必须以 DOM 为准，不能只信 dshSettingsDialogVisible。
test('ESC 关设置页以 DOM 为准，不能只信进程内标志位', () => {
  assert.match(
    mainSource,
    /async function dismissDshSettingsDialogWhenOpen\(\): Promise<void>[\s\S]*?if \(!await isDshSettingsPageOpen\(\)\) return[\s\S]*?dismissDshSettingsDialog\(\)/,
    '兜底函数必须先问 DOM（isDshSettingsPageOpen）再关，没开就空转',
  )
  // 兜底必须在标志位判据之外也接一次：否则标志位为 false 时 escapeRoute 走 pass-through，
  // 兜底根本没机会跑，ESC 依旧失效。
  const fallback = /if \(input\.key === 'Escape' && auxiliaryWindow === undefined && contents === mainWindow\?\.webContents\) \{\s*runMainTask\(dismissDshSettingsDialogWhenOpen\(\)\)/.exec(mainSource)
  assert.notEqual(fallback, null, '主壳上的 ESC 必须有无条件兜底，不能只挂在 escapeRoute 的标志位分支上')
  // 刻意不吞 ESC：设置页没开时 DSH 自身的 ESC 语义（关浮层、退输入态）必须原样透传。
  // 只看真实调用，注释里提到 preventDefault 不算数。
  const dismissBranch = /if \(route === 'dismiss-dsh-settings'\) \{([\s\S]*?)\n    \}/.exec(mainSource)
  assert.notEqual(dismissBranch, null, '找不到 dismiss-dsh-settings 分支')
  const dismissCode = dismissBranch![1]!.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  assert.ok(
    !dismissCode.includes('preventDefault'),
    '关设置页不得吞掉 ESC，否则会破坏 DSH 页面自身的 ESC 行为',
  )
})
