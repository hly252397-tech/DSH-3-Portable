# AgentOS 检查点

> 用途：上下文压缩 / 跨天接力的唯一可信入口。恢复时**先复核本条**，再动手。
> 最后更新：2026-09-17（目标轮 15）

## 目标

按《便携式高自治 Agent 可靠执行系统 V1.0 任务单》在 `G:\DSH-3-Portable\AgentOS\` 建立高自治执行系统，
最终通过 §28 全部 15 项验收测试。硬约束：Stable 永不直接修改；无证据不得回滚运行中的 Stable。

**本轮口径变更**：便携盘内、可逆、当前目标必需的工程工作**自行决策并执行**，不逐项征询用户。

## 已验（有可复现证据）

| 项 | 证据 |
|---|---|
| 29 个模块 / 22 个测试文件 / 55 个 CLI 命令 | `node scripts/run-tests.mjs` → `tests 167 / pass 167 / fail 0`；**零孤儿进程** |
| **三项能力实施记录** | `AgentOS/docs/I-TRIGGER-RECOVERY-FORENSICS.md`（含 GCC 12 项 + GIR 10 项 + 未验证边界） |
| **① 自动验证触发器** | 策略层 7 用例全过（debounce 一批一次 / 单实例 / 噪声抑制 / forceVerify）；插件已登记：`bundles_count 30`、Junction 建好、**宿主半侧 `import` 通过**（`apply/inject/name`，`inject:['webServer']`）；备份 `package.json.bak-before-agentos-trigger` |
| **② Stable 自动恢复** | 6 用例全过（含「无凭证绝不许改指针」+ 被拒时指针字节不变）；`stable-status` 真机：`current=0.1.6-alpha.1-…`、`previous=0.1.5-rc.2-…`、**台账里无 Stable → 正确拒绝**；普通角色 → `pointer_write_forbidden` |
| **③ 启动第一条错误取证** | 7 用例全过；真机演练：第一条 `stored=True`（`Cannot find package '@deepseek-ai/dsh-client-ui-slots'` line/col 12/17），后续 6 条连锁后**第一条原样未变**，共享层判定 `True`（最大组 `dsh-client-ui-slots`） |
| §28 覆盖自查（README §6.1） | 系统级：1/3/4/5/7/9/10/11/12/13/14/15；**判定级剩 3 项**（2/6/8） |
| Stable Shield（真机） | 7 个保护面；桌面 5 槽同版本 → 如实报歧义不猜；往真实活动槽写被拒、关键文件 SHA-256 前后一致 |
| 触发器（真机） | `watch --once`：`RAN/PASS 1821ms` → `SKIP 774ms`；轮询 3 轮 `ran=0 skipped=3`；锁自动释放；停止哨兵生效 |
| §28 测试 1 / 10 / 14（系统级） | 自动开子任务回续；Process Broker 真停且零孤儿；候选白名单进 File Broker 并 3 条同拦 |
| 七层 Gate Engine + 自动熔断 | `verify` → `PASS`；坏 profile + `candidate_id` → `BOOT_FAILED` → 候选真被移进 `rejected/` |
| 事故核查：§2 的 BOOT_BROKEN **不成立** | `Data\Recovery\boot-audit-20260917\REPORT.md`；已固化为机器判定（`boot-audit`） |
| 本轮修的真 bug | ① `running_object_is_candidate` 读了一个**我凭空发明的** `pointer.stable` 字段（真实 `current.json` 没有）→ 改为按「current 槽 ≠ 台账 Stable 槽」判定；② 一段空 `if` 死代码留在安全闸门里，已删 |
| **槽位盘点与回收（12 项任务）** | `AgentOS/runtime/slots.json` + 每槽清单 `AgentOS/runtime/slot-manifests/*.json`：12 槽角色认定（current / previous / last_known_good / retired）；引用分**强/弱**（弱 = 历史转录、日志、本工具自身产出）；**5 槽移入 `Data/Trash/Slots`**，可回收 **2,551,029,144 B = 2.376 GB**；同盘 rename **释放 0 字节**（78.701 → 78.700 GB），故"移入回收区"只是隔离不是回收；随后按保留策略**永久删除 4 个**（3 个桌面槽与 current/previous 同为 1.0.66 → 重复且最占地方；留 1 个 harness 作备用 `0.1.5-rc.1-fc2859f0fa67674c`）→ 实测释放 **2,327,846,232 B = 2.168 GiB**，可用空间 78.694 → **80.664 GB**（净增 1.97 GiB，与按文件累计差 ~0.2 GiB，**未查明原因，如实标注为度量偏差**）|
| **冷启动 ×2 + 负向对照 ×2** | `AgentOS/scripts/coldstart-verify.mjs`：current 槽 `0.1.6-alpha.1-2a49814bc8ce816d` **PASS / 6499ms**（`http://127.0.0.1:54826`）；previous 槽（自动回滚目标）`0.1.5-rc.2-fd316e6b895e48c1` **PASS / 6751ms**。对照：已移走的槽 → **FAIL exit=3**（preflight 缺入口）；槽正常但 profile 故意装坏 bundle → **FAIL exit=1 / 136ms** —— 探测能区分好坏，PASS 才成立 |
| **桌面槽身份落地** | `state.json` **保留** `currentVersion:"1.0.66"`（`sanitizePortableDesktopUpdateState` 用 `exactVersion()` 校验，换槽 ID 会被静默回退 + 自定义字段会被丢弃），**附加** `currentSlotId`；`AgentOS/scripts/sync-desktop-slot-identity.mjs` 幂等重断言 + `--check` 检漂移（真机 `--check` exit=0）。槽身份权威仍是 `pointer.json`（`current`/`previous` 是**对象**，槽 ID 取 `relativePath` 的 basename） |
| ⚠️ **新发现冰山（未修，待决）** | 活动 Web profile 的 `node_modules` 中 `react` / `react-dom` / `scheduler` / `loose-envify` 四个 **Junction 指向 `Data/Temp/diag-home8\...\.dsh-module-fallback`** —— 活动前端依赖一个**临时诊断目录**，`Data/Temp` 一旦被清理前端即崩。与本次槽回收无关，但同属"活动件依赖非耐久位置"。15 个顶层链接中**无一指向被移走的 5 槽**（移动未打断任何链接） |

## 未验 / 未做（不许当成完成）

1. **插件宿主半侧与客户端半侧尚未在真实重启后确认**（本地插件 `lib/index.js` 不是热重载对象，是物理约束）。
   重启后应：`GET http://127.0.0.1:<port>/agentos-trigger/status` 返回 `loaded: true`。
2. **自动恢复目前不会触发**：真机晋升台账里**没有任何 Stable 记录**。前置是候选通过完整门禁后调用
   `recordPromotion(...)` 写台账——属"把判定接进链路"的延续，不需要用户决策。
3. **判定级剩 3 项**（README §6.1）：测试 2（拖延措辞没接进"发答复"路径）、6（"在 Stable 复现 B"是流程不是代码）、8（成员清单靠人给）。
4. **官方基线红灯**：`verify-dsh-official-baseline.mjs --online` 报 HEAD 已漂移（基线 `c291e796` → 当前 `0d1f5000`）。
   动 `src/**` 前必须先人工审阅官方变更并更新基线（强制动作，已记录）。
5. Governor 不是常驻 daemon；Network Broker 只有判定；Skill/Tool 自我开发执行侧（§24）未接；SQLite（§25）未建（console 已覆盖查询需求）。
6. **客户端渲染进程控制台仍无法读取**（根路径 401）——但取证器已能在客户端自行捕获第一条错误，不再需要人盯 DevTools。

## 等待用户

- 当前**没有阻塞用户的项**。原先要的「失败插件名单」不再需要：取证器已在客户端自行抓第一条真实异常，且名单本身不是根因。
- 唯一需要人做的是**重启 DSH** 让插件宿主半侧生效（物理约束，不是选择）。

## 下一步（按优先级）

1. **重启后确认插件生效**（`/agentos-trigger/status` 应 `loaded:true`）。
2. **把晋升写进台账**：候选通过完整门禁时调 `recordPromotion`，自动恢复才真正可用。
3. 判定级剩 3 项接链路（最容易的是测试 2：把 `checkDeferredWork` 接进 Governor 收尾报告）。
4. ~~回收区 5 槽永久删除~~ **已完成（轮 15）**：留 1 个 harness 备用，删 4 个，释放 2.168 GiB。清扫器 `Data/Temp/sweep-trash-slots.mjs` + 守卫（先比对「指针 current/previous + 活动进程命令行」受保护清单，**命中即整体拒绝、绝不半途删**），日志 `Data/Trash/sweep-log.jsonl`。删除后复核：7 个活动槽齐全、桌面 6/6 进程仍在原槽。
5. **修 `react`/`react-dom`/`scheduler`/`loose-envify` 四个跨界到 `Data/Temp` 的 Junction** —— 这是会"哪天突然崩前端"的隐患，优先级高于功能开发。

## 环境事实（避免重复踩坑）

- `pwsh` 是 **Windows PowerShell 5.1**：无三元；ASCII-only 脚本；`Set-Content -Encoding utf8` 带 BOM；传原生参数吃双引号；`fn $x | Out-Null` 吞输出；`$obj.int + '('` 会试图把 `(` 转 Int32。
- Node 24 `--test` 不接受目录参数；`scripts/run-tests.mjs` 已展开文件列表。
- `spawn` 只 `unref` 不 `detached`，父进程退出子进程就死。
- 大块 `old_string` 替换易失配、且**改前必须先 read**（本轮被工具拦过两次）；有状态 worker 计数器必须按条目分开。
- 桌面 `state.json` 的 `currentVersion` 是**应用版本**（`app.getVersion()`），**不是槽 ID**；槽身份已附加为 `currentSlotId`（更新器 sanitize 时可能丢弃，重跑 `sync-desktop-slot-identity.mjs` 补回）；同版本可对应多个候选槽。
- **G 盘删小文件的实际速度（轮 15 实测，修正此前"20 分钟"的担心）**：harness 槽 **23,954 个文件删除仅 69.5 秒**；桌面槽 600 文件 **0.7 秒**。此前按 50ms/文件外推的 ~20 分钟**高估了约 17 倍** —— 别再用单文件均值外推批量删除耗时，直接实测。
- **PUA 反馈记录**：`Data/Home/.pua/feedback.jsonl`（用户说"记录一次有可见 PUA 输出的交付"时追加，`rating:null` 不记评分）；**备用副本只保留一个** `feedback.jsonl.bak-*`。
- **孤儿进程检查必须延迟复核**：测试刚结束时采样会误报（进程可能正在退出）。实测出现过一次假阳性（PID 14720 延迟复核已不存在）。
- **插件 API 事实来源**：`Data/DSH/profiles/web/local/dsh-ui-tweaks/`（可运行范本）——
  `ctx.effect(() => { const un = ctx.webServer.register({kind:'exact',path,handler}); return () => un() }, 'desc')`；
  客户端 `window.__ModuleLoader__.load({id, factory})`。
