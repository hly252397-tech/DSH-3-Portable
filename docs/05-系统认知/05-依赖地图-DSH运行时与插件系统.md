# 05 依赖地图 — DSH 运行时与插件系统

> 审计日期：2026-09（以实机产物为准）。官方运行时为构建产物，只读分析。
> 所有路径均以仓库根 `G:\DSH-3-Portable` 为基准。

---

## 1. 运行时实体的真实位置与版本

> **⚠ 2026-09-26 更正（本节路径与版本已过期，请以事实源现读为准）**
>
> 本节下文按 `App\dsh-runtime` 撰写，但：
> 1. **`App\dsh-runtime` 从来不是"正在运行的活动槽"**（本节第 13 行原写作"活动运行时槽（正在运行）"，是错的）。
>    该目录**确实存在**（2026-09-26 实测：`dsh`/`dsh.cmd`/`dsh.ps1`/`package.json`/`pnpm-workspace.yaml`/`.dsh-extract-complete`），
>    但它是**历史解压产物 `0.1.2-alpha.3`，只作 slots 全不可用时的最后回退**；
> 2. **活动运行时槽**是 `Data/Runtime/Harness/slots/<版本>-<指纹>`，由 `Data/Runtime/Harness/current.json` 指向；
>    2026-09-26 读数为 **`0.1.7-rc.2`**（槽 `0.1.7-rc.2-4d29c691bfdf224c`），回滚目标 `0.1.6-alpha.2`；
> 3. 下列 `0.1.2-alpha.3` 版本号与"200+ 官方包 / 1319 个 .d.ts"是**撰写时对 legacy 目录的读数**——它们描述的是回退件而非产品实际运行的运行时，
>    **不得作为"当前运行时"引用**；需要类型一手资料时去**活动槽**目录下现读；
> 4. **随包插件矩阵项数以 `src/bundled-plugins.ts` 的 `BUNDLED_PLUGINS` 为唯一事实源**（2026-09-26 读数为 **15 项**）。

| 实体 | 路径 | 版本 |
|---|---|---|
| 随包运行时压缩包 | `App/resources/dsh-runtime.tgz`（+`.sha256`） | 首启原子解压 |
| **活动运行时槽**（正在运行） | `Data\Runtime\Harness\slots\<版本>-<指纹>`（`current.json` 指向） | **0.1.7-rc.2**（2026-09-26 读数） |
| 回滚槽（`previous`） | `Data\Runtime\Harness\slots\0.1.6-alpha.2-cf1f0a33455401b5` | 0.1.6-alpha.2 |
| legacy 回退件 `App\dsh-runtime`（**存在，但非活动槽**） | `App\dsh-runtime\node_modules\@deepseek-ai\dsh` | 0.1.2-alpha.3（最后兜底） |
| 解压逻辑 | `App\resources\extract-runtime.mjs`（入口校验 `node_modules/@deepseek-ai/dsh/lib/bin.js`）、`runtime-archive.js` | — |
| 桥接/外壳脚本 | `App\resources\desktop-bridge\*.js`（`desktop-bridge.mjs`、`plugin-seed.js`、`profile-updates.js` 等） | — |

> **⚠ 2026-09-26：下面这段是 legacy 回退件的读数，不是活动槽的**（`App\dsh-runtime\package.json` 确实存在；`0.1.2-alpha.3` 与"1319 个 .d.ts"描述的是回退件）。
> 需要运行时根清单与类型一手资料时，请在**活动槽**目录下现读：`Data\Runtime\Harness\slots\0.1.7-rc.2-4d29c691bfdf224c\`。
>
> ~~运行时根清单 `App\dsh-runtime\package.json`：私有根包 `dsh-desktop-runtime`，直接依赖仅 `@deepseek-ai/dsh@0.1.2-alpha.3` + `cordis-plugin-group` + `dsh-scope/dsh-timeout/dsh-invariants`（全部同版本家族）。其余 200+ 官方包以嵌套方式物理存在于 `App\dsh-runtime\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`（pnpm 嵌套布局），全部精确 `0.1.2-alpha.3`，且每个包都带 `lib\types\**\*.d.ts`（共 1319 个 .d.ts，类型审计一手资料）。~~

---

## 2. `ctx` 核心服务面（以 .d.ts 声明合并核实）

Cordis 通过 `declare module '@deepseek-ai/cordis' { interface Context { … } }` 声明服务。以下为实机类型声明摘录（省略号处为原文路径）：

| ctx 键 | 类型 | 声明位置（相对 `App\dsh-runtime\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`） |
|---|---|---|
| `ctx.tools` | `ToolRuntime` | `dsh-tools\lib\types\index.d.ts`（`interface Context { tools: ToolRuntime }`） |
| `ctx.llm` | `LlmRuntime` | `dsh-llm\lib\types\index.d.ts`（附 `llm/stream` waterfall 事件） |
| `ctx.commands` | `CommandRuntime` | `dsh-commands\lib\types\index.d.ts` |
| `ctx.jobs` | `JobRegistry` | `dsh-jobs\lib\types\index.d.ts`（抽象注册表，`dsh-jobs-local` 提供实现） |
| `ctx.sessions` | `SessionStore` | `dsh-session\lib\types\index.d.ts`（仅追加事件日志 + `session/event`） |
| `ctx.agentLoop` / `configuredAgentIdentities` | `AgentLoop` | `dsh-agent-loop\lib\types\index.d.ts` |
| `ctx.webServer` | `WebServer` | `dsh-host-webserver\lib\types\index.d.ts`（附 index 注入事件） |
| `ctx.connection` | `HostConnectionHandle` | `dsh-client-connection\lib\types\rpc-host.d.ts`（"Host Connection transport and RPC registrations"） |
| `ctx.subagents` | `SubagentRuntime` | `dsh-subagent\lib\types\index.d.ts` |
| `ctx.clientModules` | `ClientModuleRegistry` | `dsh-client-modules\lib\types\index.d.ts`（web 插件表） |
| `ctx.typert` | typert 注册表 | `dsh-typert-registry\lib\types\service.d.ts`（dsh-base patch 里 `id: typert`） |
| `ctx.slots`（浏览器半侧） | slots 注入面 | `dsh-client-ui-cordis\lib\types\client\slots.d.ts`；运行时自用示例见 `dsh-client-ui-cordis\lib\client.js`（`ctx.slots.inject("sidebar.footer.action", …)`） |
| `ctx.locale`（浏览器半侧） | 本地化 | `dsh-client-locale\lib\types\client\index.d.ts` |
| `ctx.loader` | Loader 服务 | `cordis-plugin-loader\lib\types\index.d.ts`（`interface Context`） |
| `ctx.timer` | TimerService | `cordis-plugin-timer\lib\types\index.d.ts`（`extends Pick<TimerService,…>`） |

其余域服务同法可查：`dsh-fs`、`dsh-shell`、`dsh-skill`、`dsh-workspace`、`dsh-storage`、`dsh-settings`、`dsh-credentials`、`dsh-subprocess`、`dsh-sandbox`、`dsh-workflow`、`dsh-goal`、`dsh-user-questions`、`dsh-session-persistence`、`dsh-session-query`、`dsh-token-meter` 等（各自 `lib\types\index.d.ts` 均带 `interface Context` 合并块）。

要点：`dsh-web-app` 浏览器半侧的 slots/locale 不在 Node `Context` 上，而是 client-runtime 的独立面——社区插件 `dsh.client.inject` 里声明的正是 `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-locale` 这类**浏览器包**（证据：`Data\DSH\profiles\web\local\dsh-better-sidebar\package.json` 的 `dsh.client.inject`）。

---

## 3. 插件加载机制

### 3.1 Profile 组成

`Data\DSH\profiles\web\` 下：

- `package.json`：`dsh.profile.bundles` **有序数组**（21 项，`@deepseek-ai/dsh-base` 永远第一），`dependencies` 声明安装来源。
- `cordis.yml`：**空数组**（`[]`，文件头注释明确"树由 patch 合成，改 cordis.patch.yml 而非本文件"）。
- `cordis.patch.yml`：profile 自有层，当前仅一条 `- insert: [{id: dsh-desktop-bridge, name: dsh-desktop-bridge}]`。
- `node_modules\`：官方/社区包 + **指向 `local\<插件>` 的 Junction**（见 §3.4）。
- `pnpm-lock.yaml` / `pnpm-workspace.yaml`。

### 3.2 patch 层叠顺序（loader 实现）

`App\dsh-runtime\node_modules\@deepseek-ai\dsh\lib\profile-boot-BTzzdrGY.js`：

```
dsh.profile.bundles 各组合包层（按列表序，读每包 dsh.bundle.patch 指向的 cordis.patch.yml）
→ profile 自己的 cordis.patch.yml
→ $DSH_HOME/cordis.patch.yml（机器级，resolveDshHome()+PROFILE_PATCH_FILENAME）
→ 各 --patch overlay（argv 顺序）
```

合并规则：**按 id 定位行、整行 config 替换、后层胜出（非深合并）**。原文注释（`profile-boot-BTzzdrGY.js` L75/124、`dsh-base\cordis.patch.yml` 头注释）："Later bundle patches and the user's profile cordis.patch.yml address these rows by id, with the last write winning per row. A patch replaces the targeted row's whole `config` rather than merging into it."

实例（codex-ui 的 `node_modules\@michengai\dsh-codex-ui\cordis.patch.yml`；**版本以 `src/bundled-plugins.ts` 矩阵现读为准**，2026-09-26 读数为 `1.1.18`）：

```yaml
- id: ui-sidebar
  disabled: true        # 整行禁用官方 ui-sidebar
- id: ui-settings-general
  disabled: true
- insert:
  - id: codex-ui
    name: '@michengai/dsh-codex-ui'
```

`dsh-base\cordis.patch.yml` 是最大的一层：一次性 insert 全部核心行（`timer`、`llm`、`session`、`typert`、`commands`、`webServer`、`web-app` 等）。

### 3.3 三种导出形态与 inject 生效通道

| 形态 | inject 声明通道 | 实例 |
|---|---|---|
| 命名导出 `name`+`inject`+`apply` | 模块级 `export const inject` 即生效；patch 条目只需 `id`+`name` | `@michengai/dsh-agency-agents`（patch 仅两行 id+name，见其 `cordis.patch.yml`） |
| default export 类 | 类静态 `static inject = [...]` | 官方服务包（如 `dsh-jobs` 抽象注册表"Subclass … and load the subclass as a plugin"） |
| default export 函数 | loader **不读模块级 inject**，必须在 patch 条目写 `inject:` 字段 | `plan-quota`（历史教训：缺失时抛 `cannot get property command without inject`，见根 AGENTS.md） |

加载顺序是**服务可用性驱动**而非行序：`dsh-base\cordis.patch.yml` 头注释 "Row order carries no load semantics (activation is service-availability driven)"。`inject` 未就绪 → Fiber 停 PENDING；把不存在的服务写进 inject → 永久 PENDING → 启动失败（AGENTS.md 已踩坑）。

### 3.4 本地插件的目录链接（Junction）

`Data\DSH\profiles\web\node_modules\` 实测：

```
dsh-better-sidebar [Junction] → local\dsh-better-sidebar
dsh-black-hole     [Junction] → local\dsh-black-hole
dsh-restart-button [Junction] → local\dsh-restart-button
dsh-sidebar-spaces [Junction] → local\dsh-sidebar-spaces
dsh-work-mode      [Junction] → local\dsh-work-mode
```

声明为 `link:local\<名字>`（profile `package.json`）。**改 `local\<插件>` 即时生效，无需同步 node_modules**；改回 `file:` 会重新物化拷贝（双拷贝陷阱，AGENTS.md 2026-09-11 条目）。

⚠️ 版本漂移实例（**历史记录，2026-09-11 已终结**）：`local\dsh-codex-ui` 曾是 0.2.113 的移植副本，而被 bundles 里的 `@michengai/dsh-codex-ui`（当时 `1.1.2`）遮蔽——**该本地副本 2026-09-11 已退役删除**（备份 `Data/Development/archived-local-dsh-codex-ui-20260911.zip`），"遮蔽"问题随之消失。现役版本以 `src/bundled-plugins.ts` 矩阵为准。

---

## 4. 当前 profile 已装插件清单

bundles（`Data\DSH\profiles\web\package.json` → `dsh.profile.bundles`，按序）：

> **✅ 2026-09-26 已按事实源重建（原表作废并替换）**
>
> 原表（撰写时快照）实测同时发生**版本漂移**与**成员漂移**：
> - 版本全部过期（例：`dsh-im-connect` 表内 `0.1.45` → 实 `0.1.55`；`codex-ui` 表内 `1.1.2` → 实 `1.1.18`）；
> - 成员对不上：旧表含 `dsh-context` / `dsh-desktop-bridge` / `dsh-work-mode` / `dsh-builtin-browser`（**均已不在矩阵**），却缺 `@michengai/dsh-code-review`、`dsh-pua`、`codex-pet`（矩阵有）。
>
> **下表已按唯一事实源重建**：`src/bundled-plugins.ts` 的 `BUNDLED_PLUGINS`（14 项）+ 官方行（`OFFICIAL_RUNTIME` / `OFFICIAL_PROFILE_BUNDLES`）。
> **成员与版本一律以该常量为准**——本表会再次过期，冲突时以代码为准，不要在此抄第三份。
> 复现方式：现读 `BUNDLED_PLUGINS` 逐条比对，而非信任本表。
| # | bundle | 实装版本（2026-09-26 按矩阵现读） | 职责一句话 |
|---|---|---|---|
| 1 | `@deepseek-ai/dsh-base` | 随 `OFFICIAL_DSH_VERSION` | 官方核心层：一条 insert 装齐 timer/llm/session/tools/commands/webServer/typert 等全部核心服务 |
| 2 | `@deepseek-ai/dsh-web-app` | 随 `OFFICIAL_DSH_VERSION` | Web 浏览器表面：覆盖 base 行的 web 专属配置（persona、`:memory:` 会话查询等） |
| 3 | `@michengai/dsh-codex-ui` | `1.1.18` | Codex 风格重造 DSH Web 侧栏/设置：patch 禁用 `ui-sidebar`/`ui-settings-general` 后 insert 替代实现 |
| 4 | `@michengai/dsh-im-connect` | `0.1.55` | 把本机 agent 接入微信/企微/钉钉/飞书/QQ/Telegram，`webServer.register` HTTP API + 逐渠道长连接生命周期 |
| 5 | `@michengai/dsh-automation` | `0.1.45`（**刻意不升**上游 0.1.51） | 定时在独立 DSH Session 执行编码任务，Web 设置页与 Agent 双入口管理；0.1.51 的 client bundle 已高度 minified，工作台文本插桩补丁无法重钉，故保持 0.1.45 |
| 6 | `@michengai/dsh-skills-manager` | `1.1.4` | 跨 DSH 与本地 Agent 安全装载/管理技能（接 `dsh-skill` 服务） |
| 7 | `@michengai/dsh-archive-manager` | `1.0.5` | 会话归档管理（官方 workspace 的替换式管理插件） |
| 8 | `@michengai/dsh-agency-agents` | `1.0.5` | 可召唤领域专家花名册（expert mode），含 agency-agents-remote typert 路由 |
| 9 | `@michengai/dsh-codex-pet` | `0.1.10` | 桌宠插件：Codex 原始宠物库、Skill 创建、网页内显示 |
| 10 | `@michengai/dsh-btw` | `0.1.13` | 只读旁问气泡：`ctx.subagents.start(fork)` + `ctx.tools.guard` |
| 11 | `@michengai/dsh-simplify` | `0.1.10` | 代码简化：限定 Git 变更范围，`ctx.commands.register` + `invocation.agent.followup` 注入消息 |
| 12 | `@michengai/dsh-code-review` | `0.1.7` | 代码审查 |
| 13 | `@michengai/dsh-pua` | `0.3.18` | PUA 风格表达增强 |
| 14 | `dsh-better-sidebar` | `0.21.1`（⚠ 与实际安装 `0.18.0-alpha.0` 不一致，见登记册 R-169） | VSCode 式右侧栏（资源管理器/编辑器/终端/git/浏览器），按会话隔离，暴露 tab/查看器注册服务。**本仓库以 `link:local/dsh-better-sidebar` 分发本地定制件**——同文件注释仍写"版本锁 0.18.0"，与矩阵条目矛盾 |
| 15 | `dsh-mcp-connector` | `0.2.59` | MCP 连接器市场：发现/授权/管理外部 MCP Server（OAuth PKCE、API Key、stdio/HTTP） |
| 16 | `dshmarket` | `1.66.1` | 可视化插件市场：浏览、搜索、一键安装社区插件 |

`schemastery@3.18.0` 显式钉在 dependencies（本地插件共同依赖，曾因剪枝崩过，AGENTS.md）。

---

## 5. 反向影响：改了什么会动到什么

| 改动点 | 直接影响 | 波及/风险 |
|---|---|---|
| **`local\<插件>`（Junction 源）** | 即时生效于下次加载/HMR；node_modules 同步可见 | 该插件的宿主服务 + 浏览器 bundle（`dsh.client` 声明的 client 导出由 `dsh-client-modules` 增量扫描，见其 `lib\types\index.d.ts` 模块注释）；写坏 `apply()` 会在加载时同步抛错——影子验证不覆盖社区插件（AGENTS.md §12.3） |
| **`@michengai/dsh-codex-ui`（node_modules，随包矩阵钉版）** | 当前真正挂载的侧栏/设置实现 | ~~`local\dsh-codex-ui` 不生效~~ **2026-09-11 起该本地副本已删除，遮蔽问题不存在**；定制 codex-ui 一律改矩阵钉版的安装产物，或按迭代重做（AGENTS.md） |
| **某条 patch 行**（bundle 或 profile 层） | 按 id 整行替换该条目 config | 只影响该 id；重述不全会丢同行其它键（后层胜出非深合并）；改 `disabled:true` 会级联卸载依赖其服务的插件 |
| **profile `package.json`** | bundles 序 → patch 层序；dependencies → 安装矩阵 | 任何 `pnpm install` 会物化 specifier 领先的整个新矩阵（2026-09-11 三连故障）；`pnpm add` 会重写 bundles 邻近字段并规范化 link 写法；官方运行时家族钉版靠 `resolutionMode: time-based`（三入口），不靠 overrides |
| **`dsh-desktop-bridge` patch 行** | 便携版外壳桥的挂载与配置 | 摘掉即失去外壳 IPC（重启按钮、更新请求 `request-harness-update` 等全链路失效） |
| **官方运行时槽（`App\dsh-runtime`）** | 只读构建产物 | 禁止原地安装/替换；更新必须走 A/B 候选槽 + 影子验证 + 失败回滚（AGENTS.md §12.1/12.3） |

---

## 6. 一句话结论

运行时 = **活动槽** `Data\Runtime\Harness\slots\0.1.7-rc.2-4d29c691bfdf224c`（由 `current.json` 指向；服务面以该槽内各包 `lib\types\*.d.ts` 的 Context 合并块为准，**2026-09-26 读数**；`App\dsh-runtime` 是 `0.1.2-alpha.3` 的**最后兜底回退件**，不是活动运行时）；插件系统 = profile 的 bundles 序 + 四层 patch 按 id 整行覆盖 + 服务可用性驱动激活；本地插件经 Junction 即时生效。`local\dsh-codex-ui` 的遮蔽问题**已随该副本 2026-09-11 退役而消失**（现役版本以 `src/bundled-plugins.ts` 矩阵为唯一事实源；2026-09-26 读数为 `1.1.18`）。
