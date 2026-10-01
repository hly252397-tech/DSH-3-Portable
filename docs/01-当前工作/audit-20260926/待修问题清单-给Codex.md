# 待修问题清单 —— 交给 Codex 执行

> 生成时间：2026-09-26｜生成者：DSH 审核会话（Lead）
> 仓库根：**`G:\DSH-3-Portable`**
> 用途：本文件是**执行任务单**。请按 §0 → §1 → §3 的顺序推进；§2 是已完成项，勿重做（但可用它做交叉核对）。

---

## 0. 先决硬约束（违反任何一条即视为未完成）

1. **门禁 Node 必须与清单一致**：`package.json` 的 `config.bundledNodeSha256[平台-架构]`。
   当前工作区只有 `Tools/node/node.exe`（`v24.21.0`，SHA256 `BA4E6D11…6C32`）命中清单；
   `App/resources/node/node.exe` 是 **`v24.20.0`**（`5C976096…07B5`），**不要用它跑门禁**。
   脚本内请用 `scripts/lib/gate-node.mjs` 导出的 `GATE_NODE`。
2. **先 `tsc` 再 `run-tests`**。`scripts/run-tests.mjs` **不重建 `dist`**；不重建就测会得到"陈旧假绿"（本轮已实际踩过一次）。
3. **禁止原地覆盖 `App/`**（AGENTS.md 红线）。桌面更新/构建只能写 `Data/Updates/Desktop/slots/` 的候选槽。
4. **不得** 删测试、放宽断言、把失败改 `skip`、写死哈希来让门禁变绿。
5. **不要动实机 `Data/` 产物**（profile、运行时槽、桌面槽、`pointer.json`）；测试自己建临时目录。
6. 改 `src/`、`scripts/*.ts`、`package.json`、`App/resources/**` 前，先读
   `docs/03-技术架构/DeepSeek-Harness-插件开发规范知识库.md` 与 `docs/03-技术架构/DeepSeek-Harness-官方兼容基线.md`（AGENTS.md 强制流程）。
7. **本仓库同时有多个写入者**（多个 DSH 会话在改同一工作树，且 545+ 项未提交）。
   动手前先确认目标文件近几分钟没被别人写；**一次只领一个包、独占文件范围**；改完立刻验。

### 门禁命令（照抄）

```powershell
Set-Location G:\DSH-3-Portable
.\Tools\node\node.exe node_modules\typescript\bin\tsc
.\Tools\node\node.exe scripts\run-tests.mjs
.\Tools\node\node.exe scripts\gates.mjs          # 另有三条 lint，见 §4-2（当前既有失败）
```

### 当前已知失败基线（供判断"你有没有引入新失败"）

最后一次全量（**重建后**、用 `Tools/node`）：**705 项 / 676 通过 / 3 失败 / 26 跳过**

| 失败 | 性质 |
|---|---|
| `#99 每个内置插件都钉死精确版本` | **本轮引入** → 见 §0-1 |
| `#619 sidechat imports … real runtime export` | 既有，未定位 → §3-4 |
| `#659 installed UI keeps local plugin links …` | 既有 UI drift → §3-3 |

> 早前还有 4 条内嵌浏览器失败（`#326/327/329/330`），**已由别的会话在途工作修掉**，最新一轮不再出现。

---

## 0-1（阻塞项，最先处理）：`dsh-mcp-connector 0.2.59` 与兼容补丁硬冲突

**问题**：矩阵已把 `dsh-mcp-connector` 从 `0.2.58` 升到 `0.2.59`（`src/bundled-plugins.ts:65`），
但本地兼容补丁**硬性只接受 0.2.58**：

```
scripts/patch-mcp-scope-refresh.mts:39-40
  if (manifest.name !== 'dsh-mcp-connector' || manifest.version !== '0.2.58') {
    throw new Error('This reviewed compatibility patch is for dsh-mcp-connector 0.2.58 only')
```

相关补丁件：`customizations/mcp-connector/connection-scopes-0.2.58.mjs`、`governance-0.2.58.mjs`
（测试 `test/mcp-scope-refresh.test.ts:9,66` 直接按这两个文件名读取）。

**二选一（请明确选一条并在记录里写理由）**：

- **方案 A（推荐，低风险）**：把矩阵回退到 `0.2.58`，并在 `src/bundled-plugins.ts` 该行上方加注释说明
  "补丁按版本硬校验，升 0.2.59 需先重钉补丁"（照 `dsh-automation` 不升 0.1.51 的先例写）。
  同时回退测试期望（见 0-2）。
- **方案 B（高风险，需取证）**：升到 `0.2.59`，同时**逐锚点重钉**两个补丁（对照 0.2.59 实装产物验证每个
  变换锚点仍唯一命中），并把 `patch-mcp-scope-refresh.mts` 的版本门更新为 0.2.59。属独立迭代，不得顺手做。

**验收**：
- 方案 A：`tsc` 0；`run-tests.mjs dist/test/mcp-scope-refresh.test.js` 与 `dist/test/bundled-plugins.test.js` 全绿；`#99` 消失。
- 方案 B：同上，且需一份"锚点在 0.2.59 上逐一命中"的证据（命令+输出）。

## 0-2：测试期望值需与 0-1 的决定保持一致

`test/bundled-plugins.test.ts` 目前被改成了新值，**尚未复跑**：

```
:51   assert.equal(BUNDLED_PLUGINS.find(p => p.packageName === 'dshmarket')?.version, '1.66.1')
:67   'dsh-mcp-connector': '0.2.59',
:68   dshmarket: '1.66.1',
```

- 若选 0-1 **方案 A** ⇒ `:67` 必须退回 `'0.2.58'`；`:51`/`:68` 保持 `1.66.1`（`dshmarket` 的升级是安全的，无补丁依赖）。
- 改完必须**重建 + 复跑**，不能只看上一次结果。

---

## 1. 未闭环的改动（需要补验证或补齐范围）

### 1-1 `src/runtime.ts` 新增的清单交叉校验 —— 需要真实链路验证

**已做**：新增 `verifyBundledNodeAgainstManifest()`，在 `resolveNodeExecutable()` 里对随包 Node
除"旁置 `.sha256`"外**再与"应用自身 `package.json`"的 `config.bundledNodeSha256` 交叉校验**；
清单不可得时只告警不阻断。
**为什么**：旁置 `.sha256` 由同一个二进制生成 ⇒ **只能发现损坏，发现不了错版**（本轮由 Codex 独立复核发现）。

**缺**：只过了单测（`test/runtime.test.ts` 4/4 + 反向对照），**未做真实打包/启动验证**。
按 AGENTS.md「候选槽就绪 ≠ 完成」，需要：构建候选 → 重启激活 → 确认主界面与 DSH readiness 正常、
`Data/Updates/Desktop/state.json` 进 `completed`、`startup-error.log` 零新增。

### 1-2 仍有 7 处硬编码陈旧的 `App/resources/node`

已接入 `GATE_NODE` 的只有 3 个：`scripts/gates.mjs:11`、`scripts/lint-ui-discipline.mjs:31`、`scripts/watch-ui.mjs:18`。

**待改**（全部指向 v24.20.0 的旧树）：

| 文件 | 行 |
|---|---|
| `scripts/diag-profile-web.mjs` | `:14`（node）、`:16`（pnpm，**pnpm 只有这个目录有，需保留 pnpm 路径**） |
| `scripts/diagnostic-web.mjs` | `:46`、`:58`（PATH 前置） |
| `scripts/probe-shadow-start.mjs` | `:25`、`:27` |
| `Install-P3-Tiny-Watch.cmd` | `:4` |
| `Test-P3-Tiny-Watch.cmd` | `:4` |
| `重建技能链接.cmd` | `:21` |

**约束**：`Tools/node` **不含 pnpm**（`pnpm-package` 只在 `App/resources/node` 下）。
⇒ 换 Node 时，pnpm 路径仍取 `App/resources/node/pnpm-package/bin/pnpm.cjs`。

### 1-3 CI 的 Node 版本未被真实验证

`.github/workflows/desktop-package.yml:54` 与 `:218` 已从 `24.20.0` 改为 `24.21.0`（**未提交**）。

**背景**：CI **不跑** `Build-DSH-Portable.ps1`（`含 Build-DSH-Portable: False`），所以没有"把 `Tools/node` 前置到 PATH"这一步；
它直接 `pnpm run prepare-runtime`（定义：`pnpm run build && node dist/scripts/prepare-runtime.js`），
用 setup-node 提供的 Node。而 `scripts/prepare-runtime.ts:163-169` 强校验
`process.version === config.bundledNodeVersion`（`v24.21.0`）、`:178-179` 再校验 SHA256。
**⇒ 改动前 CI 在该守卫处必然抛错；改动后应在 CI 上方可通过——但未实跑验证。**

**要求**：给出一份"本地以 `Tools/node` 跑通 `prepare-runtime` 版本+SHA 守卫"的证据
（可只跑到守卫通过即止，**不要**真跑完整装配以免触发 G: 盘大批量删除）。

### 1-4 `scripts/run-tests.mjs` 跨进程互斥 —— 长时并发未验证

已加 `run-tests.lock`（原子创建、持有者进程已死即接管、等待默认 5 分钟可配、超龄兜底 2 分钟、`DSH_TEST_NO_LOCK=1` 可跳过）。
四条路径已实测（死锁接管 2.1s / 活锁等待 / 超时干净报错 / 正常路径无残留）。
**缺**：长时间、多会话真实并发下的稳定性；另需评估"默认 5 分钟等待窗口撞上超长测试"会不会误报超时。

---

## 2. 已完成（勿重做，可交叉核对）

| 包 | 内容 | 证据 |
|---|---|---|
| P-A | `src/runtime-slots.ts`（静默回退改为可观测、指纹缺失不再伪造全零并落盘）、`src/process-control.ts`（`terminateProcessTree` 改为等待进程树 + 超时） | 专项 8/8 + 3/3；反向对照 |
| P-B | `src/harness-runtime-candidate.ts`（lockfile 来源白名单补 `https://`；复用分支改比槽内指纹）、`src/session-path-repair.ts`（失败不删备份 + 备份幂等 + 单会话失败不外抛）、`src/runtime-prebuilt.ts`（完成标记 + 残缺目标真实修复）、`src/atomic-file.ts`（失败保留唯一副本） | 专项 18/18；反向对照 |
| P-D | 文档 24 处（`docs/00-交接入口` 6 个、`docs/03-技术架构` 4 个、`docs/05-系统认知` 8 个），含 bundles 表整体重建、D-18 `keepUnreferencedSlots=0` 修正、新增家园代际数据流章节 | 自检通过、编码 U+FFFD=0 |
| 其他 | `dshmarket 1.65.1→1.66.1`；`src/feature-panels.ts` P49–P53 版本号订正；`AGENTS.md` 门禁命令改 `Tools/node` + 更正说明 | — |

---

## 3. 审核发现的遗留缺陷（按优先级）

### 3-1 工作区 `App/resources/node` 是 1.0.43 旧构建树的快照

**证据**：`App/resources/app.asar` 自述 `version=1.0.43`、`bundledNodeVersion=v24.20.0`、哈希 `5C976096…`，
与其 `node.exe` 及旁置 `.sha256` **完全自洽**；而 `package.json`/`Tools/node`/`runtime-node`/两个部署槽均 `v24.21.0`。
`App/` **不在任何构建链上**（`prepare-runtime` 产物是 `runtime-node`，`package.json` 的 `extraResources` 也指向 `runtime-node`），
没有任何脚本写 `App/`（只有读取方：`Start-DSH-Portable.ps1:405,412-414` 的 legacy 回退）。

**修法**：必须走**完整构建**（`Build-DSH-Portable.ps1`）重新装配；**禁止原地覆盖 `App/`**。
另注意：该旧树**内部自洽**，所以 §1-1 的交叉校验按"应用自身清单"判定**会放行它**——这是**有意的**
（旧而完整 ≠ 坏；拿它比仓库根清单会把合法回退路径 Brick）。

### 3-2 `dsh-better-sidebar` 三处互相矛盾

| 位置 | 值 |
|---|---|
| `src/bundled-plugins.ts:64`（矩阵条目） | `0.21.1` |
| `src/bundled-plugins.ts:37-38`（**同一文件注释**） | "版本仍锁 `0.18.0`；升到上游的 `0.19.1`…" |
| `Data/DSH/profiles/web/local/dsh-better-sidebar/package.json`（**实际安装**） | `0.18.0-alpha.0` |

**需要**：裁定"以 `link:` 分发的本地定制件在矩阵里该写什么"，并让注释与条目一致；注释里的"上游 0.19.1"也已过期（矩阵是 0.21.1）。

### 3-3 UI drift 失败（`#659`）

```
UI drift: Data/DSH/profiles/web/local/dsh-better-sidebar/lib/client.js
UI drift: Data/DSH/profiles/web/local/dsh-better-sidebar/portable/browser-view.js
```
产品文件在基线记录（`customizations/ui/baseline.json`，18:53）**之后**被改（19:12 / 19:37），基线未跟上。
**这是他人会话的在途工作** ⇒ 先查归属；**不要替它 `--record` 背书**。

### 3-4 `#619 sidechat imports must be a real runtime export`

既有失败，未定位。需要找出是"运行时导出确实缺失"还是"测试期望过期"。

### 3-5 `test/dsh-process.test.ts` 全量并行下偶发

`fixtureStartupTimeoutMs = 3_000`（`:94`）。全量并行负载下子进程冷启动 + 就绪轮询可超 3 秒而失败；
**隔离跑 3 次全绿（11/11）**。生产侧超时是 120 秒 ⇒ **不是产品缺陷**。
**不要用"直接调大超时"糊过去**（会掩盖真问题）；要么把它做成可配置并说明依据，要么登记为已知偶发。

### 3-6 `src/main.ts` 的会话自愈调用点未包 try/catch

`src/main.ts`（`repairMisplacedSessionLogs` 调用处，约 `:1026-1038`）依赖"该函数内部不再抛错"这一约定。
若将来有人让它重新抛错，启动路径会崩。建议在调用点补兜底，或在函数文档注释里把该约定写成硬约束。

### 3-7 `prepare-runtime.ts` 版本守卫的双来源问题

`scripts/prepare-runtime.ts:163-169` 强校验 `process.version === bundledNodeVersion`。
本地靠 `Tools/node`（`Build-DSH-Portable.ps1:10-23` 按清单哈希校验并自愈），CI 靠 setup-node。
两条来源都要满足同一版本 ⇒ 当前只改了 CI 侧；需确认没有第三条路径（例如文档里让开发者用别的 Node）。

### 3-8 登记册 `R-01～R-168` 的绝大多数仍未修

见 `docs/01-当前工作/audit-20260926/问题总登记册.md`。
本轮只覆盖了 R-013/14/15/16/17/18/19 + R-119~122 等一小部分。**这是最大的一块 backlog。**

### 3-9 `docs/01-当前工作/**` 142 份历史记录含过期内容

按"不改写历史"原则**有意未动**；但其中 2 份的插件编号已过期（已知项）。

### 3-10 `scripts/ui-baseline.mjs --record` 既有缺陷

早前会话发现：`--record` 会抛错/卡住，导致漂移无法重新记录基线。未修。

---

## 4. 工具与口径（防再踩）

### 4-1 `run-tests.mjs` 不重建 `dist` ⇒ 陈旧假绿

建议加守卫：若 `dist/` 比 `src/` 或 `test/` 旧则**直接报错**（而不是静默用旧产物）。
本轮实证：改矩阵后未重建就跑，得到 9/9 假绿；重建后立刻暴露 `#99`。

### 4-2 `scripts/gates.mjs` 的三条 lint 当前是既有失败

最新实测（**两个 Node 结论一致**，故与 Node 无关）：

```
lint-ui-discipline       FAIL (11/13)   探针数据新鲜（≤600s）实测 ~84000s
lint-plugin-deps         FAIL (4/6)     同一核心包的 peer 声明一致
verify-adaptive-layout   FAIL (4/8)     探针数据新鲜（≤120s）实测 ~84000s
```

判据：`scripts/lib/gate-node.mjs` 能正确选中 `Tools/node`（哈希 `BA4E6D11…` 命中清单）。
若你改完仍见同样 FAIL，属既有问题，不算你引入。

### 4-3 门禁 Node 的权威口径

- 权威值：`package.json` → `config.bundledNodeSha256[<platform>-<arch>]`
- 命中者：`Tools/node/node.exe`（`v24.21.0`）
- 脚本内：`import { GATE_NODE } from './lib/gate-node.mjs'`
- 需要 pnpm：`App/resources/node/pnpm-package/bin/pnpm.cjs`

---

## 5. 附录：关键事实速查

| 项 | 值 | 出处 |
|---|---|---|
| 桌面版本 | `1.0.76` | `package.json` |
| 内置 DSH | `0.1.7-rc.2`（npm `next` 最新；`latest=0.1.5-rc.3`） | `config.bundledDshVersion` / `OFFICIAL_DSH_VERSION` |
| 活动 Harness 槽 | `0.1.7-rc.2-4d29c691bfdf224c`（回滚目标 `0.1.6-alpha.2`） | `Data/Runtime/Harness/current.json` |
| 家园代际 | `v4-rc2b` → `Data/DSH-generations/v4-rc2b/home` | `Data/Updates/Harness/homes/0.1.7-rc.2.json` |
| 桌面槽 | current `1.0.76-local-3cfc4743bb8d1fff` | `Data/Updates/Desktop/pointer.json` |
| 随包插件矩阵 | **15 项**，唯一事实源 `src/bundled-plugins.ts` 的 `BUNDLED_PLUGINS` | 代码 |
| Node 权威 | `v24.21.0`（= Node 官方最新 LTS "Krypton"），哈希 `BA4E6D110E8C1592A1ECD390F6B05F3DA124B13871A5BE62B341A07A853C6C32` | `package.json` + nodejs.org `SHASUMS256.txt` |
| 旧的 Node 副本 | `App/resources/node/node.exe` = `v24.20.0` / `5C976096E04E5C2C1F091938926234CC9FBEBFE9787DDD149351B3B0ECC707B5`（属 1.0.43 旧树，内部自洽） | 实测 |

### 相关文档

- `docs/01-当前工作/audit-20260926/问题总登记册.md` —— 主登记册（R-01～R-172）
- `docs/01-当前工作/audit-20260926/本轮修复清单.md` —— 本轮已修项
- `docs/01-当前工作/audit-20260926/P-A-执行记录.md` / `P-B-执行记录.md` / `P-D-执行记录.md`
- `docs/01-当前工作/audit-20260926/Codex-独立验证-Node版本分裂脑.md` —— Codex 上一轮独立复核（CONFIRMED）

---

## 6. 【新发现·最高优先级】`Data/Runtime/Packaged` 内容寻址缓存**无保留策略**（46 GB 级）

**现象**：G: 盘一度用到 98.5%（220.1/223.6 GB，仅剩 3.45 GB）。头号元凶是
`G:\DSH-3-Portable\Data\Runtime\Packaged` = **48.47 GB / 224 万文件 / 106 个目录**。

**根因（已实读代码复现）**：`src/extract-runtime.ts:79-89`

```ts
const installDir = join(resolve(runtimeRoot), 'Packaged',
                        `${officialDigest.slice(0,16)}-${storeDigest.slice(0,16)}`)
```

键 = `<dsh-runtime.tgz.content-sha256 前16>-<plugins-store.tgz.content-sha256 前16>`
（`readArchiveVersion` → `readDigestFile`，回退 `.sha256`）。

- 设计意图（代码注释）：「让每个不可变归档对有独立缓存，候选无法污染活动运行时」——**意图正确**；
- 但 `preparePackagedRuntimeCacheInChild`（`:96-115`）**只创建、只校验，没有任何 prune/retention**；
- 每次 `dsh-runtime.tgz` 或 `plugins-store.tgz` 的摘要变化（构建/更新/换运行时）就**新增一份 0.4–1.2 GB**；
- 实测 106 份跨 2026-09-04 → 09-28（24 天），**只增不减**。

**为什么危险**：这不是"垃圾文件"，是**无限增长的缓存**——只要持续构建/更新，它会一直吃掉磁盘，
且**没有任何启动检查或门禁会发现它**。

**建议修法（供 Codex 评估）**：
1. 在 `preparePackagedRuntimeCacheInChild` 或 `resolvePackagedRuntimeCache` 之后加**保留策略**：
   只保留「被引用的键」（当前运行应用的 `resources` 摘要对）+「最近 N 个」或「M 天内」，
   其余走既有 `Data/Temp/prepare-recycle` + 后台清理器机制（**不要用同步 `rm`**）；
2. 引用判定要覆盖：`pointer.current` / `previous` / `pending`、`transactions/*/app/resources`、
   `App/resources`（legacy 回退）、`release/win-unpacked/resources`；
3. 加一条**测试**：构造 N 个摘要对 → 断言保留策略只留该留的；
4. 考虑加"缓存总量上限"并在超限时告警（当前无任何可见性）。

**本轮已执行的处置（一次性，非根治）**：
- 穷尽搜索全仓含该 sidecar 的 resources 目录，确定**被引用的 5 个键**：
  `a03172b9a39a3e5e-c295526a38332f67`（current + release）、
  `11c45d1041f59ff2-90465033dd06a6fa`（previous 回滚目标）、
  `549d21ad846400d0-ca6126a4b076e566`（transactions/756f43cb 的 app）、
  `dcf9cdc571c0f765-925a5b57a85802d6`（diagnostics/artifacts 证据）、
  `dcf9cdc571c0f765-b69bb40d3a43ed28`（isolated-qoder-build 证据）；
- 其余 **101 个**已按仓库既有机制移入 `Data/Temp/prepare-recycle`（同卷 rename，O(1)），
  由脱离进程的后台清理器逐个真实删除（约 39ms/文件 ⇒ 2.24M 文件需数小时~一天，空间**渐进释放**）；
- 处置日志：`Data/Temp/packaged-gc-20260928.log`；脚本：`Data/Temp/gc-packaged.mjs`（一次性）。

**⚠ 给 Codex 的注意**：`Packaged` 是**内容寻址缓存**，缺失时
`packagedRuntimesNeedExtraction()` 返回 true 并**自动重新解压**，所以删除未引用项**不会**造成故障
（最坏是多一次解压）。但**绝不要删正在运行实例使用的那一份**（即 `pointer.current` 对应的键）。