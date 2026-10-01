# 审核单元 G 取证报告（Data/ 状态与配置面）

> 来源：穷尽式只读审核单元 G（子代理会话），2026-09-26。本文是**证据留档**，未修改任何文件。
> 索引见 [全项目审核总报告](../便携版3-全项目审核总报告与修复清单.md)。
> 范围：`Data/` 的状态与配置面（不深挖海量会话数据，只抽查代表样本）。

## 一句话结论

**版本链（`1.0.76` / `0.1.7-rc.2` / `v4-rc2b` / 指纹）自洽，但"状态面"已经不干净**：桌面端两个不可变槽**都过不了完整性校验**（槽清单里的 `dsh-runtime.tgz.content-sha256` 与同目录实装值不一致），启动器从 09-26 12:21 起**每次启动都回退或扫槽恢复**；同时存在**两个平行家园**（现役 = `Data/DSH-generations/v4-rc2b/home`，`Data/DSH` 已冻结）、明文密钥两份、38 处 `.bak`、多个孤儿目录（含一个使 rg 整体失败的断链）。

## 🔴 Findings

| # | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| G-F1 | `launcher.log:2126-2234`、`startup-error.log:1`、`Desktop/state.json:3-4` | **桌面端两槽完整性校验持续失败，启动器反复回退/扫槽恢复**（现役可能不是不可变槽，或每次启动都走异常路径） | 12:12 `pointer.current 未通过完整性校验` → 12:21 起 `pointer.current` 与 `pointer.previous` 双双失败 → `无可用不可变桌面槽，回退 legacy App（其中 dsh-runtime 可能落后于清单版本）`，此后 12:33/13:27/14:34/15:45 反复出现；同槽 `resources/settings.html` 加载 `ERR_FAILED (-2)`；而 `state.json` 仍写 `phase:none / 已是最新版本` | 以槽清单→文件哈希为线索定因（见 G-F2），重建一个干净候选槽再让用户重启；**不要手改 `pointer.json`** |
| G-F2 | `slots/1.0.76-local-3cfc4743bb8d1fff/slot-manifest.json:11` vs `…/resources/dsh-runtime.tgz.content-sha256:1`；旧槽同理 | **槽清单声明的 content-sha256 与实装文件不一致**（很可能是 G-F1 的根因） | 清单声明 `33998bb31b5656508557c11f70181dc8f84e4d4e779d483205187eacd15e24d6`；实装文件 = `11c45d1041f59ff240f357e08dfbf6b06145b512672b6e6ea93c96d93bb3497a`。**两个槽的清单都写同一个 `33998bb3…`，两个槽的实装文件都写 `11c45d10…`**（主会话实读确认）。对照：`.tgz.sha256` 与清单**逐槽一致** ⇒ 失配的是清单里的 content-sha256，而非 tgz 损坏 | 让构建在打包后重写清单，或校验时以 `.content-sha256` 为准；修好后走一次正常 A/B 暂存 |
| G-F3 | `Data/DSH/storages/workspace.json:65` vs `Data/DSH-generations/v4-rc2b/home/storages/workspace.json:73`；两份 `agent-bridge.json:1` | **两个家园并存且状态分叉，现役是 generation home，`Data/DSH` 已冻结** | 冻结家园 `updatedAt 2026-09-25T14:44:26Z`（正好停在运行时提交 `Runtime/Harness/current.json:14 committedAt 2026-09-25T14:56:37Z` 之前）；现役家园 `updatedAt 2026-09-26T08:21:25Z`。`agent-bridge` 同 URL 不同 PID/令牌：`75228 / d4bbaf4f…`（冻结）vs `75744 / b878e043…`（现役） | 明确唯一活动家园；冻结家园整体归档或打标，避免"改了不生效 / 双份状态互相覆盖" |
| G-F4 | `Data/DSH/.credentials.yaml:7-14` 与 `Data/DSH-generations/v4-rc2b/home/.credentials.yaml:7-14` | **明文凭据两份**（非已知清单项） | 两份内容完全相同：`DEEPSEEK_API_KEY: sk-f3d8b3e9…`、`ZAI_CODING_CN_API_KEY`、`QWEN_TOKEN_PLAN_CN_API_KEY: sk-sp-H.DLYLEX…`、`SENSENOVA_API_KEY`、`XIAOMI_TOKEN_PLAN_CN_API_KEY: tp-ccjllvtl…`、`OLLAMA_LOCAL_API_KEY`（占位），外加 `client-connection/browser-session` 的 grant `secret: kYFO39jXqQ66…` | 只保留现役家园一份；历史副本清除/加密；便携盘可能被复制或整包发布 ⇒ **视同已暴露，建议轮换** |

## 🟠 Findings

| # | 位置 | 问题 | 证据 |
|---|---|---|---|
| G-F5 | `plugin-update.log:1`；`…/home/profiles/web/node_modules.broken-20260925-234407/` | **跨家园 symlink + 孤儿 `.broken` 目录 + `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`** | pnpm 原文：generation home 的 `node_modules` "are currently symlinked from the virtual store directory at `G:\DSH-3-Portable\Data\DSH\profiles\web\node_modules\.pnpm`"，要求 reinstall 到它自己的 `.pnpm`；`.broken-*` 内 `dsh-custom-spaces` 是**断链**（rg `os error 2`，使整棵 `v4-rc2b` 无法被 rg 枚举） |
| G-F6 | 两处 `settings.yaml` 均不存在；`Data/DSH/settings.yaml.imported:1-264`；`profiles/web/cordis.patch.yml` | **现役配置层没有 `settings.yaml`，patch 只覆盖一半 section** | `settings.yaml.imported` 的 section：`ui-onboarding / llm-pi-ai / agency-agents / agent-default-model / ui-theme / dsh-better-sidebar / work-mode / custom-spaces / ui-usage-billing / permission`；patch 只有 `llm-pi-ai / agency-agents / agent-default-model / ui-theme / permission` + 2×desktop-bridge insert ⇒ `dsh-better-sidebar`（含 `defaultWidthPercent:42`、`browserNoSandbox:true`、`workspaceFence:false`）、`work-mode`、`custom-spaces`、`ui-usage-billing`、`ui-onboarding` **在现役配置里没有落点** |
| G-F7 | `settings.yaml.imported:246-247,250` | **危险默认值（新项）** | `dsh-better-sidebar: browserNoSandbox: true` + `browserInterceptHttps: true`（内嵌浏览器**关沙箱且拦截 HTTPS**）；`:250 workspaceFence: false`（工作区围栏关闭） |
| G-F8 | `profiles/web/package.json:24`；`local/dsh-custom-spaces.disabled/package.json:2`；`settings.yaml.imported:254-260` | **link 依赖指向不存在目录（三方不一致）** | 依赖声明 `"dsh-custom-spaces": "link:local\\dsh-custom-spaces"`，但 `local/dsh-custom-spaces/package.json` 与 `node_modules/dsh-custom-spaces/package.json` 都不存在，实体只剩 `local/dsh-custom-spaces.disabled/`；该插件也不在 `bundles` 里，而 settings 里仍留着它的空间配置（与单元 F 的 F-03 同源） |
| G-F9 | `storages/dsh_automation.json:25,29`；状态行 `:48,77,184,213,294,323,378` | **每夜自动化配置自相矛盾 + 连续失败 + 家园切换后不再触发** | 定义 `cwd: G:\DSH-3-Portable\宏建云系统` + `permissionPreset: workspace-write`，而任务要写 `.git/`、`Data/Updates/Desktop`；13 次运行 = 5 failed / 1 skipped / 7 succeeded，失败摘要明确写"沙箱只允许写 宏建云系统，`.git`/`Data` 全被拒"；最后 `scheduledFor 2026-09-24T16:00:00Z`，**09-25/09-26 无新运行** |
| G-F10 | `profiles/web/.dsh-recovery/quarantined-bundles.json:115-122` | **一条未闭环隔离记录（无 `resolvedAt`）** | 11 条记录里 10 条有 `resolvedAt`，唯 `2026-09-20T05-22-57-748Z-…`（`@deepseek-ai/dsh-experimental-agent-team-profile`，"插件 package.json 不存在"）没有 |
| G-F11 | 见证据列 | **备份与残骸堆积（38 处 `.bak` + 孤儿目录 + `.tmp`）** | `Data/DSH` 下 `*.bak*` 共 38：`settings.yaml.bak-before-{hongjian-space,qwen38,opencode-free}`、`profiles/web/package.json.bak-*` **10 个**、`pnpm-lock.yaml.bak-20260920-restore`、`pnpm-workspace.yaml.bak-{182204,20260920-restore}`、`local/dsh-better-sidebar/lib/*.bak-*` **5 个** + `portable/browser-view.js.bak-*` **3 个**、`local/dsh-hj-workbench/lib/client.js.bak*` **3 个**、`dsh-custom-spaces.disabled/lib/*.bak-before-stub` 2 个；另有 `.dsh-usage-ledger.json.{bak, e9e3f1a4b577.tmp}`、`.dsh-usage-stats.json.bak`；`Updates/Harness/homes/0.1.7-rc.2.json.{v4-rc2.bak, bak-disable-iso-20260926-000700}`；孤儿目录 `profiles/web/node_modules/@michengai/dsh-automation_tmp_49448_10/`（有 `lib/index.js`、LICENSE、assets，**无 package.json**）；`storages/session_projcache_archive_manager/`（旧 v1，42 文件）与 `_v2`（约 110 文件）并存重复，v2 内还有 `.83b15bed-….tmp` 残片 |

## ⚪ Findings

| # | 位置 | 问题 |
|---|---|---|
| G-F12 | `node_modules/.modules.yaml:640,641,550,553`；`.dsh-usage-ledger.json:1`；`quarantined-bundles.json:73,84,95,106,126`；`Local State:1`；`browser/library.json:1-955` | **可移植性：其余绝对路径与机器绑定项** — `storeDir = G:\…\Data\Development\pnpm-home\store\v11`、`virtualStoreDir = G:\…\Data\DSH\profiles\web\node_modules\.pnpm`；账本每 session 记 `cwd: G:\DSH-3-Portable`；隔离记录 reason 里嵌整段 `G:\…` 栈；`Local State` 的 `os_crypt.encrypted_key` 是 **DPAPI 密文**（换机/换用户即失效，浏览器 cookie 不可迁移）；`browser/library.json` 955 行浏览历史含 `login.hongjian.com` ERP 登录页 |
| G-F13 | `storages/workspace.json:11-25` vs `:32-63`；`storages/work_mode.json:7-71` | **同一 session 既在归档列表又在活动列表（7 个）** — `session-4a3a5123…`、`session-08424336…`、`session-46e2384c…`、`session-ecf0f9a0…`、`session-0bbc4459…`、`session-8e0e56fd…`、`session-60be02da…`（generation home 同样如此）；`work_mode.json` 保留全部 13 个归档 session 的模式记录，无回收 |
| G-F14 | `cordis.patch.yml:10-222` vs `.dsh-usage-ledger.json:1` | **patch 的 `llm-pi-ai.config.providers` 只列 5 个 provider，而账本指纹里出现过 11 个** — patch 列 `zai-coding-cn / qwen-token-plan-cn / sensenova / ollama-local / xiaomi-token-plan-cn`；账本 fingerprint 另有 `grok, kimi-coding, opencode, opencode-go, qwen-token-plan, tencent-token-plan, xiaomi-token-plan-ams, xiaomi-token-plan-sgp`。若 loader 对 `providers` 是整段覆盖，这些 provider 会消失（需确认是深合并；asar 实现层不可读）。**除已知两条外，patch 内没有第三个重复 id** |
| G-F15 | `package.json:10` vs `.modules.yaml:550`；`profiles/web/pnpm-workspace.yaml:1-23` | **工具链与 specifier 轻微漂移** — 根 `packageManager: pnpm@11.26.0` ↔ profile `.modules.yaml: packageManager pnpm@11.24.0`；profile `pnpm-workspace.yaml` **无 `resolutionMode`**，而 runtime 槽的有（若该要求只针对官方运行时则合规）；`minimumReleaseAgeExclude` 里仍列 `dsh-codex-ui@1.1.2`，实装 `1.1.18` |
| G-F16 | `profiles/web/.dsh-reload-request:1` | 遗留重载请求（**已核实不会自触发**）：内容 `2026-09-15T23:23:42.5248560+08:00`；`src/profile-watch.ts:75-82` 只在 `fs.watch` 事件里对 `PROFILE_RELOAD_REQUEST_FILE` 置 `forceReload`，存量文件不产生事件。可删（本轮按要求未动） |

## 版本/指针自洽项（无问题，供交叉核对）

根 `package.json:3` `1.0.76`、`:24 bundledDshVersion 0.1.7-rc.2` ↔ `Desktop/pointer.json:4-13` 两槽均 `1.0.76` ↔ `Runtime/Harness/current.json:3-6` `0.1.7-rc.2` + 指纹 `4d29c691…` ↔ `slots/<current>/.dsh-runtime-fingerprint:1`（一致）↔ `slots/<current>/package.json:25` `@deepseek-ai/dsh 0.1.7-rc.2` ↔ `Updates/Harness/homes/0.1.7-rc.2.json:2-4` 指向 generation `v4-rc2b`（目录存在）↔ `Updates/Harness/state.json:4` `0.1.7-rc.2`。

**桌面槽只留两版（current + previous）已满足**：`slots/` 下只有这 2 个 `slot-manifest.json`。`Updates/Harness/policy.json:2-14`：`channel alpha / safe-auto / keepGoodSlots 3 / maxAutomaticDeployAttempts 2 / deployRetryCooldownHours 24`（运行时槽保留策略，不违桌面"只留两版"规则）。

## 无法核实项

1. **无法计算 SHA-256**（无 shell）→ 不能逐文件断言槽内制品匹配；G-F2 是"清单声明 vs 同目录 `.content-sha256` 文件"的**文本级对照**，可人工复核。
2. `Data/Temp` 规模与 `prepare-recycle` 真实占用**未能量化**（枚举 30s 超时）。
3. `Data/Updates/Desktop` 是否有事务目录未能枚举；`pending.json` 试探不存在。
4. `Data/DSH-generations/v4-rc2b` 顶层**无法用 rg 枚举**（`.broken-20260925-234407\dsh-custom-spaces` 断链导致 `exit 2`）。
5. `Data/DSH` 顶层非 `.dsh-*` 的普通 `*.json` 未穷举（`settings.yaml` 确认不存在）。
6. `handoffs/` 存在但**无文件**。
7. `Data/RuntimeCandidate/**` 确认**不存在**（不是"未读"）。
8. asar 内 `dsh/` 实现层不可读（`os error 3`）→ patch 条目 id 是否存在、config 是否深合并未能核实（G-F14 只能列为"需确认"）。
9. `plugin-*.log` **不在** `Data/DSH` 下；实际为 `Data/Electron/UserData/{plugin-update.log, plugin-seed.log, startup-error.log}`。

## 方法学备注（供后续复用）

- `grep` 对**显式传入**的 `Data/**` 路径是生效的（本单元靠它完成大部分发现）。
- `glob` 无法锚定层级且递归匹配任意深度；在大目录（slots、node_modules、Temp）必然 30s 超时。
- 对**不存在**路径 `grep` 报 `IO error/os error 2`，对**存在但无匹配**报 `No matches found` — 可用这一差异做便宜的存在性探针（`handoffs`、`prepare-recycle`、`RuntimeCandidate` 即据此定性）。
