# DeepSeek Harness 官方兼容基线

本文件把“遵守官方要求”落实为两条不可混用的基线：**实现基线**是便携版实际内置的运行时，**审查基线**是开发开始时核对到的官方最新提交。官方处于 Developer Preview，允许破坏性变更，因此不能看到新文档就直接调用旧运行时中不存在的接口。

## 当前基线

| 项目 | 当前值 | 用途 |
|---|---|---|
| **实现基线（活动运行时槽）** | `@deepseek-ai/dsh 0.1.5-rc.2`，槽 `Harness/slots/0.1.5-rc.2-fd316e6b895e48c1`（2026-09-11 17:09 提交） | **编译、运行、API 与 Profile 兼容性的最终依据**；上一槽 `0.1.2-rc.1` 保留以支撑回滚。出处：`Data/Runtime/Harness/current.json` |
| 打包内置运行时（回退） | `@deepseek-ai/dsh 0.1.6-alpha.1`（2026-09-16 随上游 v1.0.63 对齐） | 随桌面安装包分发的**回退**运行时，必须与 `package.json` 的 `config.bundledDshVersion` 一致（门禁脚本强制）。它不是正在使用的运行时；npm `latest` 当前为 `0.1.5-rc.1`，故二者已不再"与 latest 稳定线一致" |
| 官方审查基线 | `deepseek-ai/deepseek-harness@c291e7961a515f6d7af9304e7fd1d257929aef26` | 检查官方最新架构、开发和测试要求 |
| 官方审查版本 | `@deepseek-ai/dsh 0.1.5-rc.2` | master 已携带 rc.2 发布；已进受信清单，作为桌面 A/B 更新器的迁移目标 |
| 运行时迁移目标 | `@deepseek-ai/dsh 0.1.5-rc.2`（受信；`0.1.5-rc.1` 亦受信） | `checkHarnessUpdate` 经 npm integrity + GitHub 标签 commit + 受信清单三重核对后可自动切换；rc.1 保留受信以支撑回滚/降级路径 |
| npm 标签快照 | `latest=0.1.5-rc.1`、`next=0.1.5-rc.2`、`alpha=0.1.5-alpha.2`（2026-09-13 复核 npm registry） | 更新器发现通道与插件「关于」页展示口径的来源 |
| 核对日期 | `2026-09-13`（复核；官方 HEAD 未变，仍 `c291e79…`） | 判断本地规范是否过期 |

机器可读记录见 `DeepSeek-Harness-官方兼容基线.json`。

## 每个功能开始前的强制动作

1. 运行 `App/resources/node/node.exe scripts/verify-dsh-official-baseline.mjs --online`。它校验：① 基线 JSON 与桌面清单的仓库／文档／commit／内置版本一致；② **指针槽里打包的回退运行时** `dsh-runtime.tgz` 的版本与桌面清单一致；③ 历史回退目录 `Data/Runtime/dsh-runtime` **仅在不存在活动槽时**才强校验（有活动槽时允许落后，只给提示）；④ 联网核对官方 HEAD 与官方 CLI 版本。注意：该脚本**不检查活动运行时槽**——活动槽以 `Data/Runtime/Harness/current.json` 为准。
2. 完整阅读 `DeepSeek-Harness-插件开发规范知识库.md`，再按本功能涉及的子系统阅读官方 Reference/Cookbook 页面和当前内置包的类型声明。
3. 先分类行为归属：Electron 桌面宿主、DSH 插件、Profile/Bundle、运行时升级、用户数据迁移。只有 DSH 内部能力进入 Cordis 插件树；桌面宿主负责进程、窗口、便携路径和 A/B 部署，不伪装成 Harness 插件。
4. 若在线检查发现官方 HEAD 变化，先审阅官方 `AGENTS.md`、`docs/architecture.md`、`docs/testing.md` 及受影响子系统，再人工更新本基线和知识库。禁止脚本自动接受新规范。
5. 若网络不可用或官方变化尚未审阅，可以继续做诊断，但不得把实现称为“符合官方最新要求”或完成正式发布。

## 官方兼容性判定

- 自定义 Harness 行为优先通过 Profile、Bundle、插件、服务、事件和 Client Slot 扩展，不直接改写官方运行时包。
- 代码必须以**已内置** `0.1.6-alpha.1` 的实际导出和类型声明为准（2026-09-16 由 `0.1.2-rc.1` 对齐上游 v1.0.63 时更新；活动运行时槽仍为 `0.1.5-rc.2`，未切换）；官方文档只作为迁移预警，运行时经 A/B 切换真正生效前不得假定新 API 存在。
- 运行时升级属于兼容性迁移：需要独立候选、依赖闭包锁定、Profile 真实组合测试、会话格式评估、A/B 切换和自动回滚。
- 产品可见插件不能只做手工 `ctx.plugin()` 单元测试，必须通过 Loader + Profile 的真实组合路径验证。
- 用户可见状态只能在事务提交点后发布；失败前不得显示“完成”。
- UI 文案由本地化字典拥有；不得在新增 Client UI 中散落硬编码产品文案。
- 生命周期、并发、子进程或清理改动必须额外审阅官方 defensive patterns，并验证取消、处置、超时和进程树回收。
- 非平凡变更必须留下决策、替代方案、兼容影响和验证证据；本仓库使用对应迭代的实施/审查记录承载，不照搬官方仓库内部 PR 流程。

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
- **刻意没跟的**：`dsh-better-sidebar` 保持 `0.18.0`（上游 `0.19.1`）——它是**本地定制 link 分发**，升上游会把
  定制件换成 npm 包，等于覆盖用户定制（矩阵注释与 UI 契约均如此规定）。
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
