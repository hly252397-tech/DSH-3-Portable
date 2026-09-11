# DeepSeek Harness (DSH) 插件开发规范知识库

> 来源：官方文档站 https://deepseek-harness.github.io/deepseek-harness/
> （guide/quickstart、develop/basic/*、develop/framework/*、develop/practice/*、develop/cordis-tutorial/06-07、reference/）
> 用途：**所有智能体与本仓库开发者**在增加功能、修复缺陷、定制插件前的强制审查依据。
> 实现适用版本：@deepseek-ai/dsh 0.1.2-rc.1（本便携版内置运行时）。官方最新审查版本为 0.1.5-alpha.1，提交与版本差异见同目录 `DeepSeek-Harness-官方兼容基线.md`；不得把最新文档中的 API 未经验证地用于旧运行时。

---

## 0. 十条铁律（违反任何一条 = 返工）

1. **模型可见即已记录**：凡抵达模型请求的内容，必须能从会话日志重建（有运行时不变量断言）。新增模型可见输入 = 必须新增会话事件（扩展 `SessionEventMap`），禁止直接塞上下文。
2. **没有特权内核**：产品一切部分皆插件（模型适配器、工具表、会话日志、agent loop 本身），所有注册都是可逆副作用。
3. **waterfall 监听器必须调用 `next()`**：不调用即短路整条流水线（这是拦截/网关的设计机制，忘写就是 bug）。
4. **插件路径必须绝对路径**（本地文件形态）：patch 文件只贡献配置，不改变模块解析目录。
5. **禁止手动清理 ctx 注册**：`ctx.on` / `ctx.tools.register` / `ctx.llm.registerAdapter` / `ctx.effect` 注册的资源在卸载时自动撤销；手动 `removeListener`、`clearInterval` 属于违规。
6. **异步处置器并发执行、不保证顺序**：顺序敏感的清理步骤必须收敛到同一个 `ctx.effect()` 返回的处置器内串行处理。
7. **配置禁止硬编码**：不同部署可能取不同值的参数必须做成配置字段（Schemastery schema）；校验在加载时响亮失败，不许静默吞错。
8. **LLM 适配器不支持的字段必须抛带稳定 code 的 `LlmError`**，禁止静默丢弃；HTTP 请求必须合并 `attributionHeaders()` 并传递 `options.signal`。
9. **后应用的 patch 层按行胜出、整行替换（非深合并）**：覆盖某行必须重述该行全部键。
10. **持久化会话事件 ≠ Cordis 事件**：`turn/*`、`step/*`、`tool/call`、`tool/result`、`compaction/*` 是会话日志事件类型，观察它们必须监听 `session/event` 后检查 `event.type`，不能 `ctx.on('tool/call', ...)`。

### 0.1 官方当前版本追加门禁

以下规则来自当前官方 `AGENTS.md`、`packages/AGENTS.md`、架构与测试规范；即使内置运行时仍为 alpha.3，新功能审查也必须覆盖：

1. 函数插件只使用命名导出的 `name` / `inject` / `Config` / `apply`，不得同时混入 default export；服务插件才默认导出 Service 类。
2. 可选服务在使用点通过 `ctx.get(name)` 查询；只有声明为必需注入的服务才能通过 `ctx.<name>` 访问。
3. 产品可见插件必须有 Loader + Profile + 真实应用/进程组合测试，手工 `ctx.plugin()` 单元测试不能作为唯一证据；注册项还要验证 Fiber 处置后确实撤销。
4. 状态、通知、缓存和 UI 回显只能在操作成功提交后发布，并从同一权威状态派生。
5. 字节、令牌、数量和时间限制必须作用于包含包装和元数据的完整结果，并覆盖极小、精确上限、单块超限和多字节输入。
6. Client UI 产品文案由类型化本地化字典拥有，禁止在组件中新增散落的硬编码文案。
7. 生命周期、并发、子进程或 teardown 改动必须审阅官方 defensive patterns；一个异步操作由一个生命周期控制器或事务所有。
8. 非平凡变更需要同批留下决策、替代方案、影响和验证证据；本仓库写入对应迭代的实施/审查记录。
9. TypeScript 保持 strict；跨持久化、配置、模型/工具 JSON、进程和 wire 边界才做运行时校验，不在同进程强类型接口上堆叠无依据的防御代码。
10. 官方仍处于 Developer Preview，会拒绝旧磁盘格式且不承诺会话格式兼容。任何运行时升级必须先做数据格式评估、备份、候选验证与回滚演练。

---

## 1. 插件骨架规范

每个插件导出三件东西：`name`、`inject`（依赖服务数组，可选）、`apply(ctx[, config])`。

### 三种合法形态

```ts
// 1) 函数形式（默认推荐）
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'
export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  // inject 声明的服务在 apply 运行前已就绪
}

// 2) 对象形式
export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) { /* ... */ },
}

// 3) 类形式（仅当插件要对外提供服务时使用）
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MyService extends Service {
  static inject = ['tools']
  constructor(ctx: Context) {
    super(ctx, 'myService')   // 服务名 → 消费方经 ctx.myService 访问
  }
}
```

> **inject 声明通道按导出形态区分**（2026-09 核对 MichengAI 全部 8 个社区插件 + 本仓库 plan-quota / dsh-sidebar-spaces）：① 命名导出形态 → 模块级 `export const inject` 即生效，patch 条目只写 `id`+`name`；② 类形式 → 类静态 `static inject = [...]`；③ default export 函数形态 → loader 不读模块级 inject，必须在 cordis 条目写 `inject:` 字段。

### 生命周期（Fiber 状态机）

```
PENDING → LOADING → ACTIVE
                 ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

- `inject` 的服务未就绪 → 插件停 PENDING 等待（**合法状态**，提供方可能稍后挂载）
- 服务消失 → 依赖它的插件自动卸载；服务恢复 → 自动重载
- 无独立 start 钩子：apply 执行即加载逻辑；提前终止用 `await fiber.dispose()`（递归卸载子插件，Promise 在全部异步清理完成后兑现）

### 嵌套上下文

```ts
const fiber = ctx.plugin(childPlugin)  // 子 Fiber 随父卸载
```

### HMR（热替换）

- 挂载 `@deepseek-ai/cordis-plugin-hmr`（需同时挂 `logger-console` 供日志、`timer` 供去抖，且必须 `node --import tsx` 启动）
- 修改源文件或 cordis.yml 都触发按 id 差异化增量更新（卸载旧实例→注册回卷→新 apply）

---

## 2. 配置规范（Schemastery）

导出 `Config` **类型** + **同名** schema 对象（不可导出普通对象——不满足 Standard Schema 接口）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'validated-plugin'

export interface Config {
  apiKey: string
  timeout: number
  mode: 'fast' | 'accurate'
}

export const Config = Schema.object({
  apiKey: Schema.string().required(),
  timeout: Schema.number().default(30000),
  mode: Schema.union(['fast', 'accurate']).default('fast'),
})

export function apply(ctx: Context, config: Config) {
  // config 已校验、已补默认值、类型安全
}
```

- cordis.yml 挂配置：条目加 `config:` 字段
- 检验标准：能否在 cordis.yml 改值而无需改代码？
- 自完备约束用 `.required()` / `Schema.union()` 表达，加载时校验失败即报错

---

## 3. 工具（defineTool DSL）

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',      // 供模型理解
    parameters: {                                // 自动校验模型传入参数
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },                // 约束 execute 返回的规范值
      render: (_args, value) => [{ type: 'text', text: value }],  // 规范值 → 模型可见内容块
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

- `defineTool` 把 `parameters` 规约转成向模型展示的 JSON Schema 并推导 args 类型，执行前自动校验
- 两段式输出：`execute` 返回符合 `output.schema` 的规范值 → `output.render` 转为可持久化的内容块
- 手动走真实流水线（不调模型）：

```ts
const result = await ctx.tools.execute({
  callId: brandString<ToolCallId>('demo-1'),   // 关联 id 必须品牌化
  name: 'greet',
  arguments: { name: 'Cordis' },
  signal: new AbortController().signal,        // 必须支持中止
})
```

- 进阶主题（官方工具参考）：嵌套 schema、规范值、后台工作、策略钩子、PTC mode、UI 卡片

---

## 4. 服务与依赖（跨插件接口）

```ts
export default class MetricsService extends Service {
  static inject = ['llm']                       // 服务可以依赖服务
  constructor(ctx: Context) { super(ctx, 'metrics') }  // 'metrics' → ctx.metrics
  record(event: string, value: number) { /* ... */ }
}

// 类型声明合并（规范要求，让消费方获得类型）
declare module '@deepseek-ai/cordis' {
  interface Context {
    metrics: MetricsService
  }
}
```

- 可选依赖：不写 inject，使用处 `ctx.get('metrics')?.record('plugin_loaded', 1)`
- 多实例隔离：cordis.yml 组设 `group: true` + `isolate` 下为某服务配独立实例

---

## 5. 事件系统（四种模式）

| 模式 | 语义 | 关键规则 |
|------|------|----------|
| `emit` | 广播 | 全部同步执行，返回值忽略 |
| `bail` | 短路 | 按序执行，第一个非 `null`/`false`/`undefined` 返回值即最终结果 |
| `serial` | 顺序 | 按注册顺序依次 await，第一个非空返回值终止后续 |
| `waterfall` | 流水线 | 每个监听器可包装下游值；**必须调用 `next()`** |

```ts
ctx.on('tools/result', (exec, result) => { })                    // 监听即效果，自动清理
const r = ctx.bail('some-check', input)                          // 短路
await ctx.serial('setup-phase', context)                          // 顺序
const out = await ctx.waterfall('my-plugin/transform', input, async () => input)

ctx.on('my-plugin/transform', async (_input, next) => {
  const downstream = await next()      // 必须调用！
  return downstream.trim()
})
```

- 类型安全（声明合并）：

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready': (payload: { id: string }) => void
    'my-plugin/check': (input: string) => boolean | undefined
    'my-plugin/transform': (input: string, next: () => Promise<string>) => Promise<string>
  }
}
```

- 命名规范 `namespace/action`：官方事件如 `agent/pre-step`、`agent/request`、`agent/request-error`、`tools/result`、`session/event`
- 事件 payload 类型来自包的类型导入：`import type {} from '@deepseek-ai/dsh-tools'`

---

## 6. 能力三层拆分（可替换能力的架构规范）

| 角色 | 职责 | Bash 示例 |
|------|------|-----------|
| Service Definition | 定义抽象 Service + Request/Result 类型 | `dsh-shell` |
| Service Provider | 继承抽象类实现具体行为 | `dsh-bash-local` |
| Consumer | 把能力包装成模型工具 | `dsh-tool-bash` |

三方只依赖 Definition；Provider/Consumer 彼此零依赖；cordis.yml 并列注册即可切换实现。

```ts
// Definition：抽象类 + 类型
export abstract class MyCapService extends Service {
  constructor(ctx: Context) { super(ctx, 'myCap') }
  abstract execute(request: MyCapRequest): Promise<MyCapResult>
}
export interface MyCapRequest { input: string }
export interface MyCapResult { output: string }

// Provider：继承实现
class MyCapLocal extends MyCapService {
  async execute(request: MyCapRequest): Promise<MyCapResult> {
    return { output: request.input.toUpperCase() }
  }
}
export const name = 'my-cap-local'
export function apply(ctx: Context) { ctx.plugin(MyCapLocal) }

// Consumer：注入服务 + 注册工具
export const name = 'tool-my-cap'
export const inject = ['tools', 'myCap']
export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    /* ... */
    async execute(args) {
      const result = await ctx.myCap.execute({ input: args.input })
      return result.output
    },
  }))
}
```

- **不要预防性拆分**：仅当角色需要独立演进才分包
- Request/Result 类型由 Definition 拥有
- 显式优于隐式：默认值走显式 `resolve(request): Spec` 步骤，不在 `run()` 里 `?? default`

---

## 7. LLM 适配器

```ts
import { LlmAdapter, LlmError, attributionHeaders,
         type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

class MyAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 提供方无关请求 → 具体 API；响应 → StreamChunk
  }
}

ctx.llm.registerAdapter(['my-provider'], adapter)   // inject = ['llm']
```

**StreamChunk 协议（顺序强制）**：`block-start` → `text-delta`/`tool-call-delta` → `block-end` → `usage` → `finish`

- 每个 block-start 必须有对应 block-end；index 从 0 递增
- `argumentsDelta` 是原始 JSON 文本增量
- `finish` 必须最后一个分片；`usage` 必须在 finish 前
- finish reason：`{ kind: 'stop' }` 或 `{ kind: 'tool-calls' }`

**错误规范**：传输/协议故障抛 `new LlmError(msg, 'STABLE_CODE')`；覆写 `resolveModel(provider, model, signal?)` 返回确切模型身份，异步查询必须响应 signal。

**cordis.yml 配置**：插件 config 声明 `apiKey`/`providers`；agent-loop 用 `provider`/`model` 引用。

参考实现：仓库 `packages/llm/llm-deepseek/`（OpenAI 兼容）、`packages/llm/llm-pi-ai/`。

---

## 8. 打包、分发与 patch 层叠

### 组合包（bundle）= npm 包 + 配置层

```
hello-plugin/
├── package.json       # 声明 dsh.bundle
├── cordis.patch.yml   # profile 列出本包时应用的层
└── index.js           # patch 行引用的插件模块
```

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml —— 插件行按包名（非路径）引用
- insert:
  - id: hello
    name: dsh-hello-plugin
```

- 无 `dsh.bundle` 的包仍可安装，但仅作普通依赖（`dsh plugin` 打警告、不激活层）
- **profile manifest 不手写**，由 `dsh plugin --profile <name> add ...` 自动维护

### 安装渠道

```sh
dsh plugin --profile demo add ./hello-plugin            # 本地
dsh plugin --profile demo add github:you/hello-plugin   # git（建议 #<sha> 锁定）
dsh plugin --profile demo add ./hello-plugin-0.1.0.tgz  # tarball
dsh plugin --profile demo add your-package              # npm
```

### patch 层叠顺序（后应用按行胜出，整行替换非深合并）

1. `dsh.profile.bundles` 各组合包层（按列表序，`@deepseek-ai/dsh-base` 永远第一）
2. profile 自己的 `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`（机器级）
4. 各 `--patch <path>` overlay（按 argv 顺序）

→ 覆盖某行必须**重述该行全部键**。

### Git 安装陷阱

git 拉源码不跑 build 脚本 → TypeScript 包缺 `lib/` 加载失败。作者须提供**自包含** `prepare` 脚本；pnpm ≥10 用户需在 `pnpm-workspace.yaml` 授权：

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

最省事分发：发 npm，或交付 `pnpm pack` 的 tgz。

### 调试利器

```sh
dsh --profile <name> --dump-config   # 打印最终启动树，任何条目都可被 patch 替换
```

---

## 9. 组合配置元数据与诊断

```yaml
- id: greeter            # 稳定标识：loader 按 id 差异化增量更新
  name: './greeter.ts'
- id: consumer
  name: './consumer.ts'
  disabled: true          # 保留条目但跳过挂载
```

- **条目必须显式带 `id`**：无 id 条目每次编辑都被当作删除+重建，增量更新失效
- `isolate`：为组提供某服务的独立实例
- PENDING 诊断：

```ts
import { FiberState, type Context } from '@deepseek-ai/cordis'

export const name = 'diagnose'
export function apply(ctx: Context) {
  setTimeout(() => {
    for (const runtime of ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        if (fiber.state === FiberState.PENDING) {
          console.log(`${fiber.name} is PENDING — a required service is missing`)
        }
      }
    }
  }, 500)
}
```

---

## 10. 架构核心概念（reference 摘要）

- **Profile**：Harness home 里 `profiles/<name>` 下的具名组装；`package.json` 的 `dsh.profile.bundles` 有序列表
- **核心包 ctx 键**：`ctx.sessions`（仅追加事件日志）、`ctx.tools`（注册表+把关执行）、`ctx.agents`/`ctx.agentLoop`、`ctx.llm`（适配器 seam）、`ctx.systemPrompt`
- **事件三域**：会话事件（持久）、`agent/*`（观察/拦截进行中工作）、能力事件（`fs/*`、`tools/*` 免导入循环挂策略）
- **轮次流水线**：`turn/start → agent/pre-step → step/start → agent/request → llm/stream → tool/call → step/end → turn/end`
  - `agent/pre-step` 决定模型看到什么（可改写/拒绝）；拒绝首条输入仍关闭一个空轮次（保证日志记录尝试）

### 新行为归属表

| 想加什么 | 挂哪里 |
|---|---|
| 模型提供方 | `ctx.llm` 注册适配器 |
| 模型工具 | `ctx.tools` 注册 |
| 拦请求/工具/轮次 | `agent/*` / `tools/*` 事件 |
| 模型可见上下文 | `agent.inject()`（⚠️ 铁律 1：需新增会话事件） |
| 用户命令（无需模型轮次） | `ctx.commands` |
| 后台任务 | `ctx.jobs` |
| 独立 LLM 子任务 / 只读旁问 | `ctx.subagents.start('fork', {parent, prompt, toolFilter, signal})` + `ctx.tools.guard()`（社区实证：dsh-btw） |
| 向当前会话注入模型可见消息 | `invocation.agent.followup(createUserMessage({..., source:{kind:'plugin', plugin}}))`，source 必带插件名（满足铁律 1；社区实证：dsh-simplify） |
| 替换内建服务实现 | patch 整行禁用原条目（`disabled: true`）+ `insert` 替代实现（社区实证：dsh-archive-manager、dsh-codex-ui） |

---

## 11. Guide 功能要点（模型路由 / MCP / SDK —— 定制开发相关）

### 11.1 配置模型（providers）

- 凭据为**只写**：保存后界面只收脱敏描述符；密钥存 `$DSH_HOME/.credentials.yaml`，settings 仅存凭据引用
- 自定义提供方：需小写 Provider ID（**永久不可改**，请求/会话/凭据引用都依赖它）、基础 URL、API 协议、凭据、至少一个模型
- 图片输入是**声明制**：手动录入的模型默认纯文本，带图请求发送前即被拒；`input: [text, image]` 是对端点的断言而非检查

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: legacy-chat
        - id: vision-preview
          input: [text, image]
      compat:
        supportsDeveloperRole: false   # 系统提示词不以 role:developer 发出
        maxTokensField: max_tokens     # 兼容只认 max_tokens 的服务端
```

- compat 是常见网关排错第一开关（全拒/仅推理模型失败 → 先关 `supportsDeveloperRole`）；路由级是模型默认值，模型级逐字段覆盖
- 模型变更下一次请求即生效，无需重启；排错：`MISSING_CREDENTIAL`/`UNKNOWN_MODEL` 补密钥或模型；401 查密钥；无 `/models` 端点手动录入

### 11.2 MCP 接入（dsh-mcp-client）—— 接第三方工具服务器的标准方式

```yaml
- insert:
  - id: memory-my-server            # 唯一 id
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: my-memory         # 工具以 mcp__<serverName>__<tool> 公开
      transport: stdio              # 或 streamable-http（配 url + headers）
      command: my-memory-mcp
      args: []
      env: {}                       # 密钥写这里，不要写进 YAML 明文
      cwd: !!js process.cwd()
```

- DSH 负责：解析 overlay、启动 stdio/连接 HTTP、发现工具、`mcp__<server>__<tool>` 命名公开；**不负责**下载服务器、初始化存储、认证与数据迁移
- 安全规范：stdio 桥接启动子进程前**主动移除凭据类环境变量和全部 `DSH_*` 变量**；密钥必须走 `config.env`
- 子进程崩溃 → 带退避自动重连 + 工具重新同步；预算耗尽 → 工具注销；初始发现异步，首条提示词前先等 `mcp__...` 工具出现
- 持久启用：合并 insert 进 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（勿覆盖整个文件）

### 11.3 Python SDK（sdk-minimal profile）

- `pip install deepseek-harness-sdk`；普通 SDK 运行**不需要系统 Node**
- 核心 API：`DeepSeekHarness(provider=, model=, max_tokens=, cwd=, dsh_home=, profile="sdk-minimal")`，`harness.run(prompt, session_id=)`；进程延迟启动、复用至上下文退出
- **自定义 profile 必须包含 `@deepseek-ai/dsh-sdk-app`（JSON-RPC server）**，缺失或非法配置启动即失败、无回退
- 会话隔离原则：新工作用新 home + 新 session id；只有继续同一持久对话才复用 home 与 id
- `sdk-minimal` 固定 danger-full-access（shell/editor 可改任意路径），务必一次性 workspace/容器

### 11.4 其他 guide 功能（了解即可）

- **GitHub 评审 overlay**：PR ready_for_review → 自动建只读评审 Session；webhook 密钥只验入站不授出站权限；HTTP 202 仅表示签名通过
- **会话内提醒（schedule）**：`schedule_create/list/delete` 工具；`at` 须 RFC 3339 或带显式时区；`every_seconds` ≥300；不支持 cron/日历表达式；不提供进程外通知
- 两者都是 `dsh web --patch apps/cli/config/examples/.../cordis.yml` 的可选 overlay，默认关闭

---

## 12. 本仓库（便携版）映射

| 官方概念 | 本仓库对应物 |
|---|---|
| 组合包 | `Data/DSH/profiles/web/local/`（`dsh-sidebar-spaces`、`dsh-codex-ui`——移植自社区上游 MichengAI/dsh-codex-ui、`dsh-restart-button`、`dsh-work-mode`、`plan-quota`）及 `dsh-desktop-bridge` |
| patch 层 | `cordis.patch.yml`（启动时注入 `dsh-desktop-bridge`） |
| profile | `Data/DSH/profiles/web`（`dsh.profile.bundles` 见其 package.json） |
| 插件产物结构 | `lib/index.js`（必须存在，ESM 入口；历史上曾因 lib/ 缺失导致 ERR_MODULE_NOT_FOUND 崩溃） |

### 12.1 官方运行时装配陷阱（2026-09-11 实证）

- **pnpm 11 忽略 `package.json` 的 `pnpm.overrides`**：只认 `pnpm-workspace.yaml` 的 `overrides`；而且通配选择器（`@deepseek-ai/dsh-*`）**实测不命中**。因此「用 overrides 把官方家族钉到同一版本」在 pnpm 11 下不可能生效。
- **官方发版包的传递依赖是 `^<同元组预发布>`**（如 `^0.1.5-rc.1`），默认最高版语义会把家族拉成混用：`0.1.5-rc.1` 根包 + `0.1.5-rc.2` 传递包，候选会在家族对齐门禁处被正确拒绝（事件日志 `候选 DSH 运行时核心包版本未对齐。`）。
- **正确做法是按发布时间解析**：`resolutionMode: time-based`。三个入口都要写，缺一个就有一条路径装出混用家族：①生成的 `pnpm-workspace.yaml`（`pnpmWorkspaceYaml(true, { resolutionMode })`）；②安装参数 `--config.resolution-mode=time-based`；③**已存在**的运行时目录（`ensureRuntimeResolutionMode`——只在文件缺失时写入的旧代码永远补不上这一行）。
- **官方运行时绝不可原地安装**：`desktopRuntimeDir` 是正在运行的活动槽。原地 `writeOfficialRuntimeManifest` + pnpm 安装会把槽改成「`package.json` 新版本 + `node_modules` 旧版本」的坏槽，且 Windows 下正在使用的文件无法替换，安装必然半途失败。用户看到的是「更新成功但版本没变」或干脆失败。桥接必须把意图交给桌面端 A/B 更新器（`request-harness-update` → 候选槽 → 影子验证 → 空闲切换 → 观察 → 失败回滚）。
- **坏槽没有任何启动检查能发现，必须主动自愈**：`isOfficialRuntimeLaunchable` 只验证入口与 peer 是否存在，指纹（`.dsh-runtime-fingerprint`）只覆盖 lock 与家族清单、**根清单被有意排除**——所以「清单写着 `0.1.5-rc.2`、实际装着 `0.1.2-rc.1`」的槽既不会被判不可用、也不会被指纹发现，错误版本号会一路流到「关于」页与更新器。其余补种逻辑对指纹槽直接早返回，因此**已存在的坏槽永远不会被修**。修法是启动时 `reconcileOfficialRuntimeManifest`：家族版本单一可读时，只把**已存在**的根清单与 `resolutionMode` 拉回实际安装版本（不动 lock、不动物化依赖，指纹语义不变）；家族混用时保持原样，交由 A/B 门禁拒绝；**绝不在指纹槽里凭空造文件**（会打破「槽是不可变制品」的既有约束与对应测试）。

### 12.2 「关于」页更新通道（host↔shell 第四通道）

- codex-ui 的依赖卡对官方运行时**故意优先读 npm `next` 标签**（`npmTaggedVersion(pkg,'next') ?? npmTaggedVersion(pkg,'latest')`），而外壳更新器的发现通道是 `[policy.channel, next, latest]`。**两侧口径必须一起改**，否则「关于」页说 `0.1.5-rc.2 可更新`、外壳却只认到 `0.1.5-rc.1`。
- 用户在「关于」页点更新的路径：`desktopPnpm.runPlugin(['add', '<官方包>@<版本>'])` → 桥接识别为官方包 → **不安装**，通过 `process.send` 上报 `REQUEST_HARNESS_UPDATE_IPC` → 外壳 `handleDshIpc` 调 `startHarnessUpdateTask(true)` → 返回退出码 1 与说明文案。桥接消息判定统一走 `isRequestHarnessUpdateIpc`（兼容字符串与 `{type}` 两种形态），主进程侧要对旧打包桥接做可选链兼容。
- **pending 幽灵条目**：codex-ui 在安装前写 `profile/.dsh-pending-updates.json`，成功挂载后才清除；失败不回滚。而 profile 安装路径明确拒绝官方包，所以官方条目永远不会被消费。本仓库的 `applyPendingProfileUpdates` 因此**不回写**官方条目，直接删除登记文件。

### 12.3 影子验证的盲区与失败退避（2026-09-11 实证）

- **影子验证不加载社区插件**：`createHarnessShadowProfile` 造的是只装 `OFFICIAL_PROFILE_BUNDLES` 的一次性 profile，且 `cordis.patch.yml` 为空。因此候选可能**通过影子验证、却在真实 profile 切换时崩溃**（历史实例：`0.1.5-alpha.1` 抛 `cannot get property webServer without inject`）。启动自修复（`src/profile-repair.ts`）只能隔离「无法解析的 bundle」与入口预检不健康者，对 `apply()` 期间同步抛错的**服务依赖类**插件无效。
- **必须按版本记忆部署失败**：否则「构建 5.7 分钟 → 切换 → 回滚 → 重启」会在每个检查周期（默认 6 小时）和每次重启后重复。`state.json` 的 `deploymentFailures` 记 `{ attempts, lastFailureAt, detail }`，`evaluateDeploymentRetryGate` 达阈值后拦截**自动**升级并置 `blocked`；用户手动检查（`interactive`）永远放行，让他们自己决定要不要再试。
- **写入失败记忆的时机**：`deployHarnessCandidate` 抛错（`failed`）、切换未提交（`rolled-back`）记一次；切换提交成功（`succeeded`）清除该版本记录。只记「部署/切换」失败，不记网络类失败，避免误伤。
- **持久化安全**：版本号必须过 `isExactVersion` 白名单（顺带挡住 `__proto__` / `constructor` 原型污染键），`attempts` 钳 1–100，`detail` 压平并截断，最多保留 20 条。

**改动这些文件的智能体，提交前必须对照本文档第 0 节铁律逐条自查，并运行仓库测试门禁。**

---

## 附：官方文档索引

- 快速入门：/guide/quickstart
- 第一个插件：/develop/basic/ ｜ 工具：/develop/basic/tool ｜ 配置：/develop/basic/config ｜ 打包发布：/develop/basic/publish
- 生命周期：/develop/framework/ ｜ 服务与依赖：/develop/framework/service ｜ 事件系统：/develop/framework/events
- 三层拆分：/develop/practice/ ｜ LLM 适配器：/develop/practice/llm-adapter ｜ 运行时 Cordis 工具：/develop/practice/dynamic-cordis
- Cordis 教程：/develop/cordis-tutorial/（01-07）
- 架构参考：/reference/
