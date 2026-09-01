# DeepSeek Harness 企业级自动更新方案

状态：**企业级目标方案，尚未投产**  
核对日期：2026-09-01（Asia/Shanghai）  
适用范围：DSH 便携版 3 的官方 `@deepseek-ai/dsh` 运行时，不包含 Electron 桌面程序和社区插件的版本发布。

## 1. 结论

可以实现“自动检测、自动拉取、自动替换、自动更新、自动重启、自动验证”，但生产实现必须是 **不可变版本 + 便携盘暂存 + A/B 运行时 + 影子启动 + 原子指针切换 + DSH 子服务受控重启 + 观察期 + 自动回滚**。

禁止采用以下方式：

- 跟随 `master` 后直接 `git pull` 到生产运行时；
- 使用 npm 的 `latest` 推断当前预发布通道；
- 在正在运行的 `Data/Runtime/dsh-runtime` 目录中原地执行安装；
- 只看到安装命令退出码为 0 就判定更新成功；
- 在任务运行中强制结束桌面或 DSH；
- 新版本启动失败后继续覆盖旧版本或无限重试。

默认推荐策略为 `safe-auto`：自动检测、下载、验证和暂存；仅在 DSH 空闲且候选版本通过全部门禁后自动切换，只重启 DSH 子服务。桌面宿主保持运行。若新运行时要求更高版本桌面宿主，则转入“桌面联动更新”，不得单独强切。

## 2. 已确认的发布事实

- 当前便携运行时：`@deepseek-ai/dsh@0.1.2-alpha.2`。
- 官方最新不可变标签：`dsh-v0.1.2-alpha.3`，提交 `dd6322d604e00eec1ba5e0c8541159906a21094a`。
- npm `alpha` 通道：`0.1.2-alpha.3`。
- npm `latest` 通道仍为 `0.1.1-rc.2`，因此本项目不能查询 `latest` 作为 alpha 更新源。
- 官方仓库声明仍处于 developer preview，可能出现破坏性兼容变更。
- alpha.3 移除了可选 SQLite Session 持久化后端。已有内容不删除，但使用者应先用旧版本导出；因此这是必须进入兼容门禁的破坏性变更。
- 当前便携数据扫描未发现 SQLite Session 后端配置；发现的 SQLite 文本属于行情 MCP 自有数据说明，不是本次阻断项。

官方事实来源：

- <https://github.com/deepseek-ai/deepseek-harness>
- <https://github.com/deepseek-ai/deepseek-harness/tags>
- <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.3>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json>

## 3. 更新对象必须分层

| 更新对象 | 权威来源 | 切换单位 | 生效动作 | 数据处理 |
| --- | --- | --- | --- | --- |
| DSH 官方运行时 | GitHub 不可变 release/tag + npm 官方 registry | A/B Runtime Slot | 只重启 DSH 子服务 | `Data/DSH` 原地保留 |
| 社区插件 | 各插件固定 npm 版本 | 单插件事务目录 | 只重启 DSH 子服务 | Profile 清单事务更新 |
| Electron 桌面 App | MichengAI GitHub Release | 整个 `App/` | 退出并重启桌面 | `Data/` 完全保留 |
| 便携版源码/脚本 | MichengAI 固定 commit | 源码文件同步 | 通常下次构建生效 | 本地定制冲突需合并 |

本方案只处理第一行。不得把四种生命周期混成一个“全部自动覆盖”。

## 4. 目录与状态模型

所有新增内容必须位于便携盘：

```text
Data/Runtime/Harness/
  slots/
    0.1.2-alpha.2-<manifestHash>/
    0.1.2-alpha.3-<manifestHash>/
  current.json
  previous.json

Data/Updates/Harness/
  policy.json
  state.json
  locks/update.lock
  manifests/<version>.json
  downloads/<version>/
  staging/<transactionId>/
  canary/<transactionId>/
  logs/update-events.jsonl
  reports/<transactionId>.json
```

`current.json` 只保存当前槽的相对路径、版本、manifest 哈希和提交时间。主进程启动 DSH 前读取它；切换使用同目录原子写入。`previous.json` 指向最后已知良好槽。禁止使用盘符绝对路径，保证换盘符后仍可启动。

`state.json` 至少包含：状态机阶段、事务 ID、当前/目标版本、源标签和 commit、ETag、重试次数、最近检查时间、下一次检查时间、候选槽、旧槽、错误分类、观察期截止时间、是否需要人工处理。

## 5. 权威来源与供应链门禁

### 5.1 版本检测

1. 主来源：`https://registry.npmjs.org/@deepseek-ai%2Fdsh` 的 `dist-tags.alpha`，使用 HTTPS、ETag 和条件请求。
2. 交叉证明：GitHub 必须存在不可变标签 `dsh-v<version>`；记录标签 commit。
3. 版本只允许严格 SemVer，包名固定为 `@deepseek-ai/dsh`；拒绝降级、拒绝未知通道、拒绝 `master` 快照。
4. 默认每 6 小时检查一次，加入 ±15% 抖动；网络失败指数退避，最大 24 小时；手动检查不受定时器限制。

### 5.2 制品验证

官方 dsh 根包依赖使用 `^` 范围，仅固定根版本不能保证依赖闭包可重复。因此企业级不能让每台客户机自由解析不同的传递依赖。

推荐由 DSH 便携版 CI 生成并发布一个签名运行时清单：

```json
{
  "schema": 1,
  "channel": "alpha",
  "version": "0.1.2-alpha.3",
  "githubTag": "dsh-v0.1.2-alpha.3",
  "githubCommit": "dd6322d604e00eec1ba5e0c8541159906a21094a",
  "node": "24.20.0",
  "minimumDesktopVersion": "1.0.41",
  "runtimeArchive": { "sha256": "...", "size": 0 },
  "packages": [{ "name": "...", "version": "...", "integrity": "sha512-..." }],
  "compatibility": { "breaks": ["sqlite-session-backend-removed"] },
  "signature": { "algorithm": "ed25519", "keyId": "...", "value": "..." }
}
```

客户机必须验证：

- 清单 Ed25519 签名和内置公钥 ID；
- GitHub tag、commit、npm 版本三者一致；
- 下载大小上限、SHA256、每个 npm 包的 `integrity`；
- lockfile 中所有 URL 仅允许 `https://registry.npmjs.org/`；拒绝 `git:`、`file:`、`http:` 和任意脚本来源；
- DSH 家族包版本全部对齐目标版本；启动 peer 完整；Node engine 兼容；
- 仅运行允许列表内的安装脚本，并保存依赖清单/SBOM。

在签名运行时清单尚未建立前，只允许自动检测、下载和本地候选验证；**不得默认静默自动切换预发布运行时**。用户手动批准可作为过渡策略，但不能宣称供应链已达到企业级全自动。

## 6. 更新状态机

```text
IDLE
  -> CHECKING
  -> AVAILABLE
  -> DOWNLOADING
  -> VERIFYING
  -> STAGING
  -> PREFLIGHT
  -> SHADOW_START
  -> READY_TO_SWITCH
  -> WAITING_FOR_IDLE
  -> SWITCHING
  -> LIVE_CANARY
  -> COMMITTED

任一候选阶段失败 -> REJECTED
切换或观察期失败 -> ROLLING_BACK -> ROLLED_BACK
```

每次状态转换必须先写审计事件，再原子写 `state.json`。进程崩溃后从状态恢复，不允许靠猜测继续。

### 6.1 检测与决策

- 比较当前槽版本、远端 alpha 版本、跳过列表和最低桌面版本。
- 解析官方 release notes 的兼容性声明；命中破坏性迁移规则时进入 `manual-blocked`。
- 若存在更新锁、磁盘空间不足、U 盘只读、运行时更新已在进行或桌面即将退出，则不启动新事务。
- 下载前要求可用空间不少于 `max(2 GiB, 候选预计展开大小 × 2.5)`。

### 6.2 下载与暂存

- 所有下载先进入 `Data/Updates/Harness/downloads/<version>/*.partial`。
- 支持断点续传，但续传完成后必须重新做全文件哈希；失败文件不得改名为正式文件。
- 解包和 npm 安装只发生在 `staging/<transactionId>`，不得触碰当前槽。
- 通过文件完整性、包版本、入口、允许脚本和依赖闭包检查后，才把暂存目录同卷改名为不可变 slot。

### 6.3 影子验证

候选槽不得直接接管生产 Profile。先用独立环境启动：

- `DSH_HOME=Data/Updates/Harness/canary/<transactionId>/dsh-home`
- 随机 loopback 端口、`--no-open`、不继承生产凭据；
- 复制经过筛选的 Profile 清单和社区插件快照，不使用生产会话存储作为写目标；
- 验证 CLI 入口、依赖对齐、Profile 解析、社区 bundle 加载、HTTP readiness、token 鉴权和前端静态资源；
- 60 秒内必须就绪，连续 3 次健康检查成功，随后正常关闭且无残留子进程。

影子验证只能证明候选可启动，不能替代切换后的真实观察期。

### 6.4 空闲判定与受控重启

- 桌面宿主持续运行，页面显示“运行时更新已验证，等待空闲切换”。
- 至少连续 30 秒没有运行中任务、审批、计划审核、问题或插件批量更新，才允许自动切换。
- 超过维护窗口仍忙碌则推迟，禁止强杀任务。
- 切换时停止当前 DSH 子服务，原子更新 `current.json`，再拉起新 DSH；Electron 窗口和内置浏览器不退出。
- 只有候选清单要求更高桌面版本时，才协调桌面 App 更新并明确提示桌面重启。

### 6.5 观察期、提交与回滚

实时门禁：

- 60 秒内 readiness 成功；
- 首页/token 引导正常；
- Profile 与桌面桥加载成功；
- 5 分钟观察期内无意外退出、无连续健康失败；
- 不出现不可解析的官方 bundle、数据迁移错误或桌面桥协议错误。

成功后写 `COMMITTED`，将新槽设为最后已知良好；保留当前槽和至少两个历史良好槽。

任何实时门禁失败时：停止候选 DSH，原子恢复旧指针，启动旧槽，验证旧槽恢复；目标版本进入隔离列表，24 小时内不自动重试。回滚目标时限 90 秒。若旧槽也失败，进入可见的恢复页面并保留全部日志，不得删除用户数据。

## 7. alpha.3 专项兼容门禁

本次 `alpha.2 -> alpha.3` 至少执行：

1. 检查是否配置 SQLite Session 持久化后端；命中则阻断自动切换，要求先在 alpha.2 导出。
2. 核对所有 `@deepseek-ai/dsh-*` 运行包实际版本均为 alpha.3，不能混用 alpha.2。
3. 使用真实社区插件清单完成影子 Profile 加载，尤其验证桌面桥、Codex UI、侧栏和市场插件。
4. 验证长会话加载、运行中图片队列、无扩展名图片读取、计划列表和后端连接状态，覆盖本次 release notes 的变更点。
5. 成功回滚演练一次后，才允许将 alpha.3 加入本机自动切换允许列表。

## 8. 配置策略

`policy.json` 建议字段：

```json
{
  "channel": "alpha",
  "mode": "safe-auto",
  "checkIntervalHours": 6,
  "maintenanceWindow": { "start": "02:00", "end": "05:00", "timezone": "Asia/Shanghai" },
  "idleQuietSeconds": 30,
  "shadowStartupTimeoutSeconds": 60,
  "liveStartupTimeoutSeconds": 60,
  "observationMinutes": 5,
  "rollbackTimeoutSeconds": 90,
  "maxDownloadRetries": 3,
  "keepGoodSlots": 3,
  "skipVersions": []
}
```

模式：

- `manual`：只在用户操作时检测和更新；
- `notify`：自动检测，发现后通知；
- `safe-auto`：自动下载、验证、等待空闲、切换、验证和回滚，推荐；
- `maintenance-auto`：仅维护窗口切换，适合无人值守设备。

预发布通道不设置“无条件强制更新”。安全公告需要强制策略时，也必须保留任务排空、验证和回滚。

## 9. 可观测性与用户体验

每个事务使用 UUID 关联，`update-events.jsonl` 记录：

- 检查时间、ETag、当前/目标版本、源标签和 commit；
- 下载来源、字节数、哈希、重试和耗时；
- 制品/依赖/签名/兼容门禁结果；
- 影子进程 PID、启动耗时、HTTP 结果和退出状态；
- 空闲等待原因、切换时间、观察期事件、提交或回滚原因；
- 所有路径对 UI 脱敏，但完整本地审计仍只写便携盘。

桌面设置页显示：当前运行时、候选版本、策略、上次检查、下载/验证进度、是否等待空闲、上次回滚、查看报告、暂停更新、立即检查、跳过版本和手动回滚。

## 10. 现有代码复用与必须重构

可复用：

- SemVer 比较和 DSH 家族版本对齐；
- 官方启动 peer 检查；
- DSH readiness/token 健康检查；
- DSH 子服务回收而不退出桌面；
- 原子文本写、归档路径穿越检查和 SHA256 校验；
- 插件健康检查、Profile 自愈和便携路径收口。

必须重构：

- `applyOfficialRuntimeVersion()` 目前原地修改当前运行时，必须替换为候选槽装配；
- 运行时解析从固定目录改为读取 `current.json`，并保留旧固定目录迁移兼容；
- 新增签名更新清单、更新锁、状态机、下载器、A/B slot 管理器和恢复启动逻辑；
- 新增影子 Profile、空闲判定、观察期/崩溃循环检测、版本隔离和回滚；
- 把更新状态和操作接入设置页、托盘与通知；
- CI 生成确定性运行时归档、lockfile、SBOM、SHA256 和 Ed25519 签名清单。

## 11. 分阶段交付

### 阶段 A：安全检测（可先上线）

- alpha 通道检测、GitHub tag 交叉验证、ETag/退避、状态与审计；
- 只通知，不修改运行时。

### 阶段 B：候选构建与影子验证

- 便携盘下载、完整性、确定性依赖闭包、候选槽、影子启动报告；
- 仍需人工批准切换。

### 阶段 C：A/B 切换与自动回滚

- 空闲判定、原子指针、DSH 子服务重启、观察期、崩溃恢复、手动回滚。

### 阶段 D：企业级全自动

- 签名发布清单、CI 供应链、维护窗口、策略 UI、故障注入矩阵和回滚演练全部完成；
- 通过质量门禁后才把 `safe-auto` 设为可选默认策略。

## 12. 投产验收矩阵

| 场景 | 预期结果 |
| --- | --- |
| 无网络/DNS/超时 | 保持旧运行时；退避；可手动重试 |
| ETag 未变化 | 不重复下载 |
| 伪造版本/非法包名/非允许域 | 检测阶段拒绝 |
| 哈希、签名或 npm integrity 不匹配 | 删除候选 `.partial`；旧版本不受影响 |
| 磁盘空间不足/U 盘只读 | 下载前阻断；显示所需空间 |
| 安装脚本不在允许列表 | 候选拒绝 |
| 下载/解包中断或应用崩溃 | 下次从状态机恢复或清理未提交 staging |
| 影子启动失败/插件不兼容 | 不切换；生成报告；隔离目标版本 |
| 正在运行任务 | 保持桌面和 DSH；等待空闲或维护窗口 |
| 新 DSH readiness 超时/崩溃 | 90 秒内自动回滚并验证旧槽 |
| 切换后桌面进程崩溃 | 下次启动识别未提交事务并回滚 |
| 回滚本身失败 | 进入恢复 UI；保留两槽和全部用户数据 |
| 便携盘盘符变化 | 相对指针仍能定位当前/旧槽 |
| 连续两次执行同一版本 | 幂等，无重复 slot 或重复重启 |
| SQLite Session 配置命中 alpha.3 | 阻断自动切换并提示旧版导出 |

只有上述测试、真实打包冒烟和一次完整回滚演练全部通过，才能把实现状态从“企业级目标方案”改为“企业级已投产”。
