# 审核单元 D 取证报告（test/ 测试套件与假门禁）

> 来源：穷尽式只读审核单元 D（子代理会话），2026-09-26。本文是**证据留档**，未修改任何文件。
> 索引见 [全项目审核总报告](../便携版3-全项目审核总报告与修复清单.md)。
> 范围：`test/**` 全部文件 + `scripts/run-tests.mjs`。**未跑测试**（shell 不可用）。

## 规模

- `test/*.test.ts` = **117** 个；`test/helpers/tmp.ts`（79 行）；`test/fixtures/` 仅 2 个 `.mjs`；无 `.mjs`/`.json` 测试；无其它子目录。
- `test()` 总数 **646**；skip 站点 **110–111**，分布在 **40** 个文件。
- 断言形态：`assert.match`/`doesNotMatch` **843** 处、`assert(...includes(...))` **95** 处、`readFile` **376** 处。
- **无恒真断言**（`assert.ok(true)` 零命中）。
- 主题分组：T1 更新/AB 槽 7；T2 种子/装配 12；T3 安装器/知识库/桥接 18；T4 UI 基线 33；T5 插件客户端 9；T6 外壳/main 20；T7 门禁元测试/冒烟 18。

## 一句话结论

**不是"没测"，而是"测法分层失衡"**：真行为契约集中在约 **10** 个文件；大量"门禁"是对仓库文本做正则/子串扫描（改注释都能过）；而**最有价值的真机契约（真实 Profile+Loader、combo 语法检查、UI live 基线、无限重启护栏、A/B 启动器）全部被 `existsSync(Data/…)` 守卫 → CI 整条 skip**；同时有 **3 个文件反过来无守卫直读 `Data/`**，CI 必然 ENOENT。

## 🔴 Findings

| # | 位置 | 问题 | 证据 |
|---|---|---|---|
| D-F1 | `test/composer-border.test.ts:7`、`test/custom-spaces-layout.test.ts:17`、`test/browser-panel-layout.test.ts:198,222-223` | **无 `existsSync` 守卫直读 `Data/DSH/profiles/web/local/...`** ⇒ CI 全新检出 ENOENT 整组失败，直接违反 `AGENTS.md` 明文禁令（"测试禁止读取实机 `Data/` 产物，CI 是全新检出"） | `composer-border.test.ts:7` 已由主会话实读确认：`readFileSync('Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/${file}', 'utf8')`，全文件 0 skip 站点。**最可能正是 CI 红的原因，建议第一优先修** |
| D-F2 | `test/no-self-scheduled-restart.test.ts:21-22, 14-18` | 🔴 级"无限重启"事故的**唯一护栏在 CI 整条 skip**（`const root = 'Data/DSH/profiles/web/local'` 无守卫）；且只扫 `local/*/lib/client.js\|client.src.js` 两个文件名，**不覆盖** `node_modules` 下 8 个随包社区插件与 store；`FORBIDDEN[0] = /app-restart/` 过宽（注释误报）而 `AGENTS.md` 又明文教用 `'app-' + 'restart'` 绕过 ⇒ **既误报又可绕过** | 该文件全文已由主会话实读（43 行） |

## 🟠 Findings

| # | 位置 | 问题 |
|---|---|---|
| D-F3 | `test/main-safety.test.ts:320-340` | 宿主侧 `app-restart` 护栏同样 skip；整文件 20 例全为 `main.ts`/`assets` 文本正则；`:260` 只认单引号 `/id:\s*'browser-toggle'/`，换双引号即绕过（对照 `sidebar-navigation.test.ts:120` 写法正确） |
| D-F4 | `test/portable-desktop-update.test.ts:642-742` | pointer 失效恢复 / 回滚先于清理 / Mutex 原子互斥 / 冷启动握手**全是对 `Start-DSH-Portable.ps1` 文本匹配**（`assert.match(launcher, /\.WaitOne\(0\)/)`）——注释或不可达分支也能过 |
| D-F5 | `test/automation-workbench.test.ts:20` | `if (!once.includes('AutomationView')) return t.skip(...)` = **以跳过代替失败**，插桩失效的真回归被静默吞掉 |
| D-F6 | `test/cost-chip-style.test.ts:16-21` | 实机对照断言包在 `if (existsSync(live))` 且**无 else** ⇒ 产物缺失时静默绿；同文件 `:34` 却用 `t.skip`，口径矛盾 |
| D-F7 | `test/feature-panels.test.ts:8-19` | 用例名宣称"覆盖 `docs/00-交接入口/07-功能清单.md` 全 74 项"，**实际从不读该文档**，只断言 `length===74` + 字段非空 |
| D-F8 | `test/bundled-plugins.test.ts:52-69,75` | 14 个插件版本表 + `OFFICIAL_DSH_VERSION === '0.1.7-rc.2'` 是 `src/bundled-plugins.ts:11` 的**手抄副本**（变更探测器），无法发现"钉错版本/上游已变" |
| D-F9 | `test/quality-gate.test.ts:12-60` | 文档门禁只做字符串存在性断言；**第 6 节"前后端与 UI 三项对齐"零自动检查**（全库仅此文件引用该文档）；`:32` 硬编码 `0.1.2-alpha.5` |
| D-F10 | `test/harness-update.test.ts:21-32` | 6 组 sha512 integrity + commit 硬编码，与 `src/harness-update.ts:111,160-162` 重复 |
| D-F11 | `scripts/run-tests.mjs:58-63` | **`readdirSync(dist/test)` 非递归**，只收平铺 `*.test.js`；`test/` 已有 `helpers/`、`fixtures/` 子目录 ⇒ 子目录里的 `.test.ts` 会**静默不执行（假绿）**；也不校验收集数 > 0。已由主会话实读确认 |
| D-F12 | 40 个文件 110–111 处 | 契约测试大面积 CI-skip：真实 Profile+Loader（`dsh-awareness-install.test.ts:194`、`sidebar-service-lifecycle.test.ts:13,28`）、combo 客户端 bundle 的 V8 语法检查（`combo-client-bundles-parse.test.ts:45`，2026-09-22 事故固化）、`ui-baseline.test.ts:15` 全部 skip ⇒ 全新检出只剩源码文本扫描兜底 |

## ⚪ Findings

`text` 断言占绝对主导；临时目录仅 7 个文件用 `helpers/tmp.ts`、约 32 个用裸 `mkdtemp`（靠 runner 收口 TEMP，裸跑残留），`test-tmp-hygiene` 只断言字符串、不强制各文件使用；跳过理由口径不一（Optional live Profile / 英文理由 / 显式离线模式 / 仓库外"工作空间"依赖）；18 处 `process.env` 改写均在 `finally`/`else` 还原（合规，但依赖每文件独立进程）；`ui-baseline.test.ts` 是少数"真门禁"（会自证失败）且其 live 项 CI skip。

## 完全没被任何用例覆盖的 `src/` 模块（`src/` 共 55 个）

`recovery-mode.ts`（零引用）、`process-control.ts`（仅作打包清单字符串 `prepare-runtime.test.ts:485` / `portable-desktop-update.test.ts:26`）、`profile-quarantine.ts`（仅 `:25`）、`profile-bundle-health.ts`（仅 `:24`）、`desktop-bridge-migration.ts`（仅 `profile-repair.test.ts:47` 注释）、`main.ts`（无导入、无行为测试，只被 8 个文件当文本读）。

## 无法核实项

1. 实测用例/通过/skip 数（静态统计 646 `test()`、110–111 skip）。
2. D-F1 是否真在 CI 挂（依据 `AGENTS.md`「CI 全新检出无 Data」推断，无法列目录/跑 CI）。
3. 本机实际生效的 skip 数；文本护栏描述的行为是否真成立；`/app-restart/` 现网是否已误报。
4. `dist/test` 与 `test/` 集合是否一致（`tsconfig` include 只含 `test/**/*.ts`，不含 `.mts/.cts`；`fixtures/*.mjs` 靠 cwd 读取）；117 与 runner 收集数是否一致。
5. 各正则实际误报/漏报率。

## 建议处理顺序（原文）

**D-F1 → D-F2 / D-F11 / D-F5 → 其余口径类。**
