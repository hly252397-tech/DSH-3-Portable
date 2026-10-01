# 审核单元 C 取证报告（scripts/ 与构建启动链）

> 来源：穷尽式只读审核单元 C（子代理会话），2026-09-26。本文是**证据留档**，未修改任何文件。
> 索引见 [全项目审核总报告](../便携版3-全项目审核总报告与修复清单.md)。
> 范围：`scripts/**` 全部 + 根目录构建/启动入口 + `package.json` scripts 段。

## 清单口径（避免误报，先记）

- `scripts/` = `.ts` 2 + **`.mts` 6** + `.mjs` 28 + `.cjs` 10 + `.ps1` 12（另 `.md` 2）。
- **6 个 `.mts` 不是缺失文件**：`patch-entry-subset` / `smoke-packaged-plugins` / `adhoc-sign` / `notarize` / `smoke-linux-package` / `smoke-macos-package`，编译成 `dist/scripts/*.mjs`，正是 `package.json` 的 `afterPack`/`afterSign`/`smoke:mac`/`smoke:linux` 与 `smoke-package.ps1:203` 引用者（`include: *.ts` 不命中 `.mts`）。
- 根目录 = `.ps1` 4 + `.cmd` 8；`package.json` scripts 9 条。合计 **71 个受审单元**。

## 一句话结论

启动器主链（指针解析 / 候选校验 / 回滚 / Mutex）与 `portable-health` 判据基本可靠，`prepare-dsh-home-generation` / `install-dsh-awareness-manual` / `build-sidebar-layout-compat` **属高质量脚本**；但**回收机制只覆盖 4 个主目标，验证用的万级文件大树仍走同步 `rm`（G: 盘 10–40 分钟"假死"）**、**`Build-UI-Only` 门禁 A 会静默放行**、**`smoke-portable.ps1` 验的是 legacy `App/` 与 legacy 运行时却打印"验证通过"**，另有 2 处启动器缺口与 3 个"改用户窗口却不还原"的取证脚本。

## 🔴 Findings

| # | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| C-F01 | `Build-UI-Only.ps1:131-141, 158-160, 58-65` | **门禁 A 假绿 + 漏判进包文件** → 静默产出「新界面 + 旧主进程」混血候选槽（`AGENTS.md` 明令禁止） | `$raw = & $git -c core.quotepath=false -C $portableRoot status --porcelain 2>$null` **不检查 `$LASTEXITCODE`**（主会话已实读 `:131` 确认）；git 失败时 `$raw` 为空 → `elseif ($null -ne $git) { Write-Ok '除 assets\ 外没有需要重新打包的改动' }`；`browser-library.cjs` 在 `build.files` 内却落到 `Get-DirtyVerdict` 的 `return 'notice'`（`:58-65`） | 检查 `$LASTEXITCODE`，失败即 block；把 `build.files`/`extraResources` 内文件纳入 block 判定 |
| C-F02 | `prepare-runtime.ts:413-415, 427, 430-432` | **回收机制覆盖不全**：万级文件大树走裸 `rm`，G: 盘 10–40 分钟「CPU≈0 无输出」，与 2026-09-13 定案要根治的现象一致 | `finally { await rm(profile, { recursive: true, force: true }) }`、`rm(staging)`、`rm(root)`；同文件 `:100-127` 就是 rename 回收解药（`AGENTS.md` 实测 store 19224 / runtime-plugins 44116 文件） | 这三处改走 `removePreparedPath`（同卷 rename 回收）；或在注释里显式说明为何必须同步删 |
| C-F03 | `smoke-portable.ps1:15, 21-25, 44, 78` | 「验证通过」**验错对象 + 触碰实机用户数据** | `$applicationPath = Join-Path $portablePaths.App 'DSH Codex Desktop.exe'`（主会话已实读 `:15` 确认 = legacy `App/`）；`$runtimeEntry = …Data\Runtime\dsh-runtime\node_modules\…`（活动运行在 `Data/Runtime/Harness/slots/`）；launch 用 `--user-data-dir=$($portablePaths.UserData)`（真实用户目录）+ `npm_config_offline='true'`；结尾打印「便携首启验证通过」 | 从 `pointer.json` 解析当前槽（复用 launcher 的 Resolve 逻辑）；用独立 temp home/userData；结论注明被测槽与版本 |

## 🟠 Findings

| # | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| C-F04 | `Start-DSH-Portable.ps1:301-310, 379, 425-476` | 正常启动路径**无「桌面已在运行」护栏** → 直接双击 exe 会带着候选撞 Chromium 单实例锁 → 候选秒退 → 自动回滚（2026-09-16 事故机制；Mutex 只挡两个启动器） | `Get-PortableDesktopProcesses` 只在 `if ($WaitForProcessId -gt 0)` 分支被调用；`if ($pendingReference) { … Start-DesktopApplication … }` 无运行实例检查 | 非 handoff 路径先查正式实例：有则提示「已在运行，请从托盘退出/点重启」并 `exit 0`（不撤指针、不启候选） |
| C-F05 | `Start-DSH-Portable.ps1:76, 248, 250, 279, 420, 428` | **StrictMode 下裸访问可选字段**：半写/损坏 `pointer.json` → `PropertyNotFoundException` 未捕获 → 启动器终止，slots 扫描与 legacy 回退都到不了 | `[string]$Reference.relativePath`（`:76` 仅对 `$null` 判空）、`$previousReference.relativePath`（`:248`）、`$pendingReference.transactionId`（`:428`）；`Portable-Environment.ps1:1 Set-StrictMode -Version Latest` 经 dot-source 生效 | 全部改走既有 `Get-OptionalProperty`（或包 try/catch） |
| C-F06 | `smoke-package.ps1:205` | 违反「必须用随包 Node」门禁 | `& node $verifierPath $dshHome` | 用同文件 `:41` 已算好的 `$expectedNodeExecutable` |
| C-F07 | `smoke-package.ps1:126-134, 230, 231` | 收尾**同步删整棵临时 DSH home**（插件矩阵万级文件）；`finally` 内再 `throw` 会盖掉原始异常 | `[System.IO.Directory]::Delete($resolvedPath, $true)`；`if ($bootstrapStillRunning) { throw … }` | 临时根放 `Data/Temp` 走 rename 回收；finally 只记录不抛 |
| C-F08 | `look-ui.ps1:105, 112-123, 126` | 改用户窗口状态（TOPMOST/宽度）**无 finally 还原**；仍用 `CopyFromScreen`（仓库已定案用 `PrintWindow`） | `[LookUiWin]::SetWindowPos($target.Handle, $HWND_TOPMOST, …)`；`:48 $g.CopyFromScreen(...)`；`exit 0` | try/finally 还原；抓图改走 `capture-app-window.ps1` |
| C-F09 | `verify-adaptive-matrix.ps1:35-49, 57-70` | 全局合成 `Ctrl+0`/`Ctrl+±` **无前台校验、无 finally**：按键可能打进用户当前窗口；中断后窗口停在测试尺寸/缩放 | `SetForegroundWindow($h)` 后直接 `keybd_event`；还原（`:70`）只在循环正常结束执行 | 校验 `GetForegroundWindow == $h` 否则 throw；try/finally 还原尺寸与 100% 缩放 |
| C-F10 | `verify-panel-drag.ps1:88-101, 119-146` | 全局 `mouse_event` 拖动无 finally：中断**残留左键按下**（用户桌面被划出选区）；`:146` 取消 TOPMOST 只在成功路径 | `mouse_event(0x0002, …)` 后进入 24 步 `MoveTo`；无 try/finally（`宏建云系统/data/temp/drag-panel-sweep*.ps1` 有正确先例） | try/finally：松左键 + `NOTOPMOST` |
| C-F11 | `ui-baseline.mjs:100-108, 92-93` | `--record` **先写共享基线（含不可变 history）再校验**；校验失败 `exit 1` 但基线已被改写 | `const baseline = recordBaseline(...)` → 之后才 `verifyBaseline(...)`；`writeFileSync(inside(root, baselinePath), ...)` | 先判定再落盘，或失败回滚 `baseline.json` |
| C-F12 | `verify-adaptive-layout.mjs:31-34` | **取证工具带副作用**：向 live 插件源码追加注释且无限增长（违反「取证工具零副作用」纪律） | `appendFileSync(TOKEN, \`\n// verify-adaptive-layout ${Date.now()}\n\`)`，`TOKEN = dsh-ui-tweaks/lib/client.js` | 改用带 cache-buster 的探针触发通道（如写 `Data/Temp` 请求文件），不改产品源码 |
| C-F13 | `build-native-browser-card.mjs:59-76, 45-55, 5-6, 80` | 用户 2026-09-23 明确要「防下次构建又出现」的两处互斥补丁**命中失败时静默跳过**；且无备份原地重写 live bundle | `if (bundle.includes(needle)) { bundle = bundle.replace(...) }` 两处皆无 else 断言；`writeFileSync(outputPath, bundle)`（`outputPath` 默认 = live `lib/client.js`） | needle 未命中即 throw；写盘前 `.bak`；落盘前后各做 `new Script()` 解析校验 |
| C-F14 | `prepare-runtime.ts:172-175, 197, 351, 353, 472-475` | 失败留残骸 + 死参数 | `verifyPreparedPluginStore(...)` → `removePreparedPath(verificationDir)` **无 finally**（历史 4093 文件来源）；`stageOfficialRuntime(destinationRoot, nodeRoot, storeDir)` 的 `nodeRoot`/`storeDir` **从未使用**，`:197` 再删 `.store` 是空操作 | 删除移入 finally；删未用参数或补实现 |
| C-F15 | `prepare-runtime.ts:15, 100-114` | **无构建级互斥**：并发构建互抢目标；回收桶名 `${basename}-${Date.now()}` 同毫秒可碰撞 → rename 失败 → 回退同步 rm（正是慢路径） | `const bucket = join(recycleRoot, \`${basename(target)}-${Date.now()}\`)`，无锁文件/Mutex | 加构建锁（`Data/Temp/prepare.lock` + PID 存活校验）或桶名加 PID/随机后缀 |

## ⚪ Findings

| # | 位置 | 问题 |
|---|---|---|
| C-F16 | `audit-dsh-accessibility.ps1:20-24,46`；`audit-live-window.ps1:2-3,46,73`；`audit-qoder-window.ps1:2,28,52` | 写死 PID/hwnd/槽路径/用户名 → 换盘换机即失效 | 
| C-F17 | `capture-app-window.ps1:6`；`diag-fix-links.mjs:7-8`；`verify-portable-storage.cjs:5`；`diag-profile-web.mjs:11`；`diag-headless-edge.mjs:7` | 其余硬编码绝对路径 / 固定槽名 |
| C-F18 | `verify-task-search.cjs:5`；`verify-knowledge-files.cjs:6`；`verify-knowledge-workflow.cjs:5`；`verify-portable-storage.cjs:14` | 固定 CDP 端口 `9237` 会挂到「端口上碰巧在监听」的任何 Chromium |
| C-F19 | `staging-registry-proxy.mjs:175, 57` | CLI 入口在 Windows **永不成立**（`import.meta.url === 'file://' + process.argv[1]`）→ 直接运行静默 no-op；host 可被 `DSH_PROXY_HOST` 改成非回环且无校验 |
| C-F20 | `lint-plugin-deps.mjs:58-67` | 注释声称的「peer 范围必须覆盖活动运行时」门禁**未实现** |
| C-F21 | `lint-ui-discipline.mjs:245, 251-269` | profile 缺失 → `bundles=[]` → 规格检查**空跑并通过** |
| C-F22 | `verify-adaptive-layout.mjs:63, 68-70` | 两处可空过：测不到对话列宽时判 PASS；探针无 `narrowText` 时「无竖排徽标」恒过 |
| C-F23 | `portable-health/Check-DSH-Health.ps1:46-61` | 与启动器判据不一致：启动器对 legacy `App` 槽豁免清单校验（`Start-DSH-Portable.ps1:92`），健康检查一律要求 manifest → 旧布局机器**假红** |
| C-F24 | `run-tests.mjs:58-63`；`portable-health/health.test.cjs` | 门禁只收 `dist/test/*.test.js`（不递归、不含 `.cjs`），健康检查的 5.1 回归测试**无任何门禁**（与单元 D 的 D-F11 同源） |
| C-F25 | `package.json:32` | 门禁口径不一致：`test` 用裸 `node`（`run-tests.mjs:73` 自身用 `process.execPath` 正确） |
| C-F26 | `build-sidebar-layout-compat.mjs:150`；`restore-scheduled-tasks-entry.mjs:11,14-16` | 备份策略不一致；后者改 `node_modules` 内已安装包（`pnpm install` 会冲掉） |
| C-F27 | `Build-DSH-Portable.ps1:18, 19-42, 29, 77-80, 94` | 无版本格式预检（`1.0.65.1` 会白跑 20–40 分钟再被 `validatePackagedApp` 拒收）；`-SkipTests` 无二次确认；无磁盘预检；`node-backup-*` 只增不删；`Invoke-WebRequest` 无 `-UseBasicParsing`/重试 |
| C-F28 | `Build-DSH-Portable.ps1:44-50` | `Tools\pnpm` 存在时**完全不校验版本**（Node 有 SHA 门禁，pnpm 没有） |
| C-F29 | `Start-DSH-Portable.cmd:5-8`；`Start-DSH-Portable.ps1:478-489`；`Install-P3-Tiny-Watch.cmd:18`；`重建技能链接.cmd:23-31,33`；`Test-P3-Tiny-Watch.cmd:10` | 静默回滚（`exit 0`）用户无感；`.cmd` 失败也返回 0；回落系统 `node`；依赖 node 展开引号 glob |
| C-F30 | `prepare-dsh-home-generation.mjs:176, 224-231` | `cpSync(dereference:true)` 整棵运行时无成本上限；`.incomplete-<ts>` 隔离目录只增不删；与运行实例无互斥 |
| C-F31 | `install-p3-tiny-watch.mjs:52-57` | `rm(targetDir)` 与 `rename(staged, targetDir)` 之间有窗口：rename 失败会丢 `local` 目录（备份在，但无自动回滚/receipt） |
| C-F32 | `brief.mjs:66` | **过滤恒真**（`\|\| true` 吞掉前两项），"同类事故"永远全列——死逻辑 |
| C-F33 | `Start-DSH-Portable.ps1:23, 429-433` | `launcher.log` 无轮转、`transactions\<id>\` 无清理，长期无限增长 |

## 正面记录（高质量脚本，可直接当范例）

`prepare-dsh-home-generation.mjs`（dry-run / 拒覆盖 / 绑定回读校验 / 失败隔离齐）、`install-dsh-awareness-manual.mjs`（dry-run + 事务目录 + 回滚冲突检测 + 路径安全）、`build-sidebar-layout-compat.mjs`（**全仓典范**：锚点唯一性 + `new Script()` 解析门禁 + `--check`）、`portable-health/Health.Core.ps1`（路径/联接/HTTP 白名单严密）、`portable-health/health.test.cjs`（假绿防线密）。

## 无法核实项（需实跑）

1. **UTF-8 BOM 字节**：read/grep 均剥离 BOM，只有 `smoke-package.ps1`（`test/prepare-runtime.test.ts:394`）与 `portable-health` 两个（`health.test.cjs:45`）被测试断言。含中文但**无 BOM 断言**的 8 个：`look-ui.ps1`、`verify-panel-drag.ps1`、`smoke-portable.ps1`、`build-launcher.ps1`、`Build-DSH-Portable.ps1`、`Build-UI-Only.ps1`、`Start-DSH-Portable.ps1`、`Portable-Environment.ps1`。核实：`[byte[]](Get-Content -Encoding Byte -TotalCount 3 <file>)`；仓库 docs 把「静态扫描 `*.ps1` 前 3 字节」列为**待做自检**，目前无全局 BOM 门禁。
2. C-F04/F-05 的真实影响取决于 Electron 单实例行为——需实跑「应用运行时双击 `DSH便携版3.exe`」。
3. C-F02/F-07 的耗时量级取决于 `copyExtractedTree` 产物实际文件数。
4. 各门禁的实跑结论（静态只能判"代码能失败"，不能判真实环境是否失败）。
5. `node --test` 对引号 glob 的展开支持（`Test-P3-Tiny-Watch.cmd:10`）。
6. `Test-NeedsCopy`（`Build-UI-Only.ps1:37-47`）用 size + mtime(±2s) 判差异，是否存在"改了但大小/时间戳不变"的漏判。
7. 未逐行读完的 10 个文件（`sidechat-component-compat.mjs`、`workbench-geometry-guard.mjs`、`sync-black-hole.mjs`、`probe-shadow-start.mjs`、`smoke-macos-package.mts`、5 个 QA `.cjs`）与 6 个部分审文件的后段——均已做风险模式扫描。
8. **`Portable-Environment.ps1:78-82` 的 `$stateFiles` 仅 3 条**：`Data/Runtime/Harness/slots/*/node_modules/.modules.yaml` 等**槽内状态不在名单**（属已知重定位遗漏族，未重复计入 findings，仅列证据）。
