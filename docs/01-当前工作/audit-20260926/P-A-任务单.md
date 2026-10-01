# P-A 任务单（R-17 / R-18 / R-19）

> 派发者：DSH 审核会话（分配者）｜执行者：MiMo Desktop
> 仓库根：`G:\DSH-3-Portable`｜随包 Node：`App\resources\node\node.exe`

## 独占文件范围（**只允许改这三个，别的文件一律不许碰**）

```
src/runtime-slots.ts
src/process-control.ts
test/runtime-slots.test.ts        （若不存在则新建）
test/process-control.test.ts      （若不存在则新建）
```

**禁入**：`src/main.ts`、`Data/**`、`pointer.json`、`.git/**`、`App/**`、`node_modules/**`、`Data/Updates/Desktop/slots/**`。别的会话正在同一仓库工作，越界即与他人冲突。

## 要修的三条

### A1 — `src/runtime-slots.ts:57-61`：槽不可用时静默回退旧目录

现状：`resolveActiveRuntimeDir` 依次尝试 `pointer.current`、`pointer.previous`，两者都不可启动时第 61 行直接 `return resolve(legacyRuntimeDir)`——无异常、无日志。

要求：
- 保留"最后回退 legacy 目录"的**行为兼容**（下游依赖它启动），但**必须发出可观测信号**：用该模块能拿到的方式（`console.warn` 或返回带来源的标记，由调用方决定是否打印）。**不要改函数签名**，除非同时更新所有调用方（那会越界到别的文件——所以**优先不改签名**）。
- 在注释里写清：为什么保留该回退、它有什么风险（老运行时无家园绑定 → 会读 `Data/DSH`）。

### A2 — `src/runtime-slots.ts:181-190`：槽指纹缺失时伪造全零指纹并持久化

现状：`.dsh-runtime-fingerprint` 缺失/损坏时 `directoryFingerprint` 返回 `'0'.repeat(64)`，而 `isSlotReference` 只校验 64 位十六进制 ⇒ 假指纹被写进 `current.json` 与 `lastFailed`。

要求：
- marker 缺失/损坏时**不要**返回全零指纹冒充合法值；改为显式区分"无指纹"与"有指纹"（例如返回 `undefined` 并让调用方决定），且**不得**把全零值当作合法指纹落盘。
- 若因为类型/调用面限制无法彻底改，至少：缺失时打印警告 + 在写入指针处拒绝持久化全零指纹。
- 保证旧槽（真没有 marker 的历史槽）仍能加载——**不要**让兼容迁移失效。

### A3 — `src/process-control.ts:7-13`：`terminateProcessTree` 名不符实

现状：`spawn('taskkill', [...])` 后立即 `return`，既不 `await` 也不 `unref()`；Windows 分支没有等待进程树真正结束。

要求：
- 改为**返回 Promise**并等待 `close`/`exit`（含超时上限，比如 8 秒），或在不改签名时显式 `unref()` 并把语义写进注释与函数名附近的文档注释。
- **注意**：若改签名，调用方在别的文件（`src/dsh-process.ts`、`src/harness-runtime-candidate.ts`、`src/plugin-seed.ts`、`src/extract-runtime.ts`）——**这些不在你的范围**。所以：**保持签名兼容**（新增可选参数或返回 void 但内部 `unref()` + 注释），并在你的执行记录里说明你选了哪种以及为什么。

## 硬约束

1. 只改上面列出的文件；越界即打回。
2. 不得为了让测试变绿而删测试、放宽断言、把失败改 skip、写死哈希。
3. `tsc` 必须保持通过（`tsc --noEmit` 退出码 0）。
4. 新增/修改的测试必须能**真的失败**：请用"故意破坏被测行为"的方式自证一次（改坏 → 复跑变红 → 改回），并在记录里贴出这两次输出。**不要**把自证用的破坏留在文件里。

## 验收命令（你必须跑并把输出摘要写进记录）

> **重要**：同时有多个包在改同一个仓库。**不要跑 `tsc`、不要跑全量测试**——那会重写共用的 `dist/`，与其他包互相污染。只跑你**自己受影响的测试文件**；`tsc` 与全量测试由派发者串行统一执行。

```powershell
Set-Location G:\DSH-3-Portable
& .\App\resources\node\node.exe .\scripts\run-tests.mjs dist\test\runtime-slots.test.js
& .\App\resources\node\node.exe .\scripts\run-tests.mjs dist\test\process-control.test.js
```

**当前基线（供对比，别为了凑绿作弊）**：全量测试 665 项 / 635 通过 / 4 失败 / 26 跳过（那 4 个失败与你无关，不要动它们涉及的文件）。

## 交付

把执行记录写到：`docs\01-当前工作\audit-20260926\P-A-执行记录.md`
内容：逐条（A1/A2/A3）——改了哪几行、改动前后对照、跑了什么命令+输出摘要、**自证红/绿两次输出**、未完成项、越界自检（确认只碰了允许清单里的文件）。
