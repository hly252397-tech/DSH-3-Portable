# Codex 独立验证 — Node 版本"分裂脑"（2026-09-26）

> 独立复核声明：本报告不采信既有结论，全部数字均由本轮实测重新获取。除本报告外未写入/修改任何文件；未跑全量测试（任务明令禁止）。

## 0. 结论

**CONFIRMED（确认，附一处范围修正）**。Claim 中的每一组数字都与实测一致，"gate 二进制与声明/预期二进制不一致"成立。但需修正爆炸半径：

- **分裂脑是真实存在的**：门禁/开发用的 `App/resources/node/node.exe` = v24.20.0，而 `package.json` 声明、`prepare-runtime` 守卫、构建工具链 `Tools/node`、当前活跃部署槽全部是 v24.21.0。
- **范围修正**：当前**活跃部署不是 `App/`**。`Data/Updates/Desktop/pointer.json` 指向 `Data/Updates/Desktop/slots/1.0.76-local-3cfc4743bb8d1fff`，两个活跃槽的 `resources/node/node.exe` 都是 v24.21.0/BA4E…（正确）。`App/` 是 2026-09-02 冻结的 **legacy 回退树**（`Start-DSH-Portable.ps1:182, 405-414`），只有在槽全部失效时才会被使用。因此：**产品实际运行的 Node 没有装错；错的是 AGENTS.md 指定的门禁二进制和 legacy 回退树**。
- **性质判定：陈旧（stale），不是有意钉版，也不是清单写错**。详见第 3 节。

---

## 1. 数字逐项核验

核验方法：`--version` 直接执行二进制；`Get-FileHash -Algorithm SHA256` 独立计算；`package.json` 逐行读取；另从官方 `nodejs.org/dist/v24.21.0/SHASUMS256.txt` 及本机下载的官方 zip 内 `node.exe` 条目做第三方交叉验证。

| 对象 | Claim 声称 | 本轮实测 | 判定 |
|---|---|---|---|
| `package.json:16` `config.bundledNodeVersion` | `v24.21.0` | `v24.21.0` | ✅ 一致 |
| `package.json:18` `bundledNodeSha256[win32-x64]` | `BA4E6D11…6C32` | `BA4E6D110E8C1592A1ECD390F6B05F3DA124B13871A5BE62B341A07A853C6C32` | ✅ 一致 |
| `App/resources/node/node.exe` 版本 | `v24.20.0` | `v24.20.0` | ✅ 一致 |
| `App/resources/node/node.exe` SHA256 | `5C976096…707B5` | `5C976096E04E5C2C1F091938926234CC9FBEBFE9787DDD149351B3B0ECC707B5` | ✅ 一致 |
| `Tools/node/node.exe` 版本 | `v24.21.0` | `v24.21.0` | ✅ 一致 |
| `Tools/node/node.exe` SHA256 | `BA4E6D11…6C32` | `BA4E6D110E8C1592A1ECD390F6B05F3DA124B13871A5BE62B341A07A853C6C32` | ✅ 一致（= 清单值） |

补充核验（claim 未提，但决定"谁对谁错"）：

- `App/resources/node/node.exe.sha256` 内容 = `5C976096…`（**与陈旧二进制自洽**，写于 2026-09-01 22:25）。
- `runtime-node/node.exe` = `BA4E…` / v24.21.0（2026-09-25 22:19）；`release/win-unpacked/resources/node/node.exe` = `BA4E…` / v24.21.0；两个部署槽 `…/resources/node/node.exe` 均 = `BA4E…` / v24.21.0。旁置 `.sha256` 全部写 `BA4E…`。
- 官方 `https://nodejs.org/dist/v24.21.0/SHASUMS256.txt` 中 `node-v24.21.0-win-x64.zip` = `158f7685…`；本机 `Data/Development/downloads/node-v24.21.0-win-x64.zip` 内 `node-v24.21.0-win-x64/node.exe` 条目解压哈希 = **`BA4E6D11…6C32`**（大小 93,580,104）。即 **清单哈希就是官方 v24.21.0 的 node.exe 哈希，清单没有错**。

---

## 2. `App/resources/node` 是怎么来的（产生链）

完整链条（每步都引用了代码）：

1. **工具链 Node 自愈**：`Build-DSH-Portable.ps1:12-14` 指向 `Tools\node\node.exe`；`:18-22` 用 `manifest.config.bundledNodeSha256.win32-x64` 校验它，不匹配就从 `nodejs.org/dist/v<engines.node>/node-v*-win-x64.zip` 下载并校验后替换（`:24-42`，旧的移入 `node-backup-<时间戳>`，`:38-40`）。**Tools/node 是被清单钉住并自愈的**。
2. **构建期用 Tools/node 执行**：`Build-DSH-Portable.ps1:52` 把 `Tools\node` 放 PATH 首位，`:78` 跑测试、`:81` 跑 `pnpm run pack`（= `prepare-runtime && electron-builder`，`package.json:35`）。
3. **prepare-runtime 拷贝"正在运行的 node"进 runtime-node**：`scripts/prepare-runtime.ts:177-183` —— `nodeExecutable = process.execPath`，哈希与清单比对（`:178-179`）后 `cp` 到 `runtime-node/node.exe` 并写 `node.exe.sha256` 旁置（`:183`）。入口守卫在 `:163-169`：`process.version !== config.bundledNodeVersion` 直接 `throw`。
4. **extraResources 复制**：`package.json:74-80` `build.extraResources` 把 `runtime-node` → 打包应用的 `resources/node`。
5. **进候选槽**：`scripts/stage-local-desktop-candidate.ts:20` 用 `release/win-unpacked/resources/node/node.exe`；`Start-DSH-Portable.ps1:100-118` 对槽内 `resources/node/node.exe` 做逐文件哈希核对。

**`App/` 不在这条链上**：没有任何当前脚本写 `App/`（全仓检索仅发现读取方：`Start-DSH-Portable.ps1:405, 412-414` 的 legacy 回退、`src/portable-desktop-update.ts:372, 529` 为旧式 `relativePath:'App'` 指针构造记录）。所以 `App/resources/node` 是**某次历史构建的 extraResources 快照**，此后再无刷新机制。

时间线证据（旁证充分）：

- `App/` 创建 2026-09-02 10:30；`App/.../node.exe.sha256` 写于 2026-09-01 22:25 —— 构建于 24.20.0 时代。
- `git log -S'5C976096'`：`cbf7528`（2026-08-27，"refresh desktop dependency stack"）引入 24.20.0/`5C97…` 钉版。
- `git log -S'BA4E6D11'`：`908e00c`（2026-09-14 21:28，"修复陈旧随包插件清单并对齐上游 v1.0.60（…运行环境）"）把钉版换成 24.21.0/`BA4E…`。`docs/00-交接入口/07-功能清单.md:364` 记载同次意图："Node 24.20.0→24.21.0、pnpm 11.24.0→11.26.0…槽内实测 Node v24.21.0"。
- `Tools/node` 落盘 2026-09-14 21:07，且 `Data/Development/node-backup-20260914-210803/node.exe` = `5C97…`（被换下的旧 Tools/node）—— 正是 `Build-DSH-Portable.ps1:38-40` 的自愈备份行为。

---

## 3. 判定：陈旧，不是有意钉版，清单也没错

**`App/resources/node/node.exe` 是陈旧快照。** 三条独立理由：

1. **无任何代码把 App 钉在 24.20.0**。全仓没有任何 "App 用旧 Node" 的配置；相反 `AGENTS.md:98` 明确要求门禁 Node "版本以 `package.json` 的 `bundledNodeVersion` 为准"。App 与该要求相悖，只能是漂移。
2. **清单已被官方源背书**：清单哈希 = 官方 v24.21.0 zip 内 node.exe 的哈希（第 1 节），且与 `Tools/node`、`runtime-node`、`release/win-unpacked`、两个活跃槽全部一致。五份制品一致、一份（App）偏离 ⇒ 偏离的是那一份。
3. **时间线吻合"旧构建残留"**：App 构建于 09-02（24.20.0 时代），09-14 的 `908e00c` 升级到 24.21.0 并自愈了 Tools/node，但 App 从此不再被任何流程刷新。

因此三种候选解释中：**"manifest 错"被否决**（官方哈希 + 五制品一致）；**"有意钉版"被否决**（无配置、无注释、无文档支持 App 留在 24.20.0）；**"陈旧二进制"成立**。

---

## 4. 影响面：哪些路径坏掉、哪些静默错行为

### 4.1 硬性失败

| 路径 | 行号 | 行为 |
|---|---|---|
| `scripts/prepare-runtime.ts` | `:163-169` | 用 App node 执行必抛 `随包 Node 版本不匹配：需要 v24.21.0，实际 v24.20.0。`。**本轮实测守卫条件**：`process.version=v24.20.0` vs 清单 `v24.21.0` ⇒ `throw=true`。即使版本侥幸相同，`:178-179` 的 SHA256 守卫也会抛（`5C97… ≠ BA4E…`）。编译产物同样在位：`dist/scripts/prepare-runtime.js:169-171`。 |
| 同上（安全性） | `:170-175` | 版本守卫先于 `writeReleaseSourceManifest`（`:171`）与破坏性清理循环（`:172-175`）执行 ⇒ 用旧二进制跑**快速失败、零副作用**，不会损坏 `runtime-*`。 |
| `package.json` 脚本链 | `:34-36` | `prepare-runtime` / `pack` / `dist` 全部经过上述守卫；用 App node 跑打包链必然失败。 |
| **HEAD 的 CI** | `.github/workflows/desktop-package.yml:54, 218`（HEAD 值） | HEAD 钉 `node-version: 24.20.0`，而 HEAD 的 `package.json:16` 要求 v24.21.0 ⇒ CI 执行到 `:147 pnpm run prepare-runtime` 时会抛同一守卫错误。**工作树里已有 24.20.0→24.21.0 的修改（未提交）**，见 `git diff`。 |

### 4.2 静默错行为（更危险）

| 路径 | 行号 | 行为 |
|---|---|---|
| `AGENTS.md` 门禁命令 | `:94-95, 98` | `tsc` + `run-tests` 规定用 `App/resources/node/node.exe` 跑 ⇒ **门禁在 v24.20.0 上通过，而实际随包/随槽运行时是 v24.21.0**。测试绿灯不覆盖真实发行运行时。 |
| `scripts/run-tests.mjs` | `:214` | `spawnSync(process.execPath, ['--test', …])` —— 测试子进程继承调用方 node ⇒ 同上，整套测试跑在陈旧运行时上。用法注释也是 `:13-14`。 |
| 硬编码 `App/resources/node/node.exe` 的脚本 | `scripts/gates.mjs:11,20`；`scripts/lint-ui-discipline.mjs:31`；`scripts/watch-ui.mjs:18`；`scripts/diag-profile-web.mjs:14`；`scripts/diagnostic-web.mjs:46,58`；`scripts/probe-shadow-start.mjs:25`；`Install-P3-Tiny-Watch.cmd:4`；`Test-P3-Tiny-Watch.cmd:4`；`重建技能链接.cmd:21` | 全部以陈旧二进制作为解释器/子进程 Node。 |
| 门禁家族内部也不一致 | `Build-UI-Only.ps1:107` vs `scripts/gates.mjs:11` | UI 快通道用 `Tools\node\node.exe`（v24.21.0），而 gates 用 App node（v24.20.0）——**同一批门禁在两个 Node 版本上跑**。 |
| 运行时完整性校验对此盲 | `src/runtime.ts:53-60`（`:57` 调校验）→ `src/runtime-archive.ts:224-231` | 校验只比对 `node.exe` 与**同目录旁置的 `node.exe.sha256`**，而该文件由 `prepare-runtime.ts:183` 从同一二进制生成 ⇒ **陈旧但自洽的 App 完美通过校验**，全程不看 `package.json` 的 `bundledNodeSha256`。 |
| 槽清单豁免 App | `Start-DSH-Portable.ps1:92`（`$relativePath -ne 'App'` 才做 slot-manifest 逐文件核验，`:100-118`） | App 树的 node 不受任何哈希门禁保护。 |
| 测试无断言 | `test/` 全目录检索 | 对 `bundledNodeVersion` / `process.version` / `node.exe.sha256` **零断言** ⇒ 任何自动测试都抓不到这类漂移。 |

### 4.3 `scripts/prepare-runtime.ts` 用 App node 跑会不会抛？—— **会，已双重确认**

源码 `scripts/prepare-runtime.ts:167-169` + 编译产物 `dist/scripts/prepare-runtime.js:169-171` 都含版本守卫；本轮用 App node 只读复现守卫表达式：`process.version = v24.20.0`、`manifest = v24.21.0`、`guard would throw: true`。**我没有真的执行 `prepare-runtime` 全流程**（它会删建 `runtime-node/`、`runtime-plugins/` 等，超出只读授权）；但守卫位于一切写操作之前（第 4.1 节），结论确定。

---

## 5. CI：会抓到什么、遮蔽什么

- **CI 用的 Node**：`.github/workflows/desktop-package.yml:51-54` 与 `:215-218` `actions/setup-node@v7` —— 工作树值 `24.21.0`，**HEAD 值 `24.20.0`**（`git diff` 显示这两处是未提交修改）。
- **CI 会抓到（大声失败）**：清单/工具链钉版不一致。HEAD 上 CI 在 `:147 pnpm run prepare-runtime` 必然撞 `prepare-runtime.ts:167` 守卫而红。也就是说 **HEAD 本身 CI/清单就是分裂脑，修复只存在于未提交的工作树**。
- **CI 遮蔽（永远看不到）**：`App/` 被 `.gitignore:21` 忽略，全新检出里根本不存在 ⇒ CI 不可能发现 "AGENTS.md 门禁二进制 = App node" 这一半分裂脑。本地门禁（24.20.0）与 CI 门禁（24.21.0）跑的不是同一个运行时，**本地绿灯 ≠ CI 环境代表**。
- CI 其余相关步骤：`:132-135` `pnpm install --frozen-lockfile` + `pnpm test`；`:147-149` `prepare-runtime` + `electron-builder`。CI 不跑 `scripts/gates.mjs`（全工作流检索 `gates|lint-ui|run-tests|ui-baseline` 零命中）⇒ 本地那套硬编码 App node 的门禁 CI 完全不覆盖。

---

## 6. 其它"双拷贝漂移"（同模式问题）

### 6.1 pnpm：同款分裂脑，且工具链自愈有缺口（重点）

| 位置 | 版本 | 应为 |
|---|---|---|
| `package.json:10` `packageManager` / `:13` `engines.pnpm` | **11.26.0** | 基准 |
| `scripts/prepare-runtime.ts:19` `bundledPnpmVersion` | **11.26.0** | 一致 |
| `runtime-node/pnpm-package`、`release/win-unpacked/.../pnpm-package`、两个槽 | **11.26.0** | 一致 |
| `App/resources/node/pnpm-package/package.json` | **11.24.0** | ❌ 陈旧（随 App 快照一起旧） |
| `Tools/pnpm/node_modules/pnpm/package.json` | **11.24.0** | ❌ 与清单不符 |
| CI `desktop-package.yml:57-59` `pnpm/action-setup` | **11.24.0** | ❌ 与清单不符 |

根因缺口：`Build-DSH-Portable.ps1:19-22` 对 **node** 做哈希自愈，但对 **pnpm 只检查文件是否存在**（`:44-50`，`if (-not (Test-Path … pnpm.cmd))` 才安装）⇒ pnpm 版本永远不会被纠正。另：`Tools\pnpm\pnpm.cmd --version` 报 11.26.0 而其 `node_modules/pnpm` 是 11.24.0，疑似 pnpm 自版本管理按 `packageManager` 自切换（**未完全证实**，见第 8 节）。

### 6.2 App 树整体是旧快照（资源/桥接同模式）

- `assets/` vs `App/resources/`：`startup.html`、`shell.html`、`theme.js`、`theme.css`、`shortcuts.html`、`about.html`、`settings.html` 全部哈希不同；`whale-particles.js`、`browser-panel.html`、`browser-workspace.css/js`、`feature-panels.html` 在 App 中根本不存在。对照 `release/win-unpacked/resources/`：**13/13 全同** ⇒ App 是旧构建快照无疑。
- `App/resources/desktop-bridge/` vs `release/win-unpacked/resources/desktop-bridge/`：6 同 9 不同，且 App 缺 `recovery-mode.js`、`startup-progress.js`。

### 6.3 陈旧 node.exe 散落副本（哈希 5C97… = v24.20.0）

`.tmp/node-v24.20.0-win-x64/node.exe`、`.tmp/path-bin/node.exe`、`artifacts/whale-deploy-20260905/candidate/resources/node/node.exe`、`Data/Development/node-backup-20260914-210803/node.exe`（自愈备份，正当）、`Data/Development/node-stage-7d65…/node-v24.20.0-win-x64/node.exe`（下载暂存残留）。

注：`.tmp/health-check-verification/**/node.exe` 是 **31 字节测试桩**（哈希 `5A0D…`），不是真二进制，已排除。

---

## 7. 最小正确修复 + 禁止事项

### 最小修复（按序，三步）

1. **提交工作树里已有的 CI 修复**：`.github/workflows/desktop-package.yml:54, 218` 的 `node-version: 24.20.0 → 24.21.0`（已是未提交改动）；顺手把 `:59` pnpm 钉版对齐 `11.26.0`。这一步消除 HEAD 上 CI 必红。
2. **把门禁解释器从 `App/resources/node/node.exe` 换成 `Tools/node/node.exe`**（或等价：在 `scripts/gates.mjs:11` / `run-tests.mjs` 前加一行断言 `process.version === config.bundledNodeVersion` 并校验哈希）。`Tools/node` 由 `Build-DSH-Portable.ps1:18-22` 哈希自愈到清单值，是唯一"天然与清单一致"的门禁二进制。涉及：`scripts/gates.mjs:11`、`lint-ui-discipline.mjs:31`、`watch-ui.mjs:18`、三个 `.cmd` 包装、以及 `AGENTS.md:34,71,94-98` 的措辞。
3. **补一个廉价防回归测试**：断言"当前执行 node 的 `process.version` 与 SHA256 == `package.json` 的 `config.bundledNode*`"，让 CI 与本地门禁都能抓到下一次漂移（当前 `test/` 对此零覆盖）。

（`App/` 里那份旧 node 不必"修"——它是 legacy 回退树，随下一次完整 `Build-DSH-Portable.ps1` → 候选槽 → 启动器重启的正规部署自然被新一代制品取代。）

### 明令禁止

- ❌ **禁止原地覆盖 `App/`**（`AGENTS.md` 红线："禁止原地覆盖 App"；App 是不可变回退树，且它绕过 slot-manifest 校验，手改其 node 会破坏制品溯源与回滚语义）。
- ❌ **禁止把 `package.json` 的 `bundledNodeVersion`/`bundledNodeSha256` 改回 24.20.0/`5C97…`** 来"对齐"App —— 清单已被官方哈希背书、与 5 份新制品一致，改清单等于把错的那头当基准，并让已部署槽与清单失配。
- ❌ 禁止手改 `node.exe.sha256` 侧车（它们是构建输出；`prepare-runtime.ts:183` 生成）。
- ❌ 禁止顺手删 `Data/Development/node-backup-*` / `.tmp` 取证副本当作"修复"（本轮只读审计未动它们）。
- ❌ 构建与候选激活不得并发（`AGENTS.md` 止损纪律第 7 条）；部署走 `Build-DSH-Portable.ps1` → 槽 → 启动器重启，绝不原地覆盖。

---

## 8. 方法与边界（诚实声明）

- 已做：两个二进制 `--version` + SHA256 独立计算；`package.json`、`node.exe.sha256` 侧车逐读；`runtime-node`/`release`/两槽/`Tools` 五点交叉；官方 SHASUMS256 与官方 zip 内 node.exe 条目三方背书；构建链、门禁脚本、CI、测试目录逐一追溯；`prepare-runtime` 守卫用只读 `-e` 复现。
- 未做 / 不确定：
  - **未执行 `prepare-runtime` 全流程**（会写 `runtime-*`，超出只读授权）——但守卫位置与实测条件足以确定它会抛。
  - **未跑全量测试**（任务明令禁止）。
  - `Tools\pnpm` 报 11.26.0 而其 `node_modules/pnpm` 是 11.24.0 的机制（疑似 pnpm `manage-package-manager-versions` 自切换）**未完全证实**；两次 `--version` 一次返回 11.26.0、一次无输出（疑似超时）。
  - CI 在 pnpm 钉版 11.24.0 vs `packageManager` 11.26.0 冲突时的确切行为（报错 or 自切换）未实测。
  - 本轮工作树有大量未提交修改（含 `package.json`、`prepare-runtime.ts`、workflow）；本报告区分标注了 HEAD 值与工作树值。

## 附：与既有登记的关系

本结论与 `docs/01-当前工作/audit-20260926/问题总登记册.md:407`（R-170）"App 装了旧二进制的分裂脑"方向一致，但本报告独立复核了全部数字，并**修正/补充**了四点：① 活跃槽制品全部正确、分裂脑限于 legacy `App/` + 门禁解释器；② 清单哈希获官方源背书（排除"声明错"）；③ 运行时侧车校验对这类漂移结构性盲（`runtime-archive.ts:224-231`）；④ pnpm 存在同款双漂移、且构建脚本对 pnpm 无版本自愈（`Build-DSH-Portable.ps1:44-50`）。
