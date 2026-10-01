# 2026-09-28 DSH Agent MCP 接口（#78）——外部大脑通道

## 目标

用户需求：让 ZCode（外部智能体）作为"外部大脑"操作 DSH 里定制的功能；连接方式是**在外部建立通道**，不是把外部模型配置进 DSH 内部。用户拍板两个决定：

1. **中继模式起步**：任务经 MCP 投给 DSH 既有会话，由会话已选模型（DeepSeek）用定制工具（hj_*、p3-tiny-*、sidebar_open 等）执行；直连模式（进程内直调功能本体）列为二期。
2. **不含重启/退出类工具**：无限重启护栏铁律（2026-09-21 事故）优先，壳级动作仍由用户手动触发。

## 方案

新建本地插件 `dsh-agent-mcp`（命名导出形态，`inject: ['sessionController']`，async generator apply，仿 I034 `dsh-agent-bridge`）：

- **MCP streamable HTTP 服务器**：`127.0.0.1:9801/mcp`（Schemastery `port` 可配），手写最小 JSON-RPC（零第三方依赖）：`initialize` / `notifications/initialized` / `ping` / `tools/list` / `tools/call`；`Mcp-Session-Id` 会话管理（上限 64、DELETE 关会话、未知会话 404 促客户端重新握手）；GET /mcp → 405（不提供 SSE 监听流）。
- **令牌持久化**（与 agent-bridge 的每次随机不同）：MCP 客户端（ZCode）的 Authorization 头是静态配置，令牌首次生成后写 `agent-mcp.json`（0600）重启复用；损坏（非 64 hex）则重新生成；卸载时校验令牌归属后删文件。
- **鉴权栈**复用 agent-bridge 已验证形态：回环 Host 精确匹配 + 拒 Origin/sec-fetch-site（挡浏览器跨站）+ Bearer `timingSafeEqual`。
- **工具 6 件套**：`dsh_capabilities`（自描述目录）、`dsh_list_sessions`、`dsh_send_task`（`resolveAgent` + `createUserMessage(source: 'plugin:dsh-agent-mcp', form: 'relay')` + `followup`）、`dsh_task_status`、`dsh_cancel_task`、`dsh_read_state`（DSH home 顶层 *.json 白名单，防路径穿越）。任务状态归集与 agent-bridge 同款（`agent/inbox/claimed|discarded`、`agent/disposed`、`session/event` 按 turn 锁定，仅 `turn/end: completed` 判成功）。
- **失败关闭**：监听失败 throw（fiber FAILED），发现文件不落盘；建连与写文件先于 yield 完成（agent-bridge 条目 13 教训）。

## 安装（house pattern，不跑 profile 内 pnpm）

- 活动家园 `Data/DSH-generations/v4-rc2b/home/profiles/web/`：`local/dsh-agent-mcp/` + `package.json`（dependencies + bundles）+ `pnpm-lock.yaml`（importer 条目）+ `node_modules` Junction。
- 旧家园 `Data/DSH/profiles/web/`：同上（三份源码副本 md5 一致：`1ebde686…`）。
- 入库归档 `customizations/agent-mcp/`（`customizations/ui-tweaks/README` 的"改实体再同步"规矩）。
- patch 条目：`- id: agent-mcp / name: dsh-agent-mcp / config: {port: 9801}`（稳定 id）。

## GCC 摘要

- Task Position：profile 插件层新增，不触碰 `src/`、`assets/`、`App/resources`、打包脚本；与 `dsh-agent-bridge`（9800）并存独立端口 9801。
- Direct/Indirect Impact：DSH 启动时多加载一个宿主侧插件（纯后端进程）；无模型可见输入变化（send_task 的 source 标注满足铁律 1）；无 UI 改动。
- Do Not Touch：两个家园既有插件、cordis.patch.yml 其余段、`agent-bridge.json`。
- Regression Scope：`test/agent-mcp.test.ts`（新）+ 全量（插件加载路径共享）+ `ui-baseline`（bundles/links 核验）。

## 门禁与证据（2026-09-28）

| 门禁 | 结果 |
|---|---|
| 官方基线 `--online` | PASS（bundled=0.1.7-rc.2 upstream=0.1.7-rc.2@21638c56 online=verified） |
| `tsc` | 0 错误 |
| `test/agent-mcp.test.ts` | **11/11 全绿**（真实 Loader + 真实 HTTP + 真实 AgentLoop） |
| 全量 `scripts/run-tests.mjs` | **765 tests / 739 pass / 0 fail / 26 skip** |
| `ui-baseline.mjs` | PASS（含 local links 与 enabled bundles 核验） |

测试覆盖：协议握手（版本协商/回退、session id）、tools/list 契约（6 工具、负向断言无 restart/quit）、真实 AgentLoop 全链路（MCP → send_task → 工具执行 → succeeded）、中继消息 source/form 契约、回合隔离（他人会话/他人回合不污染）、协议错误（-32601/-32602）与工具错误（isError）区分、鉴权（401/403 全谱）、会话过期 404、DELETE 204、GET 405、read_state 白名单与防穿越、令牌持久化（损坏重生/有效复用/卸载清文件）、端口占用失败关闭。

## 三项对齐（例外登记）

本轮为纯宿主侧协议层能力：无前端、样式、插件客户端改动；用户入口即 MCP 端点本身（外部程序调用），无 DSH 内 UI 控件/界面，故不适用"用户入口→前端事件→后端处理→结果反馈"链路登记。例外理由：内部协议能力，按门禁记录。UI 基线零漂移（未触碰受保护文件）。

## GIR 摘要

- 实际修改范围 = 预期范围（两个家园 profile 登记文件 + 新插件目录 + customizations 归档 + 新测试 + 功能清单），无超界。
- 未破坏公共接口：`dsh-agent-bridge`（9800）未动；官方 bundles/patch 其余条目未动；junction 只增不改。
- 遗留风险与边界：
  - ZCode 的 MCP HTTP 客户端兼容性需真实连接冒烟（协议按 streamable HTTP 规范实现，JSON 单响应合法；若客户端强要 SSE 则回退 Plan B：stdio 包装器）。
  - `dsh_read_state` 只暴露 home 顶层 JSON，属有意收窄；业务功能直连（不经会话模型）为二期。
  - 令牌为长期凭据（0600 本机文件），轮换 = 删除 `agent-mcp.json` 后重启 DSH。

## 交付闭环（未完成，见止损纪律第 3 条）

候选（插件三件套 + 登记 + junction）已就绪 ≠ 完成。需：用户重启 DSH → 冒烟脚本 `Data/Temp/mcp-smoke.cjs` 验证（描述文件落盘 / 9801 监听 / initialize + tools/list + capabilities / list_sessions）→ 交付 ZCode 接入命令 → 真实连接成功后才可宣布完成。
