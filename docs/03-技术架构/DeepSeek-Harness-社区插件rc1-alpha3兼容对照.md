# DeepSeek Harness 社区插件 rc.1 ↔ 内置运行时 兼容对照

> 用途：社区插件（MichengAI 8 件套等）按官方 `@deepseek-ai/* 0.1.2-rc.1` API 开发；便携版实现基线已升级为 `0.1.2-rc.1`。本表逐项核对 rc.1 API 在本地运行时**实物**中的存在性与形态差异，作为移植/排障的判定依据。对应 `AGENTS.md` 的「官方兼容性双基线」与「社区插件生态实证」。
>
> 核对时间：2026-09-07；基线更新：2026-09-09。证据源：
> - `App/dsh-runtime/node_modules/@deepseek-ai/`（rc.1 实物；顶层只有 5 个壳包，实际包在 `dsh/node_modules/@deepseek-ai/` 下，含 6931 个 `.d.ts`）
> - `Data/DSH/profiles/web/package.json`（本机实装组合）
> - `Data/DSH/dsh-skills-manager.log`、`Data/DSH/dsh-im-connect/`（实测运行痕迹）
>
> 排障提示：ripgrep/搜索工具会按 `.gitignore` 跳过 `App/`，搜运行时必须用 `grep -r`（bash）。

## 1. 总判定

| 维度 | rc.1 社区插件假设 | 内置运行时实物 | 判定 |
|---|---|---|---|
| 宿主 ctx 服务键 | 各 `@deepseek-ai/*` 包提供 | 83 个包做 `interface Context` 增强，社区插件用到的键全部存在（见 §2） | ✅ 兼容 |
| 宿主 API 方法 | register/start/section/guard/followup/prefix/await/pre-execute… | 逐项找到类型或符号（见 §3） | ✅ 兼容 |
| 客户端 slots API | `@deepseek-ai/dsh-client-ui-slots` 包 | **无此包**；`slots` 服务由 `dsh-cordis-client-runner`（加载器）与 `dsh-client-ui-renderer` 提供，枚举出 52 个 slot 路径 | ✅ API 在，包载体不同 |
| 客户端包 require | peer 依赖 `dsh-client-runtime`/`dsh-client-ui-primitives`/`dsh-client-store` 等 | 不在 dsh-runtime 内；经 profile 依赖安装（`Data/Runtime/plugins/store`，pnpm v11 内容寻址仓库）+ 桌面 `window.__ModuleLoader__` 注入 | ⚠️ 机制不同，走查安装产物 |
| betterSidebar | ——（社区方案） | 内置运行时无此注册表；来自 profile 里第三方 `dsh-better-sidebar@0.18.0-alpha.0` | 非基线能力，随插件装 |
| subagents fork | `ctx.subagents.getProvider('fork')` / `start('fork', …)`（dsh-btw） | `dsh-subagent-fork-in-process` 包在；`'fork'` 字面量未在类型中找到 | ⚠️ provider id 需运行时实测 |
| npm 安装通道 | `dsh plugin --profile web add @michengai/<pkg>@latest` | profile 已实装 6 件套（见 §5） | ✅ 已按此通道工作 |

## 2. 宿主侧服务键对照

「rc.1 使用方」来自 8 件套源码；「内置运行时提供包」均已在 `dsh/node_modules/@deepseek-ai/` 下确认存在（含 `.d.ts`）。

| 服务键 | 内置运行时提供包 | rc.1 使用方 |
|---|---|---|
| `tools` | dsh-tools | agency-agents、automation、btw、skills-manager |
| `commands` | dsh-commands | btw、simplify |
| `subagents` | dsh-subagent（+ dsh-subagent-fork-in-process / -spawn-in-process） | agency-agents、btw |
| `llm` | dsh-llm（+ llm-deepseek / llm-pi-ai / llm-retry） | agency-agents、automation、im-connect、simplify |
| `systemPrompt` | dsh-system-prompt | agency-agents、automation（ctx.get） |
| `settings` | dsh-settings（+ dsh-settings-file） | agency-agents |
| `storageDomain` | dsh-storage-domain | automation、archive-manager |
| `agents` | dsh-agent | automation、im-connect |
| `sessions` | dsh-session（+ projection / query / persistence 族） | automation |
| `workspaceRegistry` | dsh-workspace | automation、archive-manager（继承改写） |
| `agentDefaultModel` | dsh-agent-default-model | automation、im-connect |
| `agentPresets` | dsh-agent-presets | automation、im-connect |
| `permissionPresets` | dsh-permission-presets | automation、im-connect |
| `webServer` | dsh-host-webserver | im-connect、dsh-sidebar-spaces（本地） |
| `credentials` | dsh-credentials（+ credentials-local） | im-connect |
| `subprocess` | dsh-subprocess（+ subprocess-local） | simplify |
| `typert` | dsh-typert-protocol / -registry / -loader | agency-agents、archive-manager |
| `connection`（client） | dsh-client-connection | automation、codex-ui |
| `remote`（client） | dsh-api-remotes / dsh-api-gateway | agency-agents、btw |
| `slots`（client） | dsh-client-ui-renderer + dsh-cordis-client-runner | codex-ui、agency-agents、automation、btw、skills-manager |
| `locale`（client） | dsh-client-locale | 全部带 UI 的插件 |
| `inputTriggers`（client） | dsh-client-ui-input-trigger | agency-agents、automation、btw |
| `approval`（client，ctx.get） | dsh-user-approval / dsh-client-ui-approval | automation（ctx.get） |
| `skill` | dsh-skill（+ skill-badge / skill-filesystem / tool-skill） | skills-manager |
| `jobs` | dsh-jobs（+ jobs-local） | **8 件套无一使用**（自管 timer 是主流） |
| `loader`（ctx.get） | cordis-plugin-loader（`await(): Promise<void>`） | automation |
| `reflect` | cordis 本体（`ctx.reflect.provide`） | agency-agents |

## 3. 宿主侧 API 方法对照

| API | 内置运行时证据 | 判定 |
|---|---|---|
| `ctx.tools.register(defineTool(…))` | dsh-tools | ✅ |
| `ctx.tools.guard(…)` | dsh-tools `lib/types/index.d.ts` 有 guard | ✅ |
| `ctx.commands.register({name, description, input:{hint}, handler})` | dsh-commands | ✅（simplify 形态逐字可用） |
| `tools/pre-execute` waterfall | dsh-tool-bash、dsh-hooks-claude-code 等命中 `pre-execute` | ✅ |
| `agent/created`、`agent/disposed`、`session/disposed` | dsh-agent `lib/` 命中 | ✅ |
| `ctx.systemPrompt.section(…)` | dsh-system-prompt 类型：「Registry for ordered system sections…」 | ✅ |
| `ctx.settings.installSection(…)` | dsh-agent-default-model、dsh-agent-presets 等命中 `installSection` | ✅ |
| `ctx.storageDomain.open(…)` | dsh-storage-domain | ✅ |
| `webServer.register({kind:'prefix', …})` | dsh-host-webserver 命中 `prefix` ×6 | ✅ |
| `ctx.typert.register(…)` + `@Remote()` | dsh-typert-protocol/-registry | ✅ |
| `ctx.reflect.provide(…)` | cordis `lib/types/context.d.ts` | ✅ |
| `ctx.get('loader').await()` | cordis-plugin-loader `tree.d.ts: await(): Promise<void>` | ✅ |
| `invocation.agent.followup(createUserMessage(…))` | dsh-agent-loop 命中 `followup` | ✅ |
| `ctx.subagents.start('fork', …)` | fork-in-process 包在，`'fork'` 字面量未找到 | ⚠️ id 待实测 |
| `ctx.effect(fn, label)` / `ctx.extend(…)` | cordis 本体 | ✅ |

## 4. 客户端侧

- **slot 路径共 52 个**（`grep -rho "slots.inject('…'"` 全量枚举）。社区插件用到的均已覆盖：`settings.section`、`sidebar`、`conversation.input.left`、`conversation.input.dock`、`conversation.chat.commandview`、`conversation.composer.*`、`conversation.hero.*`、`shell.overlay` 等。新增 UI 前先在本清单确认路径存在；各 UI 包自带 `lib/types/client/contract/slots.d.ts` 契约文件（approval/chat/conversation/cordis/goal/input-trigger/message-feedback/model-selection…）。
- **内置运行时不发布 4 个客户端包**：`dsh-client-runtime`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-store`（rc.1 插件的 peer 依赖）。实际解析通道：profile 依赖经 `Data/Runtime/plugins/store`（pnpm v11 store，`lockfile-verified.jsonl` 校验）随插件安装，客户端 bundle 由桌面外壳以 `window.__ModuleLoader__.load({id, factory(require)})` 注入 DSH 视图（见本地 `dsh-codex-ui/dist/client.js` 头部）。排障时先查插件自己的 node_modules 里有没有这几个包。
- `App/plugins/store/v11`（`plugins-store.tgz` 解包目标）当前为空，属条件解包；不要把它当成客户端包的常驻来源。

## 5. 实测状态（本机 profile，2026-09-07）

`Data/DSH/profiles/web/package.json` 已实装：agency-agents 0.1.26、archive-manager 0.1.24、automation 0.1.24、codex-ui 0.2.101（本地 vendored，上游已 0.2.106）、im-connect 0.1.33、skills-manager 0.1.34，另有 dsh-better-sidebar 0.18.0-alpha.0、dsh-context 0.38.5、dsh-mcp-connector 0.2.31、dshmarket 1.40.0 与 3 个 `file:local/` 插件。

| 插件 | 证据 | 状态 |
|---|---|---|
| skills-manager | `Data/DSH/dsh-skills-manager.log`：2026-09-02、09-06 正常创建技能文件 | ✅ 运行中 |
| im-connect | `Data/DSH/dsh-im-connect/{channels.json, gateway.log}` | ✅ 有运行数据 |
| 其余 4 件 | `Data/Electron/UserData/startup-error.log` 为空（无加载失败记录） | ⚠️ 未逐个做 UI 级验证 |

## 6. 移植守则

1. **宿主插件基本可直接装**（npm 通道）；装完核对 `Data/Electron/UserData/startup-error.log` 为空、DSH readiness 正常。
2. **客户端 UI 插件**：slots/locale/inputTriggers API 可用，但 slot 路径以 §4 的 52 路径清单和各包 `contract/slots.d.ts` 为准；rc.1 文档新路径不一定存在。
3. **不要 import rc.1 独有包名**（dsh-client-runtime 等）进宿主侧代码；它们只存在于客户端 bundle 的 require 通道。
4. **版本漂移防御**：同一 API 两代签名不同时，学 dsh-agency-agents 的 settings-compat 双代桥接（运行时探测 + 两条实现路径）。
5. **已知 Web 行为差异点**：模型设置筛选（基线 2026-09-03 审阅记录）；涉模型设置 UI 的移植要单独验证。
6. subagents fork 的 provider id、以及任何 `⚠️` 项：先写最小探针脚本在真实 Profile 上跑一次，再写业务代码。
