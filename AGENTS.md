# AGENTS.md — 智能体强制开发指令（DSH 便携版 3）

本仓库是 **DeepSeek Harness (DSH) 官方应用**的便携版定制。DSH 是插件化架构：**产品一切部分皆插件，一切注册可逆**。定制功能前必须理解并遵守官方插件规范。

> 🚀 **入口捷径**：凡开发功能、修复缺陷或改动插件/外壳/打包脚本，先加载 `dsh-dev-spec` 技能——它把本文件的「必读文档 → 审查清单 → 类型/测试门禁」固化为可执行流程，避免凭记忆跳过审查。技能未注册时才按本文件手工执行。

## 🧭 智能体行为边界（全局，所有会话生效）

**智能体是执行方，不是指挥方。** 凡智能体自己有能力完成的动作（浏览器自动化、文件读写、数据整理、脚本运行、检索调研），一律自己动手完成，不得反将其推回给用户。

**仅允许找用户的三类事项：**

1. 需要用户本人身份/凭据的操作（如输密码、扫码登录）；
2. 难回滚写操作的最终确认（批量修改、删除、部署切换等——按各子目录 AGENTS.md 的红线执行）；
3. 规则、口径或方案存在实质冲突，需要用户拍板。

**找用户的方式也有约束：** 必须带选项与建议（"建议 A，理由…；备选 B，代价…"），不允许开放式甩任务（"你看怎么办？"）。遇到智能体无法完成的事，先说明原因、给出已做的最佳尝试，再列选项——而不是把原始任务原样退回。

## 🧯 止损纪律（防"越修越坏"｜每轮必守）

> 来源：2026-09-13 外壳顶栏失效修复的复盘（[41 号记录](docs/01-当前工作/I023-前后端UI全项目审核/41-顶栏工具组失效修复.md)）。当时 bug 是别人引入的，但"修好了用户却看不到"是执行失误——修复卡在候选槽、没让用户重启确认。以下七条专治这类失败。

1. **诊断先行**：改代码/配置前先写一行 `问题是 ___；证据是 ___；下一步是 ___`。没有证据不动手，也不拿"先读一遍/先加载技能"充当诊断。
2. **对照复现**：宣布"修好了"之前，必须能用旧制品**复现原故障**，并证明新制品不再复现。只有正向通过、没有反向对照，不算证据。
3. **交付闭环**：候选槽就绪 ≠ 完成。凡需切换/重启才生效的改动，必须让用户重启后亲眼确认；未确认前只能说"候选已就绪"，不许宣布修复完成，也不许顺势去开下一个话题。
4. **共享状态先读清单**：`ui-baseline --record`、改写 baseline / 索引 / 清单前，先比对"本次改动 vs 受保护清单"，并逐文件核对与上一版的差异。撞上他人会话在途写入时**不替它背书**，如实报漂移。
5. **长任务留检查点**：上下文压缩或交接前落一段 `目标 / 已验 / 未验 / 下一步`；恢复时先复核任务身份与验收，再动手，不把别的任务的失败计数接过来。
6. **一 bug 一会话**：得出结论就落文档或黑洞条目；跨天接力靠制品，不靠记忆。
7. **构建与候选激活不并发**：`Build-DSH-Portable.ps1` 会启动脱离进程的回收清理器，在 G: 盘逐文件删除数万个文件（实测 20 分钟删掉 3.3 万个），候选槽冷启动撞上这段盘 I/O 会卡住主视图加载。2026-09-19 实证：候选 14:51:30 启动、其 DSH 服务端 14:51:52 正常 boot，但同一时刻另有构建在建（14:54:07）且回收器正在删 4.4 万文件，7 分钟后主视图 `ERR_FAILED` → fail-closed 退出 → 启动器自动回滚（候选内容已排除：与现役槽只差一个非启动路径默认值）。**规则**：构建与"请用户重启激活候选"必须串行——先让 `Data/Temp/prepare-recycle/` 排空（回收器连扫 3 轮空后自行退出）再请人重启；被杀的构建会留下孤儿回收桶与冻结的 `.sweeping` 心跳，下一个构建才接手清理。

## 定制永久保留门禁（用户决定，2026-09-30）

所有新增、修复、下线以及更新/重构，必须明确功能的持久源码归属、生成/安装路径、活动 Profile/桌面槽与回归证据，不能只改现役文件。更新或重新构建不得让已接受功能回到原版。机器可读保护清单为 `customizations/preservation.json`，执行模块为 `src/customization-preservation.ts`；同时继续执行既有 UI baseline，不以新清单替代 UI 行为验收。

构建与切换前捕获实际本地插件、启用状态、运行文件、稳定 patch/link 和来源；候选必须保持这些能力与用户开关。发现丢失、意外禁用、错误链接、未批准源码漂移或缺少新内核家园/兼容配套时阻止切换，保留现役，不自动删功能或扩大兼容豁免。合法变更要记录差异、补负向对照与真实组合验收，再更新保护记录；禁止仅改哈希放行。完整规则见 `docs/03-技术架构/构建更新与定制防回退规则.md`；本轮证据见 `docs/01-当前工作/20260930-构建独立更新与定制保护.md`。

完整构建须封存源码/工具/正式测试输入、编译后 dist 与真实打包制品；只在门禁完成且输入未漂移时形成成功 receipt。UI 快通道只能替换明确映射的非嵌入素材，不凭 git dirty、mtime 或 `-Force` 认定旧 asar 对应新源码。新本地候选缺最终事务凭据时不得激活、健康提交或从 slots 扫描恢复；构建/装配租约持有到激活提交或完整回退结束。current/previous/pending 对应的定制快照和事务凭据也是受保护运行配套，不能当“已完成临时文件”清理。

## 官方兼容性双基线

- **实现基线**：以便携版实际内置的 `@deepseek-ai/dsh` 版本、导出和类型声明为准；不得因为官方最新文档出现新 API 就直接在旧运行时中调用。
- **审查基线**：每个功能开始前运行 `Tools/node/node.exe scripts/gate-node-run.mjs scripts/verify-dsh-official-baseline.mjs --online`，核对 `deepseek-ai/deepseek-harness` 官方 HEAD。官方变化时，必须先人工审阅官方 `AGENTS.md`、架构、测试规范和受影响子系统，禁止自动接受后继续开发。
- 机器可读版本记录和适用规则见 `docs/03-技术架构/DeepSeek-Harness-官方兼容基线.json` 与同名 `.md`。无法联网核对时只能继续诊断，不得宣称“符合官方最新要求”。
- **上游同步与便携保护基线（2026-09-19）**：吸收桌面上游（MichengAI/dsh-codex-desktop）前必读 [上游同步与便携保护基线.md](docs/03-技术架构/上游同步与便携保护基线.md)——保护文件三档清单、四类差异处理、固定 10 步升级流程与发布门禁；混合文件（`src/main.ts`、`src/plugin-seed.ts`、`src/bundled-plugins.ts`、`package.json`、`cordis.patch.yml`、`assets/**`）**禁止整文件取上游**，必须逐 hunk 人工核对。

## ⛔ 强制流程：任何功能增加或缺陷修复之前

**凡涉及以下范围的改动，必须先通读规范知识库并逐条对照审查：**

- `src/`（Electron 主进程 / 桥接层）、`browser-library.cjs`
- `Data/DSH/profiles/**` 下的插件（如 `dsh-sidebar-spaces`）、`cordis.patch.yml`
- `App/resources/**` 运行时装配产物、`scripts/prepare-runtime.ts`、打包与启动脚本
- `package.json`（版本、bundledNodeVersion、extraResources）

**必读文档（按序）：**

1. `docs/03-技术架构/DeepSeek-Harness-官方兼容基线.md` —— 已安装版本与官方最新提交的双基线
2. `docs/03-技术架构/DeepSeek-Harness-插件开发规范知识库.md` —— 完整规范知识库（本仓库整理，含接口代码与铁律）
3. 本功能涉及的官方 Reference/Cookbook 页面与内置运行时类型声明；不能用本地摘要代替受影响子系统的一手资料

**审查动作（写代码前逐条自问）：**

- [ ] 我的新行为归属正确吗？对照知识库第 10 节"新行为归属表"（工具→`ctx.tools`、提供方→`ctx.llm`、拦截→事件、命令→`ctx.commands`、后台任务→`ctx.jobs`）
- [ ] 是否触碰"模型可见输入"？是 → 必须新增会话事件（扩展 `SessionEventMap`），铁律 1"模型可见即已记录"
- [ ] 插件导出是否符合三种合法形态之一（`name` + `inject` + `apply`）？
- [ ] 所有注册是否经由 `ctx`（自动清理）？有没有违规的手动 `removeListener`/`clearInterval`？
- [ ] waterfall 监听器是否都调用了 `next()`？
- [ ] 可调参数是否都做成了 Schemastery 配置而非硬编码？
- [ ] 本地插件路径是否绝对路径？patch 条目是否带稳定 `id`？
- [ ] patch 覆盖是否重述了整行配置（后层按行胜出，非深合并）？
- [ ] 是否以真实 Profile + Loader 组合验证了产品可见插件，而不只有手工挂载单测？
- [ ] 用户可见状态是否只在事务提交点后发布？新增 Client UI 文案是否由本地化字典拥有？
- [ ] 生命周期、并发、子进程或清理改动是否覆盖取消、处置、超时和进程树回收？

## 🔗 前后端与 UI 三项对齐（强制）

**UI / 侧边栏修改与升级必读**：[UI 定制维护契约](docs/03-技术架构/UI定制维护契约.md)。这是用户要求的长期维护入口。每一轮落盘修改都要追加原因、改法、文件/构建路径和本轮验收证据，失败尝试也要记，禁止只在最终答复留一句结论。最新用户决定覆盖旧图；不得恢复已取消的顶部工作区条边框、旧浏览器入口或删掉右侧卡片。

改动前、更新后及交付前运行 `Tools/node/node.exe scripts/gate-node-run.mjs scripts/ui-baseline.mjs`（门禁 Node 的版本要求见下节「强制验证」的更正说明）。漂移必须调查，合法修改完成实际 UI 验证和记录后才可用 `--record --note ... --evidence ...` 追加新基线，再过全测。禁止直接改哈希/删测试放行。受保护源码快照与历史在 `customizations/ui/`，Data/artifacts 不入库的问题不能再被忽略。该检查是开发/构建门禁，不替代第三方更新后的真实点击和缩放验证。

所有新增、修改、下线的用户功能，包括仅修改前端、样式或插件客户端的变更，必须执行 [变更与答复质量门禁第 6 节](docs/01-当前工作/便携版3-变更与答复质量门禁.md#6-前后端与-ui-三项对齐强制门禁)。该节是三项对齐规则的唯一事实源，进入功能开发前必须阅读。

- 开发前更新功能清单，建立“用户入口与子界面 → 前端事件与调用 → 后端处理 → 结果反馈”的对应关系，并从后端反查用户入口。
- 后端用户能力必须有可达入口；可操作控件必须产生真实行为及反馈；主页面、弹窗、二级界面必须验证交互、布局和状态。内部能力或纯前端交互的例外须按门禁记录理由。
- 交付前完成适用的真实链路与 UI 验证并保存证据。有入口缺失、点击无反应、虚假成功、关键界面不可用或缺少运行证据时，不得标记验收通过。
- 后续新增、修改和下线均须同步对齐记录；历史“已实现”标记不能替代本次验收。

## 🧭 全局上下文检查 GCC / 全局影响复查 GIR（强制）

中/大型任务（判定标准见模板）禁止收到任务后直接改代码。系统认知层入口：`docs/05-系统认知/00-总览索引.md`（阅读顺序 + 任务路由 + 最高优先级警报）。

- **任务前**：按 [GCC 模板](docs/05-系统认知/10-GlobalContextCheck与ImpactReview模板.md) 完成 12 项前置检查并填写结论模板（Task Position / Direct & Indirect Impact / Reusable / Constraints / Expected Files / Do Not Touch / Regression Scope）。
- **任务后**：按同一模板完成 10 项 GIR；实际修改范围超出预期（第 2 项 YES）必须重新执行影响分析；破坏公共接口/数据结构/架构（第 5–7 项）必须附论证；门禁与回归全 PASS 才能在 `docs/00-交接入口/07-功能清单.md` 登记"已实现"。
- 模块职责、依赖、数据流、架构决策（32 条 D-xx）以 `docs/05-系统认知/` 为第一索引；该目录与代码冲突时以代码为准。
- **codex-ui 双拷贝已退役（2026-09-11）**：`local/dsh-codex-ui` 陈旧副本（0.2.113 + 历史补丁）已删除，备份在 `Data/Development/archived-local-dsh-codex-ui-20260911.zip`；活动版是 npm `@michengai/dsh-codex-ui 1.1.2`。**1.1.2 缺失旧副本的定制功能**（批量归档 BatchArchivePanel、data-plugin 样式归属标记等），test/ 里相关用例处于 existsSync 跳过态——恢复这些功能要先做新迭代，不要试图复活旧副本。

## ✅ 强制验证：改动完成之后

> **2026-09-27 最新升级补充**：版本以当前清单为准；构建工具改用 `Tools/node-v<engines.node>` 与 `Tools/pnpm-v<packageManager版本>`，不覆盖其他会话仍使用的旧工具。下方历史 `Tools/node/node.exe` 命令须加 `scripts/gate-node-run.mjs` 再接目标脚本，或使用清单 SHA256 验证过的版本目录 Node。pnpm 12 的 Node 入口是 `bin/pnpm.mjs`，禁止继续把旧 App 的 `pnpm.cjs` 当成最新工具，也不能把原生 pnpm.exe 交给 Node 解释。现役槽版本与候选源码版本必须分开记录。

1. **类型与测试门禁**（必须全绿才算完成）：

   ```sh
   # 门禁解释器一律经 scripts/gate-node-run.mjs 转发 —— 它会 re-exec 到清单哈希命中的那个 Node
   ./Tools/node/node.exe scripts/gate-node-run.mjs node_modules/typescript/bin/tsc
   ./Tools/node/node.exe scripts/gate-node-run.mjs scripts/run-tests.mjs   # 全量测试：每次跑在独立临时目录，跑完自动清理
   ```

   注意：门禁 Node **版本必须等于 `package.json` 的 `config.bundledNodeSha256[平台-架构]`**，禁止用系统 Node（版本门禁）。

   > **⚠ 2026-09-26 更正（登记册 R-170）**：此前本文写的是 `App/resources/node/node.exe`，但工作区那个目录是**一棵 `1.0.43` 旧构建树的快照**——其 `resources/app.asar` 自述 `bundledNodeVersion=v24.20.0`，与自身 node 的旁置 `.sha256` 完全自洽，**却与当前清单/`Tools/node`/`runtime-node`/部署槽（全部 v24.21.0）不一致**。
   > 后果是**静默的**：门禁在 v24.20.0 上通过，而产品实际跑 v24.21.0 ⇒ 绿灯不覆盖真实发行运行时；且 `scripts/prepare-runtime.ts:167` 的版本守卫在该 Node 上必然抛错。
   > 需要 pnpm 的命令仍取 `App/resources/node/pnpm-package/bin/pnpm.cjs`（`Tools/node*` 不含 pnpm）。
   > **脚本内的门禁 Node 请用 `scripts/lib/gate-node.mjs` 导出的 `GATE_NODE`**，它会自动挑选哈希命中清单的那个并告警说明；已接入 `gates.mjs` / `run-tests.mjs` / `lint-ui-discipline.mjs` / `watch-ui.mjs`。
   > 旁置 `.sha256` 由同一个二进制生成 ⇒ **只能发现损坏，发现不了错版**；`src/runtime.ts` 已增加"应用自身清单"的交叉校验来补这个盲区。

   > **🔴 2026-09-29 二次更正：上一条「改用 `Tools/node/node.exe`」已再次过期**。清单换代到 `v26.10.0` 后实测：`Tools/node/node.exe` 停在 **v24.21.0、哈希 `BA4E6D11…` 不再命中清单**（当时命中的是 `Tools/node-v26.10.0/node.exe` 与现役槽 `resources/node/node.exe`，哈希 `CEA6AC36…A9BC4` = `bundledNodeSha256['win32-x64']`）。
   > **这正是 R-170 换了版本号重演一遍**：按本文字面裸跑 `tsc` 又变成在错版运行时上取绿灯。**因此本节所有命令一律加 `scripts/gate-node-run.mjs` 转发**（`README.md:149-152` 已是这个写法），或直接用 `Tools/node-v<清单 bundledNodeVersion>/node.exe`。
   > **不确定当前该用哪个就跑这一句**：`node -e "import('./scripts/lib/gate-node.mjs').then(m=>console.log(m.GATE_NODE))"`。
   > `GATE_NODE` 候选顺序：`Tools/node-v<版本>` → `Tools/node` → `App/resources/node` → `process.execPath`，取**第一个哈希命中清单**的；全不命中即抛错拒跑，不降级为未校验门禁。`run-tests.mjs` 自身也用它 spawn 测试子进程，所以经运行器跑的测试结果始终有效。

   **不要直接裸跑 `node --test dist/test/*.test.js`**：多数测试用 `tmpdir()` 建目录且不自行清理，实证每轮残留约 270 个目录（曾累积到 `Data\Temp` 1.58 GB）。运行器把子进程 `TEMP/TMP/TMPDIR` 收口到本次运行目录、全绿即删、失败时保留路径；需要保留现场排查时先设 `DSH_TEST_KEEP_TMP=1`。单独跑某个文件同样走运行器：`scripts/run-tests.mjs dist/test/foo.test.js`。
   运行器已加**跨进程互斥**（`Data/Temp` 同级的 `dsh-test-runs/run-tests.lock`）：两个会话同时跑测试会串行等待而不是互相踩临时目录（此前会造成 `EPERM`/`EEXIST` 伪失败）。等待窗口用 `DSH_TEST_LOCK_WAIT_MS` 调，`DSH_TEST_NO_LOCK=1` 可跳过。

2. **重新打包 + A/B 候选部署**（`src/` 改动需要）：

   ```sh
   powershell -NoProfile -ExecutionPolicy Bypass -File Build-DSH-Portable.ps1
   ```

   该命令完成类型检查、测试、打包和候选暂存，但不覆盖正在使用的 `App/`，也不结束桌面进程。之后从托盘正常退出或使用“重启应用”，`Start-DSH-Portable.ps1` 才会切换候选、验证健康文件并在失败时自动回滚。禁止恢复已删除的原地覆盖部署脚本。

2.1. **只改界面素材（快通道，秒级）**：改动只落在 `assets/**` 时不必跑整条装配。`assets/*` 在 `build.extraResources` 里是原样复制到 `resources\`，不进 `app.asar`、不经 `tsc`，所以把差异素材铺进 `release\win-unpacked\resources\` 再走同一个候选槽即可。

   ```sh
   Build-UI-Only.cmd            # 门禁通过才同步素材并暂存候选槽
   Build-UI-Only.cmd -DryRun    # 只跑门禁与差异报告，不动任何文件
   Build-UI-Only.cmd -SkipStage # 只刷新 release\win-unpacked，不暂存
   Build-UI-Only.cmd -Force     # 仅兼容旧参数；不绕过任何门禁、不携带未打包源码
   ```

   门禁会拦下必须全量构建的情况：`src/**`、可执行 `scripts/**`、`plugins/**`、`customizations/**`、`package.json`、编译配置、锁文件、工作区依赖配置或 `node_modules/**` 有改动，或 `dist/` 比 `resources\app.asar` 新。**被拦是预期行为**——界面快通道无法携带会进 `app.asar` / `resources\desktop-bridge\` 的改动；历史 `-Force` 强推会得到"新界面 + 旧主进程"的混血槽，**该旁路已禁止**。当前 `Build-UI-Only.ps1` 无论是否传 `-Force` 均执行门禁裁决、编译新鲜度、UI 源码基线、活动 Profile 与既有候选资源的定制保护；任一失败必须先解决或走全量构建，不得用旧 `app.asar` 强推。

3. **端到端验证**：双击 `DSH便携版3.exe` 启动，确认候选通过清单哈希、主界面与 DSH readiness、`Data/Updates/Desktop/state.json` 进入 `completed`，且 `Data/Electron/UserData/startup-error.log` 没有新增错误。

## ⚠️ 本仓库已踩过的坑（不要再犯）

- **GNU tar / bsdtar 差异**：`runtime-archive.ts` 必须运行时探测（GNU 才加 `--force-local`）。测试环境（Git Bash）解析到 GNU tar，用户双击启动器环境解析到 System32 bsdtar —— **测试通过 ≠ 用户可用，必须用双击启动器路径验证**
- **ps1 脚本必须带 UTF-8 BOM**：PowerShell 5.1 按 ANSI 解析无 BOM 的 UTF-8，中文注释会导致语法错误
- **`prepare-runtime` 的删除阶段曾要 20–50 分钟（2026-09-13 定案，并已在脚本内根治）**：装配第一步 `removePreparedPath` 要清掉 `runtime-node` / `runtime-plugins` / `runtime-dsh` / `runtime-dsh.tgz`。真实原因有两条，**都不是"沙箱静默挂起"**：
  - ① **安全删除守卫是秒级抛错，从不挂起**。它经 `NODE_OPTIONS=--require node-language-shim.cjs` 注入每个 node 进程，撞阈值后 `bulk-guard check` 打印 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 并 `exit 2`，shim 转 `throw` —— 实测 **1.09 秒**就返回。**历史旁路记录（禁止执行，不是操作指令）**：旧实现曾通过清空 `NODE_OPTIONS`、关闭 `CODEBUDDY_SAFE_DELETE_ENABLED` / `CODEBUDDY_SAFE_DELETE_SANDBOX` 避开注入，还存在保护环境传不到孙进程的问题；这一做法违反当前安全边界，已从 `scripts/prepare-runtime.ts` 移除。**当前必须完整继承宿主删除守卫环境**；保护拒绝时保留诊断并有限重试/隔离，不得清空或覆盖守卫变量、改用另一 shell 或外部删除命令继续执行。
  - ② **真正的耗时是本盘删小文件极慢**。实测同一份 20 个小文件：**G: 盘 1008ms（50.4ms/个）、C: 盘 7ms（0.3ms/个）—— 慢 168 倍**；读 / stat / 列目录全都正常（200 次 stat 仅 14ms），所以**不是盘坏了，是删除被逐文件拦截**。`runtime-plugins` 有 **44116 个文件**（`store` 19224 / `staging` 20799 / `offline-verification` 4093）⇒ 单轮同步清理 **≈37 分钟**，全程 CPU≈0、无任何输出，与"进程卡死"外观完全一致。**它慢，但活着**，别杀进程。
  - **回收优化及安全收敛（2026-09-30，`scripts/prepare-runtime.ts`）**：先将明确归属的生成目录同卷移动到 `Data/Temp/prepare-recycle/`，再由后台清理器处理；跨卷/占用时只使用同一受保护的 Node 删除路径。禁止清空删除守卫环境或换 shell 绕过拒绝。删除前和每轮 worker 都核对逻辑路径、真实路径、普通目录及祖先链接；失败有限重试后隔离为 `.failed` 并留诊断，不无限自旋。启动器遇到活跃回收队列/心跳仍阻止候选激活，普通已隔离诊断不再永久阻塞。2026-09-13 的旧耗时数据不是本轮缓存提速证据；本轮需实际测量后才报效果。
  - **回收区自清理**：一次构建会依次回收 `runtime-node` / `runtime-plugins` / `runtime-dsh/.store` / `store/v11/projects` 等，后台清理器**循环清空回收区**（连续 3 轮扫空后自动退出），无需人工干预；`Data/Temp/` 本身在 `.gitignore` 内，也不进 `app.asar` / `extraResources`。
  - **🔴 2026-09-29 清理器卡死根因（两次复现"心跳在跳、两小时零删除"）——两层叠加，均已修复/定位**：
    ① **双实例竞态**：构建的 `pnpm run pack` 与 `prepare-runtime` 并行启动，两进程同时发现无心跳 → 各 spawn 一个清理器 → 双实例对同一桶**并发 rmSync 互踩**（EBUSY/ENOENT 竞态）→ rm 子进程静默退出（`stdio:'ignore'` 且无 exit 监听）→ sweeper 干等 pending 的 2 小时超时。修复（`RECYCLE_CLEANER` 三处）：启动时**心跳抢占让位**（后到实例自杀）；rm 子进程**非零退出立即重置 pending**；同桶**连续失败 3 次改名 `.failed`** 移出队列。
    ② **本机第三方安全软件对 PE 文件持句柄锁**（Windows Defender 服务不可查询 0x800106ba ⇒ 有第三方杀软接管）：`node.exe` 等可执行文件 unlink 报 **EPERM**（改名成功但改名后删仍 EPERM=锁跟文件走；杀光所有进程仍 EPERM=非进程占用）。这也重新解释了上面"G 盘 50.4ms/个"的历史实测——**是杀软对 PE/扫描热文件的选择性慢，普通文件实测 ~688 个/秒（1.5ms/个）**，18.8 万文件 5 分钟删完（`Data/Temp/purge-recycle.mjs` 两阶段：删能删的 + EPERM 清单落 `recycle-cleanup-report.json`）。**根治需在杀软面板给 `Data\Temp\` 加信任/排除**（待用户操作）；代码侧 `.failed` 隔离已防锁文件阻塞清理。
  - **判"慢但活着"的三条独立证据**（只在强制关掉回收后才会用到）：`(Get-Process -Id <pid>).CPU` 两次相减 > 0；`Win32_Process` 的 `OtherOperationCount` 每 45 秒涨几十万而字节量 <1MB（元数据密集 = 在推进）；递归文件数**下降 = 正在删（正常）**。
  - **进度指标陷阱**：`runtime-plugins\store\v11\files` 下是 **2 字符前缀目录**，数顶层条目恒等于 256 就"饱和"，必须**递归**数文件。
  - **中断过的构建仍会让产物残缺**：`prepare-runtime` 按 `[runtime-node, runtime-plugins, runtime-dsh, runtime-dsh.tgz]` 先清后建；被中断的构建**只清不建** ⇒ `runtime-node\`、两个 `.tgz` 全缺，只能全量重跑 —— 回收区里的副本是临时的，别指望拿它复用产物。
- **插件 `lib/` 结构**：`dsh-sidebar-spaces` 的 `node_modules` 实例曾因缺 `lib/index.js` 崩溃（ERR_MODULE_NOT_FOUND）；修复物在 `local/dsh-sidebar-spaces`，不要破坏
- **禁止原地覆盖 App**：桌面更新和本地构建只可写入 `Data/Updates/Desktop/slots/` 的不可变候选槽；通过启动验证前必须保留当前槽，失败由启动器自动回滚。
- **🔴 槽固化后禁止直写，降级必须可见（2026-10-01 回滚事故）**：1.0.78+build.1 被回滚到 1.0.77 且**用户全程零提示**，两条独立成因。① **降级被记成 `none`**：指针退回旧槽时 `Save-RecoveredDesktopPointer` 一律写 `Set-UpdateState -Phase 'none'`，而 `src/main.ts` 的 `applyPortableDesktopUpdateState` 把 `'none'` 映射成 `kind:'none'`＝"当前已是最新版本" ⇒ 用户跑旧槽、界面说已是最新。**规矩**：任何"指针退回旧槽"的路径都必须发 `rolled-back`，候选撤回后指针已无 `pending`，被撤回版本只能由调用方用 `-TargetVersion` 显式传入。② **已提交的候选被二次降级**：`health.json` 已落盘、`events.jsonl` 已记 `completed`，启动器仍按 3 分钟进度租约空等到期后走回退分支。**规矩**：回退前必须 `Test-DesktopReferenceMatch (freshPointer.current) $pendingReference`，命中即 `return committed` —— 候选进程自己提交指针，启动器只是观察者，拿旧快照覆盖观察结果就是把健康版本降级；等待提交要有诊断出口（45s `publishDeadline` 把 `state.phase`/`transactionId` 写进日志），不许静默空转。③ **完整性失败也是降级**：当前槽 `Test-CompleteDesktopSlotFiles` 不过时走 `pointer.previous`/`slot-scan`，同样必须带 `DowngradeReason` 发 `rolled-back`。用户可见提示在顶栏 `#restart-btn` 左侧的黄色胶囊（`.rollback-capsule`）。④ **根因之一是往已固化槽里直写素材**：槽内 `resources/settings.html`（16:21:46）与 13:34:44 固化的 `slot-manifest.json` 记录不一致。**写 `assets/**` 只改源码**，`Build-UI-Only` 第 5 步会重建槽并重生成 manifest；往已暂存槽直接拷文件 ⇒ 下次启动完整性校验必然失败（605 个文件全树重哈希）。护栏：`test/rollback-notice.test.ts`（6 项）。
- **候选槽只留两版：current + previous（用户规则，2026-09-19）**：单槽 ≈780 MB，A/B 契约只需要「当前槽 + 一个回滚目标」。`prunePortableDesktopSlots` 默认 `keepUnreferencedSlots = 0`——指针引用的 `current` / `previous` / `pending` 永远保留，**其余槽一律删除**，不额外留历史版本；需要多留几版只允许通过显式传参（测试用），不得改默认值。调用点只有两个，都在事务提交点之后：`confirmRunningCandidate`（健康提交后）与 `stageLocalDesktopBuild`（暂存后）。**手工删槽前必须先读 `pointer.json` 的 current/previous 与 `state.json` 的 pending 事务**，只删三者之外的目录；`Data/Runtime/Harness/slots/` 是运行时槽，不适用本规则（另有自己的保留策略）。
- **上游"启动清理"移植必须评估便携盘 I/O 量级（2026-09-19 死页事故）**：上游 v1.0.65 的 `stripOfficialProfileDependencies` 每次启动全删 profile 的 `node_modules/@deepseek-ai`，靠"运行时自装官方层"兜底——上游环境（SSD、store 对齐）秒级完成；便携盘 G: 上是 4.4 万文件级 pnpm 全量校验重装，实测 7-8 分钟且失败 → 主视图永远停在加载屏 → 候选激活连续超时回滚、现役槽也死页（现象极像"候选槽坏了"，实为每次启动都发生）。**凡移植上游启动路径改动，先问"这个操作在 G: 盘 4.4 万文件规模下要多久、失败会怎样"**；修复后的护栏语义见 07-功能清单 47 行。
- **electron-builder TEMP**：NSIS 打包时 TEMP 必须指向真实可写的用户临时目录，否则找不到临时 include 文件。`Build-DSH-Portable.ps1` 已通过 `Portable-Environment.ps1` 的 `Set-DshPortableEnvironment` 设置（`TEMP/TMP` → `<便携根>\Data\Temp`，`ELECTRON_BUILDER_CACHE` → `Data\Development\electron-builder-cache`）；**绕过该包装脚本直接跑 electron-builder 时必须自行设置这两个变量**
- **PowerShell 转义**：Git Bash 里调用含 `$_` 的 PowerShell 命令会被 Bash 展开，用单引号包裹或写成 ps1 文件
- **DSH 插件服务名与注入**：`ctx.command()` 不存在——命令服务名是 **`commands`（复数）**，注册 API 是 `ctx.commands.register({name, description, input:{hint}, handler(invocation)→{kind:'success',text}})`；服务未在组合中时改用 `ctx.get('name')` 可选访问，**不要**把不存在的服务写进 inject（否则 PENDING 导致启动失败）。注入声明的有效通道**按导出形态区分**（2026-09 对照 MichengAI 8 个社区插件与本仓库 plan-quota / dsh-sidebar-spaces 源码核实，见下方「社区插件生态实证」）：① **命名导出** `name`+`inject`+`apply` → 模块级 `export const inject` 即生效，patch 条目只写 `id`+`name`；② **default export 类** → 类静态 `static inject = [...]`；③ **default export 函数** → loader 不读模块级 inject，必须在 cordis 条目（bundle 的 cordis.patch.yml）写 `inject:` 字段——plan-quota 即此形态，缺失时抛 "cannot get property command without inject"
- **profile 本地插件已改为目录链接（2026-09-11 迁移）**：`node_modules/<本地插件>` 是指向 `local/<插件>` 的 Junction，**改 `Data/DSH/profiles/web/local/<插件>` 即时生效，无需同步到 node_modules**；声明必须用 `link:./local/<名字>`（改回 `file:` 会重新物化拷贝、复活双拷贝陷阱）；新插件若已在 lockfile 以 `file:` 解析，需摘除 lock 条目重装才会变成链接。迁移记录与回滚步骤见 [评估文档](docs/03-技术架构/评估-目录链接替代插件双拷贝.md)
- **外壳内浮层盖不住 DSH WebContentsView**：独立合成层永远在外壳 HTML 之上，z-index 无法穿透；工具栏类交互用按钮内联状态（两步确认），别做应用内模态
- **profile 包 specifier 领先安装是地雷**：`Data/DSH/profiles/web/package.json` 的依赖版本可能被插件市场侧提升而未实际安装（node_modules 还是旧版）；任何 `pnpm install`（包括为无关目的跑的）都会把整个新矩阵物化。2026-09-11 实例：link 迁移的 install 物化了 codex-ui 0.2→1.1 全矩阵，引发三连故障——①codex-ui 1.1 侧栏改用 `--dcu-sidebar-*` 变量命名空间，theme.css 未覆盖导致设置页回退淡绿（已补映射+防回归测试）；②旧矩阵提升的裸 `schemastery` 被剪枝，本地插件（sidebar-spaces/better-sidebar/work-mode）`import 'schemastery'` 失败（已显式装回 3.18.0 入 manifest）；③DSH 自愈把加载失败的本地插件从 `dsh.profile.bundles` 摘除（已按备份恢复 20 项）。跑 profile 内 pnpm 前先 diff 备份 `Data/Updates/LinkMigration-backup-20260911/package.json` 的 specifier 与实际安装差异；`pnpm add` 会重写 bundles 邻近字段并规范化 link 路径写法，改完必须复跑 `sidebar-service-lifecycle` 测试
- **官方运行时家族钉版靠 `resolutionMode`，不靠 overrides**：pnpm 11.24 完全忽略 `package.json` 的 `pnpm.overrides`，且通配 overrides（`@deepseek-ai/dsh-*`）实测不命中；官方发版包把传递依赖写成 `^<同元组预发布>`，最高版语义会把候选拉成混用家族（`0.1.5-rc.1` 根包 + `0.1.5-rc.2` 传递包），在家族对齐门禁处被判失败。三个入口必须同时写 `resolutionMode: time-based`／`--config.resolution-mode=time-based`：生成的 `pnpm-workspace.yaml`、安装参数、以及**已存在**的运行时目录（`ensureRuntimeResolutionMode`；只在文件缺失时写入的旧代码永远补不上）
- **官方运行时绝不原地安装**：桥接的 `desktopRuntimeDir` 就是**正在运行的活动槽**。原地 `writeOfficialRuntimeManifest` + pnpm 安装会留下「`package.json` 新版本 + `node_modules` 旧版本」的坏槽（Windows 下正在使用的文件还替换不了，必然半途失败），用户看到「更新成功但版本没变」。正确路径：桥接发 `request-harness-update`（`isRequestHarnessUpdateIpc` 判定，兼容字符串与 `{type}`）→ 外壳 `startHarnessUpdateTask(true)` → A/B 更新器。插件「关于」页读 npm `next` 标签，与外壳发现通道 `[policy.channel, next, latest]` **必须一起改**，否则提示与可切换目标天生不一致
- **官方 pending 条目是幽灵，绝不能回写**：codex-ui 在安装前写 `profile/.dsh-pending-updates.json`、失败不回滚，而 profile 安装路径明确拒绝官方包——回写会让一次失败点击变成永远无法应用的待更新项，并在之后每次插件更新里被合并带回。`applyPendingProfileUpdates` 只消费社区条目，官方条目一律清掉
- **影子验证不覆盖社区插件，运行时升级必须带失败退避**：`src/harness-shadow.ts` 造的是一次性 profile（只装 `OFFICIAL_PROFILE_BUNDLES`、`cordis.patch.yml` 为空），因此候选可以「影子验证通过 → 真实 profile 切换崩溃 → 自动回滚」（历史实例 `0.1.5-alpha.1`：`cannot get property webServer without inject`）。启动自修复只挡得住「无法解析的 bundle」，挡不住 `apply()` 里同步抛错的服务依赖插件。`state.json` 的 `deploymentFailures` + `evaluateDeploymentRetryGate` 按版本退避（默认 2 次 / 24 小时，手动检查永远放行）就是为此存在——**不要为了让自动升级更积极而绕过它**；同时新增部署失败点时（`deployHarnessCandidate` 抛错、切换回滚）必须记一次，切换提交成功必须清除该版本记录
- **便携启动预检必须与官方 bundle 解析同语义（2026-09-28「实验性插件开关拨不动」事故）**：官方 `dsh-plugin-manager` 的 `selectBundle(name, enabled)` **只写 `dsh.profile.bundles`、从不写 `dependencies`**，并用 `bundleManifest(name, profileDir, installAnchor)` 在「**运行时安装锚点 + profile**」两处解析包；而便携侧 `src/profile-bundle-health.ts` 的 `inspectProfileBundle` 曾只看 `<profile>/node_modules/<pkg>` —— 于是只装在运行时安装目录里的官方 bundle（`@deepseek-ai/dsh-experimental-*` 三个实验性开关）被误判「插件 package.json 不存在」→ 启动预检隔离并把包从 bundles 摘除 → 用户看到「拨开开关就重启、重启回来还是关的」（重启是官方 `selectBundle` 的运行时重载语义，属预期；被回滚才是 bug）。**规矩**：便携侧任何「bundle 能不能加载」的判定，都必须用 `[profileDir, ...extraDirs]`（`extraDirs = desktopRuntimeDir`）与官方 `resolveBundleDir` 对齐，参照 `isResolvableProfileBundle`；新增判定点时同步串 `extraDirs`，并加「只在运行时安装目录里」的正向用例 + 「两处都没有」的对照用例。修复记录：`docs/01-当前工作/20260928-实验性插件开关重启后未生效修复.md`
- **指纹槽的清单损坏没有启动检查能发现，靠 `reconcileOfficialRuntimeManifest` 自愈**：`isOfficialRuntimeLaunchable` 只看入口与 peer 是否存在，`.dsh-runtime-fingerprint` 只覆盖 lock 与家族清单（**根 `package.json` 被有意排除**），而指纹槽在 `seedOfficialRuntime` 里直接早返回——三者叠加的结果是「清单 `0.1.5-rc.2` + `node_modules` `0.1.2-rc.1`」的坏槽永远不会被修，错误版本号一路传到「关于」页与更新器。自愈只在**家族版本单一可读**时把已存在的根清单与 `resolutionMode` 拉回实际版本（不动 lock、不动物化依赖，指纹语义不变）；家族混用时保持原样交给 A/B 门禁；**绝不在指纹槽里凭空造文件**（会打破「槽是不可变制品」约束与其回归测试）
- **测试禁止读取实机 `Data/` 产物，CI 是全新检出**：`test/` 里凡直接 `readFile`/`import` 实机 profile 插件产物（`Data/DSH/profiles/web/local/*`、`profiles/web/node_modules/*`）、运行时槽或仓库外工作空间文件（如 `工作空间/`）的用例，本机全绿但 CI 直接 ENOENT 整组失败（2026-09-11 首次跑 CI 连挂两轮的根因）。必须 `existsSync` 守卫 + `t.skip('实机产物缺失（CI 全新检出）')`，模块级读取/导入一律改惰性；改完用干净克隆（`git clone . 别处` + `pnpm install --frozen-lockfile` + tsc + node --test）复验 0 fail 才算过
- **🔴 客户端 bundle 里禁止任何重启/退出动作（2026-09-21 无限重启事故）**：把 `dshDesktopShell.action('app-restart')` 写进 `Data/DSH/profiles/web/local/*/lib/client.js` 后，**该 bundle 每次页面加载都会执行** ⇒ 重启后页面又加载 ⇒ 又重启 ⇒ **自激无限重启**（用户端表现为窗口反复重启、工具调用全部 `outcome unknown`、GUI 端口每次都在变）。**铁律**：客户端 bundle 里禁止出现 `app-restart` / `app-quit` / `dshDesktopShell.action('app-restart'|'app-quit')` —— 这类动作必须由**用户显式操作**触发，走受控通道（既有范例 `local/dsh-restart-button`：仅本机 webServer 可达 + 共享密钥 + 必须显式 POST）。护栏用例：`test/no-self-scheduled-restart.test.ts`（对事故原文能命中、对安全写法不误报）。**排查提示**：出现"无限重启"时先看进程存活时长（正常应持续增长）与最近改动过的客户端 bundle；**第一动作是让那个 bundle 加载不到或去掉触发行**，不要在同一种改法上反复重试。
- **认祖后的版本标签名归便携仓库**：`git fetch upstream --tags` 会把上游 `v<版本>` 标签拉进本地；认祖合并后要 `git tag -f v<版本>` 把名字声明给便携仓库自己的发布提交（发布契约脚本要求标签名恰为 `v<精确版本>`）。此后 `git fetch upstream --tags` 对该版本报标签冲突属预期，不要为消冲突删掉自己的发布标签
- **🔧 禁止用 here-string / 行切片脚本改源码文件（2026-09-21 事故）**：用 PowerShell here-string 拼接改 `lib/client.js` 时终止符写成 `'@ -split …`（**终止符必须独占一行**），脚本把文件**截断成 67 行**、原 396 行主体全丢；该文件不在 git、无 `.bak`、junction 指向同一份、Electron 缓存为空，恢复花了 40 分钟（多帧 zstd 会话日志逐帧解码 + 确定性装配，脚本在 `Data/Temp/unzstd-multiframe.cjs`）。**规矩**：改源码一律用 `edit` 工具或 Node 脚本（语义明确）；**动实机产物前先复制 `.bak`**。另：`test/no-self-scheduled-restart.test.ts` 按**字面量**扫描客户端 bundle，若某段代码是要**拦截**重启类动作，把字面量拆开拼（`'app-' + 'restart'`）——不要为过测而改护栏。
- **🖼️ 抓"应用窗口"必须用 `PrintWindow`，裸用 `CopyFromScreen` 会抓到别的应用（2026-09-21 实测）**：`CopyFromScreen` 抓的是**屏幕物理像素**——当 DSH 窗口被别的窗口压住（用户切到 Chrome 干活）时，抓到的就是那个窗口。当时现象是「DOM 的 `checkVisibility=true`、坐标正常，但截图里怎么也看不到该元素」，差点据此下"元素没渲染"的错误结论；同时**把用户的 ERP 页面拍进了取证文件（隐私风险）**。**正解**：`scripts/capture-app-window.ps1`（`PrintWindow(hwnd,hdc,PW_RENDERFULLCONTENT=2)`，渲染窗口自身内容、与遮挡无关、不抢焦点）；`scripts/look-ui.ps1` 是"临时置顶→抓→还原"，可用但会改窗口层级并抢焦点，用户正在别处干活时优先用新脚本。**判据**：截图"看不见某元素"时，先确认"我截的是不是那个窗口/那个页面"，再下结论。

## 🔢 版本号政策（2026-09-14 起）

- **基础版本完全跟随上游**：认祖到哪个上游版本，便携版号就是它（现为 1.0.65）；禁止再自建 1.0.5x/1.0.6x 独立计数线
- 同基座的便携重建/修复用 **`+build.N` 构建元数据后缀**：`1.0.65+build.1`、`1.0.65+build.2`…（认祖新上游时归零重计）。**不要用第 4 段数字**（`1.0.65.1`）——比较器认识它，打包链路不认识：2026-09-19 实测 electron-builder 把 `1.0.65.1` 写成 exe 元数据 `FileVersion=1.0.6-5.1` / `ProductVersion=1.0.6.0`，`validatePackagedApp` 据实拒收（`候选程序版本 1.0.6 与目标 1.0.65.1 不一致`）⇒ 构建白跑一轮、暂存中止。`+build.N` 被 `compareReleaseVersions` 有意忽略（`1.0.65+build.1` ≡ `1.0.65`，不会有假更新提示），且已由 `1.0.64+build.2` 槽实测走通完整发布链路
- 历史自建线 1.0.54–1.0.66 已退役：已部署实例继续运行，基础版本超过其号后自然恢复更新

## 🔗 内核/插件解耦方针（用户架构决定，2026-09-29）

用户方针：**内核（DSH 官方运行时）与插件各自独立更新，两者之间只允许桥梁式连接，禁止"你中有我、我中有你"**。依据 2026-09-29 的 0.2.0-rc.1 升级实证（成功切换后被插件生态阻挡回滚，见功能清单 45b）：

- **新插件一律走协议桥形态**（第一层，已验证免疫内核升级）：零 `@deepseek-ai/*` import、零 peerDependencies、只经 HTTP/WS/会话注入协议与宿主通信——实证：agent-bridge/agent-mcp/hj-workbench/p3-tiny-watch/restart-button 在 0.2 切换瞬间全部存活，而 13 个 peer 钉版插件全被 boot 校验拒载（`dsh-app-boot` 的 `evaluatePluginCompatibility`：peer 不满足且未豁免即 throw 跳过）。
- **深度 UI 集成插件（better-sidebar/codex-ui 类）属结构性耦合**，与内核版本同走是产品形态决定的；升级内核时经 `<profileDir>/compatibility.json` **精确豁免**（官方 `dsh plugin allow-version` 通道，语义为自担风险放行）+ **7b 打开方式体检把关**——豁免是桥、体检是闸，缺一不可（0.2 实测：抽样核心 API 符号在 0.2 全部存活，peer 钉版是官方生态保守声明而非必然硬断裂，但 678 文件变更含行为级漂移，必须实测兜底）。
- 内核升级流程中豁免清单的生成/失效核对应随 7b 一起执行；禁止用改 peer 宽区间代替豁免（npm 包会被升级冲掉，豁免是 profile 数据可长期维护）。

## 🌐 社区插件生态实证（MichengAI 8 仓库，2026-09-07 源码核对）

8 个已发布社区插件（`https://github.com/MichengAI/<repo>`，npm 安装：`dsh plugin --profile web add @michengai/<repo 名>@latest`）的源码核对结论，是本文件规则的一手实证。**注意：它们按官方 0.1.2-rc.1 API 开发，移植进便携版（alpha.3 运行时）前必须按「官方兼容性双基线」逐个核对 API 在内置运行时存在**（dsh-agency-agents 自带 settings-compat 双代桥接，就是这种版本漂移的活教材）。逐项存在性核对结论见 `docs/03-技术架构/DeepSeek-Harness-社区插件rc1-alpha3兼容对照.md`。生态全景目录：`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`（180+ 社区插件分类清单，均带 `dsh.bundle` 清单、走 `dsh plugin add` 安装；MichengAI 8 件套与 profile 里 `dsh-better-sidebar` 的同名家族 omdsh-dev/DSH-better-sidebar 都在其中）。

| 仓库 | 实证价值 |
|---|---|
| `dsh-codex-ui` | 客户端 UI 全面重塑：slots 顶替 `ui-sidebar`（patch 禁行 + insert）；活动版为 npm `@michengai/dsh-codex-ui 1.1.2`（旧 local 移植副本已退役删除，见 GCC 一节与坑清单） |
| `dsh-skills-manager` | `@deepseek-ai/dsh-skill` 技能服务接入 + 客户端设置页（slots/locale） |
| `dsh-agency-agents` | 命名导出 + 模块级 inject 标准范例、`systemPrompt.section`、settings 设置段、`ctx.reflect.provide` 自提供服务、settings-compat 双代 API 桥接 |
| `dsh-archive-manager` | 替换式插件：整行 `disabled: true` 禁用 `workspace`/`session-projection-cache`/`ui-workspace` 再 insert 替代实现 |
| `dsh-automation` | `tools/pre-execute` waterfall（先 `await next()` 再按策略升级 `{kind:'ask', reason}`）、`ctx.get('loader').await()` 等 Loader 就绪再启动、自管单 timer 调度 |
| `dsh-im-connect` | `webServer.register({kind:'prefix', path, handler})` HTTP API + 请求头自校验、外部 IM 长连接逐渠道生命周期回收 |
| `dsh-btw` | 独立旁问：`ctx.subagents.start('fork', {parent, prompt, toolFilter, signal})` + `ctx.tools.guard()` 只读护栏、独立气泡 BubbleStore |
| `dsh-simplify` | `ctx.commands.register` 逐字范例、`invocation.agent.followup(createUserMessage({source:{kind:'plugin', …}}))` 向当前会话注入消息、`subprocess` 子进程 |

8/8 一致的通用形态：

- **双端同构 npm 包**：package.json `dsh.bundle.patch` 指向随包 cordis.patch.yml（宿主半侧）；`dsh.client: {platform:'web', inject:[<@deepseek-ai/dsh-client-* 包>]}` + `exports['./client']`（浏览器半侧，宿主自动发现，patch 不写手动挂载行）；`files` 必含 `lib/` 与 `cordis.patch.yml`
- **UI 注入一律走宿主 slots**：`ctx.slots.inject('<路径>', …)`（实证路径：`settings.section`、`sidebar.schedule`、`sidebar.workspaces`、`conversation.input.left`、`conversation.input.dock`、`conversation.chat.commandview`）+ `ctx.inputTriggers.registerSource` 注册斜杠/@ 触发词；文案走 `ctx.locale.register(NS, {zh, en})` + `ctx.locale.bind(NS)` 类型化命名空间字典
- **host↔client 通信三条实证通道**：`ctx.connection.rpc.handle('/通道名')`；`webServer` prefix HTTP API（需自校验请求头）；typert 远端（`ctx.typert.register` + `@Remote()` 装饰器 + 客户端 `ctx.remote.$mount()`）
- **归属表补充**（接知识库第 10 节）：独立 LLM 子任务/旁问 → `ctx.subagents` fork + `ctx.tools.guard`；向当前会话注入模型可见消息 → `invocation.agent.followup(createUserMessage(...))` 且 `source.kind:'plugin'` 必带插件名（满足铁律 1）；替换内建能力 → patch 禁行 + insert 替代实现
- **依赖与发布**：`dependencies` 留空，`@deepseek-ai/*` 精确钉版双写 devDependencies + peerDependencies；`prepack` 先构建保证 `lib/` 完整；无可调参数的插件不导出 Config（btw/simplify），纯值调参走 patch 条目内联 `config:`

## 📁 关键文档

| 文档 | 用途 |
|---|---|
| `docs/03-技术架构/DeepSeek-Harness-插件开发规范知识库.md` | **插件/接口/事件/打包规范（改动前必读）** |
| `docs/03-技术架构/00-桌面启动器架构基线.md` | 桌面启动器架构 |
| `docs/03-技术架构/DeepSeek-Harness-企业级自动更新方案.md` | 更新机制设计 |
| `docs/01-当前工作/便携版3-变更与答复质量门禁.md` | 变更质量门禁 |
| `docs/05-系统认知/11-问题修复测试与关联变更规则.md` | 修复前查阅：根因证据、关联变更判定、回归范围、并发保护与交付记录 |
| `docs/00-交接入口/07-功能清单.md` | 功能登记与三项对齐证据索引 |
| `便携版3-使用说明.md` | 用户视角使用说明 |
