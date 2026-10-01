# DeepSeek Harness 官方兼容基线

本文件把“遵守官方要求”落实为两条不可混用的基线：**实现基线**是便携版实际内置的运行时，**审查基线**是开发开始时核对到的官方最新提交。官方处于 Developer Preview，允许破坏性变更，因此不能看到新文档就直接调用旧运行时中不存在的接口。

## 当前基线

| 项目 | 当前值 | 用途 |
|---|---|---|
| **实现基线（随包烘焙/隔离候选）** | `@deepseek-ai/dsh 0.1.7-rc.2`（2026-09-25 随上游 v1.0.76 吸收烘焙；`Data/RuntimeCandidate` 已隔离装全并过依赖核对）。**在装槽的 1.0.77 候选以 `0.2.0-rc.2` 为目标**——源码常量（`src/bundled-plugins.ts` / `package.json`）已改，候选激活并实机验证前，本行仍以现役槽为准 | **编译、运行、API 与 Profile 兼容性的最终依据**；激活走独立家园绑定（`Data/DSH-generations/<代>` + `Data/Updates/Harness/homes/<版本>.json`），旧运行时 0.1.6-alpha.2 经无绑定路径继续读原 `Data/DSH`，混用被 fail-closed 阻断 |
| 官方审查基线 | `deepseek-ai/deepseek-harness@639ed015397290b3745d163aafe02ffee4aa3f84` | 2026-09-29 人工审阅（0.2.0-rc.2 受信）；不代表采用该 HEAD 的全部实现 |
| 官方审查版本 | `@deepseek-ai/dsh 0.2.0-rc.2` | 官方标签 `dsh-v0.2.0-rc.2` 指向该 commit，且即官方仓库当前 HEAD |
| 核对日期 | `2026-09-29`（推进审查基线 + 0.2.0-rc.2 受信） | 判断本地规范是否过期 |

机器可读记录见 `DeepSeek-Harness-官方兼容基线.json`。

> **文档地址更正（2026-09-29）**：JSON 的 `official.documentation` 原为 `https://deepseek-ai.github.io/deepseek-harness/`，该地址**返回 404**，导致 `scripts/verify-dsh-official-baseline.mjs --online` 报「官方文档地址不在允许列表中」。已改为脚本允许列表里那条 `https://deepseek-harness.github.io/deepseek-harness/`（实测 200）。这是本轮之前就存在的缺陷，不是本轮引入。

## 2026-09-29 人工审阅记录（0.2.0-rc.2 受信 / 上游桌面壳 v1.0.77）

- **触发**：用户 2026-09-29 指示「DSH 和桌面壳都有新版本了，都拉取更新吧」。桌面壳取上游 `v1.0.77`，内核取官方 `0.2.0-rc.2`。
- [官方比较](https://github.com/deepseek-ai/deepseek-harness/compare/4878cdabd87d4041bdaff61d04c966883b9fd07a...639ed015397290b3745d163aafe02ffee4aa3f84)：**187 提交 / 300 文件**。
- 变更主体：`apps/web` 交互打磨（模型选择器模糊搜索、会话时长/主题/快捷键）、`apps/desktop` 托管 CLI 命令管理、Windows ACL 单次修复、cordis `Client` inspect 查询限时，以及 `perf(client)` 长会话渲染与鲸鱼动画降载。
- **破坏性核查（结论：干净）**：`packages/api` 与 `packages/client` 无任何 `export` 删除；`packages/boot/*` 与 `packages/bundle/*` 只是 `package.json` 版本号 0.2.0-rc.1→rc.2 的提升；官方未发布 rc.2 的 upgrade-guide（现有 `docs/upgrade-guide` 只回填到 0.1.7-rc.2），即官方未申报对外可感知的破坏性变更。唯一 grep 命中的 "breaking" 是 `AGENTS.md` 里的一句策略表述。
- 受信凭据：npm registry 实取 `dist.integrity`（`sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==`）+ 官方标签 `dsh-v0.2.0-rc.2` → `639ed015`（发布提交 `c1b47e41` "release(dsh): 0.2.0-rc.2"）；已写入 `src/harness-update.ts` 的 `BUILTIN_TRUSTED_HARNESS_RELEASES`。
- **关键顺序事实**：`BUILTIN_TRUSTED_HARNESS_RELEASES` 编译进 `app.asar`，所以**现役 1.0.76 槽永远无法部署 rc.2**——内核更新必须先有新桌面构建。这是本轮必须先构建、不能直接在内核侧动手的原因。
- 残余风险（如实记录）：社区插件 peer 精确钉在 `0.2.0-rc.1`，rc.2 不满足。**按用户「内核与插件各自独立更新、只经桥梁连接」的方针处理**：用 `compatibility.json` 的 v5 代际绑定 + 逐插件精确豁免放行（`Prepare-DSH-Kernel-Update.cmd` / `scripts/prepare-kernel-update.mjs`），**不改 peer 宽区间**。切换后必跑 7b 体检 `scripts/check-open-behavior.mjs`。
- 插件侧**刻意不跟**上游 v1.0.77 的 12 个社区插件版本提升与 `dsh-mcp-connector` 移除（理由与台账见 [上游同步与便携保护基线.md](上游同步与便携保护基线.md) §9）。

## 2026-09-28 人工审阅记录（0.2.0-rc.1 受信前置）

- [官方比较](https://github.com/deepseek-ai/deepseek-harness/compare/21638c56315ae6a2b552d6091945d3144c9af32e...4878cdabd87d4041bdaff61d04c966883b9fd07a)：106 提交 / 678 文件 / 17 贡献者（compare API 单页 300 文件为样本 + 全量提交列表逐条审阅主题）。
- 变更主体：Windows 沙箱 ACL 诊断修复（Explorer 窗口可见性、ACL 修复安全性）、WebKit/Safari 会话 JSON 兼容、Office/PDF 文本选择双主题、Windows 标题栏间距（caption gaps）、会话日志上传偏好、设置性能（composition 复用）、0.2 预览版公告（**首启会弹一次需用户确认**）、Koffi 依赖钉版、macOS 麦克风权限。
- **与本仓库定制相关的判定**：无聊天视图文件打开器改道、无 fileLink/openPath/ToolRow/workspaces 相关提交、无破坏性插件 API 变更迹象——升级后仍须实跑 `scripts/check-open-behavior.mjs`（升级流程 7b）实测确认。
- 受信凭据：npm registry 实取 `dist.integrity`（sha512-F6hK…3ng==）+ 官方标签 `dsh-v0.2.0-rc.1` commit（GitHub API 实取 = HEAD 4878cdab，发布提交 `release(dsh): 0.2.0-rc.1 (#5387)`）；已写入 `src/harness-update.ts` BUILTIN 清单。
- 残余风险（如实记录）：社区插件（better-sidebar 0.18.0-alpha.0 / codex-ui 1.1.18 等）对 0.2 家族 peer 适配未逐一实测，影子验证不覆盖社区插件——靠 A/B 自动回滚兜底；更新策略已锁 manual（2026-09-28 用户决定），本次为一次性手动升级。

## 2026-09-28 人工审阅记录（设置整合续作）

- [官方比较](https://github.com/deepseek-ai/deepseek-harness/compare/477b4f420553e8a52c2fbccc464d7561b239c443...21638c56315ae6a2b552d6091945d3144c9af32e)：155 提交。比较 API 文件列表有上限，另取两端完整递归树（truncated 均 false）核对，发现 544 个新增/修改文件；这是影响定位而非全仓逐行审计。
- 官方 `AGENTS.md`、`docs/testing.md` blob 与前次相同，继续沿用已审阅规则。`docs/architecture.md` 仅新增失败步骤须补记缺失工具结果的说明，本次设置入口不触模型事件/会话恢复。
- 受影响路径核对：`packages/client/runtime`、`ui-settings`、`ui-slots` 未变；`boot/plugin-manager` 只有测试变化，未更改兼容豁免规则。`boot/app-boot/src/profile.ts` 仅在可选 bundle 列表增加 experimental-schedule-bundle。
- 实读新版 `ui-settings-general` 文档和 `DesktopUpdateIndicator.tsx`：设置仍由 settings.section ledger 投影，Host 拥有桌面更新操作，客户端只展示状态。展示文案/tooltip 变化不要求便携外壳移植；账户/模型 onboarding、插件管理 UI、遥测和官方 desktop 的变更不属于本次实现，不更新已安装运行时。
- CLI 清单仍为 rc.2。本轮不移植、不调整受信清单、不授权插件风险豁免，仅更新审查 SHA。用户批准暂用已真实验证的 Codex UI 1.1.18；1.1.20 的实际 Loader 拒绝证据保留在设置整合记录。

## 2026-09-25 人工审阅记录（上游 v1.0.76 吸收）

- 审阅范围：官方 `0.1.6-alpha.2 → 0.1.7-rc.2` 全量 diff（6783 文件，其中 packages 3870 文件），聚焦插件实际依赖面，不逐行读 client UI。
- **官方 AGENTS.md**：新增 dev:web/dev:desktop 命令与 make 目标（开发工具链，不影响便携）；workspace 依赖范围规则细化为 `workspace:*`（DSH）/`workspace:~`（vendor/native）；新规范 "No new assertions to unknown"。均不改变插件 ctx API 语义。
- **loader**：新增 volatile 配置热更新（schema `meta.volatile` 字段免重挂载生效，事件 `loader/volatile-update`）与 `equalExceptVolatile` 比较；`internal/update` 的 unparse 改为显式 `.call(this.runtime.Config)`。增量功能，无破坏。
- **core/session**：fork 快照出现 "migration deferred" 注释、tool-history 扩展、types 演化——会话格式持续演化，实证"新版写入后旧运行时拒绝读取"的既知结论；本次升级因此采用独立家园代际隔离而非原地混用。
- **插件三形态、ctx 服务名、slots/locale、connection/webServer** 未见移除或签名破坏；便携本地插件（命名导出/default 类/default 函数）兼容预期成立，以激活后真实加载为准。
- 本记录同步于 `DeepSeek-Harness-官方兼容基线.json`（verifiedAt 2026-09-25T16:40+08:00）。

## 2026-09-24 人工审阅记录（I035 系统认知与手册）

- 在线门禁发现 HEAD 漂移，人工阅读精确提交的 AGENTS、architecture、testing、defensive-patterns，以及 system-prompt/tools 子系统；保留既有历史审阅记录。
- 继续使用插件、服务和 scope 扩展，不修改官方运行时；模型可见内容必须由持久会话事件重建，新增认知采用已有系统提示/动态上下文记录链。
- 已安装 alpha.2 的类型实读支持 `section`、`context` 和 `system-prompt/assemble`。完整提示 `complete:true` 会排除附加系统节，故不能只靠 section 宣称覆盖所有 Agent。
- `tools.schemas(scope)` 是可调用能力目录，不等于模型 wire schemas；PTC 模式入口可能只有 `run_code`。本轮须分别测试 scope 隔离与实际调用说明。
- 官方要求非平凡可见变化保留 keyless recorded-session 场景、真实 Loader 组合与生命周期清理；本地仍执行更严格的 tsc/全测门禁。
- 持久化不改 Session 格式，手册独立存于 Data；采用显式修订和冲突检测。处置须等待异步工作结束，junction 只解除链接、不递归删目标。
- 上述为审查基线更新，不表示运行时升级、不自动接受未来 HEAD、不改变 UI 基线哈希。

## 每个功能开始前的强制动作

1. 运行 `App/resources/node/node.exe scripts/verify-dsh-official-baseline.mjs --online`。它校验：① 基线 JSON 与桌面清单的仓库／文档／commit／内置版本一致；② **指针槽里打包的回退运行时** `dsh-runtime.tgz` 的版本与桌面清单一致；③ 历史回退目录 `Data/Runtime/dsh-runtime` **仅在不存在活动槽时**才强校验（有活动槽时允许落后，只给提示）；④ 联网核对官方 HEAD 与官方 CLI 版本。注意：该脚本**不检查活动运行时槽**——活动槽以 `Data/Runtime/Harness/current.json` 为准。
2. 完整阅读 `DeepSeek-Harness-插件开发规范知识库.md`，再按本功能涉及的子系统阅读官方 Reference/Cookbook 页面和当前内置包的类型声明。
3. 先分类行为归属：Electron 桌面宿主、DSH 插件、Profile/Bundle、运行时升级、用户数据迁移。只有 DSH 内部能力进入 Cordis 插件树；桌面宿主负责进程、窗口、便携路径和 A/B 部署，不伪装成 Harness 插件。
4. 若在线检查发现官方 HEAD 变化，先审阅官方 `AGENTS.md`、`docs/architecture.md`、`docs/testing.md` 及受影响子系统，再人工更新本基线和知识库。禁止脚本自动接受新规范。
5. 若网络不可用或官方变化尚未审阅，可以继续做诊断，但不得把实现称为“符合官方最新要求”或完成正式发布。

## 官方兼容性判定

- 自定义 Harness 行为优先通过 Profile、Bundle、插件、服务、事件和 Client Slot 扩展，不直接改写官方运行时包。
- 代码必须以**已内置**运行时（**活动槽 `Data/Runtime/Harness/current.json`**；2026-09-26 读数为 `0.1.7-rc.2`，槽 `0.1.7-rc.2-4d29c691bfdf224c`）的实际导出和类型声明为准。**本行不再写死版本号**——历史沿革：`0.1.2-rc.1`（2026-09-11 前）→ `0.1.5-rc.2` → `0.1.6-alpha.2`（2026-09-18 随上游 v1.0.64 吸收）→ `0.1.7-rc.2`（2026-09-25 随上游 v1.0.76 吸收）。官方文档只作为迁移预警，更新尚未经 A/B 切换生效前不得假定新 API 存在。
- 运行时升级属于兼容性迁移：需要独立候选、依赖闭包锁定、Profile 真实组合测试、会话格式评估、A/B 切换和自动回滚。
- 产品可见插件不能只做手工 `ctx.plugin()` 单元测试，必须通过 Loader + Profile 的真实组合路径验证。
- 用户可见状态只能在事务提交点后发布；失败前不得显示“完成”。
- UI 文案由本地化字典拥有；不得在新增 Client UI 中散落硬编码产品文案。
- 生命周期、并发、子进程或清理改动必须额外审阅官方 defensive patterns，并验证取消、处置、超时和进程树回收。
- 非平凡变更必须留下决策、替代方案、兼容影响和验证证据；本仓库使用对应迭代的实施/审查记录承载，不照搬官方仓库内部 PR 流程。

## 2026-09-19 人工审阅记录（上游 v1.0.65 吸收期间）

- **触发**：`scripts/verify-dsh-official-baseline.mjs --online` 报「官方 HEAD 已变化：基线 `c291e7961a515f6d7af9304e7fd1d257929aef26`，当前 `ddefc45fbc7f8e46dd73185e68295696d1297887`」。按强制动作第 4 条先人工审阅，未自动改写基线。
- **HEAD 判读（关键，避免误当成"官方又跑远了"）**：新 HEAD `ddefc45f` 就是标签 **`dsh-v0.1.6-alpha.2` 的发布合并提交**（2026-09-17，PR #4469 `worktree/release-dsh-0.1.6-alpha.2`），`apps/cli/package.json` 版本经实读为 `0.1.6-alpha.2`；旧基线 `c291e79` 则是 2026-09-10 的 PR #3977（0.1.5-rc.2 线）。**即漂移方向是"追上了我们已经在跑的版本"**，不是引入了更新一代。旁证：本仓库 `src/harness-update.ts` 受信清单里 `0.1.6-alpha.2` 登记的 `githubCommit` 正是 `ddefc45f…`（2026-09-18 由 npm integrity + GitHub 标签双凭据核对）。
- **规范文件差异（逐行审阅 AGENTS.md / docs/architecture.md / docs/testing.md）**：
  - `AGENTS.md`（156 → 180 行）：① 持久化规则新增"必须确认已声明的持久化类型变更"并要求引用 `docs/cookbook/reviewing-persistence-type-changes.md`；② 仓库结构表整体重写并**大幅扩容**（新增 `ssh/`、`ptc-runtime/`、`sandbox/`、`deliverables/`、`computer-use/`、`browser-use/`、`jobs/`、`goal/`、`schedule/`、`session-query/`、`attachment/`、`spill/`、`storage/`、`workspace/`、`feedback/`、`host/`、`client/`、`mcp/`、`runtime-diagnostics/`、`test-support/`；`experimental/` 语义反转为"默认公开、显式列举私有例外"）；③ 写作铁律收紧——空 `catch` 必须点名吞掉的错误、评论只许局部、**禁用 `prove`/`nance` 含糊来源标签**；④ **Agent Note 政策放宽**：只有"持久决策依据"才必须写，机械与局部编辑（含本地 UI 改动）豁免；⑤ 新增"Windows 打包/签名必读"与"浏览器自动化/GIF 录制要用 `pin-browse-picker` 覆盖层"两条流程条目。
  - `docs/architecture.md`（161 → 165 行）：① **HMR 改为由 YAML 决定**——base 启用"仅配置"的 `dsh-hmr`，headless/SDK/ACP 关闭，`sdk-minimal` 不加载，profile patch 可覆盖；② base 为 Web 与 agent 引入 Plugin Manager；③ **官方桌面宿主重构**——Electron 以 Electron Node 模式启动 Desktop Host，Host 调用共享 CLI profile runner 与完整 Web 应用，窗口先载打包好的 Web 资源再等 boot injections 激活客户端插件，Node IPC 改载 boot/readiness/fatal/shutdown，**桌面默认端口 `19387`**（profile 可覆盖）；④ AgentLoop 串行等待 `agent/created` 初始化，失败回滚创建；⑤ "model-visible means logged" 补充——**修改既有消息内容的插件须注册纯消息投影**（detached readers 需显式提供同样定义）。
  - `docs/testing.md`（56 行，仅 1 处）：真实入口路径的举例更新——`lib/worker.cjs`（worker-thread 兄弟入口）改为 `lib/process.js`（Node 程序引导），smoke 用例随之从 `code-runtime/code-runtime-worker-thread` 迁到 `ptc-runtime/ptc-runtime-node`（包重命名）。
- **受影响子系统逐条判定本仓库影响**：
  - 官方桌面宿主重构（③，含 `19387` 端口）：属**官方私有桌面实现**，与便携版外壳无同步关系。实测本仓库 `src/main.ts`、`src/dsh-view-preload.cts` 无 `listen(`/`createServer`/`19387`，外壳不监听任何端口（走 WebContentsView + `app://` 协议 + preload IPC），因此不存在端口冲突面；`Data/DSH/profiles/` 下也不使用官方保留的 `profiles/desktop`（本仓库是 `web` profile + 自管 seeding），故"公共 CLI 不得管理 Desktop profile"这条约束不适用于本 fork 的自管路径。**决策：不移植**（与 2026-09-11、2026-09-08 两次同类判定一致）。
  - HMR（①）：实读活动槽 `dsh-base@0.1.6-alpha.2` 的 `cordis.patch.yml`，`hmr` 条目为 `disabled: !!js "!ctx.get('profileContext')"` + `config: { root: [] }`——**有 profile 上下文即启用、且仅配置级（模块根为空）**。本仓库 profile patch 未提及 `hmr`，即沿用该默认；`src/` 内无 HMR 相关代码。**决策：不改**（这是随包运行时的官方默认，且本仓库 profile 由 seeding 生成、不做运行期改写）。
  - 消息投影（⑤）：本仓库触达模型可见面的方式只有 `systemPrompt.section`（dsh-agency-agents 的实证形态）与会话事件订阅，**不修改既有消息内容**，故不涉及纯消息投影注册义务。**决策：不改**，但作为规则候选补进知识库（"要改既有消息必须注册投影"）。
  - `agent/created` 串行初始化与失败回滚（④）：属运行时内部时序保证，本仓库无插件监听该事件（已 grep `src/` 与 `local/` 插件），无需适配。
  - 测试入口/包重命名（testing.md）：官方仓库内部路径，本仓库测试不引用其包路径，无影响。
  - `AGENTS.md` 写作铁律（③）：`prove`/`nance` 禁词、空 `catch` 点名、评论局部化三条**对本仓库仍然适用**，已在本轮新增代码与注释中遵守；"Agent Note 只为持久决策"的放宽与本仓库"非平凡变更留记录"的既有口径一致，本仓库继续按自己的迭代记录承载。
- **本仓库决策与动作**：实现基线不动（活动槽已是 `0.1.6-alpha.2`，与本次官方 HEAD 同版本，**无需运行时迁移**）；审查基线由 `c291e79` 推进到 `ddefc45f`（JSON 的 `official.commit`/`official.dshVersion` 与本节表格同步更新）；受信清单不动（`0.1.6-alpha.2` 早已受信）；不产生任何移植补丁；HMR/端口/消息投影三项作为"已知官方现状"记录备查。

## 2026-09-11 人工审阅记录

- 审阅范围：`b2e3b2a0125854567a4a5fcba75782e42fe84901...c291e7961a515f6d7af9304e7fd1d257929aef26`（160 提交、300 文件；`.agents/notes` 126 为内部笔记）。基线随审阅推进锚定 `c291e79`，CLI 版本 `0.1.5-rc.2`（master 已合并 rc.2 发布）。
- 官方桌面架构收敛（`apps/desktop` 76 文件，重点 8e4d3bab「优化打包方式、启动速度」）：新增 `runtime-tree.ts`（不可变桌面资源树 + `desktop-runtime.json` 描述符 + 逐文件 SHA256）、`profile-packages.ts`、`backend-controller.ts`、renderer 启动页（`startup.html/css/js` + `startup-error.ts`），删除 `seed-store.ts`，`project-manager.ts` 重构（+194/−308），`main.ts` +217/−93；另有 macOS 签名/公证并行化与 electron-builder 配置调整（CI 提速）。**方向与便携版既有设计趋同**（不可变槽/清单哈希/启动进度页/受控重启），互不移植（官方桌面为私有实现），但两项技术值得评估引入：①共享包经目录链接暴露给插件（对应本仓库「local/ 与 node_modules 双拷贝」痛点，Windows junction 可行性待验证）；②renderer 独立启动页与错误页拆分（比当前单页 startup.html 的阶段渲染更清晰）。
- 会话读取器弃用（5cfc765f / #3828）：`docs/subsystems/session.md` +3 行、`packages/core/session/src/index.ts` +3 行 `@deprecated` 标记直读事件读取器，配套同步历史读取弃用政策。本仓库插件经 `ctx` 事件订阅与 waterfall 拦截，不触直读 API；`session-path-repair.ts` 读取的是已发布会话文件格式头（邻接迁移政策保证已发布代不移动），均不受影响。后续 0.1.5 迁移时知识库需补充新政策条目。
- 其余主题：web composer 命令菜单（分组/本地化/glyph）、0.1.5 反馈与文件精化 backport（060323d8）、subprocess Linux scope 空范围修复（060ae6f3）、Blacksmith CI 托管镜像修复。`docs/architecture` 仅 i18n 同步，无规范变化。
- 本仓库决策：实现基线维持 `0.1.2-rc.1`；受信清单维持不变（0.1.5 生态阻断未解除，npm `latest=0.1.5-rc.1`、`next=0.1.5-rc.2` 均未受信，更新器只通知不切换）；桌面 fork 与官方桌面无同步关系，本区间不产生移植补丁，双技术评估项记入待办。
- 后续决策（同日，用户报告「关于」页可更新提示与更新失败后）：用户看到插件「关于」页提示 `0.1.2-rc.1 → 0.1.5-rc.2  可更新`，点击更新后失败。定位为三个独立缺陷叠加，一并修复：
  1. **家族钉版失效（根因）**：pnpm 11.24 完全忽略 `package.json` 的 `pnpm.overrides`，且 overrides 的通配选择器（`@deepseek-ai/dsh-*`）实测不命中；官方发版包把传递依赖写成 `^<同元组预发布>`，最高版语义把候选拉成混用家族（`0.1.5-rc.1` 根包 + `0.1.5-rc.2` 传递包），`isOfficialRuntimeFamilyAligned` 门禁正确拒绝，事件日志记录 `候选 DSH 运行时核心包版本未对齐。`。改为官方运行时统一按发布时间解析：`resolutionMode: time-based` 同时写入生成的 `pnpm-workspace.yaml`、安装参数（`--config.resolution-mode=time-based`）和既有运行时目录（新增幂等 `ensureRuntimeResolutionMode`）。用真实候选构建器实测：`0.1.5-rc.1` 与 `0.1.5-rc.2` 各自装配 240 包、官方家族 231/231 全对齐、0 混用，双双通过候选校验。
  2. **活动槽被原地改写**：插件「关于」页点更新会走桥接的官方分支，旧实现直接在**正在运行的活动运行时槽**上 `writeOfficialRuntimeManifest` + pnpm 安装，把槽的 `package.json` 改成新版本而 `node_modules` 仍是旧版本（且 Windows 下正在使用的文件无法替换，安装必然半途失败），槽随即在家族对齐门禁处失效。现改为绝不原地安装：桥接返回退出码 1 并发出 `request-harness-update`，由外壳启动 A/B 更新周期（候选槽 → 影子验证 → 空闲切换 → 观察 → 失败回滚）。
  3. **两套版本口径不一致**：codex-ui「关于」页对官方运行时读 npm **`next`** 标签（`0.1.5-rc.2`），外壳更新器只发现 `[alpha, latest]`（`0.1.5-rc.1`），提示与可切换目标天然不同。现把 `next` 纳入发现通道，并将 `0.1.5-rc.2` 加入受信清单（npm integrity 与 `dsh-v0.1.5-rc.2` 标签 commit 已核对），使官方 HEAD、插件 peer 声明（`0.1.5-rc.1 || 0.1.5-rc.2`）与「关于」页展示三处口径一致；`0.1.5-rc.1` 保留受信以支撑回滚与降级。
  4. 附带修复：codex-ui 在安装前写 `.dsh-pending-updates.json`、安装失败不回滚，导致一次失败点击留下永远无法应用的幽灵待更新项（`profile` 安装路径明确拒绝官方包）。`applyPendingProfileUpdates` 现在不再回写官方条目，直接清掉登记文件。
  5. 实机修复：活动槽 `0.1.2-rc.1-2c82a3efc755c12c` 的 `package.json` 被旧实现半改写为 `0.1.5-rc.2`（`node_modules` 仍为 `0.1.2-rc.1`），已用正式写入函数恢复为 `0.1.2-rc.1`；校验该槽重新计算指纹仍等于登记的 `2c82a3ef…`，223 个官方包，槽内容与 `current.json` 记录一致。

## 2026-09-13 复核与文档纠偏（官方无变化）

- **复核结论（实测）**：`scripts/verify-dsh-official-baseline.mjs --online` **PASS / `online=verified`**，官方 HEAD 仍为 `c291e79…`（与基线 JSON 一致，故**无需重新人工审阅官方规范**）；npm `dist-tags` 仍为 `latest=0.1.5-rc.1`、`next=0.1.5-rc.2`、`alpha=0.1.5-alpha.2`。
- **纠偏 ①（表格）**：原表把「便携版实现基线」写作 `0.1.2-rc.1` 并称"与 npm latest 稳定线一致"，与实际不符——`0.1.2-rc.1` 是**打包内置／回退**运行时，而**活动运行时槽自 2026-09-11 17:09 起为 `0.1.5-rc.2`**（出处 `Data/Runtime/Harness/current.json`，`previous` 为 `0.1.2-rc.1`），且 npm `latest` 已到 `0.1.5-rc.1`。现拆为"实现基线（活动运行时槽）"与"打包内置运行时（回退）"两行，并把"编译／运行／API 依据"明确指向活动槽。
- **纠偏 ②（强制动作第 1 条）**：原文称该脚本"验证实际运行时版本"，易被读成校验活动槽。按其真实行为重述：校验的是**打包回退运行时**与桌面清单一致、历史回退目录仅在无活动槽时强校验，并指明活动槽以 `current.json` 为准。
- **纠偏动因**：2026-09-13「执行方工具门」迭代（`docs/01-当前工作/I024-执行方工具门/00-迭代总览.md`）开工核对时被本文档过期表述误导——据其以为实现基线是 `0.1.2-rc.1`，而实际实读类型来自 `0.1.5-rc.2` 槽。
- **未改动**：机器可读基线 JSON 本身正确，本轮不动（`policy.allowAutomaticBaselineRewrite: false`）；本文件此前的按日审阅记录**一律保持原样不改写**，过期判断以本节为准。

## 2026-09-10 人工审阅记录

- 审阅范围：`5dda764ed3aa172535a7967b06ff95d9cbfe536a...b2e3b2a0125854567a4a5fcba75782e42fe84901`（262 提交、300 文件；`.agents/notes` 193 文件为内部笔记）及其中官方根 `AGENTS.md`、`docs/AGENTS.md`、`THIRD_PARTY_NOTICES.md`、`apps/desktop-host` 的逐文件差异；GitHub tag `dsh-v0.1.5-alpha.2` 已核对指向 HEAD `b2e3b2a`。
- 规范变化：根 `AGENTS.md` 仅措辞调整——Session 版本/状态权威收敛到新文档 `docs/session-format-status.md`（邻接迁移规则不变：已发布代不得移动/覆盖/删除）；`docs/AGENTS.md` 写作规则同步引用该权威文档；`THIRD_PARTY_NOTICES.md` 明确浏览器预构建产物中的第三方输入独立于 npm 依赖段解析；`apps/desktop-host` 仅版本号随发布对齐，无代码变化。
- 主要技术变化：①子代理目录（parent-owned child catalogs）——Session V3 投影视图新增 catalog 事件族与快照顺序保证，session hydration 视图改为全有/全无，session-query 默认返回全部投影状态；②`apps/web` 67 文件——侧栏全局面板与文档/图片/PDF 预览、交付文件卡片与原生文件操作、反馈对话框、插件实例标签、MCP 分页循环修复、scoped tools 指引修复；注意 Mermaid/Graphviz/SVG/HTML 代码块预览在 #3710 引入后被 #3901 整体 Revert，最终 HEAD 不含该特性；③CI/流程——weighted PR approvals、取消被取代验证、review-ownership 重构；④实验性 Agent Teams 包独立发布，不在 `dsh` 依赖闭包内。
- Client UI 影响：新增能力全部位于官方 web 客户端内部，与桌面外壳的 WebContentsView、preload IPC、主题令牌、菜单 Portal 和 Client Slot 接口无契约变更。
- 本仓库决策：官方审查基线推进到 `0.1.5-alpha.2@b2e3b2a`；**受信清单维持不变**——0.1.5-alpha.1 的除名裁决依然成立（本范围内无 MichengAI 插件族适配，真实 Profile 下 `cannot get property webServer without inject` 阻断未解除），重新受信前必须先过实机 Profile 验证的既定前置不变。实现基线仍为 `0.1.2-rc.1`。已核对 0.1.5-alpha.2 的 npm integrity（sha512-nzkfldYf3rIXeW0gfExtxoUdhaivsO+kAaKV4JpNLZC0OtxAUlnAZ0yHzf03IaOTNtAP/aXS7FOAr5O8Lckr1A==）与家族依赖闭包（全部对齐 `^0.1.5-alpha.2`），备将来生态适配后受信使用。
- 追评（同日）：审阅期间 master HEAD 已再前移至 `c291e79`（+160 提交、300 文件：`.agents/notes` 126、`apps/desktop` 76、`apps/web` 47）。显著主题：composer 命令菜单 UI、桌面打包方式与启动速度优化、macOS 签名/公证并行化、`docs(session)` 直接事件读取器弃用政策、CI 预算与夹具稳定化；`docs/architecture` 仅 i18n 同步。**基线仍锚定已审阅的发布点 `b2e3b2a`**，不追热 master；`--online` 门禁对 HEAD 漂移保持红灯即漂移信号，下一轮审阅覆盖 `b2e3b2a..HEAD`（`apps/desktop` 76 文件与桌面 fork 相关性高，需细读）。
- dist-tag 快照（同日）：npm `latest=0.1.5-rc.1`、`next=0.1.5-rc.2`、`alpha=0.1.5-alpha.2`。0.1.5 线已进入 rc 收敛期而生态适配仍未发生；`checkHarnessUpdate` 的两条发现通道（alpha/latest）当前均未受信，更新器只会通知不会切换，运行时槽保持 `0.1.2-alpha.5`。**0.1.2 → 0.1.5 运行时迁移是下一个大里程碑**，前置仍是 MichengAI 插件族适配 + 实机 Profile 验证。

## 2026-09-09 人工审阅记录

- 审阅范围：官方根 `AGENTS.md`、`docs/architecture.md`、`docs/testing.md`、`docs/defensive-patterns.md`，以及 `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8...5dda764ed3aa172535a7967b06ff95d9cbfe536a` 的提交和文件差异。
- 主要变化：会话格式继续向 v3 信封与预置系统原语演进，新增文件系统直接展示、composer 统计胶囊、历史内 system prompt 替换等 Client 能力；CLI 版本进入 `0.1.5-alpha.1`；架构与测试文档主要补充 agent scope、canonical session envelopes、prebuilt primitives 等设计笔记。
- Client UI 影响：新增能力与桌面外壳的 WebContentsView、preload IPC、主题令牌、菜单 Portal 和 Client Slot 接口无直接契约变更；官方独立 Electron 桌面应用继续作为上游私有实现，不移植其私有传输。
- 本仓库决策：按用户要求将内置官方运行时从 `0.1.2-alpha.3` 升级到 `0.1.2-rc.1`，并通过桌面 A/B 候选机制部署；不引入 `0.1.5-alpha.1` 的新会话格式、v3 信封或通用文件上传 API。运行时升级已核对 npm integrity 与 GitHub 标签 commit，留待打包后真实 Profile 组合验证。
- 后续决策（同日）：用户重启后发现运行时仍停留在 `0.1.2-alpha.5`，因 npm alpha 通道已推进到 `0.1.5-alpha.1` 且不在受信清单，更新被 block。用户明确表示无法自行维护、要求提示消失。已将 `0.1.5-alpha.1` 加入受信清单，并把实现基线提升至 `0.1.5-alpha.1`，随包版本同步对齐。升级后由 A/B 候选与自动回滚机制兜底。
- 再后续决策（同日晚）：`0.1.5-alpha.1` 实机验证失败——影子启动需先修复桌面 bootstrap（新版 `bin.js` 以 `import.meta.main` 守卫自执行，被 import 时必须显式调用其导出的 `runCli`，已修复并加双代回归测试）；修复后真实 Profile 切换仍失败，MichengAI 插件族最新版（dsh-automation 0.1.35）在 0.1.5-alpha.1 下抛 "cannot get property webServer without inject"，生态未适配。决策：`0.1.5-alpha.1` 从受信清单除名（integrity/commit 已记录备查，重新受信前必须过实机 Profile 验证）；`checkHarnessUpdate` 改为在 alpha 与 latest 双发现通道中选最新受信版本，alpha 未受信时回退 latest 稳定线（当前 `0.1.2-rc.1`，插件族按其 API 开发）；实现基线回到 `0.1.2-rc.1`。

## 2026-09-03 人工审阅记录

- 审阅范围：官方根 `AGENTS.md`、`docs/architecture.md`、`docs/testing.md`、`docs/defensive-patterns.md`，以及 `49a606bc5b5934603f22a26957a07dc799ab0291...76fda729799fe9b3848dbe2c211d4b231032b81e` 的提交和文件差异。
- 主要变化：统一出站代理策略、模型列表协议发现、Python 打包运行时 Node 解析修复、`0.1.2-rc.1` 版本发布。
- Client UI 影响：`apps/web`、`ui-layout`、`ui-primitives`、`ui-slots`、`client-web` 的相关包只变更版本号；唯一 Web 行为差异位于模型设置筛选，与桌面浏览器视图、菜单 Portal 和 Client Slot 接口无关。
- 本仓库决策：桌面合成层修复继续使用内置 `0.1.2-alpha.3` 的公开 `betterSidebar` 注册表和既有 preload IPC；不引入 `rc.1` API，不升级运行时。

## 2026-09-04 人工审阅记录

- 审阅范围：官方根 `AGENTS.md`、`docs/architecture.md`、`docs/testing.md`，以及 `76fda729799fe9b3848dbe2c211d4b231032b81e...d347e703908d0406b7a7ef80e3a0e594d86b2215` 的提交和文件差异。
- 主要变化：发布会话格式迁移与 v2 助手流、通用文件上传、会话搜索结果定位、技能模糊搜索、可点击链接呈现、Windows 根路径与隐藏子进程修复，官方版本进入 `0.1.3-alpha.1`。
- Client UI 影响：附件和输入栏新增通用文件上传；Workspace 搜索打开结果后会展开并定位会话；Markdown/WebBlock 调整链接样式；设计平台语义变量只扩展链接与文件呈现，没有改变桌面 WebContentsView 或外壳主题注入接口。
- 本仓库决策：本轮 Qoder 风格桌面外壳继续以 Electron 宿主和现有 `0.1.2-alpha.3` Client UI 主题变量为实现边界；不引入 `0.1.3-alpha.1` 的文件上传或 v2 会话 API，不迁移会话格式。运行时升级必须另立候选并完成数据迁移与回滚验证。

## 官方一手来源

### 2026-09-08 三项对齐审核的人工审阅

- 已审阅固定提交的根开发指令、架构、测试、defensive patterns、官方桌面 README 和提交比较；原文及比较记录位于 `artifacts/alignment-audit-20260908/official/`。
- 上游已引入独立官方 Electron 应用、专用 desktop Profile 和无 HTTP 端口的传输；本仓库仍是社区桌面宿主与 web Profile 的组合，不能直接移植其私有桌面协议。
- 本轮保持已安装 API、Profile 和会话格式，审核重点为真实入口、双方契约、状态提交、失败反馈和 UI 回归。上游重连、排队发送、会话迁移与客户端渲染变化作为兼容风险记录，不自动升级运行时。
- 验证遵循真实 Loader/应用组合和可观察结果，隔离审核数据与用户 Profile；本次全项目测试由用户明确要求，失败不以修改断言掩盖。

## 2026-09-16：随上游 v1.0.63 对齐内置运行时版本

- **动因**：上游发 `v1.0.63`（commit `079d1df`，范围 `up-v1.0.62..up-v1.0.63` 仅 2 个提交），其中 `7eaade7` 把
  `bundledDshVersion` / `OFFICIAL_DSH_VERSION` 由 `0.1.5-rc.2` 提到 `0.1.6-alpha.1`。用户明确选择"插件与运行时一起跟进"。
- **顺带发现的既有漂移**：本仓库 `package.json` 的 `bundledDshVersion` 原为 **`0.1.2-rc.1`**，而**实际在跑的运行时是
  `0.1.5-rc.2`** —— 声明与实装相差三代。本次按用户决定直接对齐到上游目标 `0.1.6-alpha.1`。
- **改了什么**：`package.json` 的 `bundledDshVersion`、`src/bundled-plugins.ts` 的 `OFFICIAL_DSH_VERSION`、
  以及随包矩阵四个插件（codex-ui `1.1.11`、dsh-context `0.53.0`、dsh-mcp-connector `0.2.49`、usage-billing `1.4.0`），
  连同声明的测试期望与本文档的"当前值"两行。
- **刻意没跟的**：`dsh-better-sidebar` 以**本地定制 link 分发**，实际安装版本为 `0.18.0-alpha.0`
  （`Data/DSH/profiles/web/local/dsh-better-sidebar/package.json`，2026-09-26 实测），升上游会把定制件换成 npm 包，等于覆盖用户定制。
  **⚠ 2026-09-26 发现一处内部不一致（待处置）**：`src/bundled-plugins.ts:64` 的矩阵条目写 `dsh-better-sidebar: 0.21.1`，
  而**同一文件 `:37-38` 的注释**仍写"版本仍锁 0.18.0；升到上游的 0.19.1…"——**注释与矩阵条目互相矛盾**，
  且矩阵值（0.21.1）与实际安装（0.18.0-alpha.0）不一致。已登记为独立问题，未擅自改动矩阵或安装（涉及分发口径）。
- **刻意没改的**：`package.json` 的 `version` 仍为便携仓自己的 `1.0.66`；上游的 `1.0.62→1.0.63` 属另一条发布线。
- **尚未完成（下一步）**：`0.1.6-alpha.1` 的运行时**尚未安装、活动槽仍为 `0.1.5-rc.2`**。按铁律不能原地安装，
  须走 `request-harness-update` → 外壳 A/B 更新器；并需复核各插件对 `0.1.6-alpha.1` 的 peer 兼容、
  UI 基线重记（两个升版插件都有客户端产物）与一次全量构建 + 重启验收。
- **证据**：`docs/01-当前工作/上游1.0.63吸收评估.md`（含镜像抓取通道与"标签名归便携仓、必须按 commit 判定"的踩坑记录）。


- <https://github.com/deepseek-ai/deepseek-harness>
- <https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart>
- <https://deepseek-harness.github.io/deepseek-harness/en/reference/>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/testing.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/defensive-patterns.md>
