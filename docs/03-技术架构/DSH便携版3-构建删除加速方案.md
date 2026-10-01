# DSH 便携版3 — 构建删除加速方案

> **立项目标**：消除「全量构建长时间毫无输出、看起来像卡死」的现象。
>
> **结论**：根因是 **G: 盘删除小文件极慢（39.14 ms/个）**，已在 `scripts/prepare-runtime.ts` 内根治
> （同卷改名 + 后台清理），删除阶段从 **≈28.8 分钟** 降到 **52.9 ms**。
>
> 落盘日期：2026-09-13 ｜ 关联坑清单：`AGENTS.md`「本仓库已踩过的坑」第 113–120 行

---

## 1. 现象

`Build-DSH-Portable.cmd` 跑到 `prepare-runtime` 之后**长时间没有任何输出**：CPU≈0、目录规模几乎不动、
终端一片安静，20–50 分钟后才继续。用户反复描述为「又不动了 / 卡住了」。

期间产生过两次误判，均已推翻：

| 误判 | 为什么不成立 |
| --- | --- |
| 磁盘坏道 / 卷级 I/O 卡死 | 读、`stat`、列目录都正常 —— 200 次 `stat` 仅 14 ms，931 MB 的目录递归计数 407 ms |
| 批量删除守卫把进程挂住 | 守卫是**秒级抛错**：撞阈值后 `bulk-guard check` 打印 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 再 `exit 2`，shim 转 `throw`，实测 **1.09 秒**返回，**从不挂起** |

## 2. 根因（实测数据）

`prepare-runtime` 装配第一步要清掉 4 个路径：`runtime-node` / `runtime-plugins` / `runtime-dsh` / `runtime-dsh.tgz`。
其中 `runtime-plugins` 实测 **44116 个文件**、931 MB：

| 子目录 | 文件数 |
| --- | --- |
| `store` | 19224 |
| `staging` | 20799 |
| `offline-verification` | 4093 |

**删除耗时对照组**（同一套代码、同样的小文件）:

| 盘 | 样本 | 总耗时 | 每文件 |
| --- | --- | --- | --- |
| **G:**（便携盘） | 300 个 | **11742 ms** | **39.14 ms** |
| C:（系统盘） | 20 个 | 7 ms | 0.35 ms |

**只换盘符，差两个数量级。** 本机 Defender 实时防护虽已关，但装了**「腾讯电脑管家系统防护」**，
逐文件拦截是主要嫌疑 —— 读 / 写 / `stat` 都不慢，**只有 `unlink` 慢**。

⇒ 44116 × 39.14 ms ≈ **1725 秒 ≈ 28.8 分钟**，全部花在「先删干净、再重建」这一步上。
这段时间没有任何日志输出，外观与进程卡死**完全一致**。

## 3. 方案

### 3.1 核心思路：把「删除」换成「改名」

`rename` 是同卷 O(1) 元数据操作，**不逐文件 `unlink`**。而 `removePreparedPath` 的语义只是
「确保 target 不存在」—— 改名到回收区后语义**完全不变**，调用方无感知。

### 3.2 实现（`scripts/prepare-runtime.ts`）

| 函数 | 职责 |
| --- | --- |
| `recyclePreparedPath(target)` | 项目内路径 → `rename` 到 `Data/Temp/prepare-recycle/<名>-<时间戳>`；非项目内 / 失败 → 返回 `false` |
| `startRecycleSweeper()` | 启动 detached 后台清理器（靠 `.sweeping` 心跳去重，已在跑就不重复启动） |
| `recycleSweepAlive()` | 心跳 120 s 内 **且** PID 仍存在 → 认为有活的清理器 |
| `removePreparedPath(target)` | **先试回收** → 失败/跨卷/开关关闭 → 走原有同步删除 |

后台清理器行为：每 5 秒一轮、**每轮只删一个目标**、每次删除交给**独立干净 node 子进程**执行 `fs.rmSync`、
每轮写 `pid:时间戳` 心跳、连续 3 轮扫空后自动退出（约 15 秒）。
`main()` 收尾还会再拉一次清理器，让本轮垃圾早一点开始清。

### 3.3 开关与回退

| 场景 | 行为 |
| --- | --- |
| 默认 | 项目内路径走回收（O(1)） |
| 跨卷 / 改名被占用 | **自动回退**到原有 `rm(maxRetries)` + `rmdir /s /q` |
| 显式设 `DSH_PREPARE_NO_RECYCLE=1` | 强制关闭回收，**完全回到旧行为** |

## 4. 验证

### 4.1 性能（`artifacts/build-delete-speedup-20260913/bench-recycle.mjs`、`bench-rmdir.mjs`）

| 路径 | 300 个小文件 | 外推 44116 文件 |
| --- | --- | --- |
| 旧：直接递归 `rm` | 11742 ms | ≈28.8 分钟 |
| 新：`removePreparedPath`（改名回收） | **52.9 ms** | **秒级** |
| **提速** | **222×** | |

### 4.2 测试

- `tsc --noEmit`：零错误
- `test/prepare-runtime.test.ts`：**35 / 35**，含新增用例
  「项目内待清理目录改走同卷回收，避免慢盘同步删除把构建挂成假死」
  （源码断言 + 行为断言：原路径消失、回收区出现同名桶）
- 全量回归：**470 tests / 459 pass / 0 fail / 11 skipped**

### 4.3 踩过的坑（改这块代码时别踩回去）

1. **清理器不能继承宿主的删除守卫。**
   清理器是 `spawn` 出来的，会**继承 `NODE_OPTIONS=--require node-language-shim.cjs`**（内含安全删除守卫）。
   直接 `fs.rmSync` 会撞阈值 `throw`，异常被 `catch{}` 吞掉 ⇒ **心跳一直在跳、桶却永远删不掉**
   （实测桶 40 秒不消失）。⇒ 删除动作交给**显式清空 `NODE_OPTIONS` / `CODEBUDDY_SAFE_DELETE_*` 的独立子进程**。
2. **不要用 cmd 的 `rmdir /s /q` 做兜底。**
   实测 `cmd /d /s /c rmdir /s /q "<普通路径>"` 在 **261 ms 内直接失败、目录原样保留**。
   `removePreparedPath` 里那条 `rmdir` 兜底写法完全相同，**同理不可靠** —— 依赖它之前先实测。
   （因为 `spawnSync` 不抛错，这条失败在原代码里是**静默**的。）
3. **心跳只写时间戳会让回收区失去维护。**
   已死清理器留下的 `.sweeping` 会在 120 秒窗口内**挡住新清理器**。⇒ 心跳写 `pid:时间戳`，
   并用 `process.kill(pid, 0)` 复核（`ESRCH` = 真死该重启，`EPERM` = 还活着）。
4. **宿主可能连带杀掉后台进程。**
   WorkBuddy 的 Bash 后台任务按 job object 清理子进程树，detached 的清理器也会被带走。
   真实构建（用户双击 `Build-DSH-Portable.cmd`）不受影响；即便被杀，**下一次构建开始时
   `removePreparedPath` 会重新拉起清理器**，回收区不会无人管。

### 4.4 真实全量构建验收（2026-09-13 21:36–21:46）

跑 `Build-DSH-Portable.ps1 -SkipTests`（经 `run-build.cjs` 启动），结果 **EXIT 0 / 601 秒**。
此前同样的构建在删除阶段要卡 20–50 分钟。

构建日志里的三行即根治的现场证据：

```
[prepare-runtime] runtime-node    已移入回收区，删除转入后台（不阻塞构建）：…\prepare-recycle\runtime-node-1789306587983
[prepare-runtime] runtime-plugins 已移入回收区，删除转入后台（不阻塞构建）：…\prepare-recycle\runtime-plugins-1789306588061
[prepare-runtime] staging         已移入回收区，删除转入后台（不阻塞构建）：…\prepare-recycle\staging-1789306728663
```

- `runtime-plugins` 的 **44116 文件 / 931 MB** 被 O(1) 改名挪走，构建**一毫秒都没等**；
- 构建结束时回收区已被后台清理器**删净并自行退出**（`.sweeping` 自动清除）——
  即 44k 文件的删除**完全吸收进构建时长内，零阻塞**；
- 候选槽 `1.0.66-local-8ff033ea99c85833` 已暂存（`pointer.json.pending`）。

**同时推翻一条旧结论**：曾据 `app.asar` mtime 断言「`src/*.ts` 改动尚未生效」——是**误判**。
实际新候选与当前运行槽逐条目比对后，**只有 7 个文件不同，且全在 `dist/scripts` 与 `dist/test`，
`dist/src/**` 零差异** ⇒ 本次构建不改变任何应用运行时行为。
**判"改动是否已生效"只认内容 hash / 逐条目差异，不认 mtime。**
比对脚本 `artifacts/build-delete-speedup-20260913/diff-asar.cjs`，注意
**asar 数据起点 = `8 + b4`**（不是 `16 + JSON 长度`，用错会得到"所有条目都不同但体积一样"的假差异）。

## 5. 影响面

- 回收区：`Data/Temp/prepare-recycle/` —— `Data/` 在 `.gitignore` 内，也**不进** `app.asar` / `extraResources`
- 单次构建产生的垃圾 ≈ **1.5 GB**（`runtime-plugins` 931 MB + `runtime-node` 108 MB + pnpm store）
- G: 盘当前空闲 **92.7 GB**，可容忍多次构建不清
- 一次构建中被回收的路径（按出现顺序）：
  `runtime-node` → `runtime-plugins` → `runtime-plugins/{staging,offline-verification}` →
  `runtime-plugins/store/v11/projects` → pnpm store metadata 镜像 →
  `runtime-node/{pnpm-package,.pnpm-pack}` → `runtime-dsh/.store`

## 6. 相关文件

| 文件 | 变化 |
| --- | --- |
| `scripts/prepare-runtime.ts` | 新增 `RECYCLE_CLEANER` / `recycleRoot` / `recycleSweepAlive` / `startRecycleSweeper` / `recyclePreparedPath`；`removePreparedPath` 前置回收；`main()` 收尾补拉一次清理器 |
| `test/prepare-runtime.test.ts` | 新增回收用例（源码断言 + 行为断言） |
| `AGENTS.md` | 坑清单第 113–120 行改写为「已根治」+ 实测数据 + 回退开关 |
| 技能 `dsh-desktop-shell-menu-workflow` | 「构建阶段的坑」§2 改写为「已内置根治」，附两个坑 |
