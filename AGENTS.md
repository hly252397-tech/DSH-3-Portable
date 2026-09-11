# AGENTS.md — 智能体强制开发指令（DSH 便携版 3）

本仓库是 **DeepSeek Harness (DSH) 官方应用**的便携版定制。DSH 是插件化架构：**产品一切部分皆插件，一切注册可逆**。定制功能前必须理解并遵守官方插件规范。

> 🚀 **入口捷径**：凡开发功能、修复缺陷或改动插件/外壳/打包脚本，先加载 `dsh-dev-spec` 技能——它把本文件的「必读文档 → 审查清单 → 类型/测试门禁」固化为可执行流程，避免凭记忆跳过审查。技能未注册时才按本文件手工执行。

## 官方兼容性双基线

- **实现基线**：以便携版实际内置的 `@deepseek-ai/dsh` 版本、导出和类型声明为准；不得因为官方最新文档出现新 API 就直接在旧运行时中调用。
- **审查基线**：每个功能开始前运行 `App/resources/node/node.exe scripts/verify-dsh-official-baseline.mjs --online`，核对 `deepseek-ai/deepseek-harness` 官方 HEAD。官方变化时，必须先人工审阅官方 `AGENTS.md`、架构、测试规范和受影响子系统，禁止自动接受后继续开发。
- 机器可读版本记录和适用规则见 `docs/03-技术架构/DeepSeek-Harness-官方兼容基线.json` 与同名 `.md`。无法联网核对时只能继续诊断，不得宣称“符合官方最新要求”。

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

所有新增、修改、下线的用户功能，包括仅修改前端、样式或插件客户端的变更，必须执行 [变更与答复质量门禁第 6 节](docs/01-当前工作/便携版3-变更与答复质量门禁.md#6-前后端与-ui-三项对齐强制门禁)。该节是三项对齐规则的唯一事实源，进入功能开发前必须阅读。

- 开发前更新功能清单，建立“用户入口与子界面 → 前端事件与调用 → 后端处理 → 结果反馈”的对应关系，并从后端反查用户入口。
- 后端用户能力必须有可达入口；可操作控件必须产生真实行为及反馈；主页面、弹窗、二级界面必须验证交互、布局和状态。内部能力或纯前端交互的例外须按门禁记录理由。
- 交付前完成适用的真实链路与 UI 验证并保存证据。有入口缺失、点击无反应、虚假成功、关键界面不可用或缺少运行证据时，不得标记验收通过。
- 后续新增、修改和下线均须同步对齐记录；历史“已实现”标记不能替代本次验收。

## ✅ 强制验证：改动完成之后

1. **类型与测试门禁**（必须全绿才算完成）：

   ```sh
   ./App/resources/node/node.exe node_modules/typescript/bin/tsc
   ./App/resources/node/node.exe --test dist/test/*.test.js   # 以实际发现数量为准，要求 0 fail
   ```

   注意：使用 `App/resources/node/node.exe`（版本以 `package.json` 的 `bundledNodeVersion` 为准），禁止用系统 Node（版本门禁）。

2. **重新打包 + A/B 候选部署**（`src/` 改动需要）：

   ```sh
   powershell -NoProfile -ExecutionPolicy Bypass -File Build-DSH-Portable.ps1
   ```

   该命令完成类型检查、测试、打包和候选暂存，但不覆盖正在使用的 `App/`，也不结束桌面进程。之后从托盘正常退出或使用“重启应用”，`Start-DSH-Portable.ps1` 才会切换候选、验证健康文件并在失败时自动回滚。禁止恢复已删除的原地覆盖部署脚本。

3. **端到端验证**：双击 `DSH便携版3.exe` 启动，确认候选通过清单哈希、主界面与 DSH readiness、`Data/Updates/Desktop/state.json` 进入 `completed`，且 `Data/Electron/UserData/startup-error.log` 没有新增错误。

## ⚠️ 本仓库已踩过的坑（不要再犯）

- **GNU tar / bsdtar 差异**：`runtime-archive.ts` 必须运行时探测（GNU 才加 `--force-local`）。测试环境（Git Bash）解析到 GNU tar，用户双击启动器环境解析到 System32 bsdtar —— **测试通过 ≠ 用户可用，必须用双击启动器路径验证**
- **ps1 脚本必须带 UTF-8 BOM**：PowerShell 5.1 按 ANSI 解析无 BOM 的 UTF-8，中文注释会导致语法错误
- **插件 `lib/` 结构**：`dsh-sidebar-spaces` 的 `node_modules` 实例曾因缺 `lib/index.js` 崩溃（ERR_MODULE_NOT_FOUND）；修复物在 `local/dsh-sidebar-spaces`，不要破坏
- **禁止原地覆盖 App**：桌面更新和本地构建只可写入 `Data/Updates/Desktop/slots/` 的不可变候选槽；通过启动验证前必须保留当前槽，失败由启动器自动回滚。
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
- **指纹槽的清单损坏没有启动检查能发现，靠 `reconcileOfficialRuntimeManifest` 自愈**：`isOfficialRuntimeLaunchable` 只看入口与 peer 是否存在，`.dsh-runtime-fingerprint` 只覆盖 lock 与家族清单（**根 `package.json` 被有意排除**），而指纹槽在 `seedOfficialRuntime` 里直接早返回——三者叠加的结果是「清单 `0.1.5-rc.2` + `node_modules` `0.1.2-rc.1`」的坏槽永远不会被修，错误版本号一路传到「关于」页与更新器。自愈只在**家族版本单一可读**时把已存在的根清单与 `resolutionMode` 拉回实际版本（不动 lock、不动物化依赖，指纹语义不变）；家族混用时保持原样交给 A/B 门禁；**绝不在指纹槽里凭空造文件**（会打破「槽是不可变制品」约束与其回归测试）
- **测试禁止读取实机 `Data/` 产物，CI 是全新检出**：`test/` 里凡直接 `readFile`/`import` 实机 profile 插件产物（`Data/DSH/profiles/web/local/*`、`profiles/web/node_modules/*`）、运行时槽或仓库外工作空间文件（如 `工作空间/`）的用例，本机全绿但 CI 直接 ENOENT 整组失败（2026-09-11 首次跑 CI 连挂两轮的根因）。必须 `existsSync` 守卫 + `t.skip('实机产物缺失（CI 全新检出）')`，模块级读取/导入一律改惰性；改完用干净克隆（`git clone . 别处` + `pnpm install --frozen-lockfile` + tsc + node --test）复验 0 fail 才算过
- **认祖后的版本标签名归便携仓库**：`git fetch upstream --tags` 会把上游 `v<版本>` 标签拉进本地；认祖合并后要 `git tag -f v<版本>` 把名字声明给便携仓库自己的发布提交（发布契约脚本要求标签名恰为 `v<精确版本>`）。此后 `git fetch upstream --tags` 对该版本报标签冲突属预期，不要为消冲突删掉自己的发布标签

## 🌐 社区插件生态实证（MichengAI 8 仓库，2026-09-07 源码核对）

8 个已发布社区插件（`https://github.com/MichengAI/<repo>`，npm 安装：`dsh plugin --profile web add @michengai/<repo 名>@latest`）的源码核对结论，是本文件规则的一手实证。**注意：它们按官方 0.1.2-rc.1 API 开发，移植进便携版（alpha.3 运行时）前必须按「官方兼容性双基线」逐个核对 API 在内置运行时存在**（dsh-agency-agents 自带 settings-compat 双代桥接，就是这种版本漂移的活教材）。逐项存在性核对结论见 `docs/03-技术架构/DeepSeek-Harness-社区插件rc1-alpha3兼容对照.md`。生态全景目录：`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`（180+ 社区插件分类清单，均带 `dsh.bundle` 清单、走 `dsh plugin add` 安装；MichengAI 8 件套与 profile 里 `dsh-better-sidebar` 的同名家族 omdsh-dev/DSH-better-sidebar 都在其中）。

| 仓库 | 实证价值 |
|---|---|
| `dsh-codex-ui` | 客户端 UI 全面重塑：slots 顶替 `ui-sidebar`（patch 禁行 + insert）；**已移植到本仓库** `Data/DSH/profiles/web/local/dsh-codex-ui` |
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
| `docs/00-交接入口/07-功能清单.md` | 功能登记与三项对齐证据索引 |
| `便携版3-使用说明.md` | 用户视角使用说明 |
