# 09 — System Intelligence Layer 实施方案（第一阶段草案）

> 状态：机制设计定稿，证据与现状引用待 4 份审计文档（01–08）汇总后回填。
> 原则：**不为建设大局观而重新设计 DSH**。本方案只新增"认知层"文件与流程挂钩，不改任何业务代码。

## 1. 目标与定位

- 让 AI 从"搜到相关文件就改"升级为"先定位任务在系统中的位置，再决定怎么改"。
- 认知层分两类资产：
  - **自动生成类**（可随代码重建，不写手写结论）：目录结构、调用点索引、插件清单、测试清单。
  - **人工/AI 维护类**（代码推不出来的知识）：模块职责、数据流叙述、设计决策、影响面经验、禁区。

## 2. 文件体系（docs/05-系统认知/）

| 文件 | 内容 | 更新方式 | 更新时机 |
|---|---|---|---|
| `00-总览索引.md` | 全部认知文件入口 + 阅读顺序 + 任务路由 | 人工 | 新增/变更认知文件时 |
| `01-产品全貌与系统概览.md` | 产品定位、入口链、核心功能链路 | AI 重审 | 官方基线变化/大版本后 |
| `02-代码地图.md` | 目录→模块→职责树，标注源码/生成物 | 半自动（脚本生成骨架+人工标注职责） | 结构变化时 |
| `03/05-依赖地图` | 外壳更新链、运行时插件系统的正反向依赖 | AI 重审 | 对应子系统改动后 |
| `04/06-数据流` | 启动/更新/部署、会话/插件交互链路 | AI 重审 | 对应链路改动后 |
| `07-设计决策记录.md` | Decision/Reason/Therefore 三段式 ADR | 追加式 | 每次产生新决策时 |
| `08-大局观失守分析.md` | 失守原因 + 认知基建缺口 | 人工评审 | 季度或重大事故后 |
| `10-GlobalContextCheck与ImpactReview模板.md` | 前置/后置检查模板 | 人工 | 检查项本身演进时 |

事实优先级（与用户要求一致）：真实代码/配置/Schema > 实际依赖关系 > Git 历史 > 测试 > 架构决策 > 说明文档。所有认知文件必须在开头声明"本文件是二手资料，冲突时以代码为准"。

## 3. 可自动生成部分（建议脚本化，本阶段不实现）

放置于 `scripts/system-intel/`，产物写入 `docs/05-系统认知/generated/`（gitignore 可选）：

1. **目录树与文件清单**：glob 顶层目录 → 生成 02 的骨架（排除 node_modules、App/resources 运行时槽内容物只列顶层）。
2. **本地插件清单**：读 `Data/DSH/profiles/web/package.json` + `local/*/package.json` → 插件名、版本、inject、patch 条目 id。
3. **测试清单**：枚举 `test/*.test.ts` → 名称与被测主题（从文件头注释提取）。
4. **调用点索引**：对每个"高影响模块"维护 grep 模式表，输出引用文件:行号（等价于 GCC 第 5 项的预计算）。
5. **官方基线快照**：复用现有 `verify-dsh-official-baseline.mjs` 的输出追加到 generated。

生成脚本由"认知文件更新时机"触发（见 §5），CI/本地门禁不强制。

## 4. 必须人工/AI 维护的部分

- 模块职责一句话与"高影响/Risk Level"评级（代码无法自证）。
- 数据流叙述（每步"为什么"）。
- 设计决策（07）：只记录影响未来开发的决策，拒绝流水账；每条必须含 Therefore（可执行禁令）。
- 禁区清单（Do Not Touch）：生成物目录、指纹槽语义、bundle 摘除自愈等。
- AGENTS.md「已踩过的坑」仍是第一手坑典：**不迁移、不改写**，认知文件引用它。

## 5. Global Context Check 落地机制（任务前置）

三层挂钩，按生效成本从低到高：

1. **AGENTS.md 增加一行强制条款**（最小改动）：中/大型任务（判定标准见模板 §适用判定）必须在最终答复前完成 `docs/05-系统认知/10-*.md` 的 12 项前置检查并填写结论模板。
2. **技能化**：新建 `dsh-global-context` 技能（与 dsh-dev-spec 并列），内容 = 读 00 索引 → 读 02 找模块位置 → grep 反查调用点 → 读 07 查约束 → 输出 GCC 结论。凡是 dsh-dev-spec 匹配的任务同时匹配本技能。
3. **子代理提示词模板**：仓库维护一份标准审计前缀（任务路由 + 认知文件路径），派出子代理时注入，保证并行审计不偏离事实源规则。

## 6. Global Impact Review 落地机制（任务后置）

1. GIR 10 项检查追加进 dsh-dev-spec 技能的"完成汇报要求"一节（该技能已是改动后门禁的执行入口，不另起炉灶）。
2. 第 2 项（超范围）触发"重新影响分析"已写入模板判定规则，AGENTS.md 强制条款中显式引用。
3. 功能清单登记（`docs/00-交接入口/07-功能清单.md`）以 GIR 全 PASS 为前置条件——把现有三项对齐门禁与 GIR 串成一条链，避免两套检查各跑各的。

## 7. 长期演进（非本阶段）

- 依赖图可视化（madge 之类对 src/ 生成 mermaid，人工审核后入 03/05）。
- 会话结束时自动 diff "预计修改文件 vs 实际修改文件"，偏差自动提示重审。
- 认知文件的"最后核实于 <commit>"戳，与官方基线脚本联动，基线变化即标记认知文件待重审。

## 8. 本阶段不做的事

- 不重构任何业务代码、不移动文档、不改打包与启动链路。
- 不实现 §3 的脚本（先人工跑一轮验证模板可用，下一阶段再固化）。
- 不把认知文件接入 CI 门禁（避免审计成本前置阻塞小任务）。

---

## 回填完成（2026-09-11 审计汇总）

### R1. 核心模块 Risk Level 评级表（来自 01–06 审计）

| 模块 | 风险 | 依据 |
|---|---|---|
| `runtime-archive.ts`（tar 探测） | 高 | GNU/bsdtar 环境差异，测试过≠用户可用（03） |
| `writeOfficialRuntimeManifest` | 高 | 写活动槽="更新成功版本没变"坑根源；指纹槽不被启动检查覆盖，靠 `reconcileOfficialRuntimeManifest` 自愈（03） |
| `startHarnessUpdateTask` | 高 | 三入口 + 单飞行语义，绕过退避门禁会放大失败（03） |
| `prepare-runtime.ts` | 高 | 输出物必须匹配两处 REQUIRED 清单（03） |
| 官方运行时槽（App/dsh-runtime） | 高 | 只读构建产物，200+ 官方包嵌套；禁止原地安装（05） |
| profile `cordis.patch.yml` 合并链 | 中高 | 按 id 整行替换、后层胜出；随包矩阵逐项 patch（**项数以 `src/bundled-plugins.ts` 的 `BUNDLED_PLUGINS` 为准**，2026-09-26 读数为 15 项）（05） |
| `Data/DSH/profiles/web/package.json` | 中高 | specifier 领先安装地雷；任何 pnpm install 会物化新矩阵（05） |
| ~~本地插件 `local/dsh-codex-ui`~~ | — | 已于 2026-09-11 退役删除（备份 zip 在 Data/Development/）；活动版为 npm `@michengai/dsh-codex-ui`（**版本以矩阵现读为准**，2026-09-26 读数为 `1.1.18`），其缺失旧副本定制功能（批量归档、data-plugin 样式标记）已登记 AGENTS.md |
| 其余 local 插件（5 件 Junction 链接） | 低中 | 即时生效，但 schemastery 依赖、bundles 摘除自愈需遵守（05） |
| `Build-DSH-Portable.ps1` / 启动器 ps1 | 中 | 门禁 + 候选暂存；UTF-8 BOM、双击环境验证（02/03） |

### R2. 失守原因 → 本方案挂钩点对应（来自 08 的 R-1~R-9）

- 坑典散文式、不可机读（AGENTS.md 无结构化字段）→ §4：不迁移坑典，07 决策记录以 D-xx 结构化索引互链。
- 决策"为什么"散落、无互链 → §2：07 成为唯一决策索引，GCC 第 10 项强制查 07。
- 无模块职责/依赖地图 → §2：01–06 六份审计文档补齐；GCC 第 1–5 项直接引用。
- 无调用点预查工具 → §3：generated/ 调用点索引脚本（对 R1 表中高/中高风险模块优先建 grep 模式表）。
- 生成物与源码并存易误改 → §4 禁区清单 + GCC 第 12 项（02 号文 §0"生成物 vs 源码"一节为权威）。
- 多插件并行、重复造轮子 → GCC 第 7/8 项：先查 05 号文插件清单（6 件本地插件职责一句话）。
- 文档分散、入口不明 → §2：00 索引规定阅读顺序与任务路由。
- 检查靠自觉、无强制 → §5/§6：AGENTS.md 强制条款 + dsh-global-context 技能 + dsh-dev-spec GIR 追加 + 功能清单登记以 GIR 全 PASS 为前置。
- 会话级上下文断裂（并行子代理各写各的）→ §5 第 3 层：子代理提示词模板注入事实源规则。

### R3. generated/ 脚本清单的具体模式表（来自 03/05 高频反查对象）

| 脚本 | 输入 grep 模式/数据源 | 输出 |
|---|---|---|
| `gen-file-tree.mjs` | glob 顶层目录（排除 node_modules、运行时槽内容物） | 02 骨架 |
| `gen-plugin-inventory.mjs` | `profiles/web/package.json` bundles + `local/*/package.json` + 各 cordis.patch.yml id | 插件清单表 |
| `gen-test-inventory.mjs` | `test/*.test.ts` 文件头注释 | 测试清单 |
| `gen-call-sites.mjs` | 模式表：`request-harness-update`、`startHarnessUpdateTask`、`writeOfficialRuntimeManifest`、`slots.inject(`、`registerTab(`、`ctx.get('betterSidebar')` 等 | 文件：行号索引 |
| `gen-baseline-snapshot.mjs` | 复用 `verify-dsh-official-baseline.mjs` 输出 | generated/baseline.md |

优先级：`gen-call-sites.mjs` > `gen-plugin-inventory.mjs` > 其余（按 GCC 第 5 项的人工成本排序）。
