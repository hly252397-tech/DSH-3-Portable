# 审核单元 A 取证报告（src · 桌面/浏览器宿主）

> 来源：穷尽式只读审核单元 A（子代理会话），2026-09-26。本文是**证据留档**，未修改任何文件。
> 索引见 [全项目审核总报告](../便携版3-全项目审核总报告与修复清单.md)。
> 范围：`src/` 下 24 个宿主/浏览器/窗口/IPC 文件 + 3 个预加载脚本 + 2 个 `.mts` + 根 `browser-library.cjs`，**100% 逐行读完**。

## 覆盖与结论

- `src/` 实际 **55 个 `.ts`** 文件（regex 分段枚举核对，非抽样）。
- 整体纪律良好：四个窗口/视图的 `webPreferences` 全部 `contextIsolation:true + nodeIntegration:false + sandbox:true`；`will-navigate` / `setWindowOpenHandler` / `will-attach-webview` 均 fail-closed；IPC 策略按 renderer kind 最小授权。
- 已排除误报 2 处：`shell-actions.ts:98` 的 `CmdOrCtrl+Shift+Plus`、`shell-contract.ts` 的 `runtimeUpdateChannel:'alpha'`（与 `HarnessUpdatePolicy.channel` 类型一致）。

## Findings

| # | 级别 | 文件:行 | 问题 | 证据 | 建议 |
|---|---|---|---|---|---|
| A-F01 | 🟠 | `src/main.ts:432-438, 1933-1956` | 主视图分区无权限处理器 | 唯一 `setPermissionRequestHandler` 装在 `persist:dsh-browser`（`:437`）；DSH 视图用的 `persist:dsh-ui`（`:1936`）**没有任何** `setPermissionRequestHandler`/`setPermissionCheckHandler`，且该视图 `webviewTag:true`（`:1939`） | 为 DSH 分区显式加两个处理器（白名单 `clipboard-sanitized-write`/`fullscreen`，其余默认拒绝）；评估去掉 `webviewTag` |
| A-F02 | 🟠 | `src/main.ts:2807-2820`；`src/dsh-view-preload.cts:357`；`src/shell-ipc-policy.ts:22` | DSH 页面可在已认证标签内执行任意 JS | 策略只问 `mayManageBrowserPanel`（仅 `'dsh'`）→ `executeJavaScript(code, true)`，上限 200KB；preload 直暴露 `executeJs`。链路：DSH 页面/webview 漏洞 → 读任意已登录站点 DOM/令牌 | 属 2026-09-20 用户令 B 方案的显式产物，但应加会话/owner 约束、用户可见指示或审计日志；至少在文档中列为"已授权的高危能力" |
| A-F03 | 🟠 | `browser-library.cjs:339-415, 438-460, 505-529` | 宿主浏览器凭据被搬进便携目录 | `importPasswords` DPAPI 解密 Chrome/Edge 密码 → `encryptSecret` 落 `userData/browser/library.json`；`importCookies` 把源站 Cookie 灌进 `persist:dsh-browser`；`importExtensions` 用 `session.extensions.loadExtension`（`:518`）。便携模式下 `userData` 即 `G:\DSH-3-Portable\Data\...`（`main.ts:253`） | 迁移前逐项显式确认与"仅本次/不落盘"选项；限制扩展网络与权限面；文档标注该目录为敏感数据 |
| A-F04 | 🟠 | `src/main.ts:1405-1419` | `app-restart` 通道无发送方校验 | `isAppRestartIpc` 只认字面量 `'app-restart'` 或 `{type:'app-restart'}`，来源是 DSH 子进程 message 通道；客户端 bundle 侧护栏不覆盖此处 | 主进程侧补来源/频率护栏与审计，或桥接层白名单发送方 |
| A-F05 | 🟠 | `src/desktop-host.ts:74-88` | 自相矛盾死代码 | `:85`（remove）、`:86`（names 为空）、`:87`（兜底）**三支全 `return true`**，与注释 `:73` 承诺的"add/update 必须能解析到包才算成功"矛盾 | 删死分支，改为 `stateChanged \|\| 已解析到包` |
| A-F06 | 🟠 | `src/main.ts:395-406` | 退出丢在飞写盘 | 浏览历史入 `browserHistoryQueue` 后由 2000ms 定时器落盘；`shutdownDesktop`/窗口 `close` 只调 `saveBrowserWorkspace()`，**从不 flush 该队列** → 退出前 ≤2s 历史静默丢失 | shutdown/close 路径显式清空队列并同步落盘 |
| A-F07 | ⚪ | `src/window-state.ts:1-8` vs `src/feature-panels.ts:66` | 注释/文档与实现矛盾 | 实现是 `shouldStartMaximized()` 恒 `true` + `maximize()`；面板声明"窗口位置/大小记忆" | 二选一：实现真实持久化，或改描述为"固定最大化" |
| A-F08 | ⚪ | `src/feature-panels.ts:55,59,112,114,126,130` | 文档过期（功能索引失真） | `:59` 指向已退役的 codex-ui 双拷贝；`:112` 指 `desktop-bridge.mts` 而同文件 `:24` 指 `desktop-bridge-client-source.ts`；`:126,130` 写 `App/dsh-runtime/...0.1.2-rc.1` 而 `bundled-plugins.ts:11` 是 `0.1.7-rc.2` | 按当前结构刷新（该文件自带"必须同步 07-功能清单"约束，属自违约） |
| A-F09 | ⚪ | `src/main.ts:3038, 3055-3059` | 死代码双实现 | `DISMISS_DSH_SETTINGS_DIALOG_SCRIPT` 与 `dsh-view-preload.cts:192-202` 逐行等价 | 收敛为单一实现 |
| A-F10 | ⚪ | `src/main.ts:824-830` | 忙等 + 残留 | 取句柄后同步忙等最多 10s（`:825-828`）不响应退出；handoff 文件仅成功路径删除（`:829`），超时抛错即残留 `Data/Updates/Desktop/handoffs/*.json` | 等待可中断；失败路径也清场 |
| A-F11 | ⚪ | `src/main.ts:4011-4015` | 静默降级 | `new Tray(icon)` 失败只 `return`；托盘是退出/检查更新的唯一入口，`icon` 也可能来自 `nativeImage.createEmpty()` | 记日志并保证仍有退出入口 |
| A-F12 | ⚪ | `src/desktop-host.ts:250-251`（使用点在 `:93/:104/:112`）、`:120`、`:206/211` | 可维护性（非运行错误，ESM 导入提升） | 静态导入文本上晚于使用点；`_invokingDir` 未使用；`killDeadline` 超时分支写后即弃 | 导入移文件头，删死信息 |
| A-F13 | ⚪ | `src/contained-settings-window.ts:54-58, 64, 67-84` | 资源处置不对称 | 注释称 OS 摆放触发 `child.on('move', syncAfterSettle)`，实际绑的是 `sync`（`:64`）；`dispose` 里 `removeListener('closed', dispose)` 移除的是 `once` 包装 | 语义对齐或改注释；只清真正注册的监听 |
| A-F14 | ⚪ | `src/desktop-host.ts:282-321, 323-332, 353-357` | 桥接安装非原子 | 逐文件 `copyFileSync` + 裸 `writeFileSync` 覆盖 profile `package.json`/`cordis.patch.yml`（同期 `plugin-seed` 走原子 helper）→ 中途断电留半套桥接 | 复用 `writeTextFileAtomicSync`；安装改"临时目录 + 原子替换" |
| A-F15 | ⚪ | `src/desktop-bridge-migration.ts:13` | 边界/错误处理 | `JSON.parse(readFileSync(manifestPath))` 无 try；profile 清单损坏时异常冒到 `main.ts:1025` → 用户看到启动失败页而非"跳过迁移继续启动" | 解析失败 warning 并跳过（下次启动重试） |
| A-F16 | ⚪ | 22 处（本单元 8 处） | 官方铁律：空 `catch` 必须点名吞掉的错误 | 本单元：`main.ts:829,846`、`browser-workspace-sessions.ts:28`、`browser-library.cjs:28,358,412,435,457`；另 14 处落 `assets/*.html`、`scripts/prepare-runtime.ts:48-49`、`plugin-seed.ts:321`、`portable-desktop-update.ts:715`、`runtime-pnpm-layout.ts:9` | 逐处补"吞掉什么 + 为何安全"注释 |

## 无法核实（需实跑 / 真实 Loader）

1. A-F01 实际可利用性：当前 Electron 对 camera/microphone/geolocation/notifications 的默认裁决。
2. A-F02 端到端：DSH 页面侧 `executeJs` 的真实调用方是否另有门禁。
3. `browser-library.cjs:518` `session.extensions.loadExtension` 在当前 Electron 的存在性与权限行为。
4. `main.ts:1945` `will-attach-webview` 与页面实际下发的 partition 名是否一致（不一致=功能不可用而非越权）。
5. `browser-library.cjs:297-307` DPAPI 子进程在用户环境（PS 5.1 + `Add-Type -AssemblyName System.Security`）是否可用。
6. `orphan-sweep.ts:36` 在无 PS 5.1/受限策略机器上的行为（静默空数组 → 孤儿不清扫）。
7. `main.ts:2850-2870` 心跳/bounds 与 `swapBrowserTabsForSession`（`:1632-1666`）在真实多会话切换下的表现。
8. 快捷键 `CmdOrCtrl+Shift+Plus` 在真实键盘布局下是否命中 `input.key==='='`。
9. 偏好原子写在杀软持有目标文件时的 EPERM 重试是否足够。
10. `main.ts:683-712` 恢复路径在含历史超宽 `ratio 0.75` 的真实 `browser-workspace.json` 下的收敛结果。
