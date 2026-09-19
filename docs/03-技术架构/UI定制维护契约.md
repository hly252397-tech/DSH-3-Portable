# UI 定制维护契约（所有智能体必读）

生效：2026-09-12。用户明确要求：每次 UI 修改都留记录，更新不得静默恢复原版外观或破坏入口。适用于 Codex、ZCode、Qoder 及其他接手智能体。最新用户决定优先于本表；改变本表时必须说明覆盖了哪一条旧决定。不能把历史尝试重新当作目标。

## 1. 当前接受的行为与外观

| 范围 | 必须保持 | 对应历史记录（I023） |
|---|---|---|
| 左侧工作栏 | 浅色界面白底；移除顶部编程/通用切换与全部/编程/通用筛选；移除旧底部知识快捷条 | 03、04、07 |
| 左右侧栏 | Codex 左导航与 better-sidebar 右侧/底部卡片共存，不能以“都是侧栏”为由删掉其中之一 | 02、09 |
| 两套右侧内容面板 | DSH 原生右面板与 better-sidebar 右卡片不能同时展开挤占对话区；切换时收起另一侧，保留两侧标签与底部面板。原生收起/全屏按钮为卡片开关预留76px，不能重叠。原生内部操作需按实际展示状态协调，不能仅包装 workspaces.openPath 或 layout.openRightbar | 24 |
| 卡片新建菜单 | 各项提供 TabDescriptor.icon(size)，使用 currentColor 的同尺寸图标，文字起点/行高一致；黑洞不可遗漏图标。复用原菜单布局，不加空格或单独文字偏移补齐 | 25 |
| 会话顶栏 | 标题、模式状态与三页签相邻，工具/卡片开关在右端；所有控件中心对齐。会话容器不超过760px时分两行，不以窗口宽度代替可用列宽。模式是原有只读状态；保留三页签、打开方式/更多菜单和卡片开关原事件。better-sidebar挂载后移除顶栏重复原生右栏入口及占位；不要恢复它，原生服务仍供资源调用 | 27、28 |
| 顶栏文件夹/更多工具组 | 无装饰竖线和额外左内边距；28px按钮、6px圆角，文件夹分段按钮不再单独套胶囊外框；右内容面板展开时离对话右框16px，原菜单及焦点行为保留 | 30 |
| 外壳左上角 | 移除home-panel重复侧栏图标及其翻转CSS；返回/前进直接排列，不留空位。保留视图→切换边栏、Ctrl+B、Logo双击与侧栏自身操作 | 33 |
| 外壳顶栏（整条） | 左段只有 返回/前进 ｜ 文件·编辑·视图·帮助（菜单 13px、padding 0 9px、竖线在前进之后）；中段为**居中定宽 320px** 的搜索胶囊（点击=查找，≤1000px 窄窗收起）；右段为 状态·重启 ｜ 搜索·设置·更新，右缘不侵 146px 系统按钮区，`.bar-right` 不再 `display:none`。重启图标为自绘电源图形 `shell-icons/power.svg`，仍是全壳**唯一**入口并保留两步确认/红底确认态/旋转态。**覆盖 33 中"重启放在最左第一个"** | 39 |
| 黑洞输入工具条 | 黑洞入口、收纳和提醒整组位于输入卡片正上方，复用 composer 宽度/侧边留白令牌，与输入卡片两侧对齐；窄列可换行，弹窗不越出该列。覆盖此前靠对话主区左边放置 | [I026/02](../01-当前工作/I026-黑洞空间/02-输入框上方工具条对齐.md) |
| 浏览器 | 右侧原浏览器卡片入口连接桌面原生浏览器；不恢复 iframe 和旧专属设置；不恢复顶部独立重复入口 | 05、08 |
| 工作台外框 | 统一白底、细线、10 px 圆角；外侧 6 px 留白；避免重复套框和四角突线；分隔条可拖动且不突出上下端点 | 10、14 |
| 右栏蓝色拖动线 | 位于对话右边框与卡片左边框中间；当前6px间距下手柄left=-7px，保持8px命中宽、2px蓝线、上下16px内收。以后改变间距时同时按两边框中点重新定位，不贴在某一条边框上 | 26 |
| 文件面板 | 有文件树时预览至少与树等宽；树最大占一半；正常面板最低 488 px，极窄视口按可用空间收敛；主区让位与实际面板同宽 | 16 |
| 底部面板 | 顶部开关、内部关闭均有效；主区定位支持 main 和旧 conversation；展开让位、间距 6 px、拖动及刷新可恢复；内容盒相对定位并按内侧 9 px 圆角显式裁切，外层 10 px 圆角；顶部拖动条两端内收 10 px，保留 8 px 命中高度 | 17、22 |
| 底部导航 | 只留原生「设置」（重启已于 I023-39 移到顶栏、底栏注入项已于 I023-43 退役、死选择器已于 I023-44 清净）；展开时等宽同行，36px高、8px间隔、图文间距6px；收起为36px图标按钮纵排、间隔4px。移除自动化，覆盖11/13/31的旧纵排要求 | 11、13、31、32、39、43、44 |
| 定时任务 | 只保留左侧管理入口，直接挂载原AutomationView。取消底部自动化及右卡片中转入口；旧space-automation标签仅作隐藏退出适配，不出现在菜单/设置清单。设置节是左侧入口的实际目的地，运行记录及原调度数据保留 | 31 |
| 源代码管理 | 只保留侧边栏Git管理卡片；diff从设置清单移除，仍作为Git文件变更的内部查看页，不删除差异能力或复活第二张同名功能卡片 | 31 |
| 重启 | **唯一入口在外壳顶栏** `#restart-btn`（自绘 `shell-icons/power.svg` + 两步确认 + 5s 超时）；实际调用桌面桥，不能只加图标或伪造成功。**覆盖本条原先的「正式 `sidebar.footer.action` 插槽」以及 34 的底栏三列排版**；底栏不得再出现第二处重启入口 | 11、34、39、43、44 |
| 首页卡片 | 输入卡独占 768 px（`--dss-home-width`）统一内容列，圆角 10 px，默认高 120 px（`--dss-home-card-height`），与工作区条间距 16 px；输入工具栏下推至底边，按钮保留 8 px 底部留白；窄栏共用尺寸单位；长输入允许自然增高。**覆盖此前默认 160 px**；**「任务最近活动分布」卡已于 2026-09-13 整卡下线（见 42），故"双卡同高"的配对语义消失，高度变量与 768 px 列继续生效** | 06、15、19、21、42 |
| 首页四类快捷任务 | 保留探索/构建/审查/修复四类、各两个提示词入口；类别展开子任务，子任务仅预填草稿，用户决定发送。四卡常规 72 px，标题容器无 340 px 最低占位；未激活任务/状态不占空间，不能改成无响应装饰 | 23 |
| 工作区/模式 | 位于输入框下方，无边框、无底色，36 px 基础行高；原有菜单继续可点。**覆盖早期“放顶部、三块全加边框”** | 18 |
| 知识中心 | 保留整理后的标题/搜索/筛选/卡片层级、菜单弹窗与真实保存反馈 | 12 |

历史详情入口：[I023](../01-当前工作/I023-前后端UI全项目审核/00-迭代总览.md)。图片是相应时点证据，不代表其余旧外观仍需保留。

## 2. 到底改哪个文件

以下路径均相对于 `G:\DSH-3-Portable`。先核对真实 Profile、安装版本、活动槽及页面，不凭截图猜版本。2026-09-12 检查时 Codex UI 已更新到 1.1.3，旧文档中的 1.1.2 是历史值；不要求退回旧版。

| 内容 | 源码/归属 | 构建与生效 |
|---|---|---|
| 首页等高、工作区条顺序、圆角、留白、文件树最小宽度、底部导航、知识中心 | `Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js` 的 HOME_DETAIL_CSS、HOME_CARD_ALIGNMENT_CSS、ROUNDED_PANEL_CSS、FOOTER_NAV_CSS、KNOWLEDGE_DETAIL_CSS | `App/resources/node/node.exe scripts/build-sidebar-spaces-client.mjs` → 同目录 client.js；刷新 |
| 底部面板主区定位 | `Data/DSH/profiles/web/local/dsh-better-sidebar/src/client/Sidebar.tsx` 和 `src/client/layout.css` | 已发布预编译 bundle 用 `scripts/build-sidebar-layout-compat.mjs` 同步；完整上游重建后也要检查/应用此兼容；刷新 |
| 原生/卡片右栏互斥 | sidebar-spaces `coordinateRightPanels/observePanelPresentation`；better-sidebar `src/client/service.ts` 的 `setPanelOpen` | 先 `scripts/build-sidebar-layout-compat.mjs`，再 `scripts/build-sidebar-spaces-client.mjs`；真实双向点击与刷新，不通过 CSS 隐藏代替状态关闭 |
| 会话顶栏分组 | sidebar-spaces `client.src.js` 的 `CONVERSATION_TOOLBAR_CSS` | `scripts/build-sidebar-spaces-client.mjs` 后刷新；依赖当前官方header类与Codex UI的data-dcu-inline-tabs，升级后实查DOM和窄列；禁止直接改npm客户端。外框6px+边框1px决定开关垂直补偿 |
| 外壳顶部图标 | `assets/shell.html`；保留`src/shell-actions.ts`和桌面桥共享toggle-sidebar动作 | 静态资源被extraResources打包，需标准Build-DSH-Portable.ps1和A/B候选；重启生效，页面刷新不能替代桌面槽切换 |
| 外壳顶栏图标资源 | `assets/shell-icons/*.svg` | 新增图标直接放该目录即可：`extraResources` 用 `**/*` 通配打包，**无需改 package.json**。新增图标须用 `<img>` 引入并配 `fill/stroke="currentColor"`——`.nav img`、`.nav.restart.confirming img`、`.nav.restart.spinning img` 三条规则只匹配 `img` |
| 定时任务入口恢复 | `scripts/restore-scheduled-tasks-entry.mjs`复用`Customize/Automation-Workbench/build.mjs`的钉版还原，旧builder不再注入workbench.js | bundled Node运行该脚本，自动备份当前客户端并校验原生哈希/唯一锚点；已经迁移时不重写，不匹配时拒绝。插件更新后先查差异和原生页/底部注册再迁移，不能覆盖整包。源脚本、旧builder和部署物均受基线保护 |
| 自动化/diff冗余卡片下线 | sidebar-spaces隐藏旧自动化适配器；better-sidebar `src/client/SideCardSection.tsx`过滤diff/space-automation | 运行`build-sidebar-layout-compat.mjs`和`build-sidebar-spaces-client.mjs`；保留GitView→DiffTab调用，不删除调度数据 |
| 黑洞卡片图标 | `customizations/black-hole/lib/client.js` 的 space-black-hole 注册 | `App/resources/node/node.exe scripts/sync-black-hole.mjs --check` 核对差异后用 `--install` 同步到 Data 本地插件，不能仅改部署物；同步脚本保护无关文件并备份 |
| 原生浏览器卡片 | better-sidebar 的 `portable/browser-view.js`、对应 BrowserView 源码及桌面桥 | `scripts/build-native-browser-card.mjs`；涉及桌面桥则另走桌面构建部署 |
| 重启入口 | `Data/DSH/profiles/web/local/dsh-restart-button/lib/client.js` | 这是该插件维护的客户端源文件，原位保存并刷新；不要直接 Object.assign 只读 SVG 属性 |
| 全局主题、更新后白底 | `assets/theme.css`、`src/dsh-view-preload.cts` | 必须按 AGENTS 走 tsc/全测/Build-DSH-Portable.ps1/A-B 候选；检查正常启动后活动槽，不能只改 dist 或活动槽文件 |

本地依赖保持 `link:local/<包名>`，`node_modules/<包名>` 必须 realpath 指向同一 `local/<包名>`；必须保留 Profile bundles。不要改回 `file:`，不要复活已退役 local/dsh-codex-ui，也不要为了修 CSS 执行全量 pnpm install。构建脚本用根目录 bundled Node；不要手改 sidebar-spaces 的生成 client.js 后遗漏源文件。

## 3. 修改一次，记录一次

每一轮实际落盘改动都要在对应任务记录追加条目，不能只在最终答复写“修好了”。连续调试可在同一记录按时间/编号追加，不必每行代码建新文档。失败尝试也要记根因、为什么撤销；后续智能体先读记录再动手，不重复已经失败的做法。

每条至少包括：

1. 用户要求/截图路径，实际问题、复现条件和根因证据。
2. 原行为 → 新行为，涉及的源码、生成物、Profile、活动版本及文件边界。
3. 修改位置、原因、关键选择器/尺寸/事件；取代哪些旧要求，哪些仍保留。
4. 精确构建命令；源码到实际加载文件的对应关系。
5. 前端事件→后端或纯前端例外→UI反馈；实测操作、结果、截图/JSON/日志路径。
6. 类型与测试结果、未验证边界、恢复方法；不能用旧记录代表本轮已验收。

先在 `docs/00-交接入口/07-功能清单.md` 标“处理中”并链接记录；通过后更新为实际状态。一轮修改失败或用户要求暂停，也须留下最后状态和下一步，避免下一位从零猜测。

## 4. 固化与自动检查

`customizations/ui/baseline.json` 是最近记录的受保护文件摘要；`sources/` 存放按内容哈希命名的完整文本快照，包含此前被 Data 忽略的关键源码和客户端；`history/` 追加记录，禁止覆盖旧历史。快照不含 Profile 凭据和会话。文件在 Git 可入库目录，但未提交/未推送不等于已有远端备份。

`evidence/` 同时归档真实验证 JSON 与当前首页、文件最小宽度、底部面板截图，避免清理 artifacts 后丢失全部依据。二次登记会追加证据快照，不覆盖旧证据。

从项目根运行：

```powershell
& ./App/resources/node/node.exe scripts/ui-baseline.mjs
```

检查受保护源码/生成物与已验收版本一致、快照完整、记录存在、本地依赖 link/Junction、bundle 启用。已接入 `node --test dist/test/*.test.js`，偏离会使测试失败。干净检出无 Data 时，只验证已归档源码及仓库文件，实机检查单独标 skip；不得称为真实 UI 验收。

合法修改先完成 UI 验证，再用自己的记录和证据登记下一版：

```powershell
& ./App/resources/node/node.exe scripts/ui-baseline.mjs --record --note docs/01-当前工作/I023-前后端UI全项目审核/你的记录.md --evidence artifacts/你的验证/results.json
& ./App/resources/node/node.exe node_modules/typescript/bin/tsc
& ./App/resources/node/node.exe scripts/run-tests.mjs
```

`results.json` 需有 `status: "pass"` 和非空 `results`；这只检查证据文件结构，真实性/覆盖范围仍由执行者负责。可以重复 `--evidence` 引用多份验证。**禁止为了变绿直接重写 baseline/hash、删除检查项、假造 JSON 或跳过实机测试。** 登记历史后若继续改受保护代码，必须再次验证并追加登记。

快照回滚：先比较 baseline.files 中的 `path` 与 `snapshot`，备份当前文件；只恢复明确回退的目标，按第 2 节重建并验证。不要整目录覆盖升级后的第三方包或整个 Data。工具只报告漂移，不擅自回写或降级。

## 5. 更新前后必须怎样做

1. 更新前跑基线检查，记录当前 Profile 依赖/实际版本、活动指针、校验输出；对本地 fork 做便携盘备份。原有 dirty 工作必须保留。
2. 官方/社区更新使用原有更新入口；`link:` 本地 fork 不换成 npm 同名发布物。它的上游更新必须作为单独迁移，先比较差异并保留 portable 改动。
3. 更新后再跑基线检查；检查真实加载的新版本及所有 UI 合约。第三方 DOM/插槽变化可能在文件哈希不变时破坏布局，必须实际点击、拖动、刷新、缩放。
4. 必测：左右侧栏共存；底部按钮展开/关闭及拖动；Files 拖窄/树拖宽/预览；首页同宽同高和底部工作区菜单；底部重启可见及隔离桥测试；浏览器入口/遮挡；浅色白底及支持的暗色状态；窄栏和 80%/125%/150% 缩放。
5. 更新导致失败时标失败并修复/恢复该模块，不能删掉控件掩盖、无限改 CSS、或以重装清 Data 解决。重启真实用户桌面前先检查活跃任务，验证优先使用独立窗口。

## 6. 构建路径怎么选（2026-09-13 起）

改动只落在 `assets/**` 时**不必**跑整条装配（`prepare-runtime` 装配 Node/插件仓库 + `electron-builder` 打包 400+ MB，约 20–40 分钟）：

| 改了什么 | 入口 | 耗时 |
| --- | --- | --- |
| 只有 `assets/**`（`shell.html` / `theme.css` / `browser-*` / 图标 …） | `Build-UI-Only.cmd` | 秒级 |
| `src/**`、`scripts/*.ts`、`package.json`、锁文件 | `Build-DSH-Portable.cmd` | 全量 |

原理：`assets/*` 在 `package.json` 的 `build.extraResources` 里是**原样复制**到 `resources\`，不进 `app.asar`、不经 `tsc`。所以把差异素材直接铺进 `release\win-unpacked\resources\`，再走同一个候选槽暂存契约即可——落点、槽清单校验、失败回滚都与全量构建完全一致。

`Build-UI-Only.cmd` 先过两道门禁，**被拦是预期行为而非故障**：

1. 工作区是否存在 `src/**`、`scripts/*.ts`、`package.json`、锁文件等会进 `app.asar` / `resources\desktop-bridge\` 的改动；
2. `dist\` 是否比 `resources\app.asar` 新（编译产物领先打包产物）。

任一命中都说明 `app.asar` 已落后于源码，强行推进只会得到「新界面 + 旧主进程」的混血槽。此时应先跑全量构建；确知后果时可用 `-Force` 只推界面，用 `-DryRun` 只报告门禁与差异、不动任何文件。

本机制是**开发/构建门禁、可恢复快照及交接规范**，未注入每个第三方插件市场的安装事务。不能承诺任意未来版本永远不变；机器检查加真实界面回归用于发现并阻止把回退当作验收成功。

## 7. 落盘记录：输入区右上角布局 + 免重启热重载（2026-09-15/16）

**原因**：用户要求把输入框工具行右侧的「平价/峰时消耗胶囊 + 模型选择」搬到「黑洞空间」那一行右端
（贴右、同一行），并要求"改界面免重启"；期间暴露「一重启会话就断」的机制缺陷。

**改法／文件**：

| 文件 | 改了什么 |
| --- | --- |
| `Data/DSH/profiles/web/local/dsh-ui-tweaks/`（实体，`Data/` 不入库） | 新本地插件：client 注入样式 + JS 搬运；宿主提供 `GET /ui-tweaks/reload-token` 热重载令牌 |
| `customizations/ui-tweaks/`（**入库归档**，含 README 与证据截图） | 实体副本 + 锚点/算法/安装步骤/本轮证据 |
| `Data/DSH/profiles/web/package.json` | `dependencies` 加 `link:local\dsh-ui-tweaks`；`dsh.profile.bundles` 追加 `dsh-ui-tweaks` |
| `Data/DSH/profiles/web/node_modules/dsh-ui-tweaks` | Junction → `local/dsh-ui-tweaks`（三者缺一，DSH 自愈会摘掉条目） |
| `scripts/look-ui.ps1` | 窗口选择改为「可见 + 有标题 + 非占满全屏」；抓图期间临时置顶、抓完取消 |
| `Data/DSH/AGENTS.md`（全局指令，不入库） | 禁止用 `.dsh-reload-request` 生效插件改动；客户端改动走热重载令牌 |
| `docs/01-当前工作/机制-界面样式免重启生效与自验.md` | 机制与事故根因（含实测证据） |

**验收证据**：`customizations/ui-tweaks/evidence/`
- `accepted-dock-row-wide-20260916.png`（1376px：黑洞行右端＝`峰时 ¥30.4  DeepSeek-V41-Fl… ⌄`，单行不重叠）
- `accepted-narrow-fallback-20260916.png`（1150px：放不下则降级，胶囊留在输入行，不压字不换行）
- 热重载实测：令牌 `…646730` → 改文件 → `…715717`；页面 `timeOrigin` `…695461` → `…717097`（1.5s 内自刷，运行时不动）

**未纳入本轮的已知项**：`src/main.ts` 里仍有临时 DOM 探针（写 `Data/Temp/dsh-settings-debug.log`，9/16 仍在写），
清理它需要全量构建换槽，另行安排；本次未改任何受保护文件（`src/dsh-view-preload.cts`、`assets/theme.css`）。
