export type ShellMenuId = 'file' | 'edit' | 'view' | 'help'

export type ShellActionId =
  | 'new-chat'
  | 'open-folder'
  | 'close-window'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'delete'
  | 'select-all'
  | 'desktop-settings'
  | 'settings'
  | 'app-restart'
  | 'toggle-sidebar'
  | 'find'
  | 'previous-chat'
  | 'next-chat'
  | 'home'
  | 'back'
  | 'forward'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'toggle-fullscreen'
  | 'toggle-devtools'
  | 'whats-new'
  | 'feedback'
  | 'show-shortcuts'
  | 'reload'
  | 'check-updates'
  | 'about'
  | 'feature-panels'

export interface LocalizedText {
  readonly en: string
  readonly zh: string
}

export interface ShellActionDefinition {
  readonly accelerator?: string
  readonly macAccelerator?: string
  readonly globalShortcut?: boolean
  readonly group: number
  readonly id: ShellActionId
  readonly keywords?: LocalizedText
  readonly label: LocalizedText
  readonly menu: ShellMenuId
}

export interface LocalizedShellAction extends Omit<ShellActionDefinition, 'keywords' | 'label'> {
  readonly acceleratorLabel?: string
  readonly keywords: string
  readonly label: string
}

export interface LocalizedShellMenu {
  readonly id: ShellMenuId
  readonly label: string
}

const text = (zh: string, en: string): LocalizedText => ({ zh, en })

export const SHELL_MENUS: readonly { readonly id: ShellMenuId; readonly label: LocalizedText }[] = [
  { id: 'file', label: text('文件', 'File') },
  { id: 'edit', label: text('编辑', 'Edit') },
  { id: 'view', label: text('视图', 'View') },
  { id: 'help', label: text('帮助', 'Help') },
]

/**
 * 菜单栏动作注册表（2026-09-29 去重后）。
 *
 * 本表只决定"菜单里出现什么"。`ShellActionId` 与 `executeShellAction` 的分发分支
 * 是另一回事——从设置窗口、关于窗口、顶栏按钮发起的同名动作不查这张表，
 * 所以下线条目不等于删除能力。
 *
 * ⚠️ 但"不查这张表"不等于"不受这张表影响"：这些动作仍要过 `SHELL_ACTION_IDS`
 * 白名单才能到达 `executeShellAction`。本轮去重时正是漏了那一步，导致顶栏「设置」
 * 静默失灵（详见 `SHELL_ACTION_IDS` 的注释与 `test/shell-actions.test.ts`）。
 *
 * 已下线的重复/无关项及各自仍然有效的入口：
 * - 桌面端设置 / DSH 设置：设置页内已有对应板块，顶栏 `#settings-btn` 也能开设置。
 * - 检查更新…：设置窗口「更新」页（`settings.html` 的 `updatesNav`）。
 * - 新功能 / 反馈：关于窗口的「查看新功能」「问题反馈」按钮。
 * - 重新加载：回收整个 DSH 运行时；顶栏「重启应用」按钮与托盘右键菜单是同类入口，且它不属于「帮助」。
 *
 * 「功能板块」一度也被移除，但 `test/feature-panels.test.ts` 明写"任何实例（含打包态）都必须含
 * 功能板块"、称其为"用户日常功能索引"，与本轮"只去重、不砍能力"的口径冲突，故保留。
 * 它的头部注释（`src/feature-panels.ts`）仍写"开发态可见的源码索引面板"，两处口径待用户拍板。
 */
export const SHELL_ACTIONS: readonly ShellActionDefinition[] = [
  { id: 'new-chat', menu: 'file', group: 0, label: text('新聊天', 'New Chat'), accelerator: 'CmdOrCtrl+N', globalShortcut: true, keywords: text('新建任务 会话', 'new task session') },
  { id: 'open-folder', menu: 'file', group: 0, label: text('打开文件夹…', 'Open Folder…'), accelerator: 'CmdOrCtrl+O', globalShortcut: true, keywords: text('新建项目 工作区 目录', 'new project workspace directory') },
  { id: 'close-window', menu: 'file', group: 1, label: text('关闭', 'Close'), accelerator: 'CmdOrCtrl+W', globalShortcut: true, keywords: text('最小化 托盘 隐藏', 'minimize tray hide') },
  { id: 'app-restart', menu: 'file', group: 2, label: text('重启应用', 'Restart App'), keywords: text('完全关闭 重启', 'full quit restart') },
  { id: 'quit', menu: 'file', group: 2, label: text('退出', 'Quit'), accelerator: 'CmdOrCtrl+Q', globalShortcut: true, keywords: text('彻底退出 关闭软件', 'exit application') },

  { id: 'undo', menu: 'edit', group: 0, label: text('撤销', 'Undo'), accelerator: 'CmdOrCtrl+Z' },
  { id: 'redo', menu: 'edit', group: 0, label: text('重做', 'Redo'), accelerator: 'CmdOrCtrl+Y', macAccelerator: 'CmdOrCtrl+Shift+Z' },
  { id: 'cut', menu: 'edit', group: 1, label: text('剪切', 'Cut'), accelerator: 'CmdOrCtrl+X' },
  { id: 'copy', menu: 'edit', group: 1, label: text('复制', 'Copy'), accelerator: 'CmdOrCtrl+C' },
  { id: 'paste', menu: 'edit', group: 1, label: text('粘贴', 'Paste'), accelerator: 'CmdOrCtrl+V' },
  { id: 'delete', menu: 'edit', group: 1, label: text('删除', 'Delete') },
  { id: 'select-all', menu: 'edit', group: 2, label: text('全选', 'Select All'), accelerator: 'CmdOrCtrl+A' },

  { id: 'toggle-sidebar', menu: 'view', group: 0, label: text('切换边栏', 'Toggle Sidebar'), accelerator: 'CmdOrCtrl+B', globalShortcut: true },
  { id: 'find', menu: 'view', group: 1, label: text('查找', 'Find'), accelerator: 'CmdOrCtrl+F', globalShortcut: true, keywords: text('搜索会话', 'search sessions') },
  { id: 'previous-chat', menu: 'view', group: 2, label: text('上一个聊天', 'Previous Chat'), accelerator: 'CmdOrCtrl+Shift+[', globalShortcut: true },
  { id: 'next-chat', menu: 'view', group: 2, label: text('下一个聊天', 'Next Chat'), accelerator: 'CmdOrCtrl+Shift+]', globalShortcut: true },
  { id: 'home', menu: 'view', group: 2, label: text('主页', 'Home'), accelerator: 'Alt+Home', globalShortcut: true, keywords: text('deepseek 首页', 'deepseek homepage') },
  { id: 'back', menu: 'view', group: 2, label: text('返回', 'Back'), accelerator: 'CmdOrCtrl+[', globalShortcut: true },
  { id: 'forward', menu: 'view', group: 2, label: text('前进', 'Forward'), accelerator: 'CmdOrCtrl+]', globalShortcut: true },
  { id: 'zoom-in', menu: 'view', group: 3, label: text('放大', 'Zoom In'), accelerator: 'CmdOrCtrl+Shift+Plus', globalShortcut: true },
  { id: 'zoom-out', menu: 'view', group: 3, label: text('缩小', 'Zoom Out'), accelerator: 'CmdOrCtrl+-', globalShortcut: true },
  { id: 'zoom-reset', menu: 'view', group: 3, label: text('实际大小', 'Actual Size'), accelerator: 'CmdOrCtrl+0', globalShortcut: true },
  { id: 'toggle-fullscreen', menu: 'view', group: 4, label: text('切换全屏', 'Toggle Full Screen'), accelerator: 'F11', globalShortcut: true },
  { id: 'toggle-devtools', menu: 'view', group: 5, label: text('开发者工具', 'Developer Tools'), accelerator: 'F12', macAccelerator: 'CmdOrCtrl+Alt+I', globalShortcut: true, keywords: text('开发者模式 调试 控制台 网络 检查元素', 'developer mode debug console network inspect') },
  { id: 'feature-panels', menu: 'view', group: 5, label: text('功能板块', 'Feature Panels'), keywords: text('开发 索引 模块 面板 文件 路径', 'dev index module file path') },

  { id: 'show-shortcuts', menu: 'help', group: 0, label: text('显示键盘快捷键', 'Show Keyboard Shortcuts'), accelerator: 'CmdOrCtrl+/', globalShortcut: true, keywords: text('按键 命令', 'keys commands') },
  { id: 'about', menu: 'help', group: 1, label: text('关于 DSH Codex Desktop', 'About DSH Codex Desktop') },
]

/**
 * 可从壳内直接发起的动作 id 白名单 —— 与上面的菜单表刻意分开维护。
 *
 * 菜单表只决定"菜单栏出现什么"；顶栏按钮、设置窗口、关于窗口、托盘菜单都是按 id
 * 直接分发，它们不查菜单表，却都要过 main.ts 的 `shellActionIds` 这道白名单
 * （`ipcMain.handle(SHELL_IPC.action)` 里 `!shellActionIds.has(id)` 直接 return）。
 *
 * 2026-09-29 实机事故：菜单去重把 desktop-settings / settings / check-updates /
 * whats-new / feedback / reload 一并从菜单表删掉，白名单跟着缩小，顶栏「设置」按钮
 * 点击后在 IPC 入口被静默丢弃 —— 控件还在、能力还在、executeShellAction 的分支也还在，
 * 但点了没反应且**没有任何报错**。凡是"有 UI 入口的动作"都必须登记在这里，与它是否
 * 出现在菜单里无关。
 */
export const SHELL_ACTION_IDS: ReadonlySet<string> = new Set<string>([
  ...SHELL_ACTIONS.map(action => action.id),
  'desktop-settings',
  'settings',
  'check-updates',
  'whats-new',
  'feedback',
  'reload',
])

export function isChineseLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith('zh')
}

export function normalizeShellLocale(value: unknown): 'zh' | 'en' | undefined {
  if (typeof value !== 'string') return undefined
  const primary = value.trim().toLowerCase().split('-')[0]
  return primary === 'zh' || primary === 'en' ? primary : undefined
}

export function formatAccelerator(accelerator: string, platform: NodeJS.Platform): string {
  return accelerator
    .replace('CmdOrCtrl', platform === 'darwin' ? 'Cmd' : 'Ctrl')
    .replace('Shift+Plus', 'Shift+=')
}

export function localizedShellMenus(locale: string): LocalizedShellMenu[] {
  const chinese = isChineseLocale(locale)
  return SHELL_MENUS.map(menu => ({ id: menu.id, label: chinese ? menu.label.zh : menu.label.en }))
}

export function localizedShellActions(locale: string, platform: NodeJS.Platform): LocalizedShellAction[] {
  const chinese = isChineseLocale(locale)
  return SHELL_ACTIONS.map(action => {
    const accelerator = platform === 'darwin' ? action.macAccelerator ?? action.accelerator : action.accelerator
    return {
      ...action,
      ...(accelerator === undefined ? {} : { accelerator }),
      label: chinese ? action.label.zh : action.label.en,
      keywords: chinese ? action.keywords?.zh ?? '' : action.keywords?.en ?? '',
      ...(accelerator === undefined ? {} : { acceleratorLabel: formatAccelerator(accelerator, platform) }),
    }
  })
}

interface ShortcutInput {
  readonly alt: boolean
  readonly control: boolean
  readonly key: string
  readonly meta: boolean
  readonly shift: boolean
}

function acceleratorMatches(accelerator: string, input: ShortcutInput, platform: NodeJS.Platform): boolean {
  const parts = accelerator.split('+')
  const expectedKey = parts.at(-1)?.toLowerCase()
  const cmdOrCtrl = parts.includes('CmdOrCtrl')
  const expectedControl = cmdOrCtrl && platform !== 'darwin'
  const expectedMeta = cmdOrCtrl && platform === 'darwin'
  if (input.control !== expectedControl || input.meta !== expectedMeta) return false
  if (input.alt !== parts.includes('Alt') || input.shift !== parts.includes('Shift')) return false
  const key = input.key.toLowerCase()
  if (expectedKey === 'plus') return key === '=' || key === '+'
  return key === expectedKey
}

export function shellActionForShortcut(input: ShortcutInput, platform: NodeJS.Platform): ShellActionId | undefined {
  return SHELL_ACTIONS.find(action => action.globalShortcut === true
    && (platform === 'darwin' ? action.macAccelerator ?? action.accelerator : action.accelerator) !== undefined
    && acceleratorMatches((platform === 'darwin' ? action.macAccelerator ?? action.accelerator : action.accelerator)!, input, platform))?.id
}
