# DeepSeek Harness 官方兼容基线

本文件把“遵守官方要求”落实为两条不可混用的基线：**实现基线**是便携版实际内置的运行时，**审查基线**是开发开始时核对到的官方最新提交。官方处于 Developer Preview，允许破坏性变更，因此不能看到新文档就直接调用旧运行时中不存在的接口。

## 当前基线

| 项目 | 当前值 | 用途 |
|---|---|---|
| 便携版实现基线 | `@deepseek-ai/dsh 0.1.2-rc.1` | 编译、运行、API 和 Profile 兼容性的最终依据；与 npm latest 稳定线一致 |
| 官方审查基线 | `deepseek-ai/deepseek-harness@5dda764ed3aa172535a7967b06ff95d9cbfe536a` | 检查官方最新架构、开发和测试要求 |
| 官方审查版本 | `@deepseek-ai/dsh 0.1.5-alpha.1` | alpha 预览线；已从受信清单除名（生态未适配），仅作迁移预警 |
| 核对日期 | `2026-09-09` | 判断本地规范是否过期 |

机器可读记录见 `DeepSeek-Harness-官方兼容基线.json`。

## 每个功能开始前的强制动作

1. 运行 `App/resources/node/node.exe scripts/verify-dsh-official-baseline.mjs --online`。该命令验证便携版清单、实际运行时版本、官方提交和官方 CLI 版本。
2. 完整阅读 `DeepSeek-Harness-插件开发规范知识库.md`，再按本功能涉及的子系统阅读官方 Reference/Cookbook 页面和当前内置包的类型声明。
3. 先分类行为归属：Electron 桌面宿主、DSH 插件、Profile/Bundle、运行时升级、用户数据迁移。只有 DSH 内部能力进入 Cordis 插件树；桌面宿主负责进程、窗口、便携路径和 A/B 部署，不伪装成 Harness 插件。
4. 若在线检查发现官方 HEAD 变化，先审阅官方 `AGENTS.md`、`docs/architecture.md`、`docs/testing.md` 及受影响子系统，再人工更新本基线和知识库。禁止脚本自动接受新规范。
5. 若网络不可用或官方变化尚未审阅，可以继续做诊断，但不得把实现称为“符合官方最新要求”或完成正式发布。

## 官方兼容性判定

- 自定义 Harness 行为优先通过 Profile、Bundle、插件、服务、事件和 Client Slot 扩展，不直接改写官方运行时包。
- 代码必须以已内置 `0.1.2-rc.1` 的实际导出和类型声明为准；官方 `0.1.5-alpha.1` 文档只作为迁移预警，运行时升级完成前不得假定新 API 存在。
- 运行时升级属于兼容性迁移：需要独立候选、依赖闭包锁定、Profile 真实组合测试、会话格式评估、A/B 切换和自动回滚。
- 产品可见插件不能只做手工 `ctx.plugin()` 单元测试，必须通过 Loader + Profile 的真实组合路径验证。
- 用户可见状态只能在事务提交点后发布；失败前不得显示“完成”。
- UI 文案由本地化字典拥有；不得在新增 Client UI 中散落硬编码产品文案。
- 生命周期、并发、子进程或清理改动必须额外审阅官方 defensive patterns，并验证取消、处置、超时和进程树回收。
- 非平凡变更必须留下决策、替代方案、兼容影响和验证证据；本仓库使用对应迭代的实施/审查记录承载，不照搬官方仓库内部 PR 流程。

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


- <https://github.com/deepseek-ai/deepseek-harness>
- <https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart>
- <https://deepseek-harness.github.io/deepseek-harness/en/reference/>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/testing.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/defensive-patterns.md>
