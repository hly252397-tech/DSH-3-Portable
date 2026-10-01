# dsh-talk-to-session

DSH 侧的**出站**跨 agent 通道：把一条自包含消息投递给本机 **MiMo Desktop** 的指定会话，并按需等待对方的 assistant 回信。这是入站通道 `dsh-agent-bridge`（外部 → DSH 会话）的反方向。

## 为什么需要它

`dsh-agent-bridge` 只解决"别的程序把活派给 DSH 会话"。DSH 会话**没有**任何主动联系其他 agent 的模型可见工具——本插件补上这一半。

## 目标端契约（一手核对，非文档转述）

| 项 | 事实 | 依据 |
|---|---|---|
| 发现文件 | `%APPDATA%\Xiaomi MiMo\desktop-api.json` → `{api,port,token,pid}` | MiMo Desktop 实现（`app.asar` 内 `desktop-api.json` 写入点） |
| 鉴权 | 全部路由都要 `Authorization: Bearer <token>`（**含 `/v1/health`**） | 实测：不带 → 401 |
| 地址簿 | `GET /v1/sessions?limit=N` → `[{id,title,slug,directory,project,time}]` | 实测 200 |
| 历史 | `GET /v1/sessions/{id}/messages` → `[{info:{role,modelID,…},parts:[{type:'text',text}]}]` | 实测 200 |
| 注入一轮 | `POST /v1/sessions/{id}/turns`，体 `{message,model,dir,perm,origin,files,plugins}` → 202 `{ok:true}` | 实测 202 |
| **`model` 必填** | 内层守卫 `if(!p.trim() \|\| !h.sessionId \|\| !h.model) return Wr("bad-request")`——缺 model 直接 400 | MiMo `app.asar` 内层 `sendTurn` |
| 回信 | HTTP **不同步**返回正文；需轮询 `/messages` 或订阅 `/events`(SSE) | 实测：202 后 assistant 需另取 |

失败码：401 `unauthorized`、403 `forbidden-host`、404 `not-found`、409 `busy`、400 `bad-request`、503 `engine-not-ready` / `not-logged-in`。

## 工具

- **`talk_contacts`**：列出 MiMo 会话地址簿（id/标题/工作目录/更新时间），供选择目标；只读。
- **`talk_to_session`**：`contact`（`ses_…` id 或唯一标题）+ `message` + `mode`（`sync` 默认等待回信 / `async` 只回执）+ `timeout_ms`。
  正文自动加 `【会话对话|来自会话「<senderLabel>」】` 前缀，保证对方"看不到你的历史"时仍能自包含理解；来源标识写在目标端的 `origin` 字段。

## 配置（Schemastery）

| 字段 | 默认 | 说明 |
|---|---|---|
| `descriptorPath` | `''` | 空 = `%APPDATA%\Xiaomi MiMo\desktop-api.json` |
| `model` | `mimo-v2.6-flash` | **必填项**，对应目标端 `model` 字段 |
| `origin` | `dsh-bridge` | 目标端来源标识 |
| `senderLabel` | `DSH 便携版3` | 消息前缀里的会话名 |
| `requestTimeoutMs` | 20000 | 单次 HTTP 超时 |
| `replyTimeoutMs` | 120000 | `sync` 等待回信上限 |
| `pollIntervalMs` | 1500 | 轮询间隔 |
| `maxMessageChars` | 32000 | 加前缀后的正文上限 |

## 安全边界

- 令牌**只**从发现文件现读（每次调用重读，端口/令牌随 MiMo Desktop 重启轮换），不进仓库、不进日志、不进任何返回值或错误文案。
- 只连 `127.0.0.1`，不转发外网。
- 投递会在对方会话产生**用户可见回合**，因此每条消息都带来源前缀与 `origin`。

## 安装

源码在 `plugins/dsh-talk-to-session/`（入库）。装入 profile 用 `scripts/install-talk-to-session.mjs`（复制到 `profiles/web/local/`、建 `node_modules` Junction、把包名并入 `dsh.profile.bundles` 与 `dependencies`），带备份与 marker。
