# P-B 任务单（R-13 / R-14 / R-15 / R-16）

> 派发者：DSH 审核会话（分配者）｜执行者：MiMo Desktop
> 仓库根：`G:\DSH-3-Portable`｜随包 Node：`App\resources\node\node.exe`

## 独占文件范围（**只允许改这几个，别的文件一律不许碰**）

```
src/harness-runtime-candidate.ts
src/session-path-repair.ts
src/runtime-prebuilt.ts
src/atomic-file.ts
test/harness-runtime-candidate.test.ts   （若无则新建）
test/session-path-repair.test.ts         （若无则新建）
test/runtime-prebuilt.test.ts            （若无则新建）
test/atomic-file.test.ts                 （已存在，可增用例）
```

**禁入（特别注意）**：`src/main.ts`（**别的会话刚改过，碰它必然冲突**）、`Data/**`、`pointer.json`、`.git/**`、`App/**`、`node_modules/**`、`Data/Updates/Desktop/slots/**`。

## 要修的四条

### B1 — `src/harness-runtime-candidate.ts:76`：来源白名单漏 `https://`

现状：`if (/(?:^|\s)(?:tarball:\s*)?(?:http:\/\/|git\+|git:|file:)/im.test(lock))` 只拦 `http://`/`git+`/`git:`/`file:` ⇒ **`https://` 形式的 tarball 来源可穿过**"lockfile 含非允许来源"门禁。

要求：
- 白名单改为**显式允许**可信域（npm registry：`registry.npmjs.org` / `registry.npmmirror.com`，按本仓既有口径），其余 `http(s)://`、`git+`、`git:`、`file:` 一律拦下。
- 保持对"lockfile 里出现任意字符串 tarball URL"的拦截能力；给正例/负例各写一个测试用例（`https://evil.example/x.tgz` 必须被拒；registry 域必须通过）。
- 不要放宽 `integrity` 校验（`expectedNpmIntegrity` 那段保持不动）。

### B2 — `src/session-path-repair.ts:48-59`：失败时删备份 + 崩溃窗口后必然 EEXIST

现状：`:49` 备份 → `:52 copyFile(COPYFILE_EXCL)` → `:55 rename`；**`:57` 在 rename 失败时删掉刚写好的备份**；且备份已存在时重跑会因 `COPYFILE_EXCL` 抛 EEXIST ⇒ 自愈永久失效。

要求：
- rename 失败**不得**删除备份（备份是唯一还原依据）。
- 备份写入改为**幂等**：目标备份已存在时，比较内容 sha256，一致则视为"备份已完成"继续；不一致则报明确错误（**不要**静默覆盖）。
- 调用点 `src/main.ts:1027` **不允许改**（禁入）；因此请在**本文件内部**做到"异常不外泄到启动路径"：导出的 `repairMisplacedSessionLogs` 对**单个会话**的失败要捕获、记录并继续处理其余会话，最后把失败清单返回或打印，**不得因为一个坏会话让整个启动流程抛错**。
- 保持"不改写会话日志字节"的既有约束。

### B3 — `src/runtime-prebuilt.ts:24-30`：完成判据过弱

现状：`existsSync(官方入口)` → 返回 `'skipped'`；`cpSync(recursive, force:false)` 直接写目标，无暂存、无完成标记 ⇒ 中断后残缺运行时被**永久跳过**。

要求：
- 改为"**复制到临时目录 → 校验入口 → 同卷改名 → 写完成标记**"；判据改用完成标记（而非仅入口文件存在）。
- 保留对**已存在完整目标**的快速跳过（不要每次重拷贝）。
- `force:false` 不足以补全残缺目录——请在记录里说明你如何处理"目标已存在但残缺"的情况。

### B4 — `src/atomic-file.ts:66-77`：同步落盘失败可能新旧俱毁

现状：`writeFileSync(tmp)` → `renameWithRetrySync`（5 档延迟后抛错）→ `finally` 删掉 `tmp`（唯一副本）；Windows rename 覆盖语义下失败后目标状态不确定。

要求：
- 失败路径**保留**临时文件（或先备份目标再改名），确保任何失败分支都**至少有一份完整内容**可恢复。
- 不要改变正常路径的语义（`writeTextFileAtomicSync` 的原子性）。

## 硬约束

1. 只改上面列出的文件；越界即打回。**特别重申：不要动 `src/main.ts`。**
2. 不得删测试、放宽断言、把失败改 skip、写死哈希。
3. `tsc --noEmit` 必须保持退出码 0。
4. 每条修复都要有能**真失败**的测试：用"故意破坏被测行为 → 复跑变红 → 改回"自证一次，记录里贴两次输出；**破坏不要留在文件里**。

## 验收命令（你必须跑并把输出摘要写进记录）

> **重要**：同时有多个包在改同一个仓库。**不要跑 `tsc`、不要跑全量测试**——那会重写共用的 `dist/`，与其他包互相污染。只跑你**自己受影响的测试文件**；`tsc` 与全量测试由派发者串行统一执行。

```powershell
Set-Location G:\DSH-3-Portable
& .\App\resources\node\node.exe .\scripts\run-tests.mjs dist\test\harness-runtime-candidate.test.js
& .\App\resources\node\node.exe .\scripts\run-tests.mjs dist\test\session-path-repair.test.js
& .\App\resources\node\node.exe .\scripts\run-tests.mjs dist\test\runtime-prebuilt.test.js
& .\App\resources\node\node.exe .\scripts\run-tests.mjs dist\test\atomic-file.test.js
```

**当前基线**：全量 665 / 635 过 / 4 失败 / 26 跳过（那 4 个失败与你无关）。

## 交付

执行记录写到：`docs\01-当前工作\audit-20260926\P-B-执行记录.md`
内容：逐条（B1–B4）改动前后对照、命令与输出摘要、**自证红/绿两次输出**、未完成项、越界自检（明确写出"未修改 `src/main.ts`"）。
