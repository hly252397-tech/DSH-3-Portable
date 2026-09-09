# DSH 便携版 3：源码更新系统方案（源码 → 可信制品 → 便携盘）

状态：**P0 部分已实施（2026-09-09）；其余待评审实施**
编写日期：2026-09-09（Asia/Shanghai）
关联文档：[DeepSeek-Harness-企业级自动更新方案](DeepSeek-Harness-企业级自动更新方案.md)（状态机、目录契约、故障合同以该文档为准，本方案不改变它们）、[桌面启动器架构基线](00-桌面启动器架构基线.md)、[官方兼容基线](DeepSeek-Harness-官方兼容基线.md)

**实施进度（2026-09-09）**：已落地三项 P0——① 更新源抽象 `PortableDesktopReleaseSource`（`src/portable-desktop-update.ts`，API/资产域/制品名去硬编码，非法配置回退默认源）；② 缺便携契约的上游新版本进入独立 `incompatible` 阶段（设置页琥珀色「已阻止」徽标 + 诊断信息 + 托盘说明项，不再渲染成红色「更新失败」；出现合规 Release 后自动恢复正常流程）；③ `prunePortableDesktopSlots` 槽位与下载缓存回收（健康提交与本地构建暂存两个提交点触发；指针引用槽永保留；未引用槽默认保留最近 3 个；审计写 `events.jsonl` source=slot-gc）。验证：tsc 全绿，406 项测试 0 fail（含更新器 9 项新场景）。origin 远端、独立版本线、契约签名、灰度策略与故障注入矩阵仍待实施。

**真机证据（2026-09-09 晚，事件链来自 `events.jsonl`）**：23:06:11 上游 1.0.51 无契约 → `incompatible`（已阻止）而非 error，当前槽不受影响；23:58:13 本地构建 1.0.51 经真实启动器（双击 `DSH便携版3.exe`）完成槽切换与健康提交 → `completed`；23:58:17 slot-gc 自动回收 1 槽；23:58:28 启动后自动检查上游 latest=1.0.51=当前版本 → `none`「已是最新」。`startup-error.log` 无新增（存量一行错误为 2026-09-08 遗留）。三项 P0 全部在用户真实便携盘上闭环验证。

**上游同步进度（2026-09-09）**：流 A 首轮完成——`merge -s ours v1.0.51` 认祖（此后 merge-base 恒为 v1.0.51，历史包袱清零），内容增量按组吸收：移植 v1.0.50 子代理未读修复；版本对齐 1.0.51、electron 44.1.1。恢复模式硬化系列经审阅**不移植**（与便携自研桥接闭包架构冲突，属 2026-09-04 集成时的既定决策）；桌面宠物、Mica、插件矩阵批量升级暂缓。自此上游发布新版（>1.0.51）时，更新器将其识别为「已阻止」而非红色失败，源码侧按本方案流 A 周期性审阅合并。

## 0. 一句话结论

便携版的更新系统已经建成"下半场"：**任何制品（官方 Release ZIP / 本地构建）都经过同一套不可变槽 + 清单哈希 + 健康提交 + 自动回滚管道**。"完美的源码更新系统"不需要重写它，而是补齐"上半场"——把**源码的三个来源**（上游官方源码、本仓库定制源码、CI 发布渠道）全部接入这条管道，并封住四个缺口：**自有发布渠道、发布者签名、槽位回收、故障演练**。

## 1. 设计原则（继承现有铁律，不新增例外）

1. **源码永远不直接触碰便携盘**。任何源码变更必须先变成"经过验证的制品"（签名的 Release ZIP，或通过门禁的本地构建槽），再走同一条 A/B 管道。旧式"下载 ZIP → 覆盖文件 → 事后打补丁"（已删除的 `Update-DSH-Portable.ps1`、`Update-Portable-Files.ps1`、`deploy-new-build.ps1`、`Customize/After-Update.ps1`）永久禁止复活。
2. **一个用户入口、两个事务协调器**：桌面协调器管桌面制品，Harness 协调器管官方运行时，插件走 Profile 事务。三者互不越界。
3. **绝不原地覆盖 `App/`**：只写 `Data/Updates/Desktop/slots/` 不可变候选槽；切换由外部启动器在正常退出后执行，失败自动回滚。
4. **官方兼容双基线**：上游源码更新必须先人工审阅官方变化（`verify-dsh-official-baseline.mjs --online`），禁止自动接受后继续开发。
5. **验收原则**："自动更新"= 自动完成检测、获取、验证、候选构建、受控切换、健康确认、失败恢复；不能证明"当前版本仍可启动、用户数据未受影响、失败可回滚"的路径不得进入统一入口。

## 2. 三条源码流，汇入同一条管道

```text
流A 上游官方源码          流B 本仓库定制源码            流C 官方稳定 Release
   │ 人工审阅+合并            │ commit + 构建               │ 契约+SHA256 门禁
   ▼                         ▼                            ▼
   └────────────┐   ┌────────┘                            │
                ▼   ▼                                     │
          Build-DSH-Portable.ps1                 桌面更新器（检测/下载/验证/预热）
          （tsc + 测试 + electron-builder）                │
                │                                        │
                └────────────┬───────────────────────────┘
                             ▼
              不可变候选槽 slots/<version>-<digest>
                             ▼ pending 指针（健康预热通过后才写入）
                正常退出 / 「重启应用」→ 外部启动器
                             ▼
              复验清单 SHA256 → 启动候选 → 心跳租约
                             ▼
              DSH readiness + health.json 提交 ──失败──▶ 自动回滚旧槽
```

### 流 A：上游官方源码同步（开发者侧，git 层面）

- 现状：`Sync-Upstream-Source.ps1` 已删除。它只做 `fetch upstream --tags` + 脏树拒绝 + `merge --ff-only`，一旦定制线与上游分叉即失效，属于已知淘汰方案。
- **正确方法：分支模型 + 审阅式合并，不追求自动化**：
  1. `main` 永远是定制发布线（tag 的唯一来源）；上游落在 `upstream/main`。
  2. 同步时按 AGENTS.md 双基线流程执行：`git fetch upstream --tags` → 运行 `App/resources/node/node.exe scripts/verify-dsh-official-baseline.mjs --online` → **人工审阅**官方 `AGENTS.md`、架构、测试规范和受影响子系统 → `git merge upstream/main` 手工解决冲突。
  3. 冲突面是收敛的：本仓库定制集中在 `src/`、`assets/`、`browser-library.cjs`、`launcher/`、启动/构建脚本、`Data/DSH/profiles/**` 插件、`desktop-package.yml`、`package.json`；其余文件原则上跟上游。
  4. 合并结果不是交付物：必须走流 B 的完整门禁（类型、测试、打包、A/B 部署、双击启动验证）才能宣称同步完成。
- 辅助脚本（可选，P2）：提供 `scripts/sync-upstream.ps1` 固化上述步骤为"检查模式 + `-Apply` 合并模式"，但**不做任何自动冲突解决**——与被删脚本的区别是允许非 ff 合并并把基线核对嵌入流程。

### 流 B：本仓库源码 → 本地构建（最短路径，已实现，日常主路径）

现状（`events.jsonl` 全部记录来自 `stageLocalDesktopBuild`，即当前实际迭代方式）：

1. `git commit` 定制改动；
2. `powershell -NoProfile -ExecutionPolicy Bypass -File Build-DSH-Portable.ps1` —— 完成 tsc + Node 测试 + electron-builder 打包 + 候选暂存，**不覆盖正在使用的 `App/`、不结束桌面进程**；
3. 从托盘正常退出或点「重启应用」→ `Start-DSH-Portable.ps1` 切换候选、复验清单、健康提交，失败自动回滚；
4. 验收：`Data/Updates/Desktop/state.json` 达到 `completed`，`Data/Electron/UserData/startup-error.log` 无新增。

完善点：
- **版本线治理（P0）**：本地构建版本为 `<上游版本>-local-<sha16>`（如 `1.0.46-local-178f0b5b95798f45`）。建议定制版引入独立版本线（见流 C），避免与官方版本号语义混淆。
- **槽位与缓存回收（P0）**：当前 `portable-desktop-update.ts` 没有任何 prune/GC，`slots/` 已积累 27 个候选（数 GB 级）。需新增保留策略：始终保留 `current`/`previous`/`pending` 引用的槽 + 最近 N 个成功槽，LRU 回收其余槽与 `downloads/` 缓存；回收只在无活跃事务时执行，写 `events.jsonl` 审计。

### 流 C：自有发布渠道（本仓库源码 → CI → GitHub Release → 自动更新）——最大缺口

现状与问题：

- CI（`desktop-package.yml`）已能在 tag 上构建全平台制品并用 `create-portable-release-contract.mjs` 生成便携兼容契约（`dsh-portable-contract-<version>-win-x64.json`），随 ZIP 一起 `gh release create`。
- 但桌面更新器把更新源**硬编码为上游** `MichengAI/dsh-codex-desktop`（`src/portable-desktop-update.ts:593` 的 API URL 与 `:670-676` 的 `trustedReleaseAssetUrl` 允许域两处），且本仓库 `git remote` 只有 `upstream`、没有 `origin`——**本仓库 CI 构建的制品目前没有自动分发路径**，定制版只能靠流 B 手动构建。

补齐方法（按序）：

1. **建立 origin 远端与发布 tag 纪律（P0）**：`git remote add origin <自己仓库>`；tag 命名 `v<便携版本>`，推 origin 触发 release job。发布前要求工作树干净、`Build-DSH-Portable.ps1` 本地全绿。
2. **更新器支持受信多源（P0）**：
   - 把发布仓库从常量改为**构建期注入、运行时锁定的更新源配置**（编译进制品，不做用户可改的任意 URL，防止供应链攻击面扩大）；
   - 允许域列表按源逐条配置（API、资产下载域）；自有源为第一优先，上游源可作为只读对照或禁用；
   - 契约增加 `source` 字段区分制品来源，禁止跨源版本号混排。
3. **独立版本线（P0）**：`fetchLatestRelease` 以 `compareReleaseVersions(version, currentVersion) <= 0` 判新（`portable-desktop-update.ts:615`），且版本必须匹配纯 `x.y.z`。若自有渠道沿用上游版本号（1.0.46），与官方 Release 会互相"看不见"或误判新旧。定制版应使用独立递增版本线（例如以 `3.x.y` 呼应"便携版 3"），契约与状态机无需改动。
4. **发布者签名（P1，企业级门禁第 1 项）**：契约目前仅靠 GitHub 资产 SHA256 自证。升级为 minisign/cosign 签名：CI 用私钥签契约，客户端内置轮换公钥验签；GitHub 摘要降级为完整性校验而非身份证明。密钥轮换与双人复核流程随 P2 一并定义。
5. **灰度与策略（P2，企业级门禁第 2 项）**：prerelease + 稳定 tag 两级灰度；客户端策略已有 `notify | auto-download | manual`（`userData/desktop-update-settings.json`），补暂停/恢复、跳过版本、维护窗口、最低版本强制。

### 流 D（正交，不改）：Harness 官方运行时更新

npm alpha dist-tag 与 GitHub 不可变 tag/commit 交叉核对 + 影子启动 + 空闲门禁 + 只重启 DSH + 5 分钟观察 + 自动回滚，已独立成协调器（`src/harness-update.ts`、`src/runtime-slots.ts`）。它与桌面源码更新正交，本方案不动；上游 DSH 版本变化仍走它 + AGENTS.md 双基线审阅。

## 3. 端到端状态与不变量（引用，不重复定义）

阶段、目录契约、故障恢复合同、UI 六阶段以 [企业级自动更新方案](DeepSeek-Harness-企业级自动更新方案.md) 第 3-5 节为准。本方案额外强调两条不变量：

- **预热先于 pending**：候选共享环境预热失败不得写入 pending（现有行为，改造任何源时不得破坏）；
- **状态单一事实源**：UI、`state.json`、`events.jsonl` 由同一状态转换生成，新增更新源后仍不得让 UI 自行推断"完成"。

## 4. 工程清单（按优先级）

| 优先级 | 事项 | 涉及位置 | 验收 |
|---|---|---|---|
| P0 | origin 远端 + 首个 tag 发布，验证 CI 产出 ZIP + 契约 | `desktop-package.yml`（已具备）、git remote | Release 页面出现契约资产且字段完整 |
| P0 | 更新源配置化（API/资产域两处硬编码） | `src/portable-desktop-update.ts:592-676` | 自有源可检测、可下载、可入槽；上游源按配置禁用/对照 |
| P0 | 独立版本线（x.y.z 纯格式） | `package.json` version、契约脚本 | 自有 Release 版本 > 当前版本时可正常触发更新 |
| P0 | 槽位与下载缓存 GC（保留 current/previous/pending + 最近 N） | `src/portable-desktop-update.ts` 新增 prune + 测试 | 槽数量收敛、审计事件落盘、活跃事务期间不回收 |
| P1 | 契约 minisign/cosign 签名 + 客户端内置公钥 | CI release job、契约脚本、`portable-desktop-update.ts` 验签 | 篡改契约/ZIP 被拒；轮换演练一次 |
| P1 | 同步辅助脚本 `scripts/sync-upstream.ps1`（检查 + 审阅式合并） | 新增 | 脏树拒绝、基线核对嵌入、不自动解决冲突 |
| P2 | 管理 UI：暂停/跳过版本/维护窗口/灰度组 | 设置页 IPC + `desktop-update-settings.json` | 三项对齐门禁 + 真实链路证据 |
| P2 | 故障注入矩阵 + 实机演练（断网、磁盘满、截断、篡改、崩溃循环、断电、盘符变化） | 测试 + 审计报告 | 每项故障行为符合第 5 节故障合同，报告归档 |
| P2 | SBOM、漏洞扫描、制品保留/撤回、密钥轮换、更新成功率指标 | CI + 遥测 | 企业级投产门禁第 5/6 项闭合 |

P0 完成后即得到"完美闭环"的最小形态：**上游源码（人工审阅合并）→ 本仓库源码 → tag → CI 签名契约 Release → 便携版自动检测/下载/验证/入槽 → 正常重启切换 → 健康提交/自动回滚**，同时本地构建路径继续作为开发迭代快车道。

## 5. 与已删除旧系统的对照（为什么旧路不可回退）

| 旧方案 | 缺陷 | 新系统对应物 |
|---|---|---|
| `Sync-Upstream-Source.ps1`（ff-only 合并） | 分叉后永久失效；无基线审阅 | 流 A：审阅式合并 + 双基线脚本 |
| `Update-DSH-Portable.ps1`（下载上游 ZIP 覆盖） | 原地覆盖、无回滚、丢失定制 | 流 C：契约门禁 + 不可变槽 + 回滚 |
| `Update-Portable-Files.ps1` / `deploy-new-build.ps1` | 双写、绕过门禁、运行中覆盖 | 流 B：`Build-DSH-Portable.ps1` 候选暂存 |
| `Customize/After-Update.ps1`（更新后钩子） | 更新后二次变异，不可审计 | 定制进源码，经构建固化进制品 |

## 6. 验收原则

引用企业级方案第 9 节原文并同样适用本方案：任何不能证明"当前版本仍可启动、用户数据未受影响、失败可回滚"的路径，不得进入统一更新入口。P0 各项落地时须按 AGENTS.md 强制验证（tsc + Node 测试 0 fail、重新打包 + A/B 候选部署、双击启动端到端验证）并保存证据。
