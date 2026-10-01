# DSH Agent MCP 接入设置

入口：**DSH 设置 → 多智能体交互管理**。本页不替代 DSH 的模型设置，也不是连接其他 MCP 服务的客户端设置。

## 连接 ZCode 等外部客户端

1. 确认页面“正在监听”，点“测试连接”。通过表示本机 MCP 握手和六个工具目录有效，**不表示外部客户端已接通**。
2. 外部客户端新增 HTTP / Streamable HTTP MCP 服务，名称可用 `dsh-agent`。
3. 复制页面实际地址（默认 `http://127.0.0.1:9801/mcp`），加入请求头 `Authorization: Bearer <令牌>`。令牌必须由本机设置页显式查看或复制，不粘贴到聊天、日志或公开仓库。
4. “复制连接信息”是通用连接字段，**不是已验证的 ZCode 导入格式/CLI 命令**；具体命令以对应客户端的帮助为准。
5. 客户端连接后先调用 `dsh_capabilities`，再用 `dsh_list_sessions` 选择已有会话。`dsh_send_task` 会让目标会话真实执行任务，继承其模型、工具和审批策略，可能产生费用；后续通过 `dsh_task_status` 查看结果，必要时 `dsh_cancel_task`。

只支持与 DSH 同一台电脑的客户端；浏览器跨站直连被拒绝。接口没有重启、退出工具。页面测试不会投递任务、不会新建会话，也不会修改外部客户端配置。

## 数据与维护

- 六工具仍由原 `lib/index.js` 提供；设置 API 为经过 DSH 正式会话鉴权的同源 `POST /dsh-agent-mcp/settings`，接受 `status / credentials / check` 与下述 `bridge.status / bridge.start / bridge.stop / bridge.cancel`。后四者是设置页内部操作，不是新增 MCP 工具。
- `DSH_HOME/agent-mcp.token`：长期凭据。首次复用旧 `agent-mcp.json` 的有效令牌，损坏则失败关闭，不自动换号。创建使用 0600；Windows 权限仍取决于实际文件系统及 ACL。
- `DSH_HOME/agent-mcp.json`：运行期间的发现文件，保留 url/token/pid 原格式，停止后仅删除本实例的文件。
- 旧版升级前先执行 `ensureToken(home)` 迁移当前令牌，再覆盖插件；否则旧版停止时会删除唯一的旧令牌。
- 暂不提供页面内改端口/启停/轮换令牌，以免外部连接被无提示中断。端口仍使用原插件的 Schemastery 配置。
- 隐藏或离开页面清除显示中的凭据；系统剪贴板由用户控制，复制后请自行妥善处理。
- 插件归档、活动家园与旧家园三份需同步；不需要重打桌面包，但须重载 DSH 插件后做现役验收。不要手改不可变桌面/运行时槽。

验证入口：`test/agent-mcp.test.ts`、`scripts/verify-agent-mcp-settings.cjs`；本轮状态见 `docs/01-当前工作/20260928-Agent-MCP接入设置.md`，不得用候选测试替代现役验收。

## 多智能体交互管理：三条通道

设置入口「多智能体交互管理」在一页里呈现三条通道：

| 通道 | 端口 | 本插件的角色 |
|---|---|---|
| 外部托管执行（Codex / OpenCode） | 8765 | 可选接管：探活、启停、读状态、取消运行 |
| DSH HTTP 指令通道 | 9800 | **只读展示**，由 `dsh-agent-bridge` 自己负责生命周期 |
| DSH MCP 接入 | 9801 | 本插件自身，原有控件未删 |

### 配置

```yaml
- id: agent-mcp
  config:
    port: 9801
    bridgeDir: 'G:/智能体桥梁/AgentBridge'   # 含 start.py 的目录；留空 = 未配置
    bridgePort: 8765
```

`bridgeDir` 留空时页面显示「未配置」，不猜盘符、不写死路径。

### 凭据模型

- 9801 的 MCP 令牌由 `credentials` 操作显式返回，默认隐藏、可显隐。
- **Bridge 的 admin token 不进浏览器**。它在 `lib/bridge-link.js` 内从 `<bridgeDir>/data/admin.token` 读取，
  且**每次请求重读**——Bridge 每次重启都会轮换该文件，缓存即失效。`bridge.*` 四个操作都不返回它。
- Bridge 的 `/console/state` 是只读开放端点，读状态连 token 都不需要。

### 启停规则

停止 Bridge 必须同时满足：归属文件与本次创建时的可信记录一致（token、pid、owner、真实目录、端口、startedAt），
当前设置仍指向同一目录/端口，而且本 DSH 持有尚未退出的同一 ChildProcess 句柄。
status 与 stop 使用同一检查；停止按钮仅在「在线且确认归属」时启用，缺失字段也默认禁用。
任一身份不匹配返回 `NOT_OWNED` 且不发送信号——DSH 重启后句柄丢失、外部手动启动或设置已换目标时，
页面仍可读取外部实例状态，但不会停止它。离线说明仅表示无法连接，不猜测它的启动历史。

“Bridge 已停止”必须以子进程实际退出为依据，不能只看信号已发送。错误或有限等待超时分别返回
`BRIDGE_STOP_FAILED` / `BRIDGE_STOP_TIMEOUT`；仍活着的自有句柄不会被丢弃来假装成功。
刷新失败会撤销页面旧的停止许可；取消返回 `ok:false` 不会显示已请求成功。

端口被非 Bridge 程序占用时，探活读 `/health` 断言 `service === 'agent-bridge'`，判定为 `PORT_NOT_BRIDGE`
并**拒绝启动**：既不 spawn，也不结束占用它的程序。
页面也会禁用该状态下的启动和停止按钮。

### 已知限制

- Windows 上 `chmod 600` 只是建议性的，ACL 不变 ⇒ 任何本机用户进程都能读 Bridge 的 `admin.token`。
  这是 Bridge 现有事实，不因本次接入而改变。
- Bridge 只记录执行结果，**不做验收判定**：页面「未验证」列表示「记录到了 result」，不等于通过验证。

## 页面结构

默认视图只留三张通道卡片、两条常驻提醒和一个顶部刷新按钮（一次打三个通道）。
细节按需展开，**默认全部折叠**：

| 折叠组 | 内容 |
|---|---|
| 通道一 · 连接详情 | 目录、端口、归属 |
| 通道一 · 查看运行 | KPI（总数/进行中/成功/失败/取消/状态不明）+ 运行、消息、工作区、智能体四张表 + 取消按钮 |
| 通道三 · 连接详情 | 传输、模式、限额、本机/令牌、工具清单、令牌显隐与复制、手写兜底 |
| 使用说明 | 四组：首次配置 / 使用方法 / 常见问题 / 权限与安全 |

两条提醒**常驻默认视图**，不会被折叠隐藏：「已产生结果 ≠ 已通过验证」；以及仅在真的存在
`DISPATCH_UNKNOWN` 时出现的投递状态不明提示。刷新失败时保留原状态并标记「可能已过期」——
宁可提示不确定，也不把还在线的通道显示成离线。

### 配色说明

页面**不继承 DSH 的 `--dsh-*` 变量**：`assets/theme.css` 不作用于设置文档，实测
`--dsh-border-subtle` 在此处取不到值。所以页面自带调色板，按 DSH 自己的 `data-color-scheme`
属性分浅色/深色两套（属性缺省 = 深色，与 theme.css 语义一致），取值与 theme.css 对齐。
若将来 theme.css 真的覆盖到设置文档，应重新测量而不是直接删掉这层。

## 怎么用（页面里也有）

设置页底部是「使用说明」，四组折叠，全部默认收起。文字版：

**一、首次配置（只做一次）** — 在 DSH 插件设置里把 `bridgeDir` 填成**含 `start.py` 的那一层**
（你的环境是 `G:/智能体桥梁/AgentBridge`），`bridgePort` 保持 8765。回页面点顶部「刷新」。

**二、使用方法 · 让 Codex / OpenCode 干活** — 全部命令在 Bridge 目录里执行，`cli.py` 自己读
`data/admin.token`，不用手动复制令牌：

```bash
python cli.py probe                                             # 看哪些端真的可用
python cli.py register "C:/你的项目路径" --agent dsh            # 打印 workspace_id
python cli.py run codex <workspace_id> "分析这个项目的架构"      # 默认只读
python cli.py run codex <workspace_id> "修复登录超时问题" --write --key fix-1
python cli.py watch <run_id>    # 或回设置页点「刷新状态」，运行表里有「取消」按钮
```

`--writable`（注册时）/ `--write`（运行时）才允许改文件，并会触发工作区独占租约。
OpenCode 需显式 `--model opencode/space-bunny-free`。`--resume <会话ID>` 必须写明确 ID。

**三、常见问题 · 必须知道的三件事** — 结果 ≠ 验收（`verified` 只表示记录到了 result）；相同 `--key` 不会起
第二个任务（返回原 `run_id` 并提示 `deduplicated`）；取消不确认就不改状态（`CANCEL_UNCONFIRMED` 时保持原状）。

**二、使用方法 · 通道二（9800）** 由 DSH 自带 `dsh-agent-bridge` 提供，本页只读显示地址与在线状态，不接管其启停。

**二、使用方法 · 通道三（9801）** 在客户端添加 HTTP / Streamable HTTP MCP 服务，地址与 `Authorization` 头用页面上的
「复制连接信息」。**该内容是通用说明，不是任何特定客户端的导入格式。** 连上后先 `dsh_capabilities`，
再 `dsh_list_sessions` 选会话，然后 `dsh_send_task`。

**三、常见问题 · 排查** — 「该端口不是 Agent Bridge」= 8765 被占，本页不会杀占用者；「停止被拒」= 不是本 DSH 启动的进程；
「未配置」= `bridgeDir` 还空着；`cannot reach the bridge` = Bridge 没在跑，点页面上的「启动 Bridge」即可。
