# 审核单元 B 取证报告（src · 状态 / 更新 / 运行时装配）

> 来源：穷尽式只读审核单元 B（子代理会话），2026-09-26。本文是**证据留档**，未修改任何文件。
> 索引见 [全项目审核总报告](../便携版3-全项目审核总报告与修复清单.md)。
> 范围：`src/` 下 19 个状态/更新/运行时文件，**全部读完（无抽样）**。
> 复核：**D1、D6 已由主会话独立复核为真**（见文末「主会话复核」）。

## 覆盖与结论

- `src/` 全量枚举 = **55 个 `.ts`**（`.` 模式触发 20MB 上限 → 结果落盘后用 `^src\` 提取，清单完整无遗漏）。
- 本单元已审 19 个；无需审 36 个（上级已审 9 个 + 范围外 27 个纯判定/序列化/布局/清单文件）。
- **无 P0，6 个 P1，12 个 P2，4 个 P3。**
- 全程 grep：**无** `as any` / `as unknown as` / `@ts-ignore` / `@ts-expect-error` / eslint-disable（仅 3 处非空断言：`portable-desktop-update.ts:751`、`runtime-pnpm-layout.ts:18`、`shell-actions.ts:172`）。
- 已申报项（`runtime-slots.ts:57-61`、`:181-190`、`process-control.ts:7-13`、`harness-update.ts:482-493`、`main.ts:829/846`、`harness-shadow.ts:43,44`、`portable-desktop-update.ts:422,572`）**未重复上报**。

## P1 Findings

| # | 文件:行 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| B-D1 | `extract-runtime.ts:210-238`（关键 `:213`、`:225-234`） | **Windows 上原地增量覆盖正在使用的运行时目录**，非"暂存→改名提交" | `:213 rmSync(completeMarker)` 先删完成标记 → `:226-228` Windows 分支 `mkdirSync(destDir)` + `copyExtractedTree`（逐文件 `copyFileSync :264`）；只有非 Windows 才 `:230-231 rm+renameSync` 原子提交。`:225` 的二次 `isExtractionCurrent` 只防重复解压，不能让覆盖原子化 | 改为"新版目录 + 同卷改名/指针切换"；覆盖前先把旧目录改名 |
| B-D2 | `session-path-repair.ts:25-64`（关键 `:49-59`）+ 调用点 `main.ts:1027` | **调用点无 try/catch，且改名失败时删掉刚落盘的备份** | `:49` 备份 → `:52 copyFile(COPYFILE_EXCL)` → `:55 rename`；`:57` 改名失败**删备份**。`main.ts:1027` 无 try/catch（对比 `:1001/:1013` 都有）⇒ 任何 `assertWithin`/`readSessionHeader` 抛出即中断启动；`:44-46` 目标已存在则每次启动都抛同一错 | 调用点兜底；失败**保留**备份 |
| B-D3 | `session-path-repair.ts:48-59` | 崩溃窗口后**必然 EEXIST**，自愈永久失效 | 进程在 `:52` 与 `:55` 之间被杀 ⇒ 备份残留、会话未动；下次 `:52 COPYFILE_EXCL` 直接 EEXIST 抛出。叠加 D2 会中断启动 | 幂等备份判定（sha256）+ 临时名两步改名 |
| B-D4 | `atomic-file.ts:66-77` | 同步落盘失败可能**新旧内容一起丢** | `:69 writeFileSync(tmp)` → `:75 renameWithRetrySync`（5 档延迟后抛最后一次错误）→ `finally` 删掉 `tmp`（唯一副本）；Windows `renameSync` 覆盖语义下失败后目标状态不确定。调用方含 modules 状态 / 插件 manifest / 运行时指针 | 失败路径保留临时文件，或先备份目标 |
| B-D5 | `runtime-prebuilt.ts:24-30` | 完成判据 = **单文件存在**；重启后残缺运行时被永久 `skipped` | `:25 existsSync(官方入口)` → 返回 `'skipped'`；`:28 cpSync(recursive, force:false)` 直接写目标，无暂存、无完成标记。中断后残缺运行时之后每次启动都被跳过，`force:false` 也不补全 | 复制到 `.partial-<uuid>` → 校验 → rename → 写完成标记；判据换标记 |
| B-D6 | `harness-runtime-candidate.ts:52-57 / 76-78 / 38-62` | 三处：①复用分支**从不读**槽内指纹；②**来源白名单漏 `https://`**；③成功后残留孤儿 `.staging-*` | ①`:55` 只与同函数重算值比对，`:50` 写的 `.dsh-runtime-fingerprint` 改名后不再验证；②`:76` 正则只列 `http://`/`git+`/`git:`/`file:`，**`https://evil/...` 直接穿过**"lockfile 含非允许来源"门禁；③`:58 rename` 之后 `finally :61 rm(stagingDir)` 落空 ⇒ 每次成功构建在 `slots/` 留一个孤儿 `.staging-*` | ①复用必须比对槽内指纹；②显式允许 registry 域 + integrity；③成功后清理 staging |

## P2 / P3 Findings（摘要）

| # | 级别 | 文件:行 | 问题 |
|---|---|---|---|
| B-D7 | 🟠 | `recovery-mode.ts:186-228, 248-269, 271-323` | 三大写入口（`enterRecoveryMode` / `restoreRecoveryPlugin` / `uninstallRecoveryPlugin` / `leaveRecoveryMode` / `tryAutoLeaveRecoveryMode`）在 `src/` 内**无调用者**（只有 `plugin-seed.ts:11` 导入只读的 `restrictProfileBundlesForRecovery`）；`:152` 只清 `pendingRestore`，不把 bundles 加回 → 恢复模式一旦进入，用户插件只能重装 |
| B-D8 | 🟠 | `desktop-updater.ts:79-85`（同类 `desktop-theme.ts:72`） | 坏数据静默替换为**会改变行为**的默认值：`:82 catch → DEFAULT_UPDATE_PREFERENCES`，用户 `manual`（禁自动检查）在文件损坏后静默变 `notify`，`:71-72` 随即放行自动检查 |
| B-D9 | 🟠 | `profile-quarantine.ts:93-102` | 提交点倒置 + 无互斥：`:93` 先改 manifest 摘 bundle，`:95-98` 才写 journal；中间崩溃 ⇒ 磁盘已隔离但 journal 无记录。`readJournal→writeJournal` 读改写无锁，与 `main.ts:1517`、`profile-repair.ts:67,92` 并发会互相覆盖 |
| B-D10 | 🟠 | `harness-runtime-candidate.ts:80-82` | `readdir(scopeRoot)` 无存在性守卫，缺失时抛 ENOENT（泄漏本机绝对路径）而非受控结论 |
| B-D11 | 🟠 | `dsh-process.ts:64-108`（关键 `:87-90`、`:121-128`） | ①`clearTimeout` 后 `waitForHttpHealth` 再给满一份 ⇒ 最坏总预算 2×120s；②`child.on('message')` 在**就绪之后**才挂 ⇒ 就绪前桥接发出的 IPC（如 `request-harness-update`）无监听者而丢失 |
| B-D12 | 🟠 | `harness-update.ts:417-421` | tag 核对失败被吞 `continue`，`:457-459` 仍返回 `updateAvailable:true`；构造时写入的 `automaticBlockReason`（`:451-453`）不在返回类型里 ⇒ 调用方拿不到阻断原因 |
| B-D13 | 🟠 | `recovery-mode.ts:208-227, 279-284` | isolated 只收录"原始 bundles 里"的名字、`pendingRestore` 只在 `restoreRecoveryPlugin` 里加回（D7 未接线）⇒ 分流不一致；`:283` 在 `exactOptionalPropertyTypes` 下是类型面妥协 |
| B-D14 | 🟠 | `profile-watch.ts:63-73, 86-92` | `retries` 每次事件清零 ⇒ 250ms 轮询可无限续命；轮询用 `readFileSync` 阻塞主进程；读失败全落空串，与清单损坏不可区分且不告警 |
| B-D15 | 🟠 | `harness-shadow.ts:34-45` | 签名为 `Promise<void>`，server 只在 `finally` 用，验证走到的分支/退出码/错误文本**全丢**；调用方（`main.ts:3792`）只能把"无异常"当通过；canary 残留无清理上限 |
| B-D16 | 🟠 | `profile-bundle-health.ts:47-63, 72-88` | 指纹只覆盖插件自身文件 + **直接**依赖 `package.json` 哈希，不含传递依赖/lock ⇒ "矩阵漂移但直接 manifest 未变"不改指纹；`hasRootExport :78` 用否定式判定，`exports:{import:…}` 缺 `"."` 也判为根导出 |
| B-D17 | ⚪ | `portable-desktop-update.ts:354-358` | 失败清理 `.catch(()=>undefined)` 与成功路径 `:349` 不对称，失败残留无告警（上级已覆盖其结论，未重复） |
| B-D18 | ⚪ | `desktop-updater.ts:93-96` | `desktopUpdateChannel` 对非 darwin 一律 `undefined`，与"仅 Windows 发行"矛盾，注释/接口语义不明 |
| B-D19 | ⚪ | `runtime-pnpm-layout.ts:7-24` | `as Record` + `JSON.parse` → 重写整份文本，会丢原始格式 |
| B-D21 | ⚪ | `atomic-file.ts:40-49` | `sleepSync` 退路是忙等，最坏 775ms 满核自旋（Electron 主进程正是触发环境） |
| B-D22 | ⚪ | `dsh-process.ts:37` | 模块级读 env 生成常量（`DSH_WEB_LAUNCH_ARGS`），import 后改 env 不生效 |

## 空 `catch` / `.catch(()=>undefined)` 逐处判定（本单元范围）

- **可接受回落**：`atomic-file.ts:35`、`readiness.ts:17`、`extract-runtime.ts:175,291,306`、`dsh-process.ts:189`、`runtime-pnpm-layout.ts:9`
- **改变行为且无告警（应修）**：`desktop-updater.ts:82`（D8）、`recovery-mode.ts:93,108,138`（D7/D13）、`profile-quarantine.ts:118`（D9）
- **把坏数据当缺数据**：`profile-bundle-health.ts:31,105`、`profile-watch.ts:19,89`（D14）
- 已申报不重复：`harness-shadow.ts:43,44`、`harness-runtime-candidate.ts:61`、`session-path-repair.ts:57`（已升级为 D3）

## 主会话复核（2026-09-26）

| 项 | 复核结论 |
|---|---|
| B-D1 | ✅ **为真**。`extract-runtime.ts:210-237` 实读：Windows 分支确为 `mkdirSync(destDir)` + `copyExtractedTree`（逐文件复制），非 Windows 才是 `rm + renameSync`；`:213` 确实先删 `.dsh-extract-complete`。 |
| B-D6② | ✅ **为真**。`harness-runtime-candidate.ts:76` 正则 `(?:http:\/\/\|git\+\|git:\|file:)` **不含 `https://`**，`https://` 形式的 tarball 来源可穿过该门禁。 |
| B-D6③ | ✅ **为真**。`:58 await rename(stagingDir, destination)` 成功后，`finally :61` 的 `rm(stagingDir)` 必然落空（`.catch(()=>undefined)` 静默吞掉），故成功后无残留但**失败或重入路径**会留下 `.staging-*`（与 §38 的 `mkdtemp` 位置一致）。 |

## 无法核实（需实跑 / 需补范围）

1. shell 不可用，全部结论为静态推断，未实机复现；范围外 36 个文件行数为约值。
2. `test/` 未逐文件核对 ⇒ **B-D7 只能断言"`src/` 内无调用者"**，若测试直接调用则性质降级。
3. **`grep` 跳过 `.gitignore` 的 `Data/**`** ⇒ 无法排除 `Data/` 内桥接或本地插件仍调用 `recovery-mode` 导出，直接影响 B-D7/B-D3 严重度（需用不依赖 grep 的方式复核）。
4. `main.ts` 只读了 `:1000-1089`；`portable-desktop-update.ts` 只读了 `:330-449` 与 `:620-679` ⇒ B-D11/B-D17 的"调用方后果"可能低估。
5. B-D6② 的 `https://` 漏项是事实，但"能否被实际利用"未做 PoC。
