# 交给 Codex 执行 · 第 1 批任务单（让"绿"可信）

> 派发者：DSH 便携版 3 审核会话（分配者角色）｜执行者：Codex（`codex exec`，ChatGPT 登录，模型 `gpt-5.6-sol`）
> 仓库根：`G:\DSH-3-Portable`（`~/.codex/config.toml` 已把 `g:\dsh-portable` 标为 trusted）
> 背景与全部证据：[问题总登记册.md](问题总登记册.md)、[覆盖矩阵](00-覆盖矩阵.md)、[总报告 §6](../便携版3-全项目审核总报告与修复清单.md)
> 定稿时间：2026-09-26

---

## 0. 为什么要先做这一批（不要跳过）

门禁实测（2026-09-26，`App/resources/node/node.exe`，Node **v24.20.0**）：

```
tsc --noEmit                      → 退出码 0（通过）
scripts/run-tests.mjs             → 653 项 / 通过 622 / 失败 6 / 跳过 25（退出码 1）
```

6 个失败中有 2 个**正是本批要修的问题**：

| 失败用例 | 实际错误 |
|---|---|
| `#117 custom spaces precede billing through native slot ordering…` | `ENOENT: …\local\dsh-custom-spaces\lib\client.js` |
| `#624 installed UI keeps local plugin links, enabled bundles and accepted content` | `UI drift: …dsh-better-sidebar/lib/client.js`、`UI drift: …dsh-custom-spaces/lib/client.js` |

**这批的目的一句话**：让"全绿"重新有意义——现在的绿是假的（CI 会红、护栏在 CI 空转、假门禁能过、门禁自己还坏了）。

---

## 1. 硬约束（违反即打回）

1. **只改本任务单列出的文件**。不得动 `Data/`、`pointer.json`、`.git/`、`App/`、`node_modules/`、任何槽（`Data/Updates/Desktop/slots/**`）、任何用户数据。
2. **不得为了让测试变绿而**：删测试、改断言放宽、把失败改 `t.skip`、写死哈希、绕过门禁。若发现某条断言本身写错了，**只允许在任务单明确授权时**改，并在提交说明里写明理由。
3. 每个任务独立提交（或用清晰的变更块分隔），完成后给出：改了哪些文件、每处改动的**前后对照**、跑了什么命令、命令输出摘要。
4. **不要顺手修**任务单以外的问题（本仓有 168 条待修，越界会破坏验收）。
5. 全程使用随包 Node：`App/resources/node/node.exe`（**不要用系统 Node**）。
6. PowerShell 脚本若含中文，必须保持 **UTF-8 BOM**（`Start-DSH-Portable.ps1`、`Portable-Environment.ps1` 等已有 BOM，勿破坏）。

---

## 2. 任务清单（按顺序做，可并行 2 条以内）

### T1 🔴 修复 UI 基线的死锁（失败 #624 + 让 `--record` 重新可用）

**现状（已实测）**
- `scripts/ui-baseline.mjs:19` 的 `protectedPaths` 含 `Data/DSH/profiles/web/local/dsh-custom-spaces/lib/client.js`，但该目录 2026-09-26 已改名为 `local/dsh-custom-spaces.disabled/`。
- `customizations/ui/baseline.json` 里有**两条同一哈希** `bafee4dedd11bd25bb4fa7c05d83a4aaf59ad84287bd96b7efd72ff8edb409f2`：
  - `customizations/custom-spaces/lib/client.js` → 实读**一致**（归档件没动）
  - `Data/DSH/profiles/web/local/dsh-custom-spaces/lib/client.js` → 文件**不存在**
- 后果一：`verifyBaseline` 默认 `live=true`（`:105`）→ 必报 `UI drift`（失败 #624 第二条）。
- 后果二：**`recordBaseline:75-77` 对每个 `protectedPaths` 调 `content()`，文件不存在会直接抛错** ⇒ `ui-baseline.mjs --record` 现在**跑不起来**，漂移无法登记。

**要做**
1. 在 `scripts/ui-baseline.mjs` 中把"不存在就把 `Data/…/dsh-custom-spaces/lib/client.js` 当保护路径"的设定去掉或改为**按实际存在性解析**（推荐：把该条从 `protectedPaths` 移除，保留 `customizations/custom-spaces/lib/client.js`；同时把 `localPlugins` 里的 `dsh-custom-spaces` 与其对应的一致性检查按"目录不存在则跳过并输出说明"处理，**不要静默通过**——要打印一条明确的跳过原因）。
2. 修正 `customizations/ui/baseline.json` 中那条指向不存在路径的记录（编辑该条或重新生成基线），使 `verifyBaseline` 通过。
3. **然后**：`Data/DSH/profiles/web/local/dsh-better-sidebar/lib/client.js` 的实际哈希是 `625ce9c50892ce7f94973ce9713a9c0251cd2ab43878dac7303f96092d696940`，而基线记录为 `0aea8089867e46fc89f1e5d3e07bf3982e67231b22d296dd751b018f50560dcc`（基线时点 `2026-09-24T19:05:06.253Z`，之后 09-25/09-26 的内嵌浏览器迁移没登记）。这是**合法的产品侧改动**，允许重记基线，但 `--record` 要求 `--note <docs/ 下的变更记录>` 与 `--evidence <通过的 UI 证据 JSON>`：
   - 先确认 `docs/01-当前工作/I023-前后端UI全项目审核/63-浏览器卡片内嵌组件迁移.md` 是否为该改动的合法记录；若是，用它作 `--note`。
   - 若缺 `--evidence`（需 `status:"pass"` 且含 `results` 数组的 JSON），**不要伪造**：改为在提交说明里写明"缺证据，未重记基线"，并把 T1 的验收限定为"`verifyBaseline` 对 custom-spaces 不再误报 + `--record` 的解析路径不再因缺文件抛错"。

**验收（必须贴输出）**
```powershell
Set-Location G:\DSH-3-Portable
& .\App\resources\node\node.exe .\scripts\ui-baseline.mjs            # 期望：无 "UI drift: ...dsh-custom-spaces..."
& .\App\resources\node\node.exe .\scripts\run-tests.mjs .\dist\test\ui-baseline.test.js
```

---

### T2 🔴 三个测试无守卫直读 `Data/`（CI 必红）

**现状**：`test/composer-border.test.ts:7`、`test/custom-spaces-layout.test.ts:17`、`test/browser-panel-layout.test.ts:198,222-223` 直接
`readFileSync('Data/DSH/profiles/web/local/...')`，**无 `existsSync` 守卫** ⇒ 全新检出（无 `Data/`）必然 ENOENT 整组失败。这违反 `AGENTS.md` 明文禁令。

**要做**：按仓库既有范式（例如 `test/agent-discipline.test.ts`）加守卫：
```ts
if (!existsSync(target)) return t.skip('实机产物缺失（CI 全新检出）')
```
注意三点：
- 守卫要放在**每个**依赖实机产物的用例里（`browser-panel-layout.test.ts` 有 3 处引用，逐个处理）。
- `composer-border.test.ts` 循环里同时读 `client.src.js` 与 `client.js` 两个文件，两个都可能缺失。
- **不要**整体 skip 整个文件——只有依赖实机产物的用例才 skip；纯逻辑断言必须继续跑。

**验收**
```powershell
& .\App\resources\node\node.exe .\scripts\run-tests.mjs
# 期望：这三组不再 fail。若能模拟 CI（临时把 Data\DSH 改名），则应为 skip 而非 fail。
```
> 允许的模拟方式：**不要真的改 `Data\DSH` 名字**（那是用户数据）。改为在提交说明里逐条列出"该用例现在有守卫"的证据（行号 + 守卫代码），并说明 CI 行为由守卫保证。

---

### T3 🔴 测试收集器漏跑子目录

**现状**：`scripts/run-tests.mjs:58-63` 的 `collectDefaultTargets()` 用 `readdirSync(testDir)`，**非递归**且只匹配 `.test.js` ⇒ `dist/test/` 下子目录里的测试会静默不跑（假绿）。

**要做**
1. 改递归收集（保持稳定排序）。
2. 加一条**自检**：收集数为 0 时直接报错退出（不能"0 个测试也算通过"）。
3. 顺带把 `scripts/portable-health/health.test.cjs` 纳入门禁（它现在没有任何门禁）——最简单可行的方式：在 `run-tests.mjs` 里显式追加该文件作为附加目标，并在输出里标明"附加目标"。若实现成本高，则退一步：只在 `scripts/gates.mjs` 里显式跑它，并在此说明。

**验收**
```powershell
& .\App\resources\node\node.exe .\scripts\run-tests.mjs    # 期望：总数 > 653（因为递归后多收了文件），且 0 fail（除 T1 相关）
```

---

### T4 🔴 无限重启护栏在 CI 空转

**现状**：`test/no-self-scheduled-restart.test.ts:21-22` 的 `const root = 'Data/DSH/profiles/web/local'` 无守卫 ⇒ CI 整条 skip。它是 2026-09-21「无限重启」事故的**唯一护栏**。另：`FORBIDDEN` 第一条 `/app-restart/` 过宽（注释里出现该词会误报），而 `AGENTS.md` 又明文教用 `'app-' + 'restart'` 绕过 ⇒ 既误报又可绕过。

**要做**
1. 加 `existsSync` 守卫（同 T2 范式，**允许** CI skip，但要把"CI 未覆盖"写进用例注释，并在提交说明里点明这是已知缺口）。
2. **扩大扫描面**：现在只扫 `local/*/lib/client.js|client.src.js`。补扫 `Data/DSH/profiles/web/node_modules/@michengai/*/lib/client.js`（随包社区插件）——同样要 `existsSync` 守卫。
3. **修误报**：把 `FORBIDDEN` 的匹配改为"**只匹配代码，不匹配注释**"——可行做法：先剥离 `//` 行注释与 `/* */` 块注释再匹配（保持对 `app-restart`/`app-quit` 的实际检出能力）。**不要**通过放宽正则来"消误报"。
4. 保留 `AGENTS.md` 允许的"拆字面量"写法不被误伤。

**验收**
```powershell
& .\App\resources\node\node.exe .\scripts\run-tests.mjs .\dist\test\no-self-scheduled-restart.test.js
# 另需自证正/负对照：构造一个含 app-restart 代码的临时文件应命中；只含注释的临时文件不应命中（用临时目录，勿改仓库文件）
```

---

### T5 🟠 `Build-UI-Only` 门禁 A 假绿

**现状**：`Build-UI-Only.ps1:131` 的 `$raw = & $git ... status --porcelain 2>$null` **不检查 `$LASTEXITCODE`**；git 失败时 `$raw` 为空 → 走到 `Write-Ok '除 assets\ 外没有需要重新打包的改动'`（假绿）。另：`browser-library.cjs` 在 `package.json` 的 `build.files` 内，却落到 `Get-DirtyVerdict`（`:58-65`）的 `return 'notice'` ⇒ 它的改动**不会**拦住界面快通道。

**要做**
1. git 调用后检查 `$LASTEXITCODE`；非 0 即视为**阻断**（block），并打印明确原因（"git 状态读取失败，无法判定是否有源码改动"）。
2. 把"进包文件"纳入 `block` 判定：至少 `browser-library.cjs`；更稳的做法是读取 `package.json` 的 `build.files` / `build.extraResources` 的 `from` 清单做通用判断（若实现成本高，就显式列 `browser-library.cjs` 并留注释说明为何）。
3. 保持现有"assets/* → skip"的行为不变。

**验收**
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build-UI-Only.ps1 -DryRun
# 期望：不再出现"除 assets\ 外没有需要重新打包的改动"这种在 git 失败时也会打印的绿字；
#       若仓库有 browser-library.cjs 的未提交改动，应被列为阻断项。
```
> `-DryRun` 不动任何文件，是允许的。

---

### T6 🟠 `session-path-repair` 调用点无兜底 + 失败删备份

**现状**：`src/session-path-repair.ts:49-57` 先备份（`COPYFILE_EXCL`）再 `rename`；`:57` 在 rename 失败时**删掉刚写好的备份**。调用点 `src/main.ts:1027` **没有 try/catch**（相邻的 `:1001`/`:1013` 都有）⇒ 任何 `assertWithin`/`readSessionHeader` 抛出都会**中断启动**。

**要做（保持语义不变，只加兜底与幂等）**
1. `src/main.ts:1027` 调用点包 try/catch：失败时记录到日志并**继续启动**（自愈失败不应阻断启动）。
2. `session-path-repair.ts`：rename 失败时**不要删备份**（备份是唯一还原依据）；或改为"只有确认目录已成功移动后才清理临时物"。
3. 让备份写入幂等：目标备份已存在且内容一致时视为已完成（用内容 sha256 判断），避免崩溃后重跑直接 `EEXIST` 抛错。**不要**放宽成"存在就覆盖"。
4. 保持"不改写会话日志字节"的既有约束。

**验收**
```powershell
& .\App\resources\node\node.exe .\node_modules\typescript\bin\tsc
& .\App\resources\node\node.exe .\scripts\run-tests.mjs .\dist\test\session-path-repair.test.js
```

---

## 3. 交付格式（我必须能据此验收）

在仓库内新建一份记录：`docs/01-当前工作/audit-20260926/Codex-第1批执行记录.md`，包含：
1. 逐任务：**改了哪些文件**（含行号区间）、**改动前后对照**（贴关键代码块）。
2. 逐任务：**跑了哪些命令 + 原始输出摘要**（含退出码）。
3. **未完成/未验证项**：如实列出（例如"缺 UI 证据未重记基线"）。
4. 明确声明：**未越界改动**（对照第 1 节硬约束逐条确认）。

最后**必须**跑并贴出：
```powershell
& .\App\resources\node\node.exe .\node_modules\typescript\bin\tsc
& .\App\resources\node\node.exe .\scripts\run-tests.mjs
```

---

## 4. 派发者（我）会独立复核什么

我不接受"我改好了"的结论，只接受门禁输出。收工后我会**自己**跑：

1. `tsc` 退出码；2. `run-tests.mjs` 的 `# tests / # pass / # fail / # skipped`；3. `ui-baseline.mjs` 是否还对 custom-spaces 误报；4. 失败 #117/#624 是否消失；5. 测试总数是否因 T3 递归而**增加**；6. `git status` 看你是否越界改了 `Data/`、槽、`App/`；7. 用**反向对照**验证：把某条守卫临时破坏，确认测试会红（证明守卫真起作用，而非恰好通过）。
