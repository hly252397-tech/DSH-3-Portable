# 三项能力实施记录：自动验证 / 自动恢复 / 自动取证

> 依据：《便携式高自治 Agent 可靠执行系统 V1.0 任务单》第三/十一/十二/十四/十五/十八/十九/二十一/二十二节
> 本轮授权口径：便携盘内、可逆、当前目标必需的工程工作**自行决策并执行**，不逐项征询。
> 记录日期：2026-09-17（目标轮 13）

---

## 0. 一句话结论

三项能力**已建成并各有可复现证据**；其中除「触发器宿主半侧需要重启生效」外，全部当场验证。
**但自动恢复目前不会触发**——原因是真机上**从没有任何版本被记录为已验证的 Stable**（见 §4）。

---

## 1. 三项能力与实现位置

| 能力 | 实现 | 验证 |
|---|---|---|
| **① 自动验证触发器** | `AgentOS/lib/triggerpolicy.mjs`（策略，纯逻辑）+ `Data/DSH/profiles/web/local/dsh-agentos-trigger/`（DSH 本地插件，宿主+客户端半侧） | 策略层 7 个用例全过；插件已登记、Junction 已建、宿主半侧 `import` 通过 |
| **② Stable 自动恢复** | `AgentOS/lib/stablerecovery.mjs`（晋升台账 + 确定性条件 + 受控指针写 + 恢复留档） | 6 个用例全过（含"无凭证绝不许改指针"） |
| **③ 启动第一条错误自动取证** | `AgentOS/lib/bootforensics.mjs`（宿主侧取证存储）+ 插件客户端半侧（捕获 dynamic import / 模块请求失败） | 7 个用例全过；真机演练第一条永不被 73 条连锁覆盖 |

---

## 2. 自动验证：设计要点

### 触发时机（不是"每写一个文件"）

```
一批会改文件的工具跑完
  → session/event 的 tool/result 命中 write/edit/... 
  → Debouncer（默认 1000ms，同 key 重置计时）
  → 调 `agentos watch --once`
  → 先比工作区指纹：没变直接退出（本盘实测 git status ≈118ms）
```

- **单实例**：同一工作区同时只能有一个验证实例；并发时只计数不排队（`skipped_while_running`）。
- **强制同步验证**：`runner.forceVerify()` 供"任务请求完成前"调用，绕过 debounce 立刻跑。
- **噪声抑制**：`.git/`、`node_modules/`、`Data/Temp/`、`Data/Recovery/` 下的变更不触发（防自触发循环）。
- **Watcher 不是正确性来源**（§15）：判定永远来自 `verify` 的同步门禁；触发器只是"叫醒服务"。

### 接入方式：本地 DSH 插件（自行选定的低风险方案）

选它的理由（不是问来的）：位于便携盘 `profiles/web/local/**` 可变区、删除即回滚、不需要 Windows 计划任务、
能覆盖未提交修改（比 git hook 覆盖面大）。

**已知物理约束**：宿主半侧**必须重启 DSH 才生效**（本地插件的 `lib/index.js` 不是热重载对象）。
因此本轮口径是 **候选已就绪，待重启确认**——不写成"已生效"。

---

## 3. 自动恢复：Stable 的定义与权限边界

### Stable ≠ previous，也 ≠ 目录里最新

Stable 只能从**晋升台账** `runtime/stable-promotions.jsonl` 解析，判据缺一不可：

- `status = STABLE`（即 `boot_verdict = PASS`）
- `runtime_slot` 在便携盘上**真实可达**

### 确定性触发条件（四条全中才允许）

1. 当前运行对象是 Candidate（由 `current 槽 ≠ 台账 Stable 槽` 判定）
2. Boot Gate 为 FAIL / ERROR / TIMEOUT
3. 存在有效 Stable
4. 当前无外部不可逆操作

### 权限边界（这才是关键）

```
普通 Agent / File Broker / Candidate：**永久无权**改 current.json（Stable Shield 继续拦）
Recovery Broker：条件全中 → 铸造一次性 capability → 受控写指针
```

`writeRuntimePointer()` 只认 `recovery-broker-capability`；无凭证 / 凭证过期 / 根不匹配一律拒绝，
且**被拒时指针文件字节不变**（有测试）。`refusePointerWrite()` 给普通角色明确拒绝语。

### 恢复动作（不删任何数据）

冻结候选 → 标记 REJECTED → 保存证据 → 切指针 → 留 `/journal.jsonl`（记 before/after 指纹、原因、Boot Verdict、结果）。
**不删除**槽位、tasks、verdicts、candidates，**不清空**事件账本。`current.json.bak` 保留。

---

## 4. 真机发现：今天不可能自动回滚（这不是问题，是事实）

```
$ agentos stable-status --portable G:\DSH-3-Portable
  current  = Harness/slots/0.1.6-alpha.1-2a49814bc8ce816d
  previous = Harness/slots/0.1.5-rc.2-fd316e6b895e48c1
  台账里的 Stable = <无 —— 从没记过晋升>
  恢复允许 = False   阻塞 = running_object_is_candidate, boot_gate_failed, valid_stable_exists
```

**没有任何版本被记录为"经过完整门禁晋升的 Stable"**，所以自动恢复会正确地拒绝执行。
要让它在真实故障时可用，前置是：**候选通过完整门禁后调用 `recordPromotion(...)` 把晋升写进台账**。
这条已列入后续（属于"把判定接进链路"的延续），不需要用户决策。

---

## 5. 自动取证：第一条永不覆盖

产物目录 `Data/Recovery/<incident-id>/`：

| 文件 | 语义 |
|---|---|
| `incident.json` | 事故元信息（runtime / candidate / 指纹 / 时间），重开**不覆盖** |
| `first-import-error.json` | **第一条真错误**，永不覆盖 |
| `first-network-failure.json` | 第一个失败模块请求（404 / 返回 HTML / 无响应），永不覆盖 |
| `subsequent-errors.jsonl` | 后续错误 append-only，**只统计** |
| `first-import-error-summary.json` | 收口统计 + 共同依赖分析 + 二分计划 |

**为什么这不重要但很关键**：插件名单本身不是根因。73 个名字只能证明"共享启动层故障"。
取证器抓的是 **第一条原始异常 + 第一个失败请求**，并给出共享层分组与二分计划。

真机演练（临时盘）：
```
第一条 stored=True  message=Cannot find package '@deepseek-ai/dsh-client-ui-slots' line/column=12/17
后续 6 条连锁 → 第一条仍原样未变
共享层判定 = True   最大组 = dsh-client-ui-slots
```

**客户端半侧**在模块求值阶段就装上捕获器（`window.error` 捕获阶段 / `unhandledrejection` / `PerformanceObserver` resource），
只抓模块相关错误，POST 给宿主端点落盘；第一条成功后只累加本地计数。

---

## 6. GCC 前置检查（12 项，摘要）

```text
Task Position        : DSH 本地插件（profiles/web/local/**）+ AgentOS 自有库；属"部署/运维 + 工具链"类
Direct Impact        : profiles/web/package.json（dependencies + dsh.profile.bundles）、新增 local/dsh-agentos-trigger/**、
                       新增 local 的 node_modules Junction、AgentOS 新增 3 个 lib + 5 个 CLI 命令
Indirect Impact      : 下次重启时的插件树组装；DSH 自愈会在插件加载失败时把它从 bundles 摘除（有兜底）
Reusable Existing    : dsh-ui-tweaks 的 webServer/effect/client-load 形态（已实读源码，不凭记忆）
Architecture Constraints: 命名导出形态 -> 模块级 inject 生效；patch 条目带稳定 id；路径绝对；
                       禁手动清理（一律 ctx.effect）；waterfall 必调 next()；本地插件走 link: + Junction
Expected Files       : 见 Direct Impact
Do Not Touch         : src/**、App/resources/**、Data/Runtime/Harness/**、Data/Updates/Desktop/**
Regression Scope     : 其他 29 个 bundle 的加载；页面启动（客户端半侧）；插件树组装
```

## 7. GIR 后置检查（10 项）

| # | 检查 | 结论 |
|---|---|---|
| 1 | 实际修改文件 | `profiles/web/package.json`（+2 行）、`local/dsh-agentos-trigger/**`（4 新文件）、`node_modules/dsh-agentos-trigger`（Junction）、`AgentOS/lib/{triggerpolicy,stablerecovery,bootforensics}.mjs`、`AgentOS/bin/agentos.mjs`、5 个测试文件 |
| 2 | 是否超出预期范围 | **否**（预期即上述清单）；profile 改动为最小插入，已备份 |
| 3 | 是否跨模块 | 是（DSH 插件层 + AgentOS 库）；已按知识库三种导出形态与 patch 规则实现 |
| 4 | 是否重复能力 | 否；触发器策略抽到 AgentOS 是为了可测试（插件只会适配） |
| 5 | 是否破坏公共接口 | **否**（只新增导出与命令） |
| 6 | 是否改数据结构 | 新增 `runtime/stable-promotions.jsonl`、`supervisor/recovery/journal.jsonl`、`Data/Recovery/<id>/*`；均为新增文件 |
| 7 | 是否违反架构 | 否；插件走 ctx 注册、无手动清理、无应用内模态 |
| 8 | 直接依赖测试 | AgentOS 全量 **167/167 通过**；插件半侧 `node --check` + 宿主 `import` 通过 |
| 9 | 间接回归 | 其他 bundle 未改动；插件加载失败有 DSH 自愈兜底；**待重启真实确认** |
| 10 | 项目构建 | 本轮**未**改 `src/**` 或打包脚本，未触发全量构建；官方基线当前红灯（HEAD 已漂移）——动 `src/**` 前必须先人工审阅官方变更 |

### 未验证边界（必须明示）

- 插件宿主半侧与客户端半侧**尚未在真实重启后确认**（物理约束）。
- `session/event` 的 `tool/result` payload 形状未在运行中实测，故全部 hook 体包了 try/catch：形状不符只会少干活，不会让插件加载失败。
- 自动恢复**目前不会触发**（台账无 Stable 记录，见 §4）。

### 下一步归谁

- **重启确认**：由用户重启 DSH 后，`GET /agentos-trigger/status` 应返回 `loaded: true`。
- **把晋升写进台账**：我继续做（候选通过门禁时调用 `recordPromotion`）。
