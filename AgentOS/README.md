# AgentOS — 便携式高自治 Agent 可靠执行系统

> 依据：《便携式高自治 Agent 可靠执行系统 总体设计与实施任务单 V1.0》
> 状态：**候选就绪**。判定层已覆盖第 28 节全部 15 项并有回归测试；**执行层尚未接入真实系统**。
> 本目录是**纯新增制品**，不修改、不依赖正在运行的 Stable 运行时槽 / 桌面槽。
> 目标硬约束「**Stable 永不直接修改**」已由 `lib/stableshield.mjs` 变成机器防线：7 个保护面、
> 按真实路径判定、无关闭开关，并已用**真实活动运行时槽**做过拒绝写入的实测。

---

## 1. 三句话讲清它干什么

1. **给"通过"上锁**：任何 PASS 都绑定当前工作区代码指纹；文件一变，旧 PASS 立刻作废，必须重验。
2. **给"失败"上闸**：后台作业的 FAIL/PASS 进追加式账本，没被任务引擎消费就禁止收工；插件启动失败自动熔断。
3. **给"改动"上笼子**：改动只能进 Candidate，必须声明假设/预期增量/受保护不变量/允许文件；引入回归自动判废且判废后禁止继续开发。
4. **给"任务"上轨**：状态机只管合法迁移；`COMPLETED` 必须过完成守卫；父任务遇阻自动开子任务并在子任务通过后**自动**回续，不等用户。

---

## 2. 运行时

```powershell
$node = 'G:\DSH-3-Portable\App\resources\node\node.exe'   # 便携版 Node v24.20.0，禁止用系统 Node
cd G:\DSH-3-Portable\AgentOS
& $node bin/agentos.mjs init          # 按任务单第五节建目录树（37 个目录，幂等）
& $node scripts/run-tests.mjs         # 全量验收测试（当前 167/167）
```

零外部依赖（`dependencies: {}`），纯 Node ESM。

---

## 3. 模块与任务单条款对应

| 文件 | 条款 | 作用 |
|---|---|---|
| `lib/paths.mjs` | §5 | 目录树、稳定 JSON、原子写（tmp→校验→rename→bak） |
| `lib/fingerprint.mjs` | §16 | 工作区指纹：Git HEAD + 修改/未跟踪文件 SHA-256 + 门禁脚本/配置/manifest SHA-256；零覆盖标 `degraded` |
| `lib/verdict.mjs` | §16 | 正式 verdict（含 before/after 指纹），指纹不等即 `INVALID` |
| `lib/ledger.mjs` | §15 / §25 | append-only 事件账本、链式完整性、未消费关键事件、作业登记校验 |
| `lib/candidate.mjs` | §11–§14 | Candidate 声明、回归增量、晋升 7 条件、判废冻结、写入守卫、补丁连锁禁令、**新缺陷归因分支** |
| `lib/bootbreaker.mjs` | §18 | Boot Circuit Breaker：8 条触发规则 → `BOOT_FAILED` + 恢复计划 |
| `lib/exitguard.mjs` | §17 | 13 条退出条件 + 8 个拖延措辞拦截 |
| `lib/broker.mjs` | §4 / §19 | 系统盘写入拦截与重定向；进程停止策略（拒绝模糊/按名查杀） |
| `lib/incident.mjs` | §22 | 事故关闭判定：没有新增机器门禁不得 `CLOSED` |
| `lib/taskstate.mjs` | §6 / §15 | 18 个状态、4 个合法终态、迁移表、`COMPLETED` 完成守卫、事件→状态推导 |
| `lib/goalcontract.mjs` | §7 | Goal Contract 字段校验、完成度评估、操作对齐检查 |
| `lib/taskstack.mjs` | §8 | 父子任务栈：`resume_point` 保存 + 子任务通过后自动回续 |
| `lib/impactset.mjs` | §9 / §10 / §21 | 问题分类 INSTANCE/FAMILY/SYSTEM/GLOBAL_RUNTIME、Impact Set 完成屏障、Family Gate、修改优先级 |
| `lib/stopline.mjs` | §14 | 5 个上限计数器 + 触发后的 8 个强制动作 |
| `lib/eventbus.mjs` | §15 | 作业登记、事件发布、未消费注入、关键事件应用到任务状态 |
| `lib/memory.mjs` | §23 / §25 | 六类记忆（episodic/semantic/procedural/self-model/world-model/project-model）、append-only、错误结论保留并标记、能力指标、模型快照 |
| `lib/learning.mjs` | §23 / §24 | 10 级晋升链（观察→…→生产 Skill）、**反过拟合闸门**（多上下文验证）、跳级拒绝、Skill/Tool 候选管线 + A/B Runtime |
| `lib/bootaudit.mjs` | §18 / §22 | 把熔断器接到真实制品：bundle 入口解析、隔离清单、只读探针 → `BOOT_FAILED` 机器判定 |
| `lib/supervisor.mjs` | §3 / §6 / §7 / §15 / §17 | **Supervisor 常驻调度循环**：权责分离（Worker 只能提结果，Supervisor 定状态/完成）、`decideNext` 纯决策、continue-until-terminal、完成守卫、停线、事件消费 |
| `lib/gateengine.mjs` | §21 / §16 / §18 | **Verifier 七层 Gate Engine**：static/target/family/regression/differential/boot/completion；启动审计在管线内**自动执行**；`BOOT_FAILED` 时**真的**判废候选 |
| `lib/filebroker.mjs` | §20 / §3-7 | **File Broker（真执行器）**：6 条前置（已读取/哈希有效/允许根/无符号链接逃逸/任务范围/已建检查点）+ 6 条后置（重读/diff/语法/类型/目标测试/DIRTY）+ tmp→校验→原子 rename→留 bak；做不到的检查进 `not_run` 不冒充通过 |
| `lib/runner.mjs` | §3 / §15 / §17 | **Runtime Governor（可反复触发的那一半）**：每次调用带步数预算、已满足条目/计数器/失败集合**持久化**、跨进程续跑、写 `status.json` 心跳并给出 `next_action` |
| `lib/stableshield.mjs` | 目标硬约束 / §11 | **Stable Shield**：把「Stable 永不直接修改」从纪律变成机器防线。保护桌面槽/运行时槽/指针/Electron 状态；按**真实路径**判定（Junction 逃逸也拦得住）；活动槽优先按指针解析，**无法确定时如实报歧义不猜**；`profiles/web` 明确不保护 |
| `lib/watcher.mjs` | §15 / §19 | **触发器（触发无关）**：`watchOnce` 是任何触发方式唯一需要的入口；先比指纹、没变直接跳过、变了才跑门禁；单实例锁 + 陈旧锁自愈 + 停止哨兵；Watcher **不是**正确性来源 |
| `lib/processbroker.mjs` | §19 | **Process Broker（真执行器）**：登记表 append-only；`spawnTracked` 真起进程并登记；`stopProcess` 真的停。只停**在册且 owner 对得上**的精确 PID；按名/模糊/批量一律拒绝且**不碰进程**；已停止的 PID 永不再动手 |
| `lib/console.mjs` | §26 | **控制台（只读聚合）**：§26 的 15 个字段一处看全；每个字段可追到来源文件；读不到就如实标 `null` + `warning`；自包含 HTML 报告（内容转义） |
| `lib/stablerecovery.mjs` | §11/§12/§14/§18 | **Stable Recovery Broker**：Stable 只能从晋升台账解析（≠ previous、≠ 最新槽）；四条确定性恢复条件；**普通角色永久无权改指针**，只有条件全中才铸一次性 capability 受控改；恢复不删任何数据 |
| `lib/bootforensics.mjs` | §18/§22 | **Boot First-Error Collector（宿主侧）**：`Data/Recovery/<id>/` 落第一条真实 import 异常与第一个失败请求，**永不覆盖**；后续只统计；共同依赖分析 + 共享层二分计划 |
| `lib/triggerpolicy.mjs` | §15/§19 | **触发策略**：只对改文件的工具触发；debounce 一批一次；**单实例**；噪声路径抑制；`forceVerify` 供完成前强制同步验证。策略可测，插件只做适配 |
| （插件）`profiles/web/local/dsh-agentos-trigger/` | §3/§15/§18 | **DSH 本地插件**：宿主半侧接 `session/event` → debounce → `watch --once`，并提供 `/agentos-trigger/{status,first-error}`；客户端半侧在模块求值阶段捕获第一条 import 异常。**宿主半侧需重启生效** |

---

## 4. CLI

```powershell
& $node bin/agentos.mjs init
& $node bin/agentos.mjs fingerprint --root <ws> --extra <json文件> [--out <file>]
& $node bin/agentos.mjs gate --root <ws> --extra <json文件> --cmd "exit 0" [--task T] [--candidate C]
& $node bin/agentos.mjs ledger-append --type FAIL --critical --payload '{"task_id":"T"}'
& $node bin/agentos.mjs ledger-status
& $node bin/agentos.mjs boot-check --input <json文件>
& $node bin/agentos.mjs exit-check --state <json文件>
& $node bin/agentos.mjs incident-check --input <json文件>
& $node bin/agentos.mjs candidate-declare --input <json文件>
& $node bin/agentos.mjs candidate-promote --input <json文件>
& $node bin/agentos.mjs candidate-attribute --input <json文件>
& $node bin/agentos.mjs patch-chain --input <json文件>
& $node bin/agentos.mjs job-check --input <json文件>
& $node bin/agentos.mjs task-create --input <json文件>
& $node bin/agentos.mjs task-show --task <id> [--satisfied a,b,c]
& $node bin/agentos.mjs task-transition --task <id> --to <STATE> [--guard <json文件>]
& $node bin/agentos.mjs stopline-check --input <json文件>
& $node bin/agentos.mjs impact-check --input <json文件>
& $node bin/agentos.mjs family-gate --input <json文件>
& $node bin/agentos.mjs boot-audit [--profile <dir>] [--harness <槽目录>] [--probe <url,url>] [--module <url,url>]
& $node bin/agentos.mjs memory-remember --input <json文件>
& $node bin/agentos.mjs memory-status --input <json文件>
& $node bin/agentos.mjs memory-list [--kind <kind>] [--all]
& $node bin/agentos.mjs memory-capability [--input <json文件>]
& $node bin/agentos.mjs memory-snapshot --input <json文件>
& $node bin/agentos.mjs learning-evaluate --input <json文件>
& $node bin/agentos.mjs learning-shortcut --input <json文件>
& $node bin/agentos.mjs learning-stages
& $node bin/agentos.mjs artifact-candidate --input <json文件>
& $node bin/agentos.mjs decide --input <json文件>            # 纯决策：给定快照该干什么
& $node bin/agentos.mjs supervise --input <json文件> [--out <file>]   # 真跑一遍调度循环（脚本化 Worker，不依赖大模型）
& $node bin/agentos.mjs verify --root <ws> --input <json文件>       # 跑完整七层管线（含管线内自动启动审计）
& $node bin/agentos.mjs file-read  --root <ws> --input <json文件>    # 登记"已读取"（跨命令持久化）
& $node bin/agentos.mjs file-write --root <ws> --input <json文件>    # 受保护写入（input.candidate_id 时强制候选白名单）
& $node bin/agentos.mjs file-status --root <ws> [--input <json文件>]
& $node bin/agentos.mjs govern --root <ws> --task <id> --input <json文件>   # 治理一次（幂等、可续跑）
& $node bin/agentos.mjs governor-status --root <ws> --task <id>            # 只读心跳
& $node bin/agentos.mjs stable-shield [--portable <便携盘根>] [--input <json文件>]   # 保护面 + 可选 probe
& $node bin/agentos.mjs watch --root <ws> --input <json文件> [--once]   # 触发入口（--once 给任何触发方式用）
& $node bin/agentos.mjs watch-status --root <ws> --input <json文件>
& $node bin/agentos.mjs proc-spawn --root <ws> --input <json文件>     # 起进程并登记（默认 unref+detached）
& $node bin/agentos.mjs proc-list  --root <ws> [--input <json文件>]
& $node bin/agentos.mjs proc-status --root <ws> [--input <json文件>]
& $node bin/agentos.mjs proc-stop --root <ws> --input <json文件>      # 只停有明确 owner 的精确 PID
& $node bin/agentos.mjs proc-register --root <ws> --input <json文件>
& $node bin/agentos.mjs proc-reconcile --root <ws> [--input <json文件>]
& $node bin/agentos.mjs console --root <ws> [--task <id>] [--portable <盘根>] [--out <html>]   # §26 一页看全
& $node bin/agentos.mjs stable-status --portable <盘根>            # Stable 从台账解析 + 四条恢复条件
& $node bin/agentos.mjs recovery-execute --portable <盘根> --input <json>   # 默认 dry-run；execute:true 才真恢复
& $node bin/agentos.mjs incident-read   [--portable <盘根>] [--input <json>]
& $node bin/agentos.mjs incident-record --input <json>            # 录第一条错误 / 收口统计
& $node bin/agentos.mjs incident-analyze --input <json>           # 共同依赖分析 + 二分计划
```

**触发器怎么接（不再需要"先定触发点"）**：任何方式都只调同一条命令 ——

```powershell
# git hook / DSH 插件 / 计划任务 / 人手，一律这样调：
& $node bin/agentos.mjs watch --root <ws> --input <触发配置.json> --once
```
它先比工作区指纹（本盘实测 `git status --porcelain` ≈ **118ms**），**没变就直接退出**，不跑任何重活。

**`--probe` 与 `--module` 的区别（踩过坑）**：
- `--probe` 只是**存活探针**，它的 404 **不会**触发熔断；
- `--module` 是**你确知的真实模块 URL**，其 404 / 返回 HTML 才会熔断。
  服务端无法枚举客户端的真实模块请求，拿自造 URL 的 404 去熔断是假阳性（已实测并加回归用例）。

**Windows 传参注意**（已实测）：
- PowerShell 5.1 传原生参数会**吃掉双引号** → JSON 请用 `--extra <文件路径>` / `--input <文件路径>`，不要内联。
- PowerShell `Set-Content -Encoding utf8` 写出的是**带 BOM** 的 UTF-8 → CLI 已主动 strip BOM。

---

## 5. 端到端对照复现（实测输出）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 覆盖 0 文件 | `gate --root <ws> --cmd "exit 0"` | `INVALID` / `fingerprint_degraded_zero_coverage` ← **拒绝假 PASS** |
| 声明覆盖 | `gate --root <ws> --extra <ex> --cmd "exit 0"` | `PASS` / fp=`103e4845…` |
| 命令失败 | `gate … --cmd "exit 3"` | `FAIL` / `nonzero_exit_code` |
| 改一个字节 | 改文件后重算指纹 | fp=`53875d3c…` → `stale=True` |
| 两个无关插件失败 | `boot-check` | `BOOT_FAILED` / `CURRENT_CANDIDATE_REJECTED` |
| 任务走完状态机 | `task-transition` 逐状态 | 8 步全 ok，`READY_TO_COMPLETE` 前 `may_stop=False` |
| 守卫不全 | `task-transition --to COMPLETED --guard {exitOk}` | `completion_guard_failed`，blockers 3 条 |
| 守卫齐全 | 同上 + 完整 guard | `COMPLETED`，文件自动落到 `tasks/completed/` |
| 终态再迁 | `task-transition --to EXECUTING` | `terminal_state_has_no_transitions` |
| 连续两次回归 | `stopline-check` | `STOP_THE_LINE` + 8 个强制动作 |
| 截图实例 vs 家族 | `impact-check` | 分类 `FAMILY` + `instance_patch_forbidden_for_family` |
| 只验一个成员 | `family-gate` | `ok=false`，`missing=[b,c]` |
| 新缺陷归因 | `candidate-attribute` | `candidate_introduced_regression` / `REJECT_AND_ROLLBACK` |
| **真机启动审计** | `boot-audit --harness <slot>` | `status=OK`、`verdict_completeness=PARTIAL`、bundle **29/29 ok**、隔离记录 **10 条全为 9/11 且 unresolved=0**、客户端存活 `reload-token -> 200` |
| 审计假阳性回归 | 同一个 audit，把 404 放 `--probe` vs `--module` | probe → `OK`；module → `BOOT_FAILED`（已固化为用例） |
| 记忆：错误结论保留 | `memory-status` 标 `rejected` | 原文一字未改，追加一条状态记录 |
| 反过拟合闸门 | `learning-shortcut` 直接要 `PRODUCTION_SKILL` | `ok=false / would_skip_required_gates`，exit code = 1 |
| 晋升链逐级卡 | `learning-evaluate` 分档喂入 | 1 次验证 → `REGRESSION_TESTED`；3 个不同上下文 → `SKILL_CANDIDATE`；缺 rollback → 不许上生产 |
| **Supervisor 走到底** | `supervise`（合约 3 条全满足 + 闸门过 + 候选已晋升） | `COMPLETED`，4 步，`trace: CONTINUE→CONTINUE→CONTINUE→COMPLETE` |
| **Worker 无法伪完成** | 同一脚本去掉 `candidate_outcome` | `COMPLETE_REFUSED ×4` → `STOP_THE_LINE`（`state=READY_TO_COMPLETE`，**没有**变成终态） |
| **失败不停工** | worker 全部失败 | `stopped=STOP_THE_LINE`，越限项 `self_inflicted_errors 3>2`，8 个强制动作齐全 |
| **没活也不许停** | `decide` 闸门未过且无队列 | `action=CONTINUE / exit_blocked_must_find_next_executable` |
| **七层管线 PASS（真机）** | `verify --root <ws>` + `run_boot_audit` | `PASS`，6 层全 True，boot `OK/PARTIAL`（`unverified=core_service_not_ready`），verdict 绑定指纹并落 `verdicts/` |
| **自动熔断 + 真判废（真机）** | 同上，但换一个缺入口的坏 profile 并传入 `candidate_id` | `BOOT_FAILED`（`two_unrelated_plugins_import_failed`）→ 候选被移进 `rejected/`，`frozen=true`、`can_continue_development=false` |
| 零覆盖指纹防假 PASS | 不传 `extra_files` | `INVALID / fingerprint_degraded_zero_coverage` |
| FAIL 进 Event Bus | `ledger-status` | 管线每次 verdict 都追加进账本（PASS/FAIL/INVALID 均为关键事件） |
| **File Broker 5 类拒绝（真机）** | `file-write` 逐项触发 | ①未读取→`pre:file_read` ②读取后外部改过→`pre:read_hash_still_valid` ③越出允许根→`pre:within_allowed_roots` ④超任务范围→`pre:within_task_scope` ⑤无检查点→`pre:checkpoint_established`；**5 种情况下文件字节未动** |
| **File Broker 真写 + 后置（真机）** | 前置全过 | `ok=true`，`.bak` 保留改动前内容，`dirty=true`，`not_run=[post:type_check, post:target_test]`（不冒充通过） |
| **后置抓语法错** | 写入坏语法文件 | `post:syntax_ok` 失败、文件已写、**bak 可回滚**、零 `tmp` 残留 |
| **跨进程续跑（真机）** | 4 次**独立 CLI 进程**调用 `govern --step-budget 1` | `EXECUTING → EXECUTING → EXECUTING → COMPLETED`，`satisfied` 逐次累积，已满足条目**不重复执行**，`run.json` 记满 4 条 history |
| **心跳可读** | `governor-status` | `state=COMPLETED / is_terminal=true / next_action=DONE / total_steps=4 / contract={"total":3,"done":true,"unmet":[]}` |
| **跨任务事件隔离** | 全局账本里别的任务的 FAIL/BOOT_FAILED | 本任务**不受影响**仍能走到 `COMPLETED`；别的事件原样保留 `unconsumed` |
| **Stable Shield（真机）** | `stable-shield` | 7 个保护面全部存在；`harness.active_slot=0.1.6-alpha.1-…`（来源 `current.json`）；桌面 5 槽同版本 → `active_slot=null` + `ambiguous_version_prefix`（**不猜**） |
| **往真实活动槽写（真机）** | `file-write` 打到 `…\slots\0.1.6-alpha.1-…\__shield_probe__.txt` | `ok=false / stage=preconditions`，失败项含 `pre:within_allowed_roots`；**探测文件未创建**；被保护的关键文件 SHA-256 **前后一致** |
| **触发器跳过重活（真机）** | `watch --once` 连调 | 首次 `RAN`（verdict `PASS`，**1821ms**）；再调 `SKIP / fingerprint_unchanged`（**774ms**，未跑门禁）；改文件后再次 `RAN`（1854ms） |
| **轮询 + 锁 + 哨兵（真机）** | `watch` 3 轮 + `watch-status` | `iterations=3 ran=0 skipped=3 stopped=max_iterations`；锁**已释放**；`total_runs=1 / total_checks=5 / last_result=PASS`；写停止哨兵后 `stop_requested=true` |
| **成本实测** | 计时 | `git status --porcelain` **118ms**；`watch --once` 的 **774ms 地板主要是 Node 进程启动**——高频触发不是免费的，但重活被正确跳过 |
| §28 测试 1 系统级（真机） | `supervise` + worker 脚本（数组形式表达"第一次阻塞、修好后成功"） | `state=COMPLETED stack_depth=1 steps=9`；轨迹 `SUBTASK_OPENED → (子任务两条) → SUBTASK_CLOSED → 重试 sc-1 → p-1 → d-1 → COMPLETE`；`sc-1=2 次`、子条目各 1 次；`resume_point.queued_item_ids=["sc-1","p-1","d-1"]` |
| **§28 测试 14 系统级（真机）** | `file-write` 带 `candidate_id`（白名单 `sub/a.js`，禁 `supervisor`） | 白名单内 `ok=true`；白名单外 `ok=false`（`pre:within_task_scope`）；`supervisor/stable/policy.mjs` 被 **3 条**同时拦（`pre:within_allowed_roots` + `pre:within_task_scope` + `pre:not_forbidden_extra_change`）；被保护文件字节**原样** |
| **§28 测试 10 系统级（真机）** | `proc-spawn` → `proc-stop` 多策略 | CLI 退出后进程**仍存活**（`detached` 生效）；`by_name` 拒绝且进程活着；owner 不匹配拒绝且活着；精确 PID + owner 匹配 → `killed=true waited_ms=4` 进程消失；登记表 `REGISTERED→DENIED→DENIED→REQUESTED→STOPPED`；**零孤儿**（测试前后 node PID 列表完全一致） |
| **§26 控制台（真机）** | `console --root <ws> --task T-CONSOLE --portable <真盘根> --out console.html` | 15 字段全量填充：`goal=生成 UI 最终候选`／`task_state=NEW may_stop=True`／`stable.harness=0.1.6-alpha.1-…`（来源 `current.json`，7 槽）／`stable.desktop=<歧义未猜>`／`candidate=cand-console`／`ws_fp=14348404…`／`last_pass_fp=14348404…`／`pending=p-1,ku-1,d-1`／`假设=cand-console,ku-1`／`verification=PASS`／`processes=pid=22196 owner=T-CONSOLE alive=True`；HTML 5350 字节 |

---

## 6. 验收覆盖（第 28 节 15 项）——**判定层全覆盖**

| # | 验收项 | 测试 | 状态 |
|---|---|---|---|
| 1 | 发现额外问题 → 自动建子任务、修复、验证、回父任务，不等用户 | `t01-t15-tasklifecycle` T1/T1b/T1c | ✅ |
| 2 | 说"下一步处理" → Exit Guard 阻止退出 | `t02-t11-exitguard` T2/T2b | ✅ |
| 3 | 旧 PASS 后改文件 → 失效 + DIRTY + 重验 | `t03-t04-fingerprint-verdict` T3/T3b/T3c/T3d/T4c | ✅ |
| 4 | Watcher 停止 → 同步门禁仍独立运行 | `t03-t04-fingerprint-verdict` T4 | ✅ |
| 5 | Watcher FAIL → Event Bus → VERIFY_FAILED → 禁止完成 | `t01-t15-tasklifecycle` T5/T5b | ✅ |
| 6 | 修 A 引入 B → 冻结、Stable 复现、归因、判废回滚 | `t01-t15-tasklifecycle` T6 | ✅ |
| 7 | 连续两个 Candidate 回归 → Stop-the-Line + 重建方案 | `t07-t08-stopline-family` T7/T7b/T7c | ✅ |
| 8 | 改家族组件 → 扩大到全部同类状态验证 | `t07-t08-stopline-family` T8/T8b–T8f | ✅ |
| 9 | 两个无关插件 import failed → BOOT_FAILED + 回滚 + 禁止逐插件修 | `t05-t09-events-boot` T9/T9b/T9c | ✅ |
| 10 | 模糊查杀 Node → Process Broker 拒绝 | `t10-t13-broker` T10/T10b/T10c | ✅ |
| 11 | 临时探针未删 → Completion Gate 拒绝完成 | `t02-t11-exitguard` T11/T11b/T11c | ✅ |
| 12 | 事故只修代码未加门禁 → 不允许 CLOSED | `t12-t14-candidate` T12/T12b | ✅ |
| 13 | 系统盘写入 → Tool Broker 拦截并重定向 | `t10-t13-broker` T13/T13b/T13c | ✅ |
| 14 | Candidate 改 Supervisor Stable → 拒绝写入 | `t12-t14-candidate` T14 | ✅ |
| 15 | 完整父任务 → 全部目标/验证/清理/打包完成才 COMPLETED | `t01-t15-tasklifecycle` T15/T15b | ✅ |

**⚠️ 口径必须说清**：上面每一条都是**本仓库自己的测试**。`verifier_status` 由 harness / 用户确认，**不由我自称通过**（任务单"权责分离"原文）。

### 6.1 覆盖自查：系统级 vs 判定级（目标轮 9 的对抗性自查结论）

自查发现的最大问题：**Supervisor 原先根本没引用 `taskstack`** —— §28 测试 1 要求"**自动**创建子任务"，
而父子任务栈当时只是个**库**。本轮已把链路接通（见下），其余条目按整合程度如实分类：

| # | 整合程度 | 说明 |
|---|---|---|
| 1 | **系统级（本轮补上）** | `Supervisor` 在 Worker 报 `needs_subtask` 时自动挂起父任务、压子任务、子任务跑完自动回续并重试原条目；嵌套子任务 LIFO 收尾 |
| 3 / 4 / 5 / 11 / 12 / 15 | **系统级** | 指纹绑定、watcher 独立性、事件→状态、Completion Gate、事故门禁、完成守卫都已接进主链路 |
| 9 | **系统级（检测+判废）** | `BOOT_FAILED` → 候选真被判废移入 `rejected/`；但"回滚 Stable"只到 `recovery_plan` |
| 13 | **系统级（经 File Broker）** | File Broker 真的按 allowed/forbidden roots 拒绝；`evaluatePathPolicy` 提供系统盘重定向语义 |
| 2 | **判定级** | `checkDeferredWork` 已实现，但**没有接进任何"发答复"的路径**（Agent 的回复不经过它） |
| 6 | **判定级** | `computeDelta` + `attributeNewDefect` + `rejectCandidate` 齐备；"在 Stable 中复现 B"是流程，不是可执行代码 |
| 7 | **系统级（本轮补上，但尚未触发）** | `evaluateRecoveryConditions` + `executeRecovery`：停线/Boot 失败后可**真的**切回 Stable 指针，留 before/after 指纹与 journal，**不删任何数据**。**真机实测：台账里没有任何 Stable 记录 → 正确拒绝执行**（要可用先得把晋升写进台账） |
| 8 | **判定级** | `validateFamilyGate` / Impact Set 完成屏障齐备，但"自动扩大验证范围"仍需人/Worker 提供成员清单 |
| 10 | **系统级（本轮补上）** | Process Broker **真的会 spawn、登记、停**：只停"在册且 owner 对得上"的精确 PID；`by_name`/`fuzzy`/`commandline_pattern`/`bulk_stop_process` 一律拒绝且**进程毫发无损**；已停止的 PID 永不再动手（防 PID 回收误杀）；`killed` 不谎报（本来就死的进程报 `already_dead`） |
| 14 | **系统级（本轮补上）** | File Broker 自己加载候选并强制 `allowed_files`；候选在场时 `supervisor/stable` **自动**进禁止面；`forbidden_extra_changes` 独立成检查；已判废候选禁止再写；候选未声明 `allowed_files`（空）按**禁止写入**处理 |

---

## 7. 已知缺口（不许当成已完成）

### 7.1 执行层未接入（判定层已具备）

| 缺口 | 现状 | 缺口含义 |
|---|---|---|
| **触发入口已就绪，但没人接线** | `watch --once` 可被任何方式调用（已实测） | 仍需有人把它挂上 git hook / DSH 插件 / 计划任务；**AgentOS 不自行安装触发器**（不擅自动用户的仓库与宿主） |
| Process / Network Broker 未接真实执行 | File Broker 已能真写；进程与网络仍只有判定 | 不能真的停/不停止程、不能真正限制网络 |
| `verify` / `file-write` 未接入 Agent 循环 | 只有 CLI 手动调用 | 每次改动**仍需人手跑**管线（或由上面那个触发器代劳） |
| 回滚 Stable 无执行器 | 只产出 `recovery_plan` | **故意不接**——回滚语义必须先经用户确认 |

### 7.2 未实现的模块

- **Supervisor / Governor 仍不是常驻 daemon**（§3）：`govern` 已能"被反复触发就接着跑"，但**没人触发就不会动**。真正的 Runtime Governor 需要一个外部触发点。
- **触发点未定**：`verify` / `govern` 都只在手动 CLI 调用时执行。挂到 git hook / DSH 插件 / watcher 三选一**需要用户拍板**。
- Skill / Tool 自我开发的**执行侧**（§24）：晋升门已建，但"真的生成并挂载一个 Skill"没接。
- A/B Runtime 的**执行器**：只有判定与流程声明。
- SQLite 实体表（§25）：所有存储都是 append-only JSONL / JSON 文件；`tasks/verdicts/candidates/memory/...` 只有文件形态，没有跨表查询。

### 7.3 其他

- 指纹覆盖范围由调用方声明；零覆盖会判 `INVALID`，但"该声明哪些"仍靠人。
- `tasks/` 三态分目录已实现；`BLOCKED_USER` / `BLOCKED_POLICY` 仍留在 `tasks/active`（任务仍归系统所有）。

---

## 8. 测试纪律

- 用 `scripts/run-tests.mjs` 跑，**不要裸跑 `node --test`**：运行器把子进程 `TEMP/TMP/TMPDIR` 收口到本次运行目录，全绿即删、失败保留现场（`DSH_TEST_KEEP_TMP=1` 强制保留）。
- Node 24 的 `--test` **不接受目录参数**（会当成模块 require），运行器已改为显式展开 `test/*.test.mjs`。
