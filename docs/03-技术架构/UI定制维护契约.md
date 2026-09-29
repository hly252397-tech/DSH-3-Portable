# UI 定制维护契约（所有智能体必读）

2026-09-28 设置导航图标去重：内置插件用拼图、自定义空间用四格、Agent预设用清单、桌面设置用显示器、外部智能体接入用互联节点。保留原按钮/文本/路由；ui-tweaks 的可撤销精确装饰，不改npm包。现役页面显示及五入口点击通过；12组隔离宽窄/缩放/主题通过，最终745 pass/0 fail/26 skip，UI基线PASS。“插件配置点击后消失”在恢复旧制品时也复现，仍单列待修，不视为本轮已修。部署、备份、失败尝试及完整GCC/GIR见 [本轮记录](../01-当前工作/20260928-设置导航图标去重.md)。

2026-09-28 Agent MCP 设置重启续验：用户确认后只重启一次，现役“外部智能体接入”唯一入口、真实窗口截图、默认隐藏凭据及页面自检通过；MCP六工具、重启令牌保持、匿名401均确认。此条覆盖下方该功能“尚未重启”的阶段状态；不替此前其他设置页/全局点击缩放未决项背书，也不声称ZCode已接入。证据与操作边界见 [本轮记录](../01-当前工作/20260928-Agent-MCP接入设置.md)。

2026-09-28 Agent MCP 接入设置：用户要求给 ZCode 已完成的 MCP 后端增加设置入口，现增加原生“外部智能体接入”子项，提供真实状态、地址、显式令牌显示/复制、连接信息、无任务自检及六工具说明；不增加另一套后端或重启工具。长期令牌分离保存并在升级前保留现役值。14项真实隔离 Profile/鼠标/重载/宽窄缩放通过，全测767/741 pass/0 fail/26 skip；归档/活动/旧家园三份同步，尚未重启现役，不能称现役界面已验收。原有布局保护不变，不重记基线。路径、失败迭代与GCC/GIR见 [本轮记录](../01-当前工作/20260928-Agent-MCP接入设置.md)。

2026-09-28 重启续验：用户授权后，候选 `8f8c59c0586c99c0` 于 01:23:24 通过启动健康并成为 current，原 current 保留为 previous；无新增 startup-error。实际页面探测确认桌面设置子项与嵌入框存在，但 PrintWindow 空白、导航探测有超时/迟到，**现役可视点击与缩放验收未完成**。本条覆盖下方尚未激活状态；不得将隔离通过等同现役 UI 全通过，详见本轮记录末节。

2026-09-28 用户最新决定与候选状态：本次设置整合暂保留 Codex UI 1.1.18，不豁免 1.1.20；正常构建成功，候选 `1.0.76-local-8f8c59c0586c99c0` 已暂存。15 项候选文件一致性、从新离线仓安装的 1.1.18 上 12 项真实隔离 Profile/鼠标/IPC/缩放验证通过；最终当前工作区全量 765 项（739 pass/0 fail/26 skip）、UI 基线通过。回收区已空，现役/回滚指针不变；尚未重启或激活，须用户另行确认后实际冷启动验收。覆盖下方“等待版本决定”及“无 pending”历史状态，失败记录仍保留，详见本轮记录末尾 GCC/GIR。

2026-09-27 本轮最终状态补记：下述 12 项真实设置验证针对 codex-ui 1.1.18。新包 1.1.20 实际被官方 DSH rc.2 兼容门禁拒绝，未擅自豁免；正常构建亦在最终内容指纹阶段因本轮并行补验的 SQLite 临时文件竞争而失败。源码基线及两轮全测通过不等于候选完成；当前无新 pending，等待用户决定版本策略，详见本轮记录末尾检查点。

2026-09-27 桌面设置统一（用户批准，源码门禁通过，尚未激活）：顶栏只保留“DSH 设置”，更新进度/状态提示移到该按钮，更新忙碌时仍可打开设置；DSH 设置新增“桌面设置”子项，复用原通知/更新/外观页面与后端。应用菜单的独立桌面设置保留为启动异常备用。覆盖下方历史“单独更新按钮”要求，不删除更新能力。采用有限方法桥与隔离 iframe，不开放任意 IPC、文件路径或脚本执行。12 项真实隔离 Profile/鼠标/IPC 验证、209 项顶栏检查通过；四处保护差异审查后登记 15-16-29 基线，全量 754/728 pass/0 fail/26 skip。测试和 GCC/GIR 见 [本轮记录](../01-当前工作/20260927-桌面设置纳入DSH设置.md)；现役旧槽 settings.html 的 ERR_FAILED 单独留档，候选及重启实测未通过前不得称现役已生效。

2026-09-27 设置入口合并（用户批准）：左侧只保留“自定义空间”，原“物料录入工作台”设置菜单取消；原服务状态/探活/唤醒/打开卡移入自定义空间表单下方“工作台服务管理”。由空间页声明子插槽、工作台提供原卡，不以隐藏导航代替迁移，也不删除后台保活或用户空间配置。单入口、两次页面重载、宽窄布局与真实探活已验；真实唤醒/打开未重复操作，全项目基线仍未闭环。见 [本轮记录](../01-当前工作/20260927-自定义空间与工作台服务合并.md)。本条覆盖历史独立工作台设置菜单，其他工作台标签不变。

2026-09-27 项目列表追加（用户最新要求）：展开态项目下的普通会话、空列表提示和“展开显示”与项目文件夹图标左线对齐，不再保留默认30px子行缩进；项目分组和折叠关系保留，运行中的行仍为转圈标记让位。只作用项目列表，不改变最近列表、收起态、右侧时间/操作和底部空间。实际截图及数字验收见 [本轮记录](../01-当前工作/20260927-项目会话列表左对齐.md)；覆盖上游默认的项目子行缩进外观，不变更其业务事件。

2026-09-27 会话顶栏追加：子智能体/模式作为完整控件排列，不再挤入固定 76px 列。≤760px 会话列采用内容宽度分配；≤520px 三页签独立第三行，正文随顶栏自然高度让位，覆盖此前窄列一律两行的规则。活动 ui-tweaks 已生效，独立矩阵和真实两行布局通过；真实三行及菜单点击尚待补验，全量仍有上一项 shell.html 基线失败。见 [本轮记录](../01-当前工作/20260927-会话顶栏窄列排版.md)。

2026-09-27 更新按钮追加（源码已改，未部署）：用户确认检查阶段旋转、下载阶段空心进度环、结束清除进度，不再显示低进度实心细竖线；保留可用版本/候选和错误/回滚圆点，不改下载与安装逻辑。210 项独立离屏检查及 11 项定点通过不等于现役验收；未重记 UI 基线，快通道被共享工作区未打包改动阻断。影响矩阵、失败尝试及发布状态见 [本轮记录](../01-当前工作/20260927-更新按钮进度细线修复.md)。

2026-09-27 补记：底部自定义空间因 0.1.7 移除旧设置 API 被停用，并非用户要求取消。Config/configForms 适配已在用户允许后备份并部署到活动 v4-rc2b Profile；空间/完整浏览器、顶栏设置/空间配置实际点击、两次重载、90%/110% 缩放及窄窗局部通过。拒绝保存与迟到保存由隔离测试覆盖，未改用户真实配置做写入验收。全量及 UI 漂移尚未闭环，不代记 better-sidebar 基线；详细文件、证据与失败尝试见 [底部空间记录](../01-当前工作/20260927-底部空间入口与更新按钮.md)。

2026-09-29 iOS 风格动效层：ui-tweaks 新增视图切换/弹层/侧栏微过渡动效（Apple 减速曲线+弹簧），总闸=html[data-dsh-motion="ios"]，系统「减少动态」自动退出；纯客户端装饰零后端，四副本同步+热重载已上真实实例，全量 0 fail；视觉验收待用户把应用切回桌面后确认，回滚=恢复 .bak-pre-ios-motion-20260929。见 [本轮记录](../01-当前工作/20260929-iOS风格动效层.md)。

生效：2026-09-12。用户明确要求：每次 UI 修改都留记录，更新不得静默恢复原版外观或破坏入口。适用于 Codex、ZCode、Qoder 及其他接手智能体。最新用户决定优先于本表；改变本表时必须说明覆盖了哪一条旧决定。不能把历史尝试重新当作目标。

## 1. 当前接受的行为与外观

2026-09-27 追加：所有会话及新任务页，“平价/峰时 + 模型选择”统一位于输入框上方右侧，与左侧黑洞工具条同行；最大化、全屏、缩小和右卡片开合不改变归属，模型继续采用紧凑图标并保留原菜单。rc.2 的 `standardControls` 同时包含多个控件，不得把它误认为计价节点整体搬走；按计价稳定标记选取，并固定异步挂载顺序。源/部署、实机和未通过项目门禁见 [本轮记录](../01-当前工作/20260927-模型计价入口统一右上角.md)。

2026-09-25 追加：右侧“浏览器”卡片的正式实现是卡片 DOM 内的工具栏与网页兄弟 `<webview>`，不再创建浏览器专用 `WebContentsView` 或 `NativeBrowserView`。ERP 等禁 iframe 页面必须继续在卡片中可操作，跨会话恢复各自地址/页面，重复点击“+”与 Files 切换不能白屏；后续功能只扩展这一套完整浏览器。此决定覆盖下方 2026-09-20 设置窗口条目中“为覆盖原生浏览器层而保留”的旧理由，以及更早的原生面板描述；设置窗口自身的边界要求不变。已知未闭环：快切会话后立刻展开“更多”，临时网页快照偶尔白底；不得把它当作已通过或以恢复旧原生层止损。实测、失败尝试和门禁见 [I023-63](../01-当前工作/I023-前后端UI全项目审核/63-浏览器卡片内嵌组件迁移.md)。

2026-09-24 追加（实机验收通过）：桌面宽度下，同一窗口的右卡片/底部面板开合、宽度和底部高度作为跨会话显示偏好；切换任务不应让外壳开合与尺寸跳变。窄于 768px 的全屏抽屉保留按需展开行为，不继承桌面展开状态。文件、终端、浏览器标签/页面、分栏及任务状态继续按会话隔离，不把内容全局复制。三旧会话切换、两次页面热重载、浏览器静置和右卡片“+”反复点击的范围及证据见 [I023-62](../01-当前工作/I023-前后端UI全项目审核/62-跨会话界面呈现统一.md)。

2026-09-20 追加：桌面设置以主窗口可见内容区居中，不以整个屏幕中心定位；打开/移动/缩放同步，区域不足则缩小并滚动，不能拖离或最大化到主界面外。保留独立窗口以覆盖原生浏览器层，不改变设置保存/更新逻辑。见[I023-58](../01-当前工作/I023-前后端UI全项目审核/58-桌面设置窗口居中与边界.md)。

2026-09-19 追加：本地全局UI字体归theme.css的--dsh-font-ui统一管理；dcu/dsw及外壳控件同源，保留对话字号设置、代码/终端等宽和外站样式。浏览器工具栏12px、更多菜单13px，不允许font:inherit简写抹掉组件字号；构建与负/正对照见 [I023-57](../01-当前工作/I023-前后端UI全项目审核/57-全局字体与浏览器控件统一.md)。待启动候选不得冒充现役已生效，不自动重启。

2026-09-19 追加：左栏底部自定义空间在上、今日消耗金额在下；展开空间入口使用浅灰圆角卡与浅蓝图标底，金额留白；收起态仍为36px图标上下排列。覆盖此前相反顺序，见 [I023-56](../01-当前工作/I023-前后端UI全项目审核/56-底部空间与用量顺序交换.md)。

同轮最新决定：收起态自定义空间必须与上方工具使用同一灰色线框/透明底/浅灰悬停，不再单独蓝色高亮；展开卡片保持不变。

2026-09-19 追加：启动鲸鱼的图片回退与粒子使用同一几何尺寸，取消入场外扩/收拢，保留轻微游动及减少动态模式。普通窗口画布稳定316px，小窗口仅为适配收缩。见 [I023-55](../01-当前工作/I023-前后端UI全项目审核/55-启动鲸鱼尺寸跳变.md)；需候选激活后验证正式启动，不把离屏验证当作已部署。

2026-09-19 追加：输入框只保留单层实体边框，不叠加原生工作区触发态 SVG 虚线。保留工作区选择与键盘聚焦反馈；实现、构建和实机验证（含失败尝试与验证边界）见 [I023-54 输入框重复虚线边框](../01-当前工作/I023-前后端UI全项目审核/54-输入框重复虚线边框.md)。

| 范围 | 必须保持 | 对应历史记录（I023） |
|---|---|---|
| 左侧工作栏 | 浅色界面白底；移除顶部编程/通用切换与全部/编程/通用筛选；移除旧底部知识快捷条 | 03、04、07 |
| 左右侧栏 | Codex 左导航与 better-sidebar 右侧/底部卡片共存，不能以“都是侧栏”为由删掉其中之一 | 02、09 |
| 两套右侧内容面板 | DSH 原生右面板与 better-sidebar 右卡片不能同时展开挤占对话区；切换时收起另一侧，保留两侧标签与底部面板。原生收起/全屏按钮为卡片开关预留76px，不能重叠。原生内部操作需按实际展示状态协调，不能仅包装 workspaces.openPath 或 layout.openRightbar | 24 |
| 卡片新建菜单 | 各项提供 TabDescriptor.icon(size)，使用 currentColor 的同尺寸图标，文字起点/行高一致；黑洞不可遗漏图标。复用原菜单布局，不加空格或单独文字偏移补齐 | 25 |
| 会话顶栏 | 标题、模式状态与三页签相邻，工具/卡片开关在右端；所有控件中心对齐。会话容器不超过760px时分两行，≤520px三页签独立第三行；子智能体/模式整组排列，禁止固定76px压缩，不以窗口宽度代替可用列宽。模式是原有只读状态；保留三页签、打开方式/更多菜单和卡片开关原事件。better-sidebar挂载后移除顶栏重复原生右栏入口及占位；不要恢复它，原生服务仍供资源调用 | 27、28；20260927会话顶栏窄列排版 |
| 顶栏文件夹/更多工具组 | 无装饰竖线和额外左内边距；28px按钮、6px圆角，文件夹分段按钮不再单独套胶囊外框；右内容面板展开时离对话右框16px，原菜单及焦点行为保留 | 30 |
| 外壳左上角 | 移除home-panel重复侧栏图标及其翻转CSS；返回/前进直接排列，不留空位。保留视图→切换边栏、Ctrl+B、Logo双击与侧栏自身操作 | 33 |
| 外壳顶栏（整条） | 左段只有 返回/前进 ｜ 文件·编辑·视图·帮助（菜单 13px、padding 0 9px、竖线在前进之后）；中段为**居中定宽 320px** 的搜索胶囊（点击=查找，≤1000px 窄窗收起）；右段为 状态·重启 ｜ 搜索·设置·更新，右缘不侵 146px 系统按钮区，`.bar-right` 不再 `display:none`。重启图标为自绘电源图形 `shell-icons/power.svg`，仍是全壳**唯一**入口并保留两步确认/红底确认态/旋转态。**覆盖 33 中"重启放在最左第一个"** | 39 |
| 黑洞输入工具条 | 黑洞入口、收纳和提醒整组位于输入卡片正上方，复用 composer 宽度/侧边留白令牌，与输入卡片两侧对齐；窄列可换行，弹窗不越出该列。覆盖此前靠对话主区左边放置。**2026-09-17 用户拍板扩展（见 §8）**：欢迎页（还没有消息的新任务页）并入本条——那一行不再由黑洞插件绝对定位到标题旁/标题下，改为与会话态**同一位置、同一外观**；**覆盖 I026/06「首页标题右侧黑洞入口」**，标题不再为它左移 | [I026/02](../01-当前工作/I026-黑洞空间/02-输入框上方工具条对齐.md)、§8 |
| 浏览器 | 右侧卡片入口只连接自己移植的完整浏览器：`browser-panel.html` 工具栏与网页是卡片 DOM 中同级 `<webview>`；主进程不得再创建浏览器专用 `WebContentsView` 叠加层。保留标签、资料、下载、扩展与智能体能力；不恢复 iframe、旧 `shell.html` chrome 或顶部重复入口 | 05、08、21、63 |
| 三个主板块 | 左侧导航、中间对话、右侧工作台各有完整细边框和圆角，视觉独立；消除异常宽白带时保留正常 6 px 间距，不删相邻边框。2026-09-17 用户明确纠正，§16.1 的“删线”解释和 §16.2 的“线仍不画”验收作废；不是指输入框下方工作区/模式行 | 10、§16.3 |
| 工作台外框 | 统一白底、细线、10 px 圆角；外侧 6 px 留白；避免重复套框和四角突线；分隔条可拖动且不突出上下端点 | 10、14 |
| 右工作区宽度 | better-sidebar 的 `writeGeometry()` 是面板渲染宽度与主区让位 `--dsh-sidebar-width` 的唯一写者。空卡片、编辑器占位、拖动、收起和缩放均不得另设 `420/560px` 状态帽、`--dss-panel-width` 或 `#root` 专用让位；重建前后运行 `scripts/build-sidebar-layout-compat.mjs --check`、`scripts/lint-ui-discipline.mjs` 与专项回归，实机核对面板宽度＝让位且输入框不越界 | I023/47、I023/61 |
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

2026-09-19 搜索入口去重（I023/51）：宽窗口只显示中部搜索框；外壳宽度 ≤1000px 时搜索框收起、右侧放大镜显示，两者互斥。覆盖 I023/39 中右侧搜索按钮始终显示的旧要求；原搜索动作、设置、更新和重启不变。

2026-09-19 自定义空间（I023/52）：展开时空间列表使用页脚整宽，名称自然换行、不用省略号截断；收起时隐藏分组标题和名称，保留36px方形点击区、16px四格图标及完整名称/地址悬停提示、可访问名称。不改原打开方式和空间设置；有空间列表时覆盖旧底部两座位平分宽度规则。

2026-09-19 设置页配色（I023/53）：浅色设置导航与主侧栏同套白灰语义色，Portal也必须收到颜色变量；白底#fff、搜索/悬停#f4f4f5、选中#e4e4e7、正文#18181b。规则只在浅色生效，不把深色模式强制改白。实现放可热刷的ui-tweaks双份客户端，不直接修改第三方npm插件。

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
| 内嵌完整浏览器卡片 | better-sidebar 的 `portable/embedded-browser-view.js`、`assets/browser-panel.html`/`browser-workspace.js` 及桌面桥；旧 `portable/browser-view.js` 仅留历史快照，不得被构建器引用 | `scripts/build-native-browser-card.mjs` 只生成内嵌后端；涉及桌面桥/资源则走标准 A/B 桌面构建与真实点击验收 |
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

## 8. 落盘记录：空白态（欢迎页）的模型选择器搬到黑洞行右端（2026-09-17）

**原因／用户要求（两轮，同一天）**：
① 用户截图圈出输入卡片左下角的模型选择器（红框1）与「👁 黑洞空间 ｜ ＋ 放进黑洞」右侧空白（红框2），要求「把红框1挪到2的位置」；
② 交付后追问「能不能做到全局对话统一呢，这个区域」，并在选项里拍板 **「位置+外观都统一成会话态」**。

**实际问题与根因（探针实测，不是推测）**：
- 红框1 ＝ `._7KE1Ra_root`（`conversation.input.model` 槽：`IconDataOutline16` + 模型名 + `⌄`）。会话态它早就被搬到黑洞行右端（第 7 节），
  但 `applyAll()` 里有一条**空白态直接短路**（`dock.closest('.wSkVaW_composerHero')` → `state('hero')` + return），所以欢迎页里它仍在输入行；
  输入行放不下时被 `flex-wrap` 连同行尾发送键换到第二行，正是用户截图所见。空白态几何守卫也天然不适用
  （`.dbh-dock` 的父级是 `display:contents` 槽容器 ⇒ `stackW=0`，只剩 `width>=260` 在判，而空白态行宽＝内容宽）。
- 红框2 ＝ `.dbh-dock`（`dsh-black-hole` 注册在 `conversation.input.dock`）。**同一个元素**在两种状态下位置不同：
  会话态它在输入卡片正上方（I026/02 的要求）；空白态插件的 `observeHomeDockPlacement()` 把它**绝对定位**到标题旁
  （宽窗 `inline`）/标题下一行（窄窗 `stacked`），并给标题加 `--dbh-home-title-shift` 的左移——这正是"不统一"的来源。

**原行为 → 新行为**：空白态不再短路，走会话态同一条 `lift()`（复用 `dsh-tweaks-seat` + `margin-left:auto`）；
**并把那一行拉回正常流、外观对齐会话态**（用户第②轮拍板），两种状态从此同位置同外观。

| 文件 | 改了什么 |
| --- | --- |
| `Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js`（实体，`Data/` 不入库） | ① 删空白态短路、改空白态守卫（「有最小尺寸 + 行里确实有 `.dbh-btn`」）；② 新增空白态统一规则组 `…dbh-home-dock-host:has(.dsh-tweaks-seat) .dbh-dock{position:static;width:calc(100% - 2*留白);max-width:卡片最大宽;margin:0 auto}` + 标题 `transform:none` + 去掉首页变体的竖分隔线/紫色胶囊/弱化字色；③ 会话态那两条 `.dbh-dock:has(.dsh-tweaks-seat){position:relative!important…}` 加 `:not(.dbh-home-dock-host *)`（否则会压掉插件的 `absolute`，实测把行甩到视口外 y=930）；④ 空白态不跑 `markFloatingButtons` |
| `customizations/ui-tweaks/`（**入库归档**） | 同步实体副本 + 本轮证据截图 + README 追加「空白态与会话态统一」一节 |

**关键选择器与数值**：`._7KE1Ra_root`（模型＝红框1）、`.dbh-dock`（黑洞行）、`.dbh-btn`（「这一行确实是黑洞行」的锚点）、
`.uV2eYG_card`（输入卡片）。宽度照抄卡片算式 `calc(100% - 2*var(--dsh-composer-side-clearance))` 再受
`var(--dsh-composer-card-max-width)` 限制并居中 —— 于是座位（`margin-left:auto`）右缘与卡片右缘**逐像素相等**（实测差 0）。
落点靠插件自己的 `order`：卡片 `order:3`、工作区条 `order:4`，这一行缺省 `order:0` ⇒ 静态化后正好落在两者之间。
**不写** `data-dbh-dock-placement` / `--dbh-home-dock-*`（那是插件的输出，它每次 sync 先删后按实测重算）。

**精确命令与生效路径**：本插件在**可变** Profile 目录，无需构建、无需重启——保留 `.dsh-reload-request` 不动，
客户端热重载令牌（`GET /ui-tweaks/reload-token`）比对 `client.js` mtime，页面自刷即生效；
实体改完再同步进 `customizations/ui-tweaks/`（`Data/` 被 `.gitignore` 忽略，实体没有版本历史）。

**实测与证据**（前端事件→纯前端例外→UI 反馈，本轮无后端参与）：
- 诊断实例（`dsh web`，同一 Profile、同一运行时槽 `0.1.5-rc.2-fd316e6b895e48c1`，独立 `DSH_HOME`，已补 `settings.yaml` 以复现主题属性）读真实 DOM：
  1384px 视口：`dock 101,391 661x32 pos=static`，与卡片 `101,439 661x113` 左右差 0、间距 16px，模型右缘 − 卡片右缘 = 0，
  `.uV2eYG_row` 只剩 `[tools | 发送]`，标题 `transform=none`，工作区条仍在卡片下方（568 > 552）；
  984px 视口复测同一组关系：`dock 138,374 768x32` vs 卡片 `138,422 768x120`，左右差 0、模型右缘差 0。
  黑色行按钮实测＝会话态形态：`color rgb(15,17,21) / padding 6px 8px / radius 8px / min-height 32px / 透明边框`，`::before` 分隔线 `content:none`。
- 应用窗口（`scripts/look-ui.ps1`，窗口最大化需 `-AllowFullScreen`）：会话态黑洞行行尾仍是 `平价 ¥金额 + 模型图标`，输入行未回归。
- 证据截图：`customizations/ui-tweaks/evidence/{before-hero-model-in-composer,accepted-hero-unified-1384,accepted-hero-unified-984,accepted-active-dock-row}-20260917.png`。
- 定位用的临时 DOM 探针**已删除**（只在定位阶段出现过）；诊断实例与临时目录已清理（先摘 Junction 再删，真实 Profile 逐项验存）。

**门禁与未验证边界**：`scripts/ui-baseline.mjs` → `PASS`（未改任何受保护文件，故未 `--record`）；`tsc` → `exit 0`；全量测试见本轮答复。
未验证：**真实 App 的欢迎页**（应用停在别的会话/视图，不能在不打断用户的前提下切到空白页）——空白态证据来自同一 Profile、
同一运行时槽、同尺度视口的诊断实例；另外黑洞插件的首页摆放效果在**它自己休眠时**（页面重载后偶发不注册 observer）会自动落到
「正常流」分支，两种分支下本插件的落点与外观一致（均已实测），但若插件日后改 `order`/宽度变量，本节规则需重新取证。

**全量测试状态（如实登记，勿误记到本节改动头上）**：本轮 497 用例 **479 通过 / 6 红**，6 条红全部读 `assets/theme.css`
（`browser-panel-layout`×2、`ui-baseline`×2「UI drift: assets/theme.css」、`workbench-panel-clamp`×2）。
原因是**并发会话**在本轮工作期间改写了 `assets/theme.css`（mtime 22:58:23）与 `src/main.ts`（22:57:00）——这两个文件本节改动**从未触碰**
（`git status` 里它们独立于本节的 `customizations/ui-tweaks/**` 与 `docs/**`）；独立门禁 `scripts/ui-baseline.mjs` 在 22:5x 仍为 **PASS**，
22:58 之后转红，正好对齐那次写入。按止损纪律第 4 条：**不替他人会话背书、不代记基线、不动它的在途文件**，
等该会话完成自己的 UI 验证后自行 `--record`。

**恢复方法**：删掉 `customizations/ui-tweaks/lib/client.js` 里那组 `…:has(.dsh-tweaks-seat)…` 空白态规则，
并把 `applyAll()` 还原为 `const inHero = …` + 短路分支（`revert(dock,[findModelSeat()]); state('hero'); return;`），
即可回到「会话态搬运、空白态交给黑洞插件」的旧行为（本插件其它改动不受影响）。

## 9. 落盘记录：全局自适应「单一尺子」+ 侧栏空态不再用空白吃掉宽度（2026-09-16）

**动因（用户原话）**：「放大缩小全局自适应可以吗？」「全局统一，而且自适应不然，以后都要一个一个改」「之前的也要自适应」。
用户在截图里两次圈出右侧一条**整高空白带**，要求从根上解决，而不是一处一处打补丁。

**实测根因（探针取证，非推测）**：
1. 空白带 = 右侧栏**空态内容**在面板里被 `flex:1` 撑满并留白；且面板按**持久化宽度**占位
   （实测 `div.nArs4W_paneEmptyCards` / `div.nArs4W_editorPlaceholder`，`nArs4W_panelBody` = 916px）。
2. 真正的分配者是**插件自己推给应用的 CSS 变量**：
   `document.documentElement.style.setProperty("--dsh-sidebar-width", …)`
   + 应用侧 `#root{margin-right:var(--dsh-sidebar-width,0px); width:calc(100% - var(--dsh-sidebar-width,0px))}`。
   ⇒ **只把面板画窄（max-width）不会让对话列变大**：实测面板 916→552，而空档 153→**496**（空白换了个位置）。
3. 外壳侧的"尺子"（`--dsh-app-width/height/zoom` + `data-dsh-compact`）**从未到达页面**：
   外壳只在 layout 事件里下发，首帧早于页面就绪，而每次（重）加载都是全新 document（变量随旧文档消失）。
   实测：候选槽已部署并通过启动验证、`app.asar` 内代码正确，但探针读到的 `appWidthVar` 仍为空。

**改法**：
- `scripts/build-sidebar-layout-compat.mjs`（既有锚点补丁脚本，带校验+幂等）注入空态规则：
  `html:has(.paneEmptyCards){--dsh-sidebar-width:560px!important}`（编辑器空态 430px）
  + `body .nArs4W_panel:has(…){max-width:同值!important}` —— **变量与面板一起收**，对话列随之长回去。
- `src/main.ts`：`view.webContents.on('dom-ready')` 里清去重键并补一次 `layoutDshView(mainWindow)`，
  让尺子跟着每个新文档重发。
- `assets/theme.css`：把**存量**各自为政的规则搬上同一条尺子（`--dsh-app-w/h`、`--dsh-sidebar-w`、
  `--dsh-chrome-w`、`--dsh-panel-margin` 四个 `:root` 令牌；面板上限兜底、1100px 媒体查询→`data-dsh-compact`、
  对话列 680px 下限→`min(680px, 可用宽-chrome)`、菜单左缘 `260px`→由侧栏宽派生）。
- `test/browser-panel-layout.test.ts`、`test/workbench-panel-clamp.test.ts`：4 条把**旧设计**钉死的用例
  只改期望值（并**新增**"页面不得再有第二条尺子"断言），未放宽任何断言。

**验收证据**：`Data/artifacts/adaptive-single-ruler-20260916/results.json`
（修前 `#root`=1485 / 面板 1638..2554 / 空档 496px；修后 `#root`=2000 / 面板 2000..2554 / **无空档**），
抓图 `宏建云系统/_probe2/final_topright.png`（红框探针已撤，面板紧贴对话列）。

**未验证边界（如实留档）**：
- 外壳尺子的**真机生效**要等下一次构建+重启后用探针复核 `appWidthVar` 非空（本轮只修了时机，尚未真机验证）。
- 浏览器卡片按同一条尺子工作（`--dsh-browser-panel-max-width` 由外壳算、页面与原生视图共用），
  但**尚未**在浏览器卡片打开态下量过三项（面板宽/原生视图宽/对话列宽）。
- 侧栏"有文档打开"的非空态按设计不受影响（新规则只命中空态类名），但同样未在真机打开态下复测。
## 10. 执行纪律（2026-09-16 事故复盘后固化，违反即返工）

> 本节由用户追问「你犯的错怎么处理？而且会一而再再而三的犯」触发。
> 下面是本机真实事故的账目与**机械约束**；后续所有会话改界面/布局都必须按此执行，不靠自觉。

### 10.1 事故账目（都发生在 2026-09-16 本轮）

| # | 错误 | 根因（不是表象） | 代价 |
|---|---|---|---|
| 1 | 用「白像素占比 93.8%」证明主区空白 | 指标选出来没先自证——稀疏文本也算白，量不出真假 | 基于错数据得出错结论 |
| 2 | 断言「空白带 = 已展开但空的原生右面板」 | 从宽度/CSS 猜，没先量 DOM；官方 `dsh-client-ui-sidebar-right` 明确「展开的列必然 seed 默认页」 | 差点按一个**不存在**的状态写规则 |
| 3 | 断言「活动 `App/` 是旧副本，所以外壳改动没生效」 | 看了历史副本，没看**正在运行的进程路径**；实际跑的就是候选槽 | 结论反转，浪费一轮 |
| 4 | 用 `!important` 覆盖 `--dsh-sidebar-width` + 面板 `max-width` | **没先找这个值由谁写**；拖动正是写它 ⇒ 拖动写进去的值被立刻压回 | **用户丢掉拖动能力**（用户实测发现） |
| 5 | 探针每次测量强制刷新页面 | 取证工具**对被观察系统有副作用**（刷新后没有重新推送布局状态 ⇒ `#root` 让位变 0、面板盖住内容） | 用户截图里的「内容被覆盖」**是我的工具造成的** |
| 6 | 多轮 PowerSheII 锚点/引号/`Split()`/CRLF 事故 | 没有写前自证机制 | 每轮一次空跑（好在守卫都拦在写入前） |

### 10.2 单一根因

**我一次又一次在"输出层"打补丁（CSS/像素/盖住），而没有先确定"这个值由谁写、谁是唯一来源"。**
加上取证工具本身会改变现场，却没先算副作用 —— 于是修一个、冒一个。

### 10.3 机械约束（写下来就要执行；做不到就不许提交）

1. **改任何变量/状态前先找写者**：`grep` 出全部写入点并列清单；只能用「写入处钳制」，**禁止用 CSS/`!important` 去盖另一个源的状态**。列不出写入者的方案不许碰。
2. **先量后猜**：任何"根因"结论必须附一条**可复现的探针数值**；没数字只能说"假设"，不许说"根因"。
3. **认活动制品**：判断"改动是否生效"一律以**正在运行的进程路径/活动槽**为准（`Win32_Process.ExecutablePath`、`pointer.json`），不看历史副本。
4. **工具零副作用**：取证/测量工具不得刷新、重排、写状态；无法避免时必须在结论中显式扣除其影响，并在给用户的说明里标注。
5. **一次只动一条规则，且先写回滚路径**：每条 UI 规则改动都配一条撤销命令 + 一条验收数字（改前/改后对照），没有对照不许说"修好了"。
6. **补丁脚本硬要求**：锚点命中数必须为 1（否则抛错）、换行先归一化、避免引号嵌套（用 here-string/书名号）、`node --check` 通过才算落地。
7. **交付口径**：候选就绪 ≠ 完成；必须用户在真机确认。未确认前只能说"候选已就绪"。
8. **改动前必须写"影响预判清单"（用户 2026-09-16 追问「你不能预判吗？」）**：对每条要改的规则，先写三列——
   「会碰谁 / 最可能的坏法 / 提前发现的方式」，并**在提交前把其中最危险的一条挡掉**。
   典型样例：把面板宽改成 `var(--x)` 时必须预判"`x` 缺失 → 宽 0 → 整块消失"，
   因此必须给非零兜底（`var(--x,420px)`）与 `min-width`，而不是等用户报"我的面板没了"。
   预判清单随当轮落盘记录一起写进本文档；没写清单的 UI 改动不许提交。
9. **会被服务的制品必须先过解析门禁 + 形状门禁 + 规格门禁**（2026-09-17 事故③/④/⑤）：改 live / 归档插件的 `lib/*.js`（**手工编辑也算**）之后，
   先跑 `node scripts/lint-ui-discipline.mjs`（检查 ⑥ 逐个 `node --check`；检查 ⑦ 用 vm 沙箱把每个客户端
   factory 真跑一遍、判返回形状；检查 ⑧ 校验服务清单内 bundle 的 `require("…")` 规格命中已知集合）。理由一（⑥）：
   宿主把客户端插件拼成**经典脚本**按段发出，一个文件的语法错误让**同段全部模块**不注册。理由二（⑦）：
   语法对≠能装载——factory 返回没有 `apply` 方法的对象时 loader 直接抛 `invalid plugin`。理由三（⑧，事故⑤）：
   生成器若把 bundle **全域字符替换损坏**（当日每个 `m`→`i`），语法与形状**都合法**，只有
   `require("react-doi")` 这类规格对不上已知模块集合才能拦住——当日该事故让 46 个插件连坐 `import failed`。
   完整定位过程与"DSH_PROFILE_DIR 不改服务路径"的坑见
   `docs/01-当前工作/I023-前后端UI全项目审核/45-better-sidebar字符损坏致46插件连坐.md`。

### 10.4 已固化的制品（不是承诺）

- `scripts/build-sidebar-layout-compat.mjs`：锚点校验 + 幂等注入（含空态收缩、写入处钳制、两框贴合三条规则）。
- `Data/artifacts/adaptive-single-ruler-20260916/results.json`：7/7 断言证据（UI 基线重记依据）。
- 本文档 §9：本轮改动的原因/机制/改法/文件/证据/未验证边界。
- 本节：约束清单，后续会话按此自证。
- `scripts/lint-ui-discipline.mjs` 检查 ⑥（2026-09-17 加）：live + 归档插件 `lib/{client,index}.js` 的解析门禁。
- `scripts/lint-ui-discipline.mjs` 检查 ⑦（2026-09-17 加）：客户端 factory 返回形状门禁（vm 沙箱实跑 factory，
  按 `dsh-client-modules materialize()` 真实语义判"function 或带 apply"；factory 抛错=跳过不判，零误报）。
- `Data/Development/ui-tweaks-live-broken-20260917/`：事故③ 的故障现场（含逐条"有意不回填"判据与恢复命令）。
- `Data/Development/agentos-trigger-bootbreak-20260917/`：事故④ 的故障现场（修复前的 client.js / index.js）。

## 11. 落盘记录：live 客户端插件语法错误 → 整串 63 个模块全灭（2026-09-17）

**症状（用户原话）**：HARNESS 界面「Failed to load plugins」，73 条插件全部
`import failed (see console for the import error)`，另有 `web boot: 73 entries did not activate`；
只有 `dsh-work-mode` 报 `pending (waiting for services: locale, settingsScope, slots)`。

**实测根因（抓的是真实制品，不是猜）**：
1. 宿主把客户端插件拼成**经典脚本**按段发出（`/plugins/??<pkg>/client.js,<pkg>/client.js,…`；实测 63 + 10 + 1 段）。
   **经典脚本里任何一处语法错误 ⇒ 整串不执行** ⇒ 同段每个模块的注册都失败，浏览器只报 `import failed`（不说文件、不说行号）。
2. 逐段解析定位失败段 = 模块 id `dsh-ui-tweaks`：live 的 `lib/client.js` 在 `installRailTooltips();` 之后插了
   `installWidthProbe();` 并**多写一个 `}`**，`apply()` 被提前闭合，其后的函数体（错误钩子 / 指针取证 / 宽度探针）
   掉进对象字面量，直到第 623 行的 `function installWidthProbe() {` 落在属性位置 ⇒
   `SyntaxError: Unexpected token 'function'`。
3. 该文件是**手工编辑 live 制品**（不走补丁脚本）时写坏的：`client.js` mtime 10:50，与 better-sidebar 的 10:43
   改动属同一轮在途工作；`index.js` 同时被加了 `/ui-tweaks/probe` 收集端。

**改法**：
- 备份故障现场 → `Data/Development/ui-tweaks-live-broken-20260917/`（`client.js`/`index.js`/`ui-probe.json` + README）。
- 用**归档副本**（`customizations/ui-tweaks/lib/`）覆盖 live 实体，删除 live `lib/ui-probe.json`。
- 门禁固化：`scripts/lint-ui-discipline.mjs` 检查 ⑥（见 §10.3 第 9 条）。

**验收证据（修前 / 修后对照）**：
- 修前：整串脚本 15440853 字节、**1 个片段解析失败**（`dsh-ui-tweaks`）、浏览器 63 条 `import failed`。
- 修后：15429987 字节（−10866 = 探针载荷）、**0 失败片段**（`vm.Script` 整串 + 逐段双查）。
- **重启才可见**：客户端模块字节在**进程启动时快照**（`dsh-client-modules` 的 `initialBundleSnapshot`），
  改盘上文件后重新抓取仍是旧串 —— 必须重启 harness 进程复核。
- 冷启动复测（`dsh web` 诊断实例，同一 Profile / 运行时槽）：
  `加载插件失败 0 / import failed 0 / did not activate 0`、`__ModuleLoader__ = mode|pendingQueue|load|create`、
  导航 17 项、`.dbh-dock` 与 `.dsh-tweaks-seat` 在位；右栏 `面板 742..1280(538px)` / `#root 让位 538px` /
  `--dsh-sidebar-width 538px`（**面板插件自己推的**）/ 覆盖 0px / 缝隙 0px。
- 门禁对照（新检查项必须能抓住旧制品）：`node --check` 对现场 `client.js` 精确报
  `SyntaxError: Unexpected token 'function'`（第 623 行）；对当前 live + 归档共 21 个 bundle 文件全通过；
  `scripts/lint-ui-discipline.mjs` = **PASS 7/7**。

**未回填的在途工作（逐条判据见现场 README）**：宽度探针 + 宿主收集端、TEMP 抓错钩子、指针取证、
resize 桥接（1.5s/4s/8s 重发 `resize`）、420px 一次性 localStorage 迁移。
其中 resize 桥接的判据是**实测**：面板插件自身 effect（deps 含 `panelOpen/width/viewport.width`）挂载即调
`writeGeometry()` 推 `--dsh-sidebar-width` ⇒ 桥接冗余；且 §10.1 事故⑤ 已记录「内容被覆盖」是探针强制刷新的自伤。

**回滚路径**：
`cp Data/Development/ui-tweaks-live-broken-20260917/{client.js,index.js} Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/`
（用于复现故障，会把界面打回"整套插件全灭"）。

**影响预判清单（§10.3 第 8 条）**：
| 会碰谁 | 最可能的坏法 | 提前发现的方式 |
|---|---|---|
| live `client.js`（63 模块拼接段成员） | 覆盖/写入写坏 → 又一次整串失败 | 覆盖后立刻 `node --check` + 抓拼接串复解析（本轮都做了） |
| `scripts/lint-ui-discipline.mjs` 新检查 | 新增 `--check` 子进程在无 `Data/` 的检出（CI）里误报 | 只检查 `existsSync` 命中的文件；根目录不存在时 0 文件 0 失败 |
| `verify-adaptive-layout` 门禁 | 探针被删 ⇒ 该步 exit 2 变红 | 已在现场 README 写明这是「仪器未安装」的真实信号，探针代码留在备份里可按需装回 |

**未验证边界（如实留档）**：
- 以上验证都在**诊断实例**（`dsh web`）；用户真机（双击启动器 → 外壳 + 原生 WebContentsView）**尚未**重启确认 ——
  按 §10.3 第 7 条，现只能报「现场已修复，待真机确认」。
- 探针缺失使 `scripts/gates.mjs` 的 `verify-adaptive-layout` 一步会红（右栏自适应复测暂无数据源）。
- `src/main.ts` 里在途的 `dom-ready → layoutDshView`（外壳尺子重发）尚未构建部署，故诊断实例中 `--dsh-app-width`
  仍为空（写入处按设计回退 `window.innerWidth`，本轮实测几何正确）。

## 12. 落盘记录：右栏「收起仍留 280px 空白条」+「拖拽手柄贯穿全高强调色竖线」（2026-09-17）

**用户输入**：两张实机截图（红框标注），无文字。红框一 = 右栏左缘那条贯穿全高的深绿竖线；红框二 = 右栏区域。
用选项确认后用户拍板：**两个都修，先修空白**；口径 = **窄到最小宽度就停住，内容仍可见可用**。

**症状 A（图2）实测**：右栏收起后右侧留 `281px` 空白条 —— 栏体（x 1074..1350）除右上两个 `data-dsh-toggle-cluster`
图标外**无标签页、无卡片**（逐行非白像素扫描：仅 y 54..67 两个字形 + y 885..888 底边），空白条左侧是
对话列自己的圆角卡片右边框（`#D9DDE3`，x 1073）。⇒ 面板已收起（`.nArs4W_panelHidden` / `translate(102%)`），
**但布局让位没释放**，是那 280px 白条在占位。

**根因 A（有据，写入处）**：live `dsh-better-sidebar/lib/client.js` 的便携补丁
`writeGeometry = (width, height) => { const __avail = …--dsh-app-width… || window.innerWidth;
const __w = Math.max(280, Math.min(width, Math.max(280, __avail - 680))); … }`。
上游契约是**收起传 0**（同文件注释 "0 while collapsed"、`src/client/layout-push.ts` 的
`panelOpen ? … : 0`），而 `Math.max(280, 0) = 280` ⇒ 收起时仍写 `--dsh-sidebar-width:280px`
⇒ `src/client/layout.css` 的 `#root { margin-right: var(--dsh-sidebar-width, 0px) }` 照抄 280px。
写入点唯一（lint 检查③实测 `setProperty` 1 处），故只改写入处、不动 CSS 覆盖。

**症状 B（图1）实测**：右栏左缘一条 **2px 贯穿全高**竖线，色值 `RGB(27,85,35)` = `#1B5523` =
verde 浅色主题的 `accent`（`theme.css:134`）。它是拖拽手柄的 hover/active 装饰线：
`dsh-sidebar-spaces` 注入的 `body .nArs4W_panel > .nArs4W_panelResize::after { width:2px;
background: var(--dsw-alias-state-business-primary,#3265ac); opacity:0 }` +
`:is(:hover,.nArs4W_panelResizeActive)::after { opacity:1 }`（该 token 经主题桥接落在 accent 上）。

**改法（各一条，落在写入处）**：
1. `Data/DSH/profiles/web/local/dsh-better-sidebar/lib/client.js`（`writeGeometry` 第一行）：
   加守卫 → `const __w = width <= 0 ? 0 : Math.max(280, Math.min(width, Math.max(280, __avail - 680)));`
1b. **这条补丁的真正写入者也得一起改**：`scripts/build-sidebar-layout-compat.mjs:56` 的 `writeGeometryClamped`
   同步加 `width <= 0 ? 0 :` 守卫。只改 live 文件的话，将来对"干净上游文件"重新生成时这个 bug 会复活；
   已打过补丁的 live 文件不会被它覆盖（脚本幂等闸 = `if (!client.includes('__avail - 680'))`）。
   ⚠ 该脚本同时被 `ui-baseline` 标为 drift，属**他人在途改动**：本轮只补我这一处，不运行该脚本、不替他人背书写回。
2. `Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.js`：删掉上面两条 `::after` 规则（换成注释）。
   手柄本身保留：8px 命中区 + `cursor: col-resize` 不变；`min-width:280px` 与拖拽钳制**未动**（下限仍是 280px）。
   `grep` 全仓（`customizations/`、`scripts/`、`docs/`）无第二处副本 ⇒ 无生成器；唯一孪生是**不参与加载**的
   `lib/client.src.js`（`package.json` exports 只指 `lib/client.js`），本轮不动、列入遗留。

**验收证据（改前 / 改后对照）**：用**被改文件里的真实代码抽行**跑假 DOM（`data/temp/panel-width-ab.cjs`）：
| width | avail | 改前(旧式) | 改后(现制品) |
|---|---|---|---|
| 0（收起） | 1376 | **280px** | **0px** |
| 0（收起·窄窗） | 900 | **280px** | **0px** |
| 280 / 300 / 554 / 900 | 1376 | 280 / 300 / 554 / 696px | 相同（拖拽语义未变） |
- `node --check`：三个 bundle 全通过；`scripts/lint-ui-discipline.mjs` = **PASS 7/7**
  （含"活动/归档 21 个 bundle 全部可解析""JS 写入点唯一 1 处"）。
- `scripts/ui-baseline.mjs`：drift 命中 `dsh-sidebar-spaces/lib/client.js`、`dsh-better-sidebar/lib/client.js`
  （=本次改动）。**本轮不 `--record`**：真机 UI 尚未确认（§10.3 第 7 条）；且该次 drift 同时命中
  `scripts/build-sidebar-layout-compat.mjs`，属他人在途改动，不替其背书。

**失败尝试（如实记，供后续会话省一轮）**：
1. 在 live `dsh-ui-tweaks/lib/client.js` 装一次性取证脚本（阶段1 挂 `nArs4W_panelResizeActive`、阶段2 点收起
   按钮走真实 `writeGeometry(0)`、阶段3 恢复），准备抓改前/改后两段画面 —— **15s 内屏幕没出现脚本的 overlay
   （绿色像素采样 = 0）**。同时宿主路由 `/ui-tweaks/reload-token` 返回 `200` 且 token = 新 mtime ⇒ 宿主侧正常。
   结论：客户端模块字节在 **harness 进程启动时快照**（§11 同一结论），改盘不重启不生效。取证脚本已**整段删除**
   （`client.js` 字节回到 44651，`panelRepro` 命中 0）。
2. 外壳侧无"只刷 DSH 视图"的入口：`executeShellAction('reload')` = `recycleDshForPluginUpdate()`，会**杀掉正在
   跑的会话**（§10 / AGENTS 明令禁止用来生效插件改动），未采用。页面自刷链条（`watchClientBundle` 轮询 token）
   的守卫 `clientInputBusy()` 只认文档里**第一个** `[contenteditable="true"]`，是否被会话标题长期卡住，本轮无 DOM
   无法判定 —— 留作独立待查项（属另一 bug，另开一轮）。

**回滚路径**：
- `dsh-better-sidebar/lib/client.js`：把 `width <= 0 ? 0 : ` 从 `const __w =` 行删掉即回旧行为。
- `dsh-sidebar-spaces/lib/client.js`：把被删的两条规则贴回（原文见本轮 §12 症状 B 段），
  即 `body .nArs4W_panel > .nArs4W_panelResize::after { … opacity: 0; }` 与
  `body .nArs4W_panel > .nArs4W_panelResize:is(:hover,.nArs4W_panelResizeActive)::after { opacity: 1; }`。

**影响预判清单（§10.3 第 8 条）**：
| 会碰谁 | 最可能的坏法 | 提前发现的方式 |
|---|---|---|
| 右栏宽度写入（`--dsh-sidebar-width`） | 守卫写错 → 打开时也写 0，整块面板消失 | 假 DOM 对照表：width>0 六个档位行为逐项相同（已做）；真机重启后先看右栏是否还在 |
| 同文件 `client-registry.js` 里的上游副本 | 两处 `writeGeometry` 语义分叉 | `grep --dsh-app-width` 全 profile：**只有 client.js 一处**补丁（已验），registry 是上游未打补丁副本 |
| 拖拽手柄命中区 | 删规则连带删掉 8px 命中区/光标 → 拖不动 | 只删 `::after` 两条，保留 `.nArs4W_panelResize` 本体规则；真机重启后拖一次分隔条 |
| 底部面板手柄有**同款**横线装饰 | 一致性只改一半（竖线没了、横线还在） | 本轮**只改用户报的竖线**；横线保留，已在交付说明里点出，待用户决定 |

**变更后自验（2026-09-17 追加；用户明确要求「别让用户确认，你自己想办法干和确认」）**：
用**诊断实例**（`dsh web`，同一 Profile / 同一运行时槽 `0.1.6-alpha.1-2a49814bc8ce816d`，`--port 0` + 打印的
token URL；客户端模块在该**新进程启动时**从盘上快照 ⇒ 载入的正是本轮改过的制品），在真实页面里读 DOM /
派发指针事件得到下表（视口 1384）：

| 断言 | 改前（页面内写旧式值复现） | 改后（现制品） | 结论 |
|---|---|---|---|
| 右栏收起时 `--dsh-sidebar-width` | **280px**（= `Math.max(280,0)`） | **0px** | ✅ |
| 收起后对话列宽 | **848px**（右侧留 278px 白条 = 用户截图那条） | **1126px / 复测 1117px（吃满）** | ✅ 白条消失 |
| 手柄 `::after` 计算样式 | 2px 强调色线（hover/active 时 `opacity 0→1`） | 无 `content`、`width: auto` | ✅ 竖线不可能再画出来 |
| 分隔条小步连续拖 15 档 | — | var `569→281→280`（夹紧下限）、`281→…→704`（夹紧上限 `vw-680`），松手回 581 | ✅ 拖拽与两端夹紧正常 |

- 同时**证伪**了本轮一个中间判断：物理扫掠时我把「面板卡在 567px」当成 CSS `!important` 钉宽；诊断实例里
  全量扫各样式表，只有 `body .nArs4W_panel{width:var(--dsh-sidebar-width,420px)!important}` 一条，
  **没有** `html:has(...){--dsh-sidebar-width:…!important}`。真因是我探针**一次跳 110px**，触发 app 的
  `pointercancel/lostpointercapture` 兜底（`abortDrag` 提交当前尺寸并结束拖动）⇒ 手法问题，不是面板问题。
- 物理扫掠 17 张逐档截图在 `data/temp/sweep/`（00-before / 1-narrow-00..02 / 2-narrowest /
  3-wide-00..08 / 4-widest / 5-restore / 99-restored），逐档数字见本轮交付说明。
- 扫掠/探针脚本：`data/temp/drag-panel-sweep*.ps1`、`restore-panel-width.ps1`、`clear-selection.ps1`。

## 13. 同源收口 + 遗留清单（2026-09-17 二轮；用户问「还有什么没有修复的」）

**本轮当场补修（同源、同类；已在新诊断实例自验，端口 52208，验完已关）**：
1. `dsh-sidebar-spaces/lib/client.js`：底部面板手柄的 `bottomResize::after` 两条规则（**横线**装饰）——与右栏
   竖线同一处装饰、同一条纪律，一并删掉（命中区与 `row-resize` 不变）。
2. `dsh-sidebar-spaces/lib/client.src.js`（**不参与加载的孪生副本**）：竖线 + 横线共四条规则同步删掉，防止
   将来切到 src 时复发。
3. 自验数据：`.nArs4W_panelResize::after` 与 `.nArs4W_bottomResize::after` 计算样式均为
   **`content: none` / `width: auto`**；**全量扫所有样式表，`Resize::after` 规则数 = 0**；两文件 `node --check` 通过。

**推翻一条既有说法（有实测，影响下游所有 UI 会话）**：§11 写的「客户端模块字节在进程启动时快照 ⇒ 改盘必须重启」
**不成立于插件 bundle**。实测：在 `dsh-ui-tweaks/lib/client.js` 插一行 `window.__twBundle='v2-marker'` ⇒ 8s 后
**页面自己重载了**（先前打在 `window` 上的探针被清空）且**新字节已生效**（`__twBundle='v2-marker'`）。
⇒ 插件客户端 bundle 是**每次请求现读磁盘**，改完**只需一次页面重载**（ui-tweaks 令牌机制就会触发）；§11 那句应限定为
**DSH 核心客户端模块**（`dsh-client-modules` 的 `initialBundleSnapshot`），不含 `/plugins/??…` 插件 bundle。
实验标记已撤（`client.js` 字节回到 44651）。顺带**证伪**热重载守卫的怀疑：文档里第一个 `[contenteditable="true"]`
就是输入框 `DIV.uV2eYG_input` 且 `innerText` 为空 ⇒ `clientInputBusy()` 不阻塞刷新。

**仍然没修的（按影响面排序）**：
| # | 未修项 | 证据 | 影响 | 修它需要什么 |
|---|---|---|---|---|
| 1 | `scripts/ui-baseline.mjs` 仍报 drift | 直接跑即见：本次改的 3 个插件文件 + 他人 `build-sidebar-layout-compat.mjs` | 门禁长期红 | 把他人改动分离后再 `--record`（不替他人背书） |
| 2 | `verify-adaptive-layout` 无数据源 | `dsh-ui-tweaks/lib` 里没有 `ui-probe.json`，探针代码在 `Data/Development/ui-tweaks-live-broken-20260917/` | `scripts/gates.mjs` 该步红 | 把探针装回（host 收集端 + client 探针） |
| 3 | 面板宽度由 app 内联 `style.width` 驱动，`--dsh-sidebar-width` 只驱动布局让位 | 诊断实例实测 var 280 / 面板 482 / 对话列 828 | 夹紧边界可能短暂不等（扫掠见过一帧 24px 缝） | 需改插件内拖拽/渲染耦合，有回归面 |
| 4 | `dsh-sidebar-spaces` 仍双拷贝（lib + src），改一处另一处会漂 | 本轮再次踩到（src 里还留着 4 条旧规则） | 结构性隐患 | 定「只认 lib」并给 src 加只读标记，或删 src |
| 5 | `build-sidebar-layout-compat.mjs` 生成器与手工编辑 live 双轨，锚点守卫脆弱 | §11 事故（多写一个 `}` → 整串 63 模块全灭）；断言是 `split(anchor).length!==2` | 再次整串全灭的风险 | 生成器加「live 是否被手工改过」守卫，或改为纯生成 |
| 6 | 右栏**存储宽度**被本轮物理探针从 ~516 改到 ~426 | v5 探针右拖 90px 后松手提交 | 夹紧解除时右栏会以 426 出现 | 反向拖 90px 再松手（可见宽度被夹，即时看不出） |

**取证产物保留作证据**：`data/temp/sweep/`（17 张逐档图）、`drag-panel-sweep*.ps1`、`restore-panel-width.ps1`、
`clear-selection.ps1`、`panel-width-ab.cjs`。

## 14. 二轮收口：把"没修的"逐条修掉（2026-09-17；用户：「修，有问题，发现问题全部修」）

| 项 | 处理 | 证据 |
|---|---|---|
| 测试门禁红（497 项 2 红） | **已修**：带归属说明 + 证据包执行 `ui-baseline --record` | `run-tests` = 497 / **485 pass / 0 fail**；`ui-baseline` = PASS |
| `verify-adaptive-layout` 无数据源 | **已修**：探针装回（宿主 `/ui-tweaks/probe` 收集端 + 客户端只读探针，按需采样、无常驻定时器；手动再采 `window.__dshWidthProbeNow()`） | 新实例实测：`ui-probe.json` 1772B、7s 新鲜、8 条断言全跑起来；实例内 5/8，3 条失败均为"要外壳尺子"的项（实例无外壳，属预期） |
| 生成器可能把语法坏串写进 live | **已修**：`build-sidebar-layout-compat.mjs` 写入前 `new vm.Script(client)` 解析门禁，不过就抛错不写盘 | 脚本 `node --check` 通过；这是**新增的更强约束** |
| `client-registry.js` 第二份未打补丁写者 | **已修**：补 280..(avail-680) 钳制 + `width<=0` 守卫 | 全 chunk 裸写法 1→0；`lint-ui-discipline` PASS 8/8（其检查③只数 live `client.js` ⇒ 盲区另记） |
| 仓库根临时残留 | **已收纳** 20 项（`_p3tw_*.txt` + `.tmp/`）→ `Data/Development/scratch-20260917/` | 根目录不再留这批散件（其余 untracked 如 `Build-UI-Only.*`、`customizations/*/evidence/*` 属他人在途/设计资产，未动） |
| "起诊断实例"手工做了 3 次 | **已固化**为 `scripts/diagnostic-web.mjs`（打印 token URL、`--print-only` 预演、Ctrl+C 清理子进程、`--slot` 指定槽） | `node --check` 通过；`--print-only` 正确解出槽 `0.1.6-alpha.1-2a49814bc8ce816d` 与 bootstrap |
| 正文蓝色高亮 | **关闭（非缺陷）**：页面重载后仍在 ⇒ 文本选中不可能跨刷新存活，是应用自身对引用内容的着色 | 像素计数 440 跨刷新不变；三次点击也无效 |
| 右栏存储宽度被物理探针改动 | **已还原**：反向拖 90px 松手提交（提交点 = 松手时 clamp 结果） | `restore-panel-width.ps1`；可见宽度被 430/560 钳制，肉眼无差异 |
| `client.src.js` 双拷贝 | **不删**：它在 `protectedPaths` 清单里（删了记录会失败），本轮已同步两处并在 §12 留痕 | `ui-baseline` 仍 PASS |
| lint 检查③ 盲区 / 面板宽度双驱动 | **留档不改**：改评分器属越界，已在 §12/§13 写清范围与后果 | 盲区：写者已补齐，门禁仍只看单文件 |
| `verify-adaptive-layout` 的「两框贴合 ±2px」 | **留档待校准**：app 实测 对话列右缘 852 / 面板元素左缘 853 = 贴合 ✓，但断言取的是面板 **body**(859) ⇒ 真机上该条可能红；按其意图（两框之间不留第三块）应改取 `nArs4W_panel` 带，需一次真机数据再定 | §12 实测数字 |

**未验证边界（如实留档）**：
- 真机此刻仍是 13:03 那个进程的旧快照 ⇒ 两处改动**要等下次重启**才载入；自验已在诊断实例完成，
  按用户要求**不再让用户做确认动作**。
- 面板元素自身的渲染宽度由 app 内联 `style.width`（store/拖动值）驱动，`--dsh-sidebar-width` 只驱动布局让位；
  夹紧边界处两者可能短暂不等（诊断实例实测：var 280 / 面板 482 / 对话列 828，边界仍只有设计值 6px 缝）。
  本轮只记录、未改（无可见症状）。
- 副作用已如实报：v2 探针脱靶在正文划过一片蓝色选中（可能与应用自身引用着色混淆，像素计数未降）；拖拽探针把
  右栏**存储宽度**从 ~516 改到 ~426；诊断实例与临时脚本已清理，用户窗口由最小化恢复为可见（尺寸位置未动）。

## 13. 落盘记录（事故③续）：新插件客户端 factory 返回无 apply 对象 → 整页 boot 失败（2026-09-17）

**症状（用户截图）**：事故③修复、真机重启后，HARNESS 页仍「Failed to load plugins」，但错误从
"73 条 import failed"变成单条 `invalid plugin, expect function or object with an "apply" method, received object`。

**实测根因（不是猜）**：14:40:41 另一会话把新插件 `dsh-agentos-trigger` 装进 profile（package.json 依赖 +
bundles 第 67 行 + node_modules 链接 + local/ 五个文件同秒落盘）。其 `lib/client.js` 的 factory 返回
`{ name, state }` —— **没有 `apply` 方法的普通对象**。loader 真实校验语义（`@deepseek-ai/dsh-web-frontend`
的 `plugin()`：`resolve(t)` 失败即抛 `… received ${typeof t}`；`dsh-client-modules materialize()`：
`exports = factory(requireStub)`）与该报错逐字吻合。语法解析全过（所以 ⑥ 抓不到），只有实跑 factory 才能看到。
宿主半侧 `index.js` 是标准命名导出（`name`/`inject=['webServer']`/`apply`），无恙。

**修法（最小干预，不碰他人设计）**：live `client.js` 的导出对象补一个空 `apply() {}`（收集器的全部工作本就
在模块求值期完成，apply 留空即符合其文件头自述）。修复前现场备份在 `Data/Development/agentos-trigger-bootbreak-20260917/`；
该插件是另一会话的在途产物、**没有归档副本**，回滚 = 从备份拷回。

**证据（修复前 → 修复后）**：

| 断言 | 修复前 | 修复后 |
|---|---|---|
| vm 沙箱实跑全部 live+归档 factory（按真实 `factory(require)` 签名） | PASS 9 / SKIP 0 / **FAIL 1**（唯一：agentos-trigger，`typeof=object keys=name,state`） | **PASS 10 / SKIP 0 / FAIL 0** |
| 对照组（把修复前副本放 `.tmp/shape-control` 再扫） | — | 该副本被 FAIL 精确抓到（同一报错语义）✅ |
| `node --check` 全部 23 个 lib 文件 | 全过 | 全过 |
| 13:44 被批量改动的 better-sidebar / sidebar-spaces factory 形状 | 合法（沙箱全覆盖验证，非跳过） | 同左 |

**门禁固化**：`scripts/lint-ui-discipline.mjs` 新增检查 ⑦（客户端 factory 形状），lint 现 8/8。

**未验证边界（如实留档）**：
- 真机需**再次重启**才载入修复（客户端模块字节在 harness 进程启动时快照）。重启后预期：boot 正常、
  插件全激活；若仍失败，下一个嫌疑按 bundle 服务顺序排查（但形状门禁已全覆盖 live+归档，剩余风险低）。
- agentos-trigger 的源副本在哪个会话/目录、是否要回写该源头，属该会话的事；本轮只修了 live 实体。

**2026-09-17 16:01 现场变化（并发会话正在写，先读这条再动手）**：
- 本会话最后一步修「白列」时，`scripts/build-sidebar-layout-compat.mjs` 与 `dsh-better-sidebar/lib/client.js` 的 mtime
  同步跳到 **16:01:22**，且生成器 `node --check` **失败**（首行成了 `iiport { readFile, writeFile } froi 'node:fs/proiises'`，
  形似一次把 `m` 打成 `i` 的批量替换）；`ui-baseline` 漂移清单只剩 `client.js`，说明 baseline 被对方重记过。
  ⇒ **§12/§13/§14 记录并验证过的 `writeGeometry` 守卫、`vm.Script` 解析门禁、286 地板等改动，已被对方改写覆盖；
  当前树 ≠ 本会话验证过的状态。** 按止损纪律第 4 条，我停手、未与并发写入抢文件。
- 已钉死的「白列」根因（与并发写入无关，代码 + 实测双证）：`portable/browser-view.js:36-37` 用**卡片**矩形判
  `rect.width < 280 || rect.height < 240` ⇒ `setOccluded(true)`；而 `body .nArs4W_panel{padding:6px 6px 6px 0}`
  让卡片 = 面板宽 − 6px（诊断实例实测 581 ⇒ 575）；面板地板是 `min-width:280px!important` ⇒ 地板态卡片 = **274 < 280**
  ⇒ 外壳隐藏原生视图 ⇒ 页面留一张空卡/白列（即 09-14 那条"未定位"项）。
  修法（已设计、未落盘，等对方停写后再上）：面板地板 280 → **286**（=280+6），写入点 4 处：`clampWidth`、
  `writeGeometry`、seam 规则 `min-width`、生成器里同两处字符串。

## 15. 落盘记录：侧栏页脚「连接中…」胶囊压住余额按钮（2026-09-17 用户「移到本该的位置去」）

**症状（用户截图 20:04:07）**：开机后左下角页脚出现橙色「⟳ 连接中...」胶囊，与「¥23.8」余额按钮视觉上
咬在一起（用户先问「为什么会出现在这里」，看完机理解释后指示「移到本该的位置去」）。

**实测根因（镜像实例 1920×1080 wide 态，杀后端逼出胶囊后量 DOM，非目测）**：
- 胶囊是官方原语 `ConnectionIndicator`（`@deepseek-ai/dsh-client-ui-primitives`，类名 `_indicator_<hash>`），
  由 codex-ui `CodexSettingsPage` 渲染为设置触发按钮的后置兄弟——它**落在三列页脚的中列＝设计位**，
  与官方 `ui-settings-general` 的 `[trigger][indicator]` 契约一致。不是它走错位。
- `dsh-sidebar-spaces` 把 `.dcu-foot` 排成 `grid-template-columns: minmax(0,1fr) max-content auto`
  （余额→胶囊→设置）。侧栏 ~245px 时第 1 列只剩 **78px**。
- `dsh-ui-tweaks` 的页脚降噪样式（§7，padding 4px 8px + 22px 图标 + 14px/600 字号）把余额按钮撑到 **96px**，
  且无 `min-width:0` ⇒ 溢出 18px 压进中列：余额 [15..111] vs 胶囊 [97..177]，**重叠 14px**。
- 用户截图里胶囊看似「跑到最左边」＝开机瞬时 footer-actions 尚空、自动放置错列 + 溢出叠加的视觉假象。

**修法（落点：`dsh-ui-tweaks/lib/client.js` CSS 数组，两副本同步：`customizations/ui-tweaks/lib/client.js` +
`Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js`）**：新增 3 条 `:has([class*="_indicator_"])`
作用域规则——胶囊在场时把余额按钮约束回第 1 轨（wrap `min-width:0/overflow:hidden`、按钮 `width:100%` +
padding/gap/图标瘦身到 78px 内），胶囊不在场时外观零变化。选择器用 `_indicator_` 子串匹配，对 CSS-module
哈希变化稳健。**不改 npm 包、不改 sidebar-spaces 的三列设计**（胶囊中列就是设计位）。

**证据（修复前 → 修复后，同一镜像实例、同一视口）**：

| 断言 | 修复前 | 修复后 |
|---|---|---|
| 余额按钮右缘 vs 胶囊左缘 | 111 > 97，**重叠 14px** | 93 ≤ 97，**重叠 0px，净距 4px** |
| 余额按钮宽 | 96px（溢出 78px 轨道） | 78px（恰合轨道） |
| 顺序 | 余额/胶囊交叠 | 余额 → 胶囊 → 设置，间距各 4px |
| 连接正常态（胶囊不在场） | 余额 107px | 余额 107px（零变化） |
| `lint-ui-discipline` | 11/11 | 11/11 |

**未验证边界（如实留档）**：
- 真机生效路径＝页面刷新（ui-tweaks 热重载令牌取 client.js mtime，输入框为空时自动 reload），无需重启 App；
  用户下次开机看到「连接中...」时胶囊应干净落在余额与设置之间，不再压住余额。
- 余额金额更长（如 ¥123.45）且胶囊在场时按 `overflow:hidden` 优雅截断，未逐位验证（当前余额 ¥23.8 有 ~8px 余量）。
- compact（收起）态无胶囊（codex-ui `wide ? … : void 0`），本修复不涉及其 §收起态规则。

## 16. 落盘记录：「中间那条线」= 两块卡片各自的边框；并收口「让位值 vs 卡片宽度」两个来源（2026-09-17 晚）

**用户输入**：实机截图红框标出对话列与右栏之间那条贯穿全高的竖线（首页/空会话态），只问「中间这条线呢？」；
用选项确认后拍板「修：先消白带，再收口漂移（推荐）」。

**它是什么（像素 + DOM 双证）**：不是装饰线，是**两块圆角卡片各自的 1px 边框** —— 对话列卡片右边框 + 右栏卡片
左边框，中间夹框架留白。用户截图 x=**673/680**（1px、#D9DDE3、贯穿全高）；左边栏↔对话列同样是 **61/68** 一对。
规则出处：`dsh-sidebar-spaces/lib/client.js` 的 `ROUNDED_PANEL_CSS`（`.pI_x6G_centerCol` 与
`.nArs4W_panelBody` 都是 `border:1px solid #d9dde3;border-radius:10px`）+ `#root{margin-right:var(--dsh-sidebar-width)}`
+ `.pI_x6G_frame{padding:6px}`。同 Profile/同运行时槽的诊断实例 DOM：centerCol `68..625`、panelBody `631..1113`
—— 相对关系与截图逐像素一致。

**真机改前实测（异常有数字）**：右栏卡片左边框在 x=808（app 800，带左上圆角）；x=690..800 在 y=100..800 上
**0 个非白像素**（120px 纯白带）；对话列卡片顶边框断在 x=687 ⇒ 布局让位值（≈673，恰好等于用户截图里右栏宽度）
比卡片实际宽度（553）**大 120px**。

**机制（代码 + 数字）**：右栏宽度两个来源 —— ① 卡片内联宽度（插件持久化 `state.width`）；② `--dsh-sidebar-width`
（插件 `writeGeometry` 写，并被 `min(width, avail-680)` 夹紧）。`HOME_CARD_ALIGNMENT_CSS`
（dsh-sidebar-spaces）**只在首页**（`.wSkVaW_root[data-phase="hero"]`）**或右栏开着文件树**
（`.nArs4W_panel … .nArs4W_editorTreeDock`）时，用 `--dss-panel-width` 把 ①② 强制同源；其它视图（对话页/设置页）
无此规则 ⇒ 两者一旦不同步就出现白带 + 只剩一根线。（诊断实例实测该夹紧差：var **487** vs 内联 **490**。）

**同轮坐实的第二处缺陷（§12 留的「待查项」）**：`dsh-ui-tweaks` 热重载守卫 `clientInputBusy()` 取
「文档里第一个 `[contenteditable=true]`」；会话页/设置页里先出现的可编辑元素带文本 ⇒ 永远判忙 ⇒
**插件改动到不了真机**。A/B（注入一个非空 contenteditable 当首个可编辑元素后改 mtime）：旧守卫**不刷新**
（注入节点 + `window` 标记都存活），新守卫**正常刷新**（都被清空）。

**改法（全部落在可变插件 `Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js`；未动上游制品）**：
1. `clientInputBusy()`：只认 composer（`[data-slot^="conversation.composer"], .uV2eYG_root`）内的可编辑元素；
   找不到槽时只认「正在编辑」的那一个。
2. 新增 `installReserveSync()`：在被 CSS 管辖之外的视图里，把 ① 按**同一夹紧**写回 ②。
   **只读 `panel.style.width`（插件意图），绝不读渲染宽度** —— 上游 `body .nArs4W_panel{width:var(--dsh-sidebar-width,420px)!important}`
   会让渲染宽度反过来受 ② 影响，读渲染宽度 = 自激回路（实测把面板一路锁死在最小宽度 280/286，已修正）。
   收起态（`nArs4W_panelHidden`）/首页/文件树视图一律跳过；差额 <1px 不写；幂等。
3. 调用点：`watchClientBundle(); installWidthProbe(); installReserveSync();`

**验收证据（改前 → 改后）**：

| 断言 | 改前 | 改后 |
|---|---|---|
| 真机中缝（对话列卡片右边框 ↔ 右栏卡片左边框） | **121px**（x 688..807 全白，只剩一根线） | **7px**（x=873/880 两根，与用户截图同形） |
| 让位值 vs 卡片宽度 | 673 vs 553（差 120） | ≈487 vs ≈481（差 ≤6 = 夹紧残差） |
| 诊断实例 A/B：让位值人为 +200px | 出现 69px 白缝（frameRight 678 / panelLeft 747） | 800ms 内自愈（420/420，缝 0） |
| 热重载守卫 A/B（同上注入） | 不刷新（节点存活） | 正常刷新（节点被清空） |
| `node --check` | — | exit 0 |
| 真机生效路径 | — | 令牌 bump 后真机**自己回传探针样本**（vw=1360/13:50:36）⇒ 新代码已在跑，**无需重启** |

**副作用与未验证边界（如实留账）**：
- 本轮用 `look-ui.ps1` 的窄档（窗口→1100→还原）取证，触发了插件自身的宽度夹紧/提交路径：真机右栏**持久化宽度
  被改写**（553 → 478 → 最小 280/286；修正自愈写法后回到 ≈487）。诊断实例与临时脚本已清理；用户想要的宽度拖
  一次即恢复（外面临时改不动 —— leveldb 被运行中的应用锁定）。
- 拖拽手柄命中区、`col-resize`、面板 `state` 均未改动；**未在真机实测拖拽**（自愈只写 `--dsh-sidebar-width`，
  不写面板 state），建议顺手拖一次确认。
- `customizations/ui-tweaks/lib/client.js`（受保护快照）本轮**未同步**：它比活动副本少 `installWidthProbe` 与
  `installReserveSync`，且属他人 20:44 的在途改动 —— 按止损纪律第 4 条不替他人背书。**下次若从快照回灌会丢掉
  本次修复，需人工合并。**
- `scripts/ui-baseline.mjs` 的 drift 会命中 `dsh-ui-tweaks/lib/client.js`（本次改动）+ 他人
  `build-sidebar-layout-compat.mjs`；本轮**不** `--record`（不替他人背书）。
- 失败尝试留档：第一版自愈读「渲染宽度」，造成右栏被锁到最小宽度（已改读内联宽度根治）。

### 16.1 追加（第二轮，2026-09-17 晚）：语义订正 —— 用户要的是「那根线本身消失」，不是白带

**用户回话**：「还是没有啊」+ 新截图（红框 x 798..860）⇒ 第一轮只修了白带，属**答非所问的交付偏差**（用户从头到尾点的都是"线"）。

**复现（新截图像素扫描）**：红框内仍有 **x=818 / x=825** 两条全高 1px #D9DDE3 = 对话列卡片右边框 + 右栏卡片左边框。

**改法（`Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js` 的 CSS 数组末尾两条）**：只删「朝向对方」的两条边框 + 对侧圆角 ——
`html body .pI_x6G_centerCol{border-right-width:0!important;border-top-right-radius:0!important;border-bottom-right-radius:0!important}`、
`html body .nArs4W_panel>.nArs4W_panelBody{border-left-width:0!important;border-top-left-radius:0!important;border-bottom-left-radius:0!important}`。
`html body` 前缀用于压过 owner（sidebar-spaces `ROUNDED_PANEL_CSS`）的 `body :is(...)` + `!important`（特异性 0,1,2 > 0,1,1）。
**不动**：卡片其余边框、其余圆角、拖拽手柄命中区（8px / `col-resize`）、`min-width`、宽度写入逻辑、面板内容。

**验收（真机窗口抓图 + 全宽像素扫描 x60..1375 / y120..860 / 行占比 ≥0.8）**：

| 断言 | 改前 | 改后 |
|---|---|---|
| 中缝全高竖线 | **2**（x=818 / x=825） | **0** |
| 左栏右边框 / 对话列左边框 | 69 / 76 | 69 / 76（不变） |
| 右栏卡片右边框 | 1361 | 1361（不变） |
| `node --check` | — | exit 0 |

**回滚**：删掉上述两行即恢复两根线。

**未验证边界**：底部面板的同款「一对线」与左栏↔对话列那对（69/76）本轮**未动**（用户只报中缝）；真实拖拽未复测（本轮未碰命中区）。

**交付记录（用户要求，不记评分）**：已按全局 AGENTS 写入 `Data\Home\.pua\feedback.jsonl`（`rating: null` + 说明；当前 43 行全部合法 JSON、无 BOM / 无中途 BOM）。

### 16.2 追加（第三轮，2026-09-17 晚）：「这里正常吗？」= 中缝还留了一条 41px 白条

**用户输入**：截图（红框 x 798..860）+「这里正常吗？」。量出来：卡片顶边框在 y=50 的断点是 **…767 / 808…**
（= 对话列卡片右缘 767、右栏卡片左缘 808）⇒ 中间 **41px 纯白条**（线没了，但留白还在）。

**真机 DOM 定案（探针新增只读 `panelDiag`，一次采样就指名道姓）**：

| 字段 | 值 | 含义 |
|---|---|---|
| `inlineWidth` | **594px** | 插件给面板写的宽度 |
| `computedWidth` | **560px** | 实际渲染宽度 |
| `maxWidth` | **560px** | **元凶**：被 max-width 压住 |
| `rootMarginRight` / `htmlVarInline` | **594px** | 布局让位仍按 594 预留 |
| `panelRect` / `bodyRect` | [800,560] / [800,554] | 面板 / 面板卡片 |
| `dssPanelWidth`·`Min`·`Limit` | 空 | HOME_CARD_ALIGNMENT_CSS **未**生效（非首页、无文件树） |
| `heroInDom` / `treeDockInPanel` | false / false | 同上 |

⇒ 「两个来源」的第三种形态：**内联 594 被 `max-width:560px` 压成 560，而 `writeGeometry` 仍按 594 写让位**，差 34px。

**我前两轮的错（留档防复犯）**：
1. 第一版读「渲染宽度」但**没有稳定性闸** ⇒ 装载过渡帧（面板恰在 280/286 地板）被固化，把面板锁死在最小宽度。
2. 第二版改「渲染==内联才写」⇒ **恰好在这种"被 max-width 压住"的场景主动跳过**，白条照旧（本轮实测：改后 41px 白条仍在）。

**定稿改法**（`dsh-ui-tweaks/lib/client.js` 的 `installReserveSync`）：基准 = **实际渲染宽度**（自带 max-width/各 clamp 的结果），
外加两道闸：① 同一读数连续保持 ≥400ms 才写（避开收起/展开/拖拽/装载过渡帧）；② `<320px` 地板态一律不碰；
收起态（`nArs4W_panelHidden`）与拖拽态（`body[data-dsh-sidebar-dragging]`）跳过；差额 <1px 不写。

**验收（真机窗口抓图 + 像素）**：

| 断言 | 改前 | 改后 |
|---|---|---|
| y=50 卡片顶边框断点（中缝宽度） | 767 / 808 = **41px 白条** | 801 / 808 = **7px 缝** |
| 全宽扫描 y120..860 中缝全高线 | 0 | 0（线仍不画） |
| 左栏 69/76、右栏右框 1361 | — | 逐条不变 |
| `node --check` | — | exit 0 |

**仪器**：探针 payload 增只读 `panelDiag`（内联/计算/max/min/rect/让位/`--dss-panel-*`/`heroInDom`/`treeDock`/`syncInstalled`）——
本次就是它一句话定案，留作常驻（`scripts/verify-adaptive-layout.mjs` 只读已知键，新增键不影响）。

**未验证边界**：① 本轮未在真机实测拖拽（sync 跳过拖拽态、且不动命中区）；② `max-width:560px` 的**写入者**（插件侧或自定义空间侧）
尚未定位 —— sync 是"以渲染为准"的兜底，不是替它定源；若日后 max-width 与内联长期不一致，应回到写入处收口。

### 16.3 追加（第四轮，2026-09-17）：恢复三个主板块的完整外框

**用户纠正**：「我有没有说过，这是三个板块，三个板块要视觉独立，要加边框」。§16.1 的"删线"解释和 §16.2 的"线仍不画"验收作废 —— 用户要的是**三个板块各有完整边框**，不是"中间那条线消失"。

**根因**：`dsh-ui-tweaks/lib/client.js` 在 §16.1/16.2 修复白带时，用 `border-right-width:0!important` 和 `border-left-width:0!important` 主动删掉了中间对话区右边框和右工作台左边框。这是错误的 —— 白带是宽度让位不同步造成的，不是边框本身。

**改法**：
1. 删除 `dsh-ui-tweaks/lib/client.js` 的 `border-*-width:0!important` 覆盖（双拷贝同步：`customizations/ui-tweaks/lib/client.js` 和 `Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js`）
2. 边框由 `dsh-sidebar-spaces/lib/client.src.js` 的 `ROUNDED_PANEL_CSS` 提供（`border: 1px solid var(--dss-panel-border) !important; border-radius: var(--dss-panel-radius) !important`），无需新增规则
3. 白带修复的 `:has()` 规则改用 `:where(:has())` 降低优先级，避免压过欢迎页 `HOME_CARD_ALIGNMENT_CSS` 导致中右板块贴合

**验证（Puppeteer CSS 回归测试，`.tmp/verify-three-panels.cjs`）**：

| 断言 | 覆盖范围 | 结果 |
|---|---|---|
| 三个板块各边 1px 边框 | 3 视口 × 2 主题 × 5 状态 = 30 组 | 全 PASS |
| 三个板块各角 10px 圆角 | 同上 | 全 PASS |
| 中右板块间距 6px | 同上（hidden 除外） | 全 PASS |
| 让位右缘贴合面板左缘 | 同上（hidden 除外） | 全 PASS |
| 负对照：旧制品删相邻边框 | before/interim 状态 | 确认复现 |
| 浏览器错误 | 全用例 | 0 |

证据：`customizations/ui-tweaks/evidence/three-panels-css-regression-20260917.json`（status: pass, 32 cases）。

**未验证**：① 真机拖拽调整面板宽度时的边框连续性（sync 跳过拖拽态）；② 官方基线 HEAD 已从 c291e79 漂移到 ddefc45，需人工审阅但不阻塞本轮纯前端改动。
## 17. 落盘记录：右栏两类缺陷——「侧边对话」崩溃 + 收起态 430px 白带（2026-09-18；用户 8 张截图 + 「不要在空会话里面测试，要在有对话记录的会话测试」）

**用户输入**：8 张真机截图（右栏各标签页状态）+「继续修复这个问题」；随后纠正测试方法：不要用空会话测，
要在有对话记录的会话测——正确，空会话走 `events.length===0` 早退，只有**有历史的会话**才进继承分支（崩溃点）。

### 17.1 「侧边对话出错：Cannot read properties of undefined (reading 'length')」

**根因（代码 + 运行时双证）**：运行时 0.1.6-alpha.1 的 Session 类**没有 `events` 属性**（dsh-session 只有
`snapshotEvents()` 方法；Agent Note 2026-09-09 `deprecate-synchronous-session-event-reads` 明确废弃同步读）。
dsh-better-sidebar 宿主侧（lib/index.js）按 0.1.2 形状直读 `.events` 共 **6 处**（2× `sessions.get(id)?.events`、
2× `agent.session.events`、2× `parentSession.events`），0.1.6 下全部 undefined ⇒
`buildSidechatInheritance(parentSession.events)` 第一行 `events.length` 即崩——与用户截图报错逐字一致。

**修法（lib/index.js）**：新增 `sessionEvents(session)` 兼容读取器（Array.isArray(events) → 用之；否则
snapshotEvents()；再否则 []），6 处直读全部替换。不动 0.1.2 形状兼容。

**验证（A/B rig，`.tmp/sidechat-rig-run.mjs`，副本挂 profile node_modules 解析真实依赖）**：
合成 19 条真实结构事件流（2 完整回合 + 1 开启回合带悬挂 tool/call——最复杂分支）：

| 断言 | 结果 |
|---|---|
| A 对照组：旧代码 × 0.1.6 形状 | **CRASH «Cannot read properties of undefined (reading 'length')»**（逐字复现用户报错） |
| B 新代码 × 0.1.6 形状 | 继承构建成功（seed 裁到开启回合前 15 条 + snapshot 承载开启状态，悬挂调用分支语义正确） |
| C 新代码 × 0.1.2 形状 | 兼容保留，同上 |
| D 边界（undefined / 空流） | 安全返回 [] |
| 镜像 UI 路径 | 409「parent session is not running」优雅路径正常；无 JS 错误 |

**未验证边界（如实）**：镜像无云供应商 key（OLLAMA 桩方案因模型选择器不列 ollama-local 未走通），
「活 agent 在场 → 一键建线程成功」的端到端最后一环未在镜像闭合；但崩溃表达式已由对照组逐字复现并消除，
真机（有 key、有活会话）打开侧边对话即应直接成功。**真机生效需重启 App**（lib/index.js 是宿主半侧，
进程启动时加载，页面刷新不够）。

### 17.2 收起右栏后整条 430px 白带（用户红框竖条）

**根因（镜像逐层实测）**：生成器 `build-sidebar-layout-compat.mjs` 的 `emptyStateClamp`（2026-09-16 引入）
写死 `html:has(.nArs4W_editorPlaceholder){--dsh-sidebar-width:430px!important}`——**不区分面板开合**。
收起（panelHidden）只藏不删 DOM，占位卡仍在 ⇒ `:has()` 恒命中 ⇒ 变量被 !important 钉死 430px，
`writeGeometry(0)` 的内联 0 写不赢 !important（镜像实测 html 内联=0px 而计算值=430px），
hero 对齐规则照抄 430 ⇒ 白带。另实测收起竞态：偶发 writeGeometry(0) 未落地（变量残留 430）同症状。

**修法（两层）**：
1. **根修（生成器）**：两条 html:has 强制规则加 `.nArs4W_panel:not(.nArs4W_panelHidden)` 作用域——
   面板可见时空态宽度逻辑原样；收起后变量解放。生成器加旧串迁移行，重跑落盘（vm 解析门禁内建）。
2. **安全网（dsh-ui-tweaks CSS）**：`body[data-dsh-sidebar-collapsed] #root{margin-right:0!important;width:100%!important}`
   ——兜住任何残余竞态（width 也必须归零，只归 margin 会留左对齐窄根）。双副本同步。

**门禁演进（事故⑥引用）**：`lint-ui-discipline.mjs` 检查②白名单形态从从未命中的
`html:has(.nArs4W_panel .nArs4W_paneEmptyCards){` 更新为实际落盘的作用域形态
（`:not(.nArs4W_panelHidden)` 两条分别计数）。旧形态是无作用域的白带根因，不再放行。

**验证（镜像 1920×1080，三态几何）**：

| 状态 | 修复前 | 修复后 |
|---|---|---|
| 收起态 whiteGap | **430px**（margin 430 残留） | **0px** |
| 展开态贴合 | — | panel x=1432 = frameRight，seamGap 0，无重叠 |
| 展开空态宽度 | 430/560 强制 | 430/560 保留（作用域内语义不变） |

**附带观察（不改代码）**：用户截图「源代码管理」卡「加载中...」——镜像同仓库秒开（stillLoading=0、0 错误），
判定为当时会话正在密集写盘导致后端 git 扫描瞬态，非代码缺陷。

**ui-baseline**：漂移 5 文件——2 个本轮修复（生成器 + 重生成 bundle）、3 个为另一会话今日已完成工作
（shell.html 09:57 设置按钮直达、dsh-view-preload.cts 10:11 设置动作兼容、layout.css 15:54 配套源），
已审阅内容 coherent、真机带其运行全日、探针新鲜，随本轮一并 `--record`
（history: `customizations/ui/history/2026-09-18T12-31-49-067Z.json`，evidence: lint 11/11 results.json）。

**真机生效路径**：白带修复（客户端 CSS/bundle）重启 App 后生效；侧边对话修复（宿主 index.js）同样需重启。

### 17.3 追加（2026-09-18 晚）：拖窄右栏后，对话列长内联代码芯片被右缘裁切

**用户输入**：双宽度截图（同一消息、两种面板宽度）+「是ui问题啊」。宽列时文字正常换行；拖窄后
`run-tests 497 / 485 pass / 0 fail` 这颗内联代码芯片**不是折行而是被右缘拦腰裁掉**（普通文字仍正常换行）。

**根因（官方 CSS 逐字定位）**：`dsh-web-frontend` 的 markdown 样式把内联 code 渲染成
`._markdown_* :not(pre)>code{display:inline-flex;…}` —— **inline-flex 是原子内联盒，永不跨行折断**；
容器 `._markdown_*` 虽有 `overflow-wrap:anywhere`，但对原子内联盒无效 ⇒ 列一窄，芯片超宽部分被裁。

**修法（`dsh-ui-tweaks/lib/client.js` CSS 数组，双副本同步）**：
`body [class*="_markdown_"] :not(pre)>code{max-width:100%!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important}`
—— 芯片限宽 100% 并允许内部按字符折行；外观仍是整颗药丸，宽列时零变化；
`[class*="_markdown_"]` 对 CSS-module 哈希稳健，`body` 前缀特异性 (0,2,2) 稳赢官方 (0,1,2)。

**验证（镜像受控实验：真实 `_markdown_5pusd_5` 类 + 360px 窄容器 + 同一颗长芯片）**：

| 形态 | 芯片右缘 vs 容器右缘 | 溢出 | 结果 |
|---|---|---|---|
| A 官方旧样式（内联强制还原） | 593 vs 460 | **133px** | 裁切（复现用户截图） |
| B 修复后 | 460 vs 460 | **0px** | 芯片折成 2 行，药丸外观完整 |

**生效路径**：ui-tweaks 热重载（令牌=mtime），页面刷新即生效，无需重启 App。
**门禁**：lint 11/11、ui-baseline 重记 PASS（history 2026-09-18T12-58-50-315Z）、全量测试 0 fail。

**附带发现（未动，待用户点头）**：`.gitignore` 曾遭编码事故（UTF-8→GBK 乱码 + 注释吞换行），
`App/`、`.tmp/`、`工作空间/`、`dist/`、`coverage/` 等规则**全部失效**——这就是源代码管理面板
「变更过多，仅显示前 2000 条」里混入大量本地文件的原因。损坏版已备份
（`.tmp/gitignore-corrupted-backup-20260918.txt`），重写需用户点头后进行。

### 17.4 追加（2026-09-18 深夜）：「这个边界」真凶＝17.2 安全网自身；真机探针全程取证

**用户输入**：本体截图圈出「对话列与面板交界」＋「只看」→「删除镜像文件，直接用本体测试」→「再有对话的界面测试」。

**取证手段升级（镜像退役）**：删除全部镜像工具（launcher/桩/rig/日志）；给 ui-tweaks 探针追加只读诊断字段
`boundaryDiag`（composer/scroll/panel 三者 rect + 最宽文本行右缘）与 `rootRules`/`innerRules`
（**枚举匹配 #root / centerCol / scrollBody 的全部含宽规则**，含来源与 ！important）。窗口 resize 抖动触发采样，
热重载自动把新字段带上——**真机自己把证据报上来**，不再需要镜像。

**真凶定案**：§17.2 的「收起态让位归零安全网」
（`body[data-dsh-sidebar-collapsed] #root{margin:0!important;width:100%!important}`）在 **body 属性与面板可见性
不同步**时（hero/会话页切换、:where 降特异性后的规则竞争）把让位清零 ⇒ 面板开着（488/560px）而 #root 全宽
（1360px）⇒ 对话内容滑到面板下面被盖住——正是用户红框里的「边界」。**这是我 17.2 引入的回归，如实记账。**

**修法**：删除该安全网（根因已由生成器 `:not(.nArs4W_panelHidden)` 作用域修复覆盖，网冗余且有害）。
双副本同步；探针诊断字段保留为常驻仪器。

**真机验证（探针数字 + 本体截图双证，2026-09-18 23:13–23:27）**：

| 断言 | 删除前（22:02/22:11 样本） | 删除后（23:13/23:21/23:23 样本） |
|---|---|---|
| hero 态让位 | 0px（rootWidth 1360，内容入面板下） | **488px**（rootWidth 872，面板 [872..1360] 吻合） |
| 会话页+空卡面板（560 态） | 同症状 | **560px**（rootWidth 800，面板 [800..1360] 吻合） |
| 内容层越界（composer/scroll 右缘 vs 面板左缘） | composer 921 > 800 | centerCol [69..794]、scroll [70..791]、composer [70..783] **全部在内** |
| 本体截图（用户原场景：同一会话+面板） | 长芯片 `run-t…` 被切半 | **芯片完整**、文本/输入框/胶囊全在面板左缘前 |

**如实留账**：
- 23:21:47 样本（侧栏展开+面板560+窗口1360）曾出现 composer 右缘 921 越界——该样本属删除后过渡/旧帧，
  23:23:25 同窗口稳态已正常；若「窄窗口+宽面板+展开侧栏」极端组合再现越界，下一步查 composer 的
  min-content（grid 轨道 minmax(auto,1fr) 撑破），本轮未再复现、不动。
- 全量测试 4 fail＝运行时槽已升 `0.1.6-alpha.2`（用户 21:54 重启生效，他人升级域），测试断言钉 alpha.1 失配——
  **非本轮改动域，不背书、只记录**。
- 生效路径：页面刷新/热重载即生效（输入框空时自动），无需重启 App。

### 17.5 追加（2026-09-19 中午）：运行时 alpha.2 适配——右栏整个消失的根因与修复

**用户输入**：「你再看看没修复，把边框做成自适应的」。实机截图显示**右栏面板整个消失**（消息列占满全宽）。

**根因（真机探针逐层取证，镜像已退役）**：用户 00:32 重启的 App 跑在**新运行时槽 0.1.6-alpha.2**（官方升级，
新增 dsh-client-ui-slots / dsh-client-ui-sidebar-browser / dsh-client-ui-primitives 等 20+ 包）。alpha.2 把
`sessions.list` 快照重构：**`.current`（当前会话）字段被移除**，改用 retain 语义。better-sidebar 按 alpha.1
契约读 `sessionList.current` 得 `undefined` ⇒ 主组件走 noSession 早退分支
（`if (state === void 0 || sessionId === void 0) return <只有禁用开关簇的壳>`）⇒ **面板 DOM 整个不渲染**。
全程零 console.error、零浮条、bundle 正常加载——纯静默。诊断手段：ui-tweaks 探针追加
boundaryDiag/rootRules/innerRules/comboDiag/consoleDiag/loaderDiag/hostDiag 字段 + better-sidebar 一次性
快照形状上报（POST 借道 /ui-tweaks/probe 落盘，3s 延迟避让常规采样）。

**alpha.2 新契约（官方用法实证）**：`list.getSnapshot()` = `{ ids, byId, phase, subagentsByParent, jobsBySession }`；
当前主会话 = `byId` 里 `retainedBy.mainView > 0` 的行（官方 agent-preset/workspace 的取法）。

**修法（三处同步）**：
1. `lib/client.js`（活 bundle）两处读点（拦截器 `currentSessionId:` + 主组件 `const current =`）改为兼容读：
   alpha.1 `.current` 优先，回落 `Object.entries(byId)` 找 `retainedBy.mainView > 0`。
2. `src/client/state.ts` 新增 `currentSessionIdOf(list)` helper（同语义）；`Sidebar.tsx` / `intercept.tsx`
   改用 helper 并补 import。
3. `scripts/build-sidebar-layout-compat.mjs` 加锚点迁移（幂等，重跑验证通过；vm 解析门禁内建）。

**真机验证（探针 12:2x 样本）**：适配后 better-sidebar 客户端上报 `hostPanel: "panel-rendered"`
——面板 DOM 恢复渲染（此前同一探针位是 noSession 壳 HTML）。快照实测确认 `retainedBy.mainView: 1`
存在于用户当前会话行，兼容读命中。

**边界自适应现状**：17.2/17.4 的宽度机制（空态作用域规则、无安全网、writeGeometry 钳制、
`body[data-dsh-sidebar-collapsed] #root` 安全网已撤）全部随 bundle 在 alpha.2 下生效；面板回来后
边框随「让位变量 = 面板渲染宽」机制自适应。用户打开 App 窗口即可见（探针会随 resize 自动采样复核）。

**门禁**：tsc 0 / lint 11/11 / ui-baseline 重记 PASS（history 2026-09-19T04-27-22-377Z）/ 全量测试全绿
（此前 4 个 alpha.2 断言失配已被升级会话修复）。

**留账**：①「边框自适应」的完整三态验证（收起/展开/拖窄）需用户打开 App 窗口后由探针自动采样复核
（页面无窗口时无法 resize 触发）；②一次性诊断代码已从 bundle 撤除，探针常驻字段保留。

## 18. 落盘记录：客户端 bundle 自调度重启 → 无限重启（2026-09-21；用户「解决不停的重启问题」）

**现象**：桌面进程每 80–130 秒被重启一次，窗口随机时刻看都在启动页（"卡 90%"其实是循环的启动相位）。

**原因**：`Data/DSH/profiles/web/local/dsh-hj-workbench/lib/client.js`（258–288 行）残留一段**无门控**的
临时自动重启——页面加载 → +2.5s 探测写盘 → 睡 30s → `window.dshDesktopShell.action('app-restart')`。
注释声称"只在构建完成、回收区排空后由我 bump reload-token 触发"，**代码里没有任何门控**；而
**客户端 bundle 每次页面加载都会执行** ⇒ 重启后页面又加载 ⇒ 又重启（自激）。

**定位方法（可复用）**：① `launcher.log` 出现 **`启动器接管握手已就绪`** 即"应用自己请求了重启"
（host 崩不会有这行）；② `restart-handoff.log` 无新条目 ⇒ 不是交接超时；③ 故障探针自证载荷
（`local/dsh-ui-tweaks/lib/ui-probe.json` 的 `{"diag":"hj-auto-restart","hasAction":"function"}`）；
④ probe 写盘时间与握手时间对齐到 1 秒内。

**改法**：删除该 block（本地插件是 Junction，改盘即生效，无需构建、无需候选槽）。全量 grep 确认
`local/*/lib/*.js` 仅此一处命中 `app-restart`。

**验收**：握手计数 200 秒采样窗 + 复检共 5.5 分钟恒为 257（修复前同窗必有 2–3 次）；桌面进程
PID 36360 自 13:19:26 持续存活；截图为主界面；`errTexts: []` 且官方+社区 client bundle 全列；
护栏 `test/no-self-scheduled-restart.test.ts` 1/1 + 正对照（事故原文命中 2 条规则 / 修复后 0 命中）；
全量测试 526 通过 / 0 失败 / 21 跳过。详见 [I023-60](../01-当前工作/I023-前后端UI全项目审核/60-客户端bundle自调度重启无限重启.md)。

## 2026-09-21 · 后台任务徽标竖排（官方 `dsh-client-ui-jobs`）＋ 抓图工具纠错

**用户诉求**：「为什么每个会话还不一样，能统一吗？」头部出现竖排文字，只在部分会话出现。

**为什么"每个会话不一样"（源码级）**：官方 `JobListAction` 渲染条件是
`state.jobsBySession[sessionId]` 非空，否则整块返回 `null` ⇒ 只有本会话有后台任务时才长出这块。

**根因（先量后猜）**：官方 `.QsffPG_count` 是 flex 项、未设 `min-width:0` ⇒ `min-width:auto = min-content`；
头部 `headerActions` 宽度随会话与布局在 **60~224px** 间变化，放不下时官方样式不截断而是逐字折行。
原故障态实测：文字 **23×144（8 行）**、按钮 **150px 高**、**y=-17 越出视口顶部**。

**改法（`local/dsh-ui-tweaks/lib/client.js` 的 CSS 数组；语义 `aria-label` 选择器，不用哈希类名）**：

```css
body button[aria-label*="后台任务"],body button[aria-label*="background task" i]{white-space:nowrap!important;min-width:0!important;max-width:100%!important;max-height:32px!important}
body button[aria-label*="后台任务"]>span,body button[aria-label*="background task" i]>span{white-space:nowrap!important;min-width:0!important;overflow:hidden!important;text-overflow:ellipsis!important;max-width:none!important}
```

**失败尝试（如实记）**：先用 `span{max-width:4.5ch}`——止住了折行，但 **224px 档仍只显示 2 字、白截断 157px**；
根因是"只限制文字宽度、没让按钮可收缩"。去掉上限又会因 `min-width:auto` 以 min-content 为地板而横向越界
（60/76/120px 档越界 84/68/24px）。最终用 `min-width:0`（按钮 + 文字双写）＋`max-width:100%` 收口。

**验收（对照复现，非正向自证）**：真实页面把官方结构复刻进真实 `headerActions`，同一同步帧内先量现行、
再用同特异性后置样式还原旧行为：

| 容器宽 | 旧行为 | 现行 |
|---|---|---|
| 60px | 60×96、5 行、y=-24 越界 | 60×28、1 行、显 3 字 |
| 76px | 76×60、3 行、y=-6 越界 | 76×28、1 行、显 4 字 |
| 120px | 120×42、2 行 | 120×28、1 行、显 7 字 |
| 224px | 144×28、1 行、显 9 字 | 144×28、1 行、显 9 字 |

真实徽标修复后实测：span `[661,15,106,18]`（全字宽、1 行）、button `[641,10,150,28]`、容器 `[565,10,226,28]`、
`checkVisibility=true`。证据目录 `customizations/ui-tweaks/evidence/badge-wrap-20260921/`（含并排实物图 + 原始载荷 + `results.json`）；
`tsc` exit 0、全量测试 **559/538 pass/0 fail/21 skipped**、`ui-baseline` **PASS**（该插件不在 `protectedPaths`）。

**⚠️ 抓图工具纠错（本轮踩到并固化）**：`CopyFromScreen` 抓的是**屏幕物理像素**；DSH 窗口被别的窗口压住时，
抓到的是**压在上面那个窗口**——本轮实测抓到用户的 Chrome / 宏建云 ERP 页面，并因此一度错误结论"徽标没渲染"。
新增 `scripts/capture-app-window.ps1`（`PrintWindow(hwnd,hdc,PW_RENDERFULLCONTENT=2)`）：直接渲染窗口自身内容，
**与遮挡无关、不抢焦点、不会拍到别的应用**。既有 `scripts/look-ui.ps1` 用"临时置顶再抓"也可用，代价是
改变窗口层级并抢焦点；**在用户正在别的窗口干活时优先用新脚本**。详见
[20260921-后台任务徽标竖排修复.md](../01-当前工作/20260921-后台任务徽标竖排修复.md)。

**未决项（如实登记）**：① 官方徽标只在"页面活着时收到 job 事件"才挂载（页面重载不重取 jobs 快照），
其定点实拍未取到，已用同结构复刻 + 真实元素坐标代替；② `customizations/ui-tweaks/` 归档副本落后实体
（791 行 vs 957 行；实体独有 176 行、归档独有 10 行含 `:where` 中缝规则），本轮只增量补证据与 README，
**未整体覆盖归档**，等专职同步决策。

## 19. 落盘记录：内置浏览器与完整版浏览器打架（2026-09-22；用户「修复内置浏览器和移植浏览器打架的问题」）

**原行为 → 新行为**：产品里同时有两套浏览器 chrome —— `assets/shell.html` 的 `#browser`（内置浏览器，历史副本）
与 `assets/browser-panel.html`（DSH 完整版浏览器，`browserPanelView`）。两者都 `DshBrowserWorkspace.create`、
都渲染标签条/地址栏、都绑 Ctrl+F/L ⇒ 叠两套工具栏并抢快捷键。修后**唯一 chrome = `browser-panel.html`**；
shell 的 `#browser` 永不显示（元素保留满足 byId 契约）。连带：P0 生命周期门禁只约束**卡片内嵌**（有 owner），
无 owner 的 shell 工作区（`openBrowser` 外链/主页组/智能体）放行正式 chrome；撤销只在曾有 owner 时关工作区可见性。

| 文件 | 改了什么 |
| --- | --- |
| `assets/shell.html`（受保护） | `renderBrowser` 恒 `host.hidden=true`；`getState` 恒报浏览器不可见 |
| `assets/browser-panel.html` | 补最大化入口（原先只在 shell 历史副本） |
| `src/main.ts` | `cardEmbedded` 分支放行 shell 工作区；`revokeBrowserPanel` / 三处撤销调用点只在有 owner 时关可见性 |
| `test/browser-panel-layout.test.ts` | 2 条防复发（shell chrome 不得显示；P0 只约束卡片内嵌） |
| `test/sidebar-spaces.test.ts` | Inventor 本机路径断言加 `t.skip` 守卫（环境缺失不再挡构建） |

**精确命令与生效路径**：`Build-DSH-Portable.ps1`（`src/` 改动必须全量构建）→ 候选槽
`1.0.66-local-e5447837f5c9a061`（事务 `90441ec1-…`）→ 用户重启切换。
`ui-baseline --record` 历史 `customizations/ui/history/2026-09-22T15-22-07-490Z.json`。

**门禁与未验证边界**：`tsc` 0；全量 0 fail（Inventor 改 skip）；`ui-baseline` PASS。
**未验证（待用户重启）**：真机只应出现一套浏览器 chrome；外链/主页组能打开并看到页面；切会话/DSH 导航不再误关 shell 工作区浏览器。
详见 [20260922-内置浏览器与完整版浏览器打架修复.md](../01-当前工作/20260922-内置浏览器与完整版浏览器打架修复.md)。

## 20. 落盘记录：浏览器首次打开空白与“+”菜单回归（2026-09-23）

用户允许受控重载后，旧客户端在有历史对话的会话中“+ → 浏览器”首次仍空白；Files→浏览器切换才恢复。实机发现 `browserPanel` 是冻结的 contextBridge 对象，工作台往它上面写生命周期标记和包装方法均无效，隐藏卡片的异步 `tabs()` 查询可能在新卡片出现后才回包并误关新 owner。此前 better-sidebar 的静置 bounds 心跳补丁只覆盖租约过期，不覆盖此竞态。改动前已列出影响：误关新 owner 会白屏；过早禁止 hide 会留下幽灵原生层；重复初始化会产生多个 interval。对应防护：异步回包时复核卡片仍隐藏、保持真隐藏时的清理、把单次安装标记放到可写的 `window`，冻结桥不再尝试包装。

第一候选只修改 `Data/DSH/profiles/web/local/dsh-hj-workbench/lib/client.js`（同目录保留 `client.js.bak-20260923-blank-race`）及异步竞态测试；首次实机通过，但第二次独立重载同路径再次白屏，故该候选明确判失败。白屏时卡片 DOM 可见、owner 却为空；生命周期为 React passive effect。最终候选再将 `Data/DSH/profiles/web/local/dsh-better-sidebar/portable/browser-view.js` 的认领效果移至 `useLayoutEffect`，重生 `lib/client.js`，在 `test/native-browser-card.test.ts` 钉住布局阶段执行，并给 `scripts/build-native-browser-card.mjs` 加断言防下次生成退回旧效果；旧源与旧 bundle 均留同目录 `.bak-20260923-first-claim`。未改外壳源码和现役 Electron 槽。

入口/前端/后端/反馈、失败候选与最终候选对照、截图及未验边界统一见 [I023-62](../01-当前工作/I023-前后端UI全项目审核/62-浏览器卡片静置空白与加号菜单回归.md)。最终候选在连续两次独立 DSH 重载后，原会话首次打开、静置 8 秒、十轮“+”开关和五轮 Files↔浏览器切换均正常；结束前把活动页恢复到原 ERP 地址。`tsc` 与 9 条定点测试通过；全量 582 条中既存 3 fail、21 skip；UI 基线原 10 项漂移未代记。完整 Electron 冷启动和第三方更新后仍需单独复验。

## 2026-09-27 补记：导航与三项失败修复（已部署，待用户确认）

本轮已复现旧导航三次切会话始终禁用，按 rc.2 官方 uiWorkspace.openSession / retainedBy.mainView 适配并加分支、删除、失败与通知回归。侧聊兼容验证改读活动运行时绑定家园，修正活动源图标名；UI 基线保留冻结代际保护并新增活动 bundle / SideChatView 保护。两处既有漂移已逐 hunk 审查，空间/浏览器两次重载与 90–110% 缩放和物理截图通过，才允许追加快照。完整 GCC/GIR、失败尝试和新导航验收状态见 [本轮记录](../01-当前工作/20260927-导航兼容与三项测试修复.md)。

后续闭环：两次全量均 713 / 687 pass / 0 fail / 26 skip，标准完整构建成功；为避免覆盖现役未回写源码的窗口修复，最终候选基于现役收口，仅两份导航桥模块变化（791 文件校验），`9ea0cb9f0a866321` 已健康激活。还原窗口与最大化/重载两轮真实导航各 7 项通过，保留 `e0a2...` 回滚。自动验收不等于用户亲眼确认。

## 2026-09-27 补记：外壳三按钮无响应

后续实机结论：用户确认后修复槽已激活，重启两步确认、Esc取消及实际重启 PASS；返回/前进在会话切换后仍禁用，旧桥依赖已移除的 sessions.list.current，需另行完成导航 API 兼容。本轮三按钮总体验收 FAIL，不沿用下述桩测试通过结论替代真实操作，完整证据仍见同一记录。

用户反馈返回、前进、重启仍无响应。实读现役 shell.html 的中文及引号已损坏，导致整个事件脚本解析失败；正确 assets 源码无该故障。独立资源修复副本与现役 791 文件哈希比对仅 shell.html 不同，不覆盖现役槽，不把内容区点击测试充作外壳验收。新增内联脚本语法/损坏反例测试；9/9 定点、11 项浏览器旧新对照通过，真实 IPC 与重启后验收待确认。详情与 GCC/GIR 见 [本轮记录](../01-当前工作/20260927-外壳三按钮无响应.md)。

## 2026-09-27 补记：点击、缩放与重载阻塞

本轮活动 Electron 追踪反证此前“排除页面插件”的判断：ui-tweaks 搬运失败后因自身 DOM 变化无限重试；现相同失败布局停止重搬，实际布局变化重试，失败保留可用原位置。冷启动及两次独立重载进一步暴露 MCP 无限制策略仍展开所有工具 schema 的后端阻塞，已用版本限定兼容补丁处理，权限分支回归通过。保留完整浏览器及右侧卡片，未改官方运行时和桌面槽。代码路径、旧新对照、失败尝试、真实点击/缩放截图与 GCC/GIR 统一见 [20260927 记录](../01-当前工作/20260927-点击与缩放失效-搬运监听循环.md)。局部实机与 8/8 定点通过；全量 673 pass / 3 fail / 26 skip，不代记既有 UI 漂移，不称整体验收完成。

## 2026-09-27 补记：现役热修复回写与门禁真实目标

18:22激活复核（覆盖下段“已暂存，未重启”的阶段状态）：用户授权重启后，08792候选因补种后再次安装时临时代理tarball URL不匹配官方metadata被供应链校验拦截，未健康提交。已撤销pending、恢复原Profile及15个本地链接，并普通启动9ea0旧槽；五项关键文件与恢复点哈希一致、宽窄三门禁全过、调试端口关闭。新版真实UI验收尚未开始，不得沿用fixture或原版通过结论。完整记录中的激活失败/回退章节为最新交付状态；继续修复缓存来源及二次安装链路后，重新构建并另行确认重启。

本轮按用户批准保留现役点击/窗口过渡修复，但不复制无鉴权 IPC、无条件抢焦点和无代次保护的计时器。门禁统一读取 activeUiProfile；探针按 sampledAt、可见会话页和面板开关状态验收，硬下限采用现有 resolveWorkbenchWidth 的400px契约。resize探针从400ms改为1200ms，避免把CSS动画中间帧当最终几何；不修改宽度、没有伪造探针或重记基线。宽窄实机三门禁通过，加入pnpm12/builder27关联修复后源码全测707通过/0失败/26跳过；两轮独立Electron16/16通过。测试必须让目标窗口实际不被遮挡，不能仅凭native visible/focused判断；临时置顶只用于测试，finally恢复用户窗口状态，不把关闭遮挡检测的诊断参数加入产品。全部失败尝试、GCC/GIR与证据见[完整记录](../01-当前工作/20260927-现役修复回写与候选构建.md)。候选08792d6114f916b8已暂存，未重启激活，不能称产品发布验收通过。

## 2026-09-27 补记：8fd 实机兼容门禁拦截与回退

8fd 候选正常启动并提交 health 后，实机发现定制侧栏缺失。官方同 Profile `--dump-config` 明确拒绝 codex-ui 1.1.20 的 client-runtime peer 范围；未启用 `allow-version`，未改包声明或基线。已恢复重启前 Profile、15 个 junction 和 9ea0 程序槽，正常启动后定制侧栏、会话点击恢复。窄窗三门禁通过；宽窗仍有两条几何检查失败，证据显示脚本整数正则不能读取 `885.4px`，且 hit-test bands 只命中文件列表子元素，不能据此当作整体验收通过。必须分别补齐真实运行时的 bundle 兼容/加载验收与几何门禁回归；健康提交不等于 UI 交付完成。过程、失败截图和回退证据见 [本轮记录](../01-当前工作/20260927-离线元数据与二次安装修复.md)。

## 21. 落盘记录：以移植的完整浏览器为唯一界面（2026-09-24）

用户明确指定“我要我自己移植的完整浏览器”“以后都要以这个为准，最好移除原生的”。这里“移除原生的”指移除旧 `shell.html` 的第二套浏览器 chrome，而不是删除完整浏览器赖以显示网页的 `WebContentsView`。旧 chrome 已删除并由 `test/browser-panel-layout.test.ts` 守护；右侧 browser 卡片只能调用 `browserPanel.show/reportBounds`，不得退回仅支持本地地址的 iframe 或调用系统默认浏览器。`scripts/build-native-browser-card.mjs` 从 `portable/browser-view.js` 重生真实客户端，并检查布局阶段认领及丢失 owner 后的自愈；`test/native-browser-card.test.ts` 检查源码/产物一致及自愈不新开重复网页标签。

本轮实机复现了新竞态：第一次打开可见，连续 20 次“+”正常，但 Files→浏览器后右侧白屏，桥接状态为 `owner:null / visible:false / cardState:visible`，宿主仍有 `563×807` 边界。根因是切换过程中的迟到隐藏可在认领后撤销 owner，而挂载中的 React 卡片不再重新执行首次认领。现在卡片仅在可见、未被弹层遮挡时每秒核对 owner；丢失时调用无 URL 的 `show({owner})` 复用原网页，并强制重报边界。最终候选连续两次独立受控 DSH 重载后，首次打开、各 20 次“+”、静置 8 秒、第一轮 5 次及第二轮 3 次 Files↔浏览器均正常；主动调用 `hide()` 撤销 owner 后 3 秒内自动恢复，浏览器仍只有 1 个标签。证据与未验项见 [I023-62](../01-当前工作/I023-前后端UI全项目审核/62-浏览器卡片静置空白与加号菜单回归.md)。

2026-09-29 设置导航分类排布：ui-tweaks 新增 `installSettingsNavGroups()` 镜像导航（不移动 React 节点，标记类隐藏原官方分组容器 + 克隆镜像 + key 回查转发点击 + 800ms 同步激活态/搜索过滤/空组收起）。六组分类表在 `SETTINGS_NAV_GROUPS`，未识别项进「其他」组。**改动须知**：官方入口按钮不是 nav 直接子节点而是 `div.dcu-settings-groups > section > button.dcu-settings-link`，取值必须用 descendant 查询；可见性判据必须用「原件是否在 DOM」（官方搜索过滤=不渲染），**不得用 offsetParent**（本插件自己隐藏了那个容器，会把全部项判为不可见）。这两条已由 test/ui-tweaks-settings-nav-groups.test.ts 钉死。见 [本轮记录](../01-当前工作/20260929-iOS风格动效层.md)。

2026-09-29 apple-design 三条低风险修正（动效层第五轮）：用户问「apple-design 模块这是什么」，核实为 Emil Kowalski（Vercel/Linear）的 17 条 Apple 设计原则，经 `ui-skills.com` 注册表分发（`emilkowalski/apple-design`；已排除同名的空仓库 `HenryDu8133/dsh-apple-design-theme` 与无关的 npm Vue3 组件库 `apple-design`）。**改动须知，三条都写在 `customizations/ui-tweaks/lib/client.js`**：
① 字排（原则 15）——侧栏分组标题**不要**用 `text-transform:uppercase` + 大字距，那是网页风；Apple 靠「更小 + 更低对比 + 留白分层」。本层已改为去 uppercase、字距 `.01em`、上留白 12px。
② 按下反馈（原则 1）——自绘镜像项补 `:active` 的 `scale(.985)` + `transition:transform 100ms ease-out`。**只加在自绘镜像上**，官方导航自带 animation，叠 transform 会和 `dsh-ios-select` 抢合成优先级。
③ 减弱动效（原则 14，**语义变更，最容易踩**）——`data-dsh-motion` 现在是**三态**：`"ios"` 全量 / `"reduced"` 系统开了「减少动态」时的降档（只剩 180ms 纯 opacity 交叉淡化，位移缩放弹性全去）/ 属性被删 = 整层静止。**`syncFlag` 绝不能再用 `delete …dataset.dshMotion`**——那会让整层零反馈、切换像卡住。`reduced` 档必须**同时**包含计费面板与页签的 `animation:none!important` 接管（选择器只写 `ios` 档时，面板自带的位移入场会在降档里漏出来）。motion-guard 已加**反向断言**钉死这条。
**取证提醒**：镜像盒有 800ms 轮询重排，**采样前必须先 `elementFromPoint` 命中测试**，别用上一轮记下的坐标——本轮就因坐标过期（y=70 → y=160）误判 `:active` 失效。CDP 的 `Emulation.setEmulatedMedia` 会在连接断开时自动复原，所以「设媒体 + 触发交互 + 读结果」必须放在**同一次** CDP 连接里。见 [本轮记录](../01-当前工作/20260929-iOS风格动效层.md)。

## 2026-09-29 补记：设置导航 19 枚图标去重 + 颜色统一（ui-tweaks 第六轮）

用户看设置页导航后指出「图标有一样的而且颜色深浅还不一样」。**根因两条，都在官方侧，本层只能绕不能改**：
① 官方 `sectionIcon(id)`（`@michengai/dsh-codex-ui`）是十几条正则分支 + 一个 `Box` 兜底，
`/plugin/` 同时命中「内置插件」「插件配置」，`/connector|mcp/` 同时命中「连接器」「外部智能体接入」，
`/expert|agency/` 与「Agent 预设」共用 `User`，没被命中的（自定义空间 / DSH 手册 / Codex UI / 宠物 …）
全掉进同一个 `Box`；② better-sidebar 自己那行用 `::before` + `currentColor` 画图标，其余行用克隆来的
官方内联 `<svg>`，颜色各随各的 CSS 走。

**改法（纯 CSS，仍在本层铁律内）**：`.dsh-sg-item > svg{display:none}` 隐掉克隆来的官方图标，
每项按 `data-dsh-nav-key` 配一枚 CSS `mask` 图标（lucide-react，ISC，路径数据由
`Data/Temp/gen-nav-icons.cjs` 从磁盘上的包提取生成，**不手抄**），统一
`background:currentColor; opacity:.62`，`padding-left:30px` 让位。激活态只靠底色和字重区分。

**三条改动须知（下次维护必读）**：

1. **`data-dsh-nav-key` 是 `navKey(textContent)` 的结果，`navKey` 会 `replace(/\s+/g,'')` 去掉全部空白。**
   选择器写 `Agent 预设`（带空格）就**一条都匹配不上**——第一次真实 DOM 验证直接抓到
   `noIcon: ["Agent预设","DSH手册","CodexUI","IM助理"]`、`distinctIcons: 16`。
   `test/ui-tweaks-settings-nav-groups.test.ts` 的 `navMembers()` 已改成按 navKey 形态比对，钉死这类错。
2. **选择器前缀必须带 `.dsh-settings-groups`**，与既有 `.dsh-sg-item` 规则同特异性；只写
   `.dsh-sg-item` 会被「后层按选择器胜出」把 `padding`/`color` 压回去。
3. **生成的 data URI 里单引号要编码成 `%27`**，否则包不进单引号 JS 字符串（本层 CSS 是字符串数组）。

**取证教训第三条**：设置页会**自动关闭**，且镜像盒 800ms 重排会让 y 坐标漂移。「读几何」和「截图」
分两次 CDP 连接做，坐标就废了——第一次跑出「归档会话 ink=0」，实际是拿旧坐标裁新画面。
**几何与像素必须同帧取**（同一 `seq` 里 `Runtime.evaluate` 紧跟 `Page.captureScreenshot`），
末项先 `scrollIntoView` 让它进视口。另：`/json` 与 `/json/list` 都要取，DSH 的 WebContentsView
目标有时只在 `/json` 出现；9444 曾有僵尸监听（OwningProcess 已不存在），改用 9445。

**验收**：19 项 19 个互不相同的像素签名、无空白项，19 项 `rgb(24,24,27)@0.62` 色深一致，
真实点击「插件市场」→ `activeMirrors:["插件市场"]` / `data-settings-section:"market"`。
`tsc` 0；本文件测试 11/11；全量 784/758/0 fail/26 skip；`ui-baseline` PASS；四副本同步并上锁，
SHA256 一致 `23D97308…17E3508`。证据 `customizations/ui-tweaks/evidence/settings-nav-icons-20260929/`。
详见 [本轮记录](../01-当前工作/20260929-iOS风格动效层.md)。
