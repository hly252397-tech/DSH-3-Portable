# P-A 执行记录（R-17 / R-18 / R-19）

> 执行者：MiMo Desktop（本会话）｜派发者：DSH 审核会话
> 仓库根：`G:\DSH-3-Portable`｜随包 Node：`App\resources\node\node.exe`（Node 24.x / tsc 7.0.2）
> 任务单：[P-A-任务单.md](P-A-任务单.md)｜执行时间：2026-09-26

---

## 0. 摘要

| 条目 | 文件 | 结论 |
|---|---|---|
| A1 | `src/runtime-slots.ts:57-81` | 回退 legacy 时按原因分别 `console.warn`，并补上「为什么保留回退 / 有什么风险」注释；**行为不变** |
| A2 | `src/runtime-slots.ts` 多处 | `directoryFingerprint` 返回 `undefined`（不再伪造全零）；指针字段可缺省；激活拒绝全零；写盘时摘除全零；历史全零指针**仍可读** |
| A3 | `src/process-control.ts` | 改为 `async`，等 `taskkill` 的 `close` **和** 子进程的 `exit`，默认 8 秒上限，**永不 reject** |

新增测试：`test/runtime-slots.test.ts` +4 用例、`test/process-control.test.ts` +3 用例（新建文件）。
三条修复均已做「改坏 → 变红 → 改回 → 变绿」自证，见第 5 节。

---

## 1. A1 — 槽不可用时静默回退旧目录

### 改了什么

**文件**：`src/runtime-slots.ts`，原 `:53-62`（现 `:57-81`）

**改动前**

```ts
/** 指针损坏或候选不完整时优先退回 previous，最后退回旧版固定目录。 */
export function resolveActiveRuntimeDir(legacyRuntimeDir: string): string {
  const runtimeRoot = dirname(resolve(legacyRuntimeDir))
  const pointer = readRuntimeSlotPointer(legacyRuntimeDir)
  for (const reference of [pointer?.current, pointer?.previous]) {
    const candidate = reference === undefined ? undefined : resolveSlotReference(runtimeRoot, reference)
    if (candidate !== undefined && isOfficialRuntimeLaunchable(candidate)) return candidate
  }
  return resolve(legacyRuntimeDir)
}
```

**改动后**

```ts
/**
 * 指针损坏或候选不完整时优先退回 previous，最后退回旧版固定目录。
 *
 * 为什么保留最后这条 legacy 回退：老安装（还没有 `Harness/current.json`，或槽全部损坏）
 * 仍要靠固定目录才能启动，下游把它当作「当前运行时目录」直接用，删掉这条分支等于让
 * 这类实例起不来——所以这里只补可观测信号，不改行为。
 *
 * 风险（必须留痕）：legacy 固定目录**没有槽（家园）绑定**，它读写的仍是共享的 `Data/DSH`
 * 那份运行时；一旦走到这条分支，A/B、回滚和「槽不可变」保护全部失效，而且下次启动还会
 * 继续落到这里。没有这条 warn，「槽全坏了」和「一切正常」在日志上完全无法区分。
 */
export function resolveActiveRuntimeDir(legacyRuntimeDir: string): string {
  const runtimeRoot = dirname(resolve(legacyRuntimeDir))
  const pointer = readRuntimeSlotPointer(legacyRuntimeDir)
  for (const reference of [pointer?.current, pointer?.previous]) {
    const candidate = reference === undefined ? undefined : resolveSlotReference(runtimeRoot, reference)
    if (candidate !== undefined && isOfficialRuntimeLaunchable(candidate)) return candidate
  }
  const fallback = resolve(legacyRuntimeDir)
  const reason = pointer === undefined ? '运行时指针缺失或损坏' : 'current/previous 两个槽都不可启动'
  console.warn(
    `[runtime-slots] ${reason}，回退旧版固定目录（该目录无槽绑定，会直接读写共享 Data/DSH，A/B 与回滚保护失效）：${fallback}`,
  )
  return fallback
}
```

### 选型说明

- **函数签名一字未改**（仍是 `(legacyRuntimeDir: string) => string`），因此不用碰任何调用方（`src/main.ts`、`src/portable-paths.ts`、`scripts/stage-local-desktop-candidate.ts`、5 个测试文件）。
- 可观测信号选 `console.warn` 而不是「返回带来源的标记」：后者必须改签名，任务单已说明那会越界。
- 区分两种原因（`指针缺失或损坏` vs `两个槽都不可启动`），否则排查时分不清「还没有槽系统」和「槽全坏了」。

### 验证

见第 5.1 节红/绿自证，以及第 6 节最终验收输出（用例 5 `ok`）。

运行时实测告警样例：

```
# [runtime-slots] current/previous 两个槽都不可启动，回退旧版固定目录（该目录无槽绑定，会直接读写共享 Data/DSH，A/B 与回滚保护失效）：C:\...\dsh-runtime-invalid-pointer-ZtDP2T\dsh-runtime
```

---

## 2. A2 — 槽指纹缺失时伪造全零指纹并持久化

### 问题拆解

`'0'.repeat(64)` 是**合法的 64 位十六进制串**，`isSlotReference` 的正则 `^[a-f0-9]{64}$` 校验不过来，于是「没有指纹」被当成「指纹是 000…0」写进 `current.json`，之后再也分不清两者。修复必须同时解决四件事：

1. 生成端不再伪造；
2. 类型上能表达「无指纹」；
3. 写盘端拒绝全零（含调用方直接传零的情况）；
4. **读端继续放行**历史全零，否则老槽直接失联。

### 改了什么

**文件**：`src/runtime-slots.ts`

**(a) 类型：`fingerprint` 改为可缺省**（原 `:7-11` → 现 `:7-15`）

```ts
export interface RuntimeSlotReference {
  readonly relativePath: string
  readonly version: string
  /**
   * 槽指纹（`.dsh-runtime-fingerprint` 的内容）。
   * 缺省表示「该目录没有指纹」——迁移前的旧固定运行时就是这种，**不是**全零指纹。
   */
  readonly fingerprint?: string
}
```

> 影响面核对：全仓 `RuntimeSlotReference` 的**外部消费点为 0**（`grep RuntimeSlotReference` 只命中原文件与测试），`main.ts` 里的 `candidate.fingerprint` 是 `harness-runtime-candidate` 的独立类型，不受影响。

**(b) 生成端：`directoryFingerprint` 返回 `string | undefined`**（原 `:181-190` → 现 `:229-245`）

```ts
function directoryFingerprint(directory: string): string | undefined {
  const marker = join(directory, '.dsh-runtime-fingerprint')
  let raw: string
  try {
    raw = readFileSync(marker, 'utf8')
  } catch {
    // 迁移前的旧固定运行时根本没有 marker：属于「无指纹」，不是全零指纹。
    console.warn(`[runtime-slots] 槽指纹文件缺失，按「无指纹」处理：${marker}`)
    return undefined
  }
  const value = raw.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(value)) {
    console.warn(`[runtime-slots] 槽指纹文件内容非法，按「无指纹」处理：${marker}`)
    return undefined
  }
  return value
}
```

改动前：`catch` 后 `return '0'.repeat(64)`（静默）；改动后：缺失与损坏**分别告警**并返回 `undefined`。

**(c) 调用端：`slotReference` 诚实地不写这个字段**（原 `:160-168` → 现 `:199-209`）

```ts
  const fingerprint = directoryFingerprint(directory)
  // 无指纹就诚实地不写 fingerprint 字段，不为了让 isSlotReference 通过而伪造全零值。
  return {
    relativePath: portableRelativePath(runtimeRoot, directory),
    version,
    ...(fingerprint === undefined ? {} : { fingerprint }),
  }
```

**(d) 写入端 1：`activateRuntimeSlot` 拒绝调用方传全零**（现 `:97-99`，位于函数体第一行）

```ts
  if (isAllZeroFingerprint(options.fingerprint)) {
    throw new Error('拒绝用全零指纹激活 DSH 运行时槽：指纹缺失/损坏时不得冒充合法值落盘。')
  }
```

**(e) 写入端 2：`writePointer` 落盘前摘除历史全零指纹**（原 `:155-158` → 现 `:177-197`）

```ts
function writePointer(legacyRuntimeDir: string, pointer: RuntimeSlotPointer): RuntimeSlotPointer {
  //落盘前的最后一道闸：历史指针里可能带着老版本伪造的全零指纹，读的时候放行（否则旧槽
  //读不回来），写的时候一律摘掉——全零指纹只允许存在于磁盘上的旧数据，不允许被再次落盘。
  const withoutFabricated = <T extends RuntimeSlotReference>(reference: T): T => {
    if (reference.fingerprint === undefined || !isAllZeroFingerprint(reference.fingerprint)) return reference
    console.warn(`[runtime-slots] 指针携带全零指纹，已拒绝写回（视为「无指纹」）：${reference.relativePath}`)
    const clone: T = { ...reference }
    delete (clone as { fingerprint?: string }).fingerprint
    return clone
  }
  const previous = pointer.previous === undefined ? undefined : withoutFabricated(pointer.previous)
  const lastFailed = pointer.lastFailed === undefined ? undefined : withoutFabricated(pointer.lastFailed)
  const cleaned: RuntimeSlotPointer = {
    ...pointer,
    current: withoutFabricated(pointer.current),
    ...(previous === undefined ? {} : { previous }),
    ...(lastFailed === undefined ? {} : { lastFailed }),
  }
  mkdirSync(harnessRuntimeRoot(legacyRuntimeDir), { recursive: true })
  writeTextFileAtomicSync(runtimePointerPath(legacyRuntimeDir), `${JSON.stringify(cleaned, undefined, 2)}\n`)
  return cleaned
}
```

同时把三处 `writePointer(...); return x` 改成 `return writePointer(...)`（`activateRuntimeSlot:118`、`commitRuntimeSlot:130`、`rollbackRuntimeSlot:152`），保证**返回值与落盘内容一致**，不会出现「内存里还带着全零、盘上已经摘掉」的分叉。

**(f) 读端：`isSlotReference` 接受「缺省」但继续放行历史全零**（原 `:192-201` → 现 `:251-261`）

```ts
    // 指纹可缺省（= 无指纹）；旧指针里已经落盘的全零指纹必须继续放行，否则历史槽读不回来。
    && (candidate.fingerprint === undefined
      || (typeof candidate.fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(candidate.fingerprint)))
```

### 兼容性结论（对应任务单「保证旧槽仍能加载」）

| 场景 | 改动前 | 改动后 |
|---|---|---|
| 旧指针带全零指纹，`readRuntimeSlotPointer` | 读出（正则过） | **仍读出**（正则 + 缺省双分支） |
| 旧指针带全零指纹，`resolveActiveRuntimeDir` | 回到该槽 | **仍回到该槽** |
| 该指针被 `commit`/`rollback` 重写 | 全零再次落盘 | **摘除后落盘 + warn**，之后仍可读 |
| 历史槽目录无 marker，激活新候选 | `previous.fingerprint = 000…0` | `previous` **不带 fingerprint 字段**，`previous` 仍存在（回滚能力保留） |
| 调用方传全零 `options.fingerprint` | 落盘为 current | **直接抛错**，不写指针 |

### 公共接口变更论证（AGENTS.md「破坏公共接口/数据结构必须附论证」——由派发者于 2026-09-26 补录）

> 本节由 **派发者/验收者** 补写。执行者 P-A 只标注了影响，未附论证；按仓库规则该项需要论证，故补录并对该变更作出裁定。

**变更内容**：`RuntimeSlotReference.fingerprint` 由 `readonly fingerprint: string` 改为 `readonly fingerprint?: string`（`src/runtime-slots.ts:7-15`）。

**必要性论证**：

1. **数据本身确实是可缺省的**，而不是"为了让类型好过"而放宽。触发路径有两条，都为真实状态：
   - `directoryFingerprint()` 在 `.dsh-runtime-fingerprint` 缺失/损坏时无法给出可信值（旧固定运行时迁移过来的槽根本没有该 marker）；
   - `activateRuntimeSlot` 只接受可信指纹（全零直接抛错），所以 **`current` 必然有指纹**，而 `previous` / `lastFailed` 可能来自"无指纹的历史槽"。
2. **保留 `string` 只能靠继续伪造全零**——这恰恰是 A2 要修掉的缺陷（全零能通过 64 位十六进制校验，于是"真指纹"与"根本没有指纹"永久不可区分）。要让类型诚实，就必须允许缺省。
3. **不变量未被削弱**：`isSlotReference` 仍要求 `fingerprint` 若存在必须是 64 位十六进制（`src/runtime-slots.ts:257-258`）；`activateRuntimeSlot` 对全零指纹**新增**拒绝（`:97-99`）。即"新写入的 `current` 一定有真指纹"这条比改动前更强。

**影响面（已全仓核对，48 处 `.fingerprint` 匹配逐条判读）**：

| 消费点 | 位置 | 是否受影响 |
|---|---|---|
| `src/main.ts:3792 / 3901 / 3945` | 用的是 `HarnessRuntimeCandidate.fingerprint`（另一个类型，**必填**） | 否 |
| `src/profile-quarantine.ts:40 / 89` | 用的是 profile 健康记录自身类型 | 否 |
| `src/harness-runtime-candidate.ts:88-106` | 局部 `validation` / 局部变量 | 否 |
| 指针读写与校验 | 全部在 `src/runtime-slots.ts` 内部，已同步适配 | 是（已处理） |
| `test/runtime-slots.test.ts:185-240` | 已覆盖缺省语义 | 是（已处理） |

结论：**没有任何外部消费点直接读取 `RuntimeSlotReference.fingerprint` 并假定它非空**（`tsc --noEmit` 退出码 0 是旁证）。

**风险与代价**（如实记录）：

- 后续若有新代码读 `activeSlot.fingerprint`，会得到 `string | undefined`，**必须自己处理缺省分支**；编译器会强制它处理（这正是可选类型的目的）。
- 指针 JSON 的 `fingerprint` 字段对历史槽**会消失**（不再是 `000…0`）。若有外部工具硬编码"该字段一定存在且为 64 位十六进制"，需要同步。当前仓库内无此类工具。
- 回滚能力不受影响：`previous` 槽仍按 `relativePath` 解析，缺指纹只影响"身份识别"，不影响"能否加载"（见上表第 4 行）。

**裁定**：**保留该变更**。它把"伪造值"换成"缺省值"，属于修正而非放宽；且已被 `activateRuntimeSlot` 的新增拒绝反向加固。

---

## 3. A3 — `terminateProcessTree` 名不符实

### 改了什么

**文件**：`src/process-control.ts`（整文件重写，原 `:1-23` → 现 `:1-86`）

**改动前**

```ts
export function terminateProcessTree(child: ChildProcess, options: TerminateProcessTreeOptions = {}): void {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    killer.once('error', () => { child.kill('SIGKILL') })
    return            // ← 既不 await 也不 unref：调用方以为树已经死了
  }
  ...
}
```

**改动后（关键部分）**

```ts
export async function terminateProcessTree(child: ChildProcess, options: TerminateProcessTreeOptions = {}): Promise<void> {
  const deadline = Date.now() + Math.max(options.timeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS, 0)
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    await runTaskkill(child, remaining(deadline))   // 等 taskkill 自己 close（带超时）
  } else if (options.processGroup === true && child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGKILL') }
    catch { child.kill('SIGKILL') }                 // 子进程可能在创建进程组前退出
  } else {
    child.kill('SIGKILL')
  }
  await waitForExit(child, remaining(deadline))     // 再等子进程真正 exit（共用同一个 deadline）
}
```

`runTaskkill`：`spawn(taskkill /t /f)` → 等 `close`；`error` 时退回 `child.kill('SIGKILL')`；**超时（默认 8 秒）则杀掉 taskkill 自身并 resolve**，不让卡死的 killer 吊住事件循环。
`waitForExit`：已退出或剩余时间为 0 立即返回；否则挂 `exit` 监听 + `setTimeout`，超时同样 resolve。

### 选型说明（任务单要求「说明选了哪种以及为什么」）

任务单给了两条路：

1. 改成返回 Promise 并等 `close`/`exit`（含超时上限）；
2. 不改签名 + 显式 `unref()` + 注释。

**我选了第 1 条**，理由：

- **第 2 条会让原问题更严重**。`unref()` 的语义是「父进程别等我」，而 R-19 报的故障恰恰是「调用方以为进程树已终止就去删目录 / 起新进程 → 文件占用、端口抢占」。`unref()` 只会让「父进程先退出、taskkill 还在跑」的竞态更大。
- 等待是**行为**修复，`unref` 只是**语义标注**；本包要修的是行为。
- 超时上限（默认 8 秒，可选 `timeoutMs`）补上了「等」的另一面：不会因为 taskkill 卡死而无限吊住事件循环。

**签名兼容性核对**（任务单担心的越界点）——`grep terminateProcessTree` 得到 6 个调用点，逐一确认全部是**语句式调用或返回 `void` 的箭头**，`void → Promise<void>` 源码零改动即可编译：

| 文件:行 | 形式 | 是否受影响 |
|---|---|---|
| `src/plugin-seed.ts:1286` | `terminateProcessTree(child)`（setTimeout 回调内语句） | 否 |
| `src/extract-runtime.ts:160,162` | 语句 | 否 |
| `src/desktop-host.ts:219` | 语句 | 否 |
| `src/desktop-host.ts:225` | `addEventListener('abort', () => terminateProcessTree(child))`（回调返回类型为 `any`/`void`，TS 的 void-返回特例放行） | 否 |
| `src/desktop-host.ts:231` | `cancel: () => { terminateProcessTree(child) }`（块体，`void`） | 否 |
| `src/dsh-process.ts:155,161` | 语句 | 否 |
| `src/harness-runtime-candidate.ts:137` | 语句 | 否 |

- 另**新增可选参数** `timeoutMs?: number`（任务单明确允许的兼容扩展方式），默认 8 秒。
- Promise **永不 reject**：所有失败降级为 best-effort `child.kill('SIGKILL')` 后 resolve，调用方忽略返回值也不会产生 `unhandledRejection`。
- 保留 `void` 但 `unref()` 的方案被否决，理由见上。

### 遗留缺口（如实记录）

6 个调用点**目前仍然不会 `await`**（调用方不在本包文件范围内，改它们会越界）。因此本次修复做到的是：

- 提供了可 `await` 的正确语义 + 超时上限；
- 忽略返回值时，事件循环**仍会**等 taskkill 与子进程退出（子进程句柄本来就是引用态，且现在还多了一层显式的 `waitForExit`）；
- 「调用方真正 await 后再删目录」需要后续包在各自文件里补 `await`，**不在本包范围**。

---

## 4. 新增测试

### `test/process-control.test.ts`（新建，3 用例）

| 用例 | 断言 |
|---|---|
| `terminateProcessTree 返回 Promise，resolve 时进程树确实已经退出` | `typeof pending?.then === 'function'` + `await` 回来后 `exitCode/signalCode` 必须已置位 |
| `terminateProcessTree 对已退出的子进程立即 resolve，且不 reject` | `assert.doesNotReject` |
| `terminateProcessTree 的超时上限生效：到点就返回，不会无限等待` | `timeoutMs: 1` 时 5 秒内返回 |

### `test/runtime-slots.test.ts`（原有 4 用例保留，新增 4 用例）

| 用例 | 覆盖 |
|---|---|
| `槽全部不可启动时回退旧目录，且必须留下可观测告警（A1）` | 行为不变（仍返回 legacy）+ 三条告警要素（回退动作 / 原因 / `Data/DSH` 风险） |
| `槽指纹缺失时按「无指纹」处理，不伪造全零指纹落盘，旧槽仍可加载（A2）` | `previous.fingerprint === undefined`、盘上无该字段、marker 缺失告警、重读 + 回滚仍可用 |
| `历史指针里的全零指纹仍可加载，但重写时一律不再落盘（A2 兼容）` | 全零指针**读得出**；`rollbackRuntimeSlot` 后 `current`/`lastFailed` 均无 fingerprint 字段 |
| `拒绝用全零指纹激活运行时槽（A2）` | `assert.rejects(/全零指纹/)` 且被拒后**不写出指针** |

未删任何既有用例、未放宽任何既有断言、未改任何既有用例为 skip。

---

## 5. 自证红 / 绿（任务单硬约束 4）

方法：只改被测源码 → 用**同一套**定向编译流程重建 → 跑同一条命令 → 看红 → 改回 → 再跑看绿。
自证用的破坏是**临时**的，已全部还原（`grep -r "TEMP-A[0-9]-BREAK" src test` → **No files found**）。

> 编译方式说明：为避免与并行包互相污染共享 `dist/`，我用 `tsc -p tsconfig.json --outDir <临时目录>` 做**全项目**类型检查与产物生成（只换输出目录），然后**仅把本包 4 个文件**的产物拷进 `dist/`。这既满足「只跑自己受影响的测试文件」，又保证拿到的是真编译产物而不是手写 JS。

### 5.1 A1 红 / 绿

**破坏**：删掉 `resolveActiveRuntimeDir` 里的 `console.warn`（保留返回值与行为）。

```
ok 1 - A/B 运行时使用相对指针切换、提交和回滚
ok 2 - 候选启动失败时原子恢复上一已知可用运行时
ok 3 - 观察期进程中断后，下次启动自动恢复上一已知可用槽
ok 4 - 指针路径越界或当前槽损坏时安全回退旧运行时
not ok 5 - 槽全部不可启动时回退旧目录，且必须留下可观测告警（A1）
ok 6 - 槽指纹缺失时按「无指纹」处理，不伪造全零指纹落盘，旧槽仍可加载（A2）
ok 7 - 历史指针里的全零指纹仍可加载，但重写时一律不再落盘（A2 兼容）
ok 8 - 拒绝用全零指纹激活运行时槽（A2）
# tests 8
# pass 7
# fail 1
EXIT=1
```

**改回后** → 见第 6 节，用例 5 `ok`，`# fail 0`。

### 5.2 A2 红 / 绿

**破坏**（三条同时，一次性覆盖 A2 的三个行为）：

1. `directoryFingerprint` 恢复成「缺失/损坏一律 `return '0'.repeat(64)`」；
2. `writePointer` 的 `withoutFabricated` 改成恒等（不再摘除全零）；
3. `activateRuntimeSlot` 的全零拒绝闸清空。

```
ok 1 - A/B 运行时使用相对指针切换、提交和回滚
ok 2 - 候选启动失败时原子恢复上一已知可用运行时
ok 3 - 观察期进程中断后，下次启动自动恢复上一已知可用槽
ok 4 - 指针路径越界或当前槽损坏时安全回退旧运行时
ok 5 - 槽全部不可启动时回退旧目录，且必须留下可观测告警（A1）
not ok 6 - 槽指纹缺失时按「无指纹」处理，不伪造全零指纹落盘，旧槽仍可加载（A2）
not ok 7 - 历史指针里的全零指纹仍可加载，但重写时一律不再落盘（A2 兼容）
not ok 8 - 拒绝用全零指纹激活运行时槽（A2）
# tests 8
# pass 5
# fail 3
TEST_EXIT=1
```

**改回后** → 用例 6/7/8 全 `ok`，`# fail 0`。

> 附注：第一次尝试的 A2 破坏（把 `withoutFabricated` 写成 `if (true || …)`）被 tsc 拦下：`src/runtime-slots.ts(178,78): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'`（短路求值导致 TS 不再收窄）。改为直接把函数体换成恒等映射后重建成功。这说明定向编译确实**会**拦类型错误，不是只出 JS。

### 5.3 A3 红 / 绿

**破坏**：保留 `Promise<void>` 签名，但恢复「`spawn` 完 taskkill 立刻 `return`，不等 `close` 也不等 `exit」。

> 说明：最初尝试直接把签名改回 `void`，被 tsc 拦下 ——
> `test/process-control.test.ts(39,30): error TS2345: Argument of type '() => void' is not assignable to parameter of type 'Promise<unknown> | (() => Promise<unknown>)'`
> （`assert.doesNotReject` 的类型要求）。因此改成「签名对、行为错」的破坏，这样红的**正是被测行为**而不是类型噪音。

```
not ok 1 - terminateProcessTree 返回 Promise，resolve 时进程树确实已经退出
  ---
  duration_ms: 208.4847
  type: 'test'
  location: 'G:\\DSH-3-Portable\\dist\\test\\process-control.test.js:16:1'
  failureType: 'testCodeFailure'
  error: |-
    await 返回时子进程应已退出

    false !== true

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///G:/DSH-3-Portable/dist/test/process-control.test.js:25:16)
    async Test.run (node:internal/test_runner/test:1404:7)
    ...（后续为 node:test 内部栈帧，已省略）
  ...
# Subtest: terminateProcessTree 对已退出的子进程立即 resolve，且不 reject
ok 2 - terminateProcessTree 对已退出的子进程立即 resolve，且不 reject
# tests 3
# pass 2
# fail 1
EXIT=1
```

**改回后** → 见第 6 节，3/3 `ok`，`# fail 0`。

---

## 6. 验收命令原始输出

### 6.1 `tsc`（全项目类型检查，输出到临时目录）

```powershell
& .\App\resources\node\node.exe .\node_modules\typescript\bin\tsc -p tsconfig.json --outDir $env:TEMP\dsh-pa-build
```

最终一次的完整输出（`tsc` 自身无任何诊断行，退出码 0）：

```
REBUILD_OK (tsc exit 0; only the 4 P-A outputs were copied into dist)
REBUILD_EXIT=0
```

> **本次会话中 `tsc` 打出过的全部诊断**（逐条如实列出，避免只报喜）：
>
> | # | 诊断 | 性质 | 是否留在最终代码里 |
> |---|---|---|---|
> | 1 | `error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline` | 我最初用「命令行点名文件」的方式调用，TS 7 拒绝；改为 `-p tsconfig.json --outDir <临时目录>` 后消失 | 否（调用方式问题） |
> | 2 | 一大批 `TS2591: Cannot find name 'node:fs'` / `TS2503: Cannot find namespace 'NodeJS'` | 上一条的 `--ignoreConfig` 变体导致 `@types/node` 解析不到 | 否（同上） |
> | 3 | `test/runtime-slots.test.ts(256,7): error TS2769: No overload matches this call. … Type 'RuntimeSlotPointer' is missing the following properties from type 'Promise<unknown>'` | **我写的测试真有类型错**：`assert.rejects` 回调返回了同步类型 | **是，已修**（`() => activateRuntimeSlot(...)` → `async () => activateRuntimeSlot(...)`） |
> | 4 | `src/runtime-slots.ts(178,78): error TS2345: Argument of type 'string \| undefined' is not assignable to parameter of type 'string'` | A2 自证破坏时把 `if (true \|\| …)` 放在最前，TS 不再收窄类型 | 否（破坏代码已还原） |
> | 5 | `test/process-control.test.ts(39,30): error TS2345: Argument of type '() => void' is not assignable to parameter of type 'Promise<unknown> \| (() => Promise<unknown>)'` | A3 自证第一次尝试把签名改回 `void`，撞上 `assert.doesNotReject` 的类型要求 | 否（改为「签名对、行为错」的破坏） |
>
> 最终状态：全项目 `tsc` **退出码 0、零诊断**；诊断里**没有任何一条来自 `src/` 下其他包的文件**，说明本包没有破坏别人的类型。

### 6.2 `run-tests.mjs dist\test\runtime-slots.test.js`

```
[test-run] 本次运行临时目录：C:\Users\96551\AppData\Local\Temp\dsh-test-runs\run-eiZVUS
[test-run] 测试文件 1 个；子进程 TEMP/TMP/TMPDIR 均指向本次运行目录。
TAP version 13
# [runtime-slots] 运行时指针缺失或损坏，回退旧版固定目录（该目录无槽绑定，会直接读写共享 Data/DSH，A/B 与回滚保护失效）：...dsh-runtime-slots-TrvpRR\dsh-runtime
# Subtest: A/B 运行时使用相对指针切换、提交和回滚
ok 1 - A/B 运行时使用相对指针切换、提交和回滚
# Subtest: 候选启动失败时原子恢复上一已知可用运行时
ok 2 - 候选启动失败时原子恢复上一已知可用运行时
# Subtest: 观察期进程中断后，下次启动自动恢复上一已知可用槽
ok 3 - 观察期进程中断后，下次启动自动恢复上一已知可用槽
# Subtest: 指针路径越界或当前槽损坏时安全回退旧运行时
ok 4 - 指针路径越界或当前槽损坏时安全回退旧运行时
# Subtest: 槽全部不可启动时回退旧目录，且必须留下可观测告警（A1）
ok 5 - 槽全部不可启动时回退旧目录，且必须留下可观测告警（A1）
# Subtest: 槽指纹缺失时按「无指纹」处理，不伪造全零指纹落盘，旧槽仍可加载（A2）
ok 6 - 槽指纹缺失时按「无指纹」处理，不伪造全零指纹落盘，旧槽仍可加载（A2）
# [runtime-slots] 指针携带全零指纹，已拒绝写回（视为「无指纹」）：slots/0.1.2-rc.1-deadbeef
# [runtime-slots] 指针携带全零指纹，已拒绝写回（视为「无指纹」）：dsh-runtime
# Subtest: 历史指针里的全零指纹仍可加载，但重写时一律不再落盘（A2 兼容）
ok 7 - 历史指针里的全零指纹仍可加载，但重写时一律不再落盘（A2 兼容）
# Subtest: 拒绝用全零指纹激活运行时槽（A2）
ok 8 - 拒绝用全零指纹激活运行时槽（A2）
1..8
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 964.5625
[test-run] 全绿，已清理本次运行临时目录。
EXIT_RUNTIME_SLOTS=0
```

### 6.3 `run-tests.mjs dist\test\process-control.test.js`

```
[test-run] 本次运行临时目录：C:\Users\96551\AppData\Local\Temp\dsh-test-runs\run-jDoefr
[test-run] 测试文件 1 个；子进程 TEMP/TMP/TMPDIR 均指向本次运行目录。
TAP version 13
# Subtest: terminateProcessTree 返回 Promise，resolve 时进程树确实已经退出
ok 1 - terminateProcessTree 返回 Promise，resolve 时进程树确实已经退出
  duration_ms: 1012.6706
# Subtest: terminateProcessTree 对已退出的子进程立即 resolve，且不 reject
ok 2 - terminateProcessTree 对已退出的子进程立即 resolve，且不 reject
  duration_ms: 185.5434
# Subtest: terminateProcessTree 的超时上限生效：到点就返回，不会无限等待
ok 3 - terminateProcessTree 的超时上限生效：到点就返回，不会无限等待
  duration_ms: 161.2726
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1623.5175
[test-run] 全绿，已清理本次运行临时目录。
EXIT_PROCESS_CONTROL=0
```

**汇总**：`runtime-slots` 8/8 通过（原 4 + 新 4）、`process-control` 3/3 通过（新建），两个验收命令退出码均为 **0**。

---

## 7. 未完成 / 未验证项（如实列出）

1. **没有跑全量测试，也没有把 `tsc` 输出到共享 `dist/`** —— 任务单「重要」一节明确禁止（并行包会互相污染），全量 tsc 与全量测试由派发者统一执行。本包只跑了两条指定验收命令。
2. **6 个 `terminateProcessTree` 调用点仍未 `await`** —— 它们不在本包文件范围，改了就是越界。本包只保证「返回值可 await + 忽略时事件循环仍会等」；「调用方真正等待后再删目录」需后续包接手。
3. **8 秒超时上限没有用真实卡死的 `taskkill` 实测** —— 只用 `timeoutMs: 1` 证明「到点必返回」这条上限逻辑；真实 taskkill 挂死属于难以稳定构造的场景。
4. **`resolveActiveRuntimeDir` 在「指针缺失」时也会告警** —— 全新安装（还没有 `Harness/current.json`）会打印这条 warn，属预期的可观测信号，但若派发者认为属于噪音，可以把「指针缺失」分支降为静默、只保留「两个槽都不可启动」分支告警。当前按任务单「必须发出可观测信号」保留。
5. **`RuntimeSlotReference.fingerprint` 变为可缺省** 是接口变更。已 grep 确认当前全仓无外部消费点，且全项目 `tsc` 退出 0；但**若后续别的包开始直接读 `ref.fingerprint`，会收到 `string | undefined`** —— 需要在交接时说明。

### 本会话早于 P-A 的遗留改动（必须向派发者披露）

本会话在收到 P-A 任务单**之前**，曾按另一份《Codex-第1批任务单》执行 T1–T3，改动了 **P-A 范围之外**的以下文件（**均未回滚**，因为再动它们同样违反「只碰允许清单」）：

- `scripts/ui-baseline.mjs`（T1）
- `customizations/ui/baseline.json` + 新增 `customizations/ui/history/2026-09-26T10-53-01-529Z.json`（T1 重记基线）
- `test/composer-border.test.ts`、`test/custom-spaces-layout.test.ts`、`test/browser-panel-layout.test.ts`（T2 加 `existsSync` 守卫）
- `scripts/run-tests.mjs`（T3：递归收集 + 0 收集报错 + 追加 `health.test.cjs`）
- 那一阶段还跑过一次**输出到共享 `dist/` 的全量 `tsc`**（`dist/test` 从 115 → 118 个文件）

这些改动与 P-A 无关，`git status` 会一并显示。**P-A 阶段我只碰了下面第 8 节列出的 4 个文件 + 4 个 `dist/` 产物。**

---

## 8. 越界自检（对照任务单硬约束 1）

**P-A 阶段改动的仓库文件（全部在允许清单内）**：

```
 M src/process-control.ts          ← 允许
 M src/runtime-slots.ts            ← 允许
 M test/runtime-slots.test.ts      ← 允许
?? test/process-control.test.ts    ← 允许（新建）
```

（`git status --porcelain` 对这 4 个路径的实际输出，见上。）

**逐条确认**：

- [x] 只改 `src/runtime-slots.ts`、`src/process-control.ts`、`test/runtime-slots.test.ts`、`test/process-control.test.ts`（后者为新建）。
- [x] 未碰 `src/main.ts` —— 全程零读写以外的修改（仅 `grep`/`read` 只读查看）。
- [x] 未碰 `Data/**` —— 所有测试数据写在 `os.tmpdir()`，由运行器收口清理；`Data/` 只读。
- [x] 未碰 `pointer.json`、`.git/**`、`App/**`、`node_modules/**`。
- [x] 未碰任何 `Data/Updates/Desktop/slots/**` 槽。
- [x] 未删测试、未放宽断言、未把失败改 `skip`、未写死哈希；3 个新用例 + 4 个新用例全部真跑真断言，且已用破坏法自证会变红。
- [x] 未修任务单以外的问题（160+ 条排队项一条没动）。
- [x] 全程使用随包 `App\resources\node\node.exe`，未用系统 Node。
- [x] 自证用的破坏已全部还原，仓库内 `TEMP-A*-BREAK` 标记 0 处。
- [x] `dist/` 只写入本包 4 个产物文件（经 `--outDir` 临时目录中转后选择性拷贝），未整建共享 `dist/`。

**范围外、但发生在 P-A 之前**的改动已在第 7 节末尾完整披露。
