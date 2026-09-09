/**
 * 功能板块注册表：开发态可见的源码索引面板。
 *
 * 每个条目对应 `docs/00-交接入口/07-功能清单.md` 的一行；面板按"视觉板块"重切，
 * 让维护者直接知道"想改某段 UI/行为，先打开哪个文件"。
 *
 * 数据是手工维护的——自动从 AST 抽取会变成"全量模块清单"噪音，违背"功能板块"的本意。
 * 任何新增/修改/下线条目，必须同步更新 `07-功能清单.md`。
 */
import type { LocalizedText } from './shell-actions.js'

export type FeaturePanelCategoryId =
  | 'sidebar'        // 左侧栏：DSH Logo、侧栏、侧栏插件
  | 'shell'          // 顶部外壳：标题栏、菜单、状态、按钮
  | 'settings'       // 设置面板：桌面端设置、DSH 设置
  | 'browser'        // 内置浏览器面板
  | 'cards'          // 侧边卡片/工作台
  | 'lifecycle'      // 启动/更新/重启/A-B/便携
  | 'plugins'        // 运行时插件（官方 + 社区）
  | 'profile'        // Profile/工具链/测试/本地模型

export interface FeaturePanel {
  /** 稳定 id，与 07-功能清单.md 编号一一对应（P01..P74 + P75=本面板自身） */
  readonly id: string
  readonly name: LocalizedText
  /** 仓库内相对路径；可点击复制 */
  readonly file: string
  readonly description: LocalizedText
  /** 跳转提示：相关迭代记录或参考 */
  readonly notes?: string
}

export interface FeaturePanelCategory {
  readonly id: FeaturePanelCategoryId
  readonly label: LocalizedText
  readonly hint: LocalizedText
}

const text = (zh: string, en: string): LocalizedText => ({ zh, en })

export const FEATURE_PANEL_CATEGORIES: readonly FeaturePanelCategory[] = [
  { id: 'sidebar', label: text('左侧栏', 'Sidebar'), hint: text('DSH 启动后左侧会话栏与本地插件入口', 'DSH left sidebar and local plugin entries') },
  { id: 'shell', label: text('顶部外壳', 'Top Shell'), hint: text('标题栏、菜单、状态、按钮、弹窗', 'Titlebar, menus, status, buttons, popups') },
  { id: 'settings', label: text('设置与对话框', 'Settings & Dialogs'), hint: text('桌面端设置、DSH 设置、主题、通知', 'Desktop settings, DSH settings, theme, notifications') },
  { id: 'browser', label: text('内置浏览器', 'Built-in Browser'), hint: text('右侧标签页/地址栏/资料库/扩展', 'Right-side tabs, address bar, library, extensions') },
  { id: 'cards', label: text('侧边卡片', 'Sidebar Cards'), hint: text('better-sidebar 卡片与工作台', 'better-sidebar cards and workbench') },
  { id: 'lifecycle', label: text('启动与更新', 'Startup & Update'), hint: text('主进程生命周期、A-B 更新、便携部署', 'Main lifecycle, A-B updates, portable deployment') },
  { id: 'plugins', label: text('运行时插件', 'Runtime Plugins'), hint: text('官方与社区 DSH 插件', 'Official and community DSH plugins') },
  { id: 'profile', label: text('Profile 与工具链', 'Profile & Tooling'), hint: text('测试套件、Ollama 接入、工具脚本', 'Test suite, Ollama, tooling scripts') },
]

export const FEATURE_PANELS: readonly { panel: FeaturePanel; categoryId: FeaturePanelCategoryId }[] = [
  // ─── sidebar ──────────────────────────────────────────────────────────
  { categoryId: 'sidebar', panel: { id: 'P24', name: text('桥接客户端注入', 'Bridge Client Inject'), file: 'src/desktop-bridge-client-source.ts', description: text('向 DSH 注入桌面端能力；双击 DSH Logo 切换侧栏', 'Inject desktop capabilities into DSH; double-click DSH logo toggles sidebar') } },
  { categoryId: 'sidebar', panel: { id: 'P28', name: text('DSH 视图预加载', 'DSH View Preload'), file: 'src/dsh-view-preload.cts', description: text('DSH WebContentsView 预加载脚本；侧栏最大宽度固定 252 px', 'DSH WebContentsView preload; sidebar max width fixed at 252 px') } },
  { categoryId: 'sidebar', panel: { id: 'P64', name: text('知识库搜索', 'Knowledge Base'), file: 'Data/DSH/profiles/web/local/dsh-sidebar-spaces', description: text('知识库/数据库跨库搜索、表格与 ECharts 分析', 'KB / database cross-search, tables, ECharts analysis') } },
  { categoryId: 'sidebar', panel: { id: 'P65', name: text('重启应用按钮', 'Restart Button'), file: 'Data/DSH/profiles/web/local/dsh-restart-button', description: text('左侧栏底部「重启应用」按钮', 'Sidebar bottom "Restart App" button') } },
  { categoryId: 'sidebar', panel: { id: 'P66', name: text('工作模式配置', 'Work Mode'), file: 'Data/DSH/profiles/web/local/dsh-work-mode', description: text('设置内保留默认模式及会话档位记录', 'Settings preserves default mode and session tier') } },
  { categoryId: 'sidebar', panel: { id: 'P54', name: text('Codex 风格侧栏 UI', 'Codex-style Sidebar UI'), file: 'Data/DSH/profiles/web/node_modules/@michengai/dsh-codex-ui', description: text('侧栏重构、扩展页、技能包展示', 'Sidebar rebuild, extensions page, skills showcase') } },

  // ─── shell ────────────────────────────────────────────────────────────
  { categoryId: 'shell', panel: { id: 'P35', name: text('外壳 IPC 契约', 'Shell IPC Contract'), file: 'src/shell-contract.ts', description: text('外壳状态/动作类型定义', 'Shell state/action type definitions') } },
  { categoryId: 'shell', panel: { id: 'P36', name: text('外壳动作定义', 'Shell Action Definition'), file: 'src/shell-actions.ts', description: text('外壳动作与本地化（菜单/快捷键）', 'Shell actions & i18n (menus / shortcuts)') } },
  { categoryId: 'shell', panel: { id: 'P37', name: text('外壳 IPC 安全策略', 'Shell IPC Policy'), file: 'src/shell-ipc-policy.ts', description: text('按 ShellRendererKind 限制 IPC 授权', 'Gate IPC by ShellRendererKind') } },
  { categoryId: 'shell', panel: { id: 'P38', name: text('外壳预加载脚本', 'Shell Preload'), file: 'src/shell-preload.cts', description: text('通过 contextBridge 暴露 dshShell API', 'Expose dshShell via contextBridge') } },
  { categoryId: 'shell', panel: { id: 'P30', name: text('窗口状态持久化', 'Window State'), file: 'src/window-state.ts', description: text('窗口位置/大小记忆', 'Persist window position/size') } },
  { categoryId: 'shell', panel: { id: 'P31', name: text('窗口导航协调', 'Window Navigation'), file: 'src/window-navigation.ts', description: text('窗口内导航协调', 'Window navigation coordination') } },
  { categoryId: 'shell', panel: { id: 'P32', name: text('窗口图标替换', 'Window Icon'), file: 'src/window-icon.ts', description: text('窗口/favicon 图标替换', 'Window/favicon icon replacement') } },
  { categoryId: 'shell', panel: { id: 'P33', name: text('URL 白名单', 'URL Allowlist'), file: 'src/navigation.ts', description: text('URL 白名单/导航策略', 'URL allowlist / nav policy') } },
  { categoryId: 'shell', panel: { id: 'P34', name: text('外链逃生路由', 'Escape Routing'), file: 'src/escape-routing.ts', description: text('外链/快捷键/弹窗关闭的统一路由', 'Unified routing for external links/shortcuts/popup close') } },

  // ─── settings ─────────────────────────────────────────────────────────
  { categoryId: 'settings', panel: { id: 'P41', name: text('全局桌面主题', 'Desktop Theme'), file: 'src/desktop-theme.ts', description: text('浅色主界面、侧栏、设置与外壳底色统一', 'Unified light surfaces for main, sidebar, settings, shell') } },
  { categoryId: 'settings', panel: { id: 'P42', name: text('Windows Toast 通知', 'Windows Toast'), file: 'src/desktop-notifications.ts', description: text('Windows 通知集成', 'Windows notification integration') } },
  { categoryId: 'settings', panel: { id: 'P43', name: text('桌面应用更新', 'Desktop Updater'), file: 'src/desktop-updater.ts', description: text('桌面应用更新检查', 'Desktop update check') } },
  { categoryId: 'settings', panel: { id: 'P44', name: text('便携模式路径重定向', 'Portable Paths'), file: 'src/portable-paths.ts', description: text('便携模式路径计算', 'Portable path resolution') } },
  { categoryId: 'settings', panel: { id: 'P45', name: text('便携版 A-B 候选更新', 'Portable A-B Update'), file: 'src/portable-desktop-update.ts', description: text('便携版 A-B 更新机制', 'Portable A-B update mechanism') } },
  { categoryId: 'settings', panel: { id: 'P46', name: text('原子文件写入', 'Atomic File'), file: 'src/atomic-file.ts', description: text('原子文件写入避免损坏', 'Atomic file writes to avoid corruption') } },
  { categoryId: 'settings', panel: { id: 'P47', name: text('会话日志路径修复', 'Session Path Repair'), file: 'src/session-path-repair.ts', description: text('会话日志路径修复', 'Session log path repair') } },
  { categoryId: 'settings', panel: { id: 'P48', name: text('DSH Market 批量操作', 'DSH Market Batch'), file: 'src/dshmarket-batch.ts', description: text('插件市场批量操作节流', 'Market bulk operation throttling') } },

  // ─── browser ──────────────────────────────────────────────────────────
  { categoryId: 'browser', panel: { id: 'P39', name: text('浏览器面板布局', 'Browser Panel Layout'), file: 'src/browser-panel-layout.ts', description: text('卡片与顶部入口共用原生浏览器；挂载、定位、隐藏、设置/菜单遮挡', 'Cards & top entry share native browser; mount, position, hide, occlusion') } },
  { categoryId: 'browser', panel: { id: 'P40', name: text('浏览器面板预加载', 'Browser Panel Preload'), file: 'src/browser-panel-preload.cts', description: text('浏览器面板预加载', 'Browser panel preload') } },
  { categoryId: 'browser', panel: { id: 'P68', name: text('浏览器资料库', 'Browser Library'), file: 'browser-library.cjs', description: text('多标签、历史、书签、凭据、扩展导入', 'Multi-tab, history, bookmarks, credentials, extensions') } },

  // ─── cards ────────────────────────────────────────────────────────────
  { categoryId: 'cards', panel: { id: 'P61', name: text('侧边卡片与右侧工作台', 'Better Sidebar'), file: 'Data/DSH/profiles/web/node_modules/dsh-better-sidebar', description: text('保留文件、终端、源码、任务等卡片', 'Files, terminal, source, tasks cards preserved') } },

  // ─── lifecycle ────────────────────────────────────────────────────────
  { categoryId: 'lifecycle', panel: { id: 'P01', name: text('主进程入口', 'Main Entry'), file: 'src/main.ts', description: text('Electron 主进程启动、窗口、托盘、通知、主题、DSH 生命周期', 'Electron main: window, tray, notification, theme, DSH lifecycle') } },
  { categoryId: 'lifecycle', panel: { id: 'P02', name: text('应用标识', 'App Identity'), file: 'src/app-identity.ts', description: text('APP_NAME、UserModelID、ToastActivator', 'APP_NAME, UserModelID, ToastActivator') } },
  { categoryId: 'lifecycle', panel: { id: 'P03', name: text('应用退出逻辑', 'App Lifecycle'), file: 'src/app-lifecycle.ts', description: text('应用关闭/退出流程', 'App close/quit flow') } },
  { categoryId: 'lifecycle', panel: { id: 'P04', name: text('图标路径解析', 'App Icon'), file: 'src/app-icon.ts', description: text('托盘/任务栏/通知/ICO 图标路径解析', 'Tray/taskbar/notification/ICO icon paths') } },
  { categoryId: 'lifecycle', panel: { id: 'P05', name: text('启动进度百分比', 'Startup Progress'), file: 'src/startup-progress.ts', description: text('启动进度计算与展示', 'Startup progress calc & display') } },
  { categoryId: 'lifecycle', panel: { id: 'P06', name: text('运行时路径解析', 'Runtime Paths'), file: 'src/runtime.ts', description: text('DSH 运行时路径计算', 'DSH runtime path resolution') } },
  { categoryId: 'lifecycle', panel: { id: 'P07', name: text('A-B 运行时槽管理', 'Runtime Slots'), file: 'src/runtime-slots.ts', description: text('激活/提交/回滚运行时槽', 'Activate/commit/rollback runtime slots') } },
  { categoryId: 'lifecycle', panel: { id: 'P08', name: text('预构建运行时复制', 'Runtime Prebuilt'), file: 'src/runtime-prebuilt.ts', description: text('官方预构建运行时复制到本地', 'Copy official prebuilt runtime locally') } },
  { categoryId: 'lifecycle', panel: { id: 'P09', name: text('pnpm 布局解析', 'Pnpm Layout'), file: 'src/runtime-pnpm-layout.ts', description: text('pnpm 目录结构解析', 'pnpm layout parser') } },
  { categoryId: 'lifecycle', panel: { id: 'P10', name: text('运行时归档解压', 'Runtime Archive'), file: 'src/runtime-archive.ts', description: text('运行时压缩包解压（GNU/BSdTar 兼容）', 'Runtime archive extract (GNU/bsdtar compat)') } },
  { categoryId: 'lifecycle', panel: { id: 'P11', name: text('子进程运行时提取', 'Extract Runtime'), file: 'src/extract-runtime.ts', description: text('子进程方式提取运行时', 'Subprocess-based runtime extract') } },
  { categoryId: 'lifecycle', panel: { id: 'P12', name: text('运行时候选构建', 'Runtime Candidate'), file: 'src/harness-runtime-candidate.ts', description: text('DSH 运行时候选版本构建', 'Build DSH runtime candidate') } },
  { categoryId: 'lifecycle', panel: { id: 'P13', name: text('启动阴影验证', 'Harness Shadow'), file: 'src/harness-shadow.ts', description: text('启动过程阴影验证', 'Startup shadow validation') } },
  { categoryId: 'lifecycle', panel: { id: 'P14', name: text('运行时更新策略', 'Harness Update'), file: 'src/harness-update.ts', description: text('DSH 运行时更新逻辑', 'DSH runtime update logic') } },
  { categoryId: 'lifecycle', panel: { id: 'P69', name: text('一键构建脚本', 'Build Script'), file: 'Build-DSH-Portable.ps1', description: text('类型检查+测试+打包+候选暂存', 'Type check + test + package + candidate stash') } },
  { categoryId: 'lifecycle', panel: { id: 'P70', name: text('启动脚本', 'Start Script'), file: 'Start-DSH-Portable.ps1', description: text('候选验证+健康检查+启动', 'Candidate verify + health check + launch') } },
  { categoryId: 'lifecycle', panel: { id: 'P71', name: text('便携环境配置', 'Portable Environment'), file: 'Portable-Environment.ps1', description: text('便携环境变量设置', 'Portable env vars') } },
  { categoryId: 'lifecycle', panel: { id: 'P72', name: text('健康检查', 'Health Check'), file: 'Check-DSH-Health.cmd', description: text('应用健康状态检查', 'App health check') } },

  // ─── plugins ──────────────────────────────────────────────────────────
  { categoryId: 'plugins', panel: { id: 'P22', name: text('桌面端宿主服务', 'Desktop Host'), file: 'src/desktop-host.ts', description: text('插件安装/卸载 pnpm 桥接', 'Plugin install/uninstall pnpm bridge') } },
  { categoryId: 'plugins', panel: { id: 'P23', name: text('桌面桥接插件', 'Desktop Bridge'), file: 'src/desktop-bridge.mts', description: text('向 DSH 注入桌面端能力', 'Inject desktop capabilities into DSH') } },
  { categoryId: 'plugins', panel: { id: 'P25', name: text('DSH 子进程管理', 'DSH Process'), file: 'src/dsh-process.ts', description: text('DSH 子进程启动/停止', 'DSH subprocess start/stop') } },
  { categoryId: 'plugins', panel: { id: 'P26', name: text('DSH 引导脚本', 'DSH Bootstrap'), file: 'src/dsh-bootstrap.mts', description: text('DSH 引导逻辑', 'DSH bootstrap logic') } },
  { categoryId: 'plugins', panel: { id: 'P27', name: text('会话 Cookie 清理', 'Session Cookies'), file: 'src/dsh-session-cookies.ts', description: text('DSH 会话 Cookie 清理', 'DSH session cookie cleanup') } },
  { categoryId: 'plugins', panel: { id: 'P29', name: text('进程树终止', 'Process Control'), file: 'src/process-control.ts', description: text('进程树安全终止', 'Process tree safe termination') } },
  { categoryId: 'plugins', panel: { id: 'P15', name: text('插件清单定义', 'Bundled Plugins'), file: 'src/bundled-plugins.ts', description: text('所有官方+社区插件版本定义', 'Official + community plugin version map') } },
  { categoryId: 'plugins', panel: { id: 'P16', name: text('插件首次补种', 'Plugin Seed'), file: 'src/plugin-seed.ts', description: text('插件首次安装到 profile', 'First-time plugin seed into profile') } },
  { categoryId: 'plugins', panel: { id: 'P17', name: text('pnpm 工具链路径', 'Plugin Toolchain'), file: 'src/plugin-toolchain.ts', description: text('pnpm 工具链/商店路径解析', 'pnpm toolchain/store path resolution') } },
  { categoryId: 'plugins', panel: { id: 'P18', name: text('Profile 自修复', 'Profile Repair'), file: 'src/profile-repair.ts', description: text('Profile 损坏自动修复', 'Auto-repair corrupted profile') } },
  { categoryId: 'plugins', panel: { id: 'P19', name: text('Profile 隔离检疫', 'Profile Quarantine'), file: 'src/profile-quarantine.ts', description: text('问题 Profile 隔离', 'Quarantine bad profiles') } },
  { categoryId: 'plugins', panel: { id: 'P20', name: text('待应用插件更新', 'Profile Updates'), file: 'src/profile-updates.ts', description: text('插件更新管理', 'Pending plugin updates') } },
  { categoryId: 'plugins', panel: { id: 'P21', name: text('Profile 文件监控', 'Profile Watch'), file: 'src/profile-watch.ts', description: text('Profile 文件变化监控', 'Profile file watcher') } },

  // 官方 DSH 运行时插件（功能清单 #49-#53）
  { categoryId: 'plugins', panel: { id: 'P49', name: text('DSH 核心运行时', 'DSH Core Runtime'), file: 'App/dsh-runtime/node_modules/@deepseek-ai/dsh', description: text('@deepseek-ai/dsh 0.1.2-rc.1；DSH 核心框架', '@deepseek-ai/dsh 0.1.2-rc.1; core framework') } },
  { categoryId: 'plugins', panel: { id: 'P50', name: text('Cordis 插件分组', 'Cordis Plugin Group'), file: 'App/dsh-runtime/node_modules/@deepseek-ai/cordis-plugin-group', description: text('@deepseek-ai/cordis-plugin-group 1.0.2；插件分组管理', 'Plugin group management') } },
  { categoryId: 'plugins', panel: { id: 'P51', name: text('会话作用域', 'Session Scope'), file: 'App/dsh-runtime/node_modules/@deepseek-ai/dsh-scope', description: text('@deepseek-ai/dsh-scope 0.1.2-rc.1；会话作用域隔离', 'Session scope isolation') } },
  { categoryId: 'plugins', panel: { id: 'P52', name: text('超时控制', 'Timeout'), file: 'App/dsh-runtime/node_modules/@deepseek-ai/dsh-timeout', description: text('@deepseek-ai/dsh-timeout 0.1.2-rc.1；请求超时控制', 'Request timeout control') } },
  { categoryId: 'plugins', panel: { id: 'P53', name: text('不变量检查', 'Invariants'), file: 'App/dsh-runtime/node_modules/@deepseek-ai/dsh-invariants', description: text('@deepseek-ai/dsh-invariants 0.1.2-rc.1；运行时不变量检查', 'Runtime invariant checks') } },

  // 社区/官方功能插件（功能清单 #54-#63）
  { categoryId: 'plugins', panel: { id: 'P55', name: text('IM 即时通讯连接', 'IM Connect'), file: 'Data/DSH/profiles/web/node_modules/@michengai/dsh-im-connect', description: text('@michengai/dsh-im-connect 0.1.34；即时通讯集成', 'IM integration') } },
  { categoryId: 'plugins', panel: { id: 'P56', name: text('定时任务自动化', 'Automation'), file: 'Data/DSH/profiles/web/node_modules/@michengai/dsh-automation', description: text('@michengai/dsh-automation 0.1.27；定时任务管理', 'Scheduled tasks') } },
  { categoryId: 'plugins', panel: { id: 'P57', name: text('技能包管理', 'Skills Manager'), file: 'Data/DSH/profiles/web/node_modules/@michengai/dsh-skills-manager', description: text('@michengai/dsh-skills-manager 0.1.38；技能包安装/管理', 'Skill pack install/manage') } },
  { categoryId: 'plugins', panel: { id: 'P58', name: text('归档管理', 'Archive Manager'), file: 'Data/DSH/profiles/web/node_modules/@michengai/dsh-archive-manager', description: text('@michengai/dsh-archive-manager 0.1.29；会话归档管理', 'Session archive management') } },
  { categoryId: 'plugins', panel: { id: 'P59', name: text('专家/代理', 'Agency Agents'), file: 'Data/DSH/profiles/web/node_modules/@michengai/dsh-agency-agents', description: text('@michengai/dsh-agency-agents 0.1.30；专家代理系统', 'Expert agent system') } },
  { categoryId: 'plugins', panel: { id: 'P60', name: text('上下文管理', 'Context'), file: 'Data/DSH/profiles/web/node_modules/dsh-context', description: text('dsh-context 0.41.2；上下文窗口管理', 'Context window management') } },
  { categoryId: 'plugins', panel: { id: 'P62', name: text('MCP 连接器', 'MCP Connector'), file: 'Data/DSH/profiles/web/node_modules/dsh-mcp-connector', description: text('dsh-mcp-connector 0.2.32；MCP 协议连接', 'MCP protocol connector') } },
  { categoryId: 'plugins', panel: { id: 'P63', name: text('插件市场', 'Market'), file: 'Data/DSH/profiles/web/node_modules/dshmarket', description: text('dshmarket 1.41.0；插件安装/更新市场', 'Plugin install/update market') } },

  // ─── profile ──────────────────────────────────────────────────────────
  { categoryId: 'profile', panel: { id: 'P73', name: text('单元测试套件', 'Unit Test Suite'), file: 'test/', description: text('覆盖插件系统、运行时、Profile、桌面功能、外壳、便携特性等', 'Plugin/runtime/profile/desktop/shell/portable tests') } },
  { categoryId: 'profile', panel: { id: 'P74', name: text('本地 Ollama 模型接入', 'Local Ollama Model'), file: 'Data/DSH/settings.yaml', description: text('本机 Ollama 0.33.3 + qwen3:8b 路由 ollama-local', 'Local Ollama 0.33.3 + qwen3:8b routing ollama-local') } },
  { categoryId: 'profile', panel: { id: 'P67', name: text('订阅额度查询（未交付）', 'Plan Quota (Not Shipped)'), file: 'docs/01-当前工作/I023-前后端UI全项目审核/', description: text('历史在途原型；当前 Profile 未安装', 'In-flight prototype; not installed in current profile') } },
]
