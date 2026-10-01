# 审核单元 F 取证报告（customizations / Customize / plugins）

> 来源：穷尽式只读审核单元 F（子代理会话），2026-09-26。本文是**证据留档**，未修改任何文件。
> 索引见 [全项目审核总报告](../便携版3-全项目审核总报告与修复清单.md)。
> 范围：`customizations/**`（550 文件）、`Customize/**`（11）、`plugins/**`（31，3 个包）。

## 一句话结论

三个受审目录**自身**基本规范（`plugins/**` 31 文件零违禁写法、`Customize/**` 11 文件无写死路径、`customizations/**` 内无 `.bak/.disabled/_legacy` 遗留），但**受保护源码与活动制品的对应关系已经破裂**：`custom-spaces` 被"半途退役"（目录改名 `.disabled` + 10 行 no-op 桩，而 baseline / 门禁清单 / profile 依赖 / 归档仍指向已不存在的 `local/dsh-custom-spaces/`）；`ui-tweaks` 宿主侧活动件比归档多 27 行且整套 `ui-tweaks` **不在受保护清单**；`Customize/Automation-Workbench/build.mjs` 的钉版哈希是**死代码**（契约承诺的"不匹配时拒绝"从未实现）。

## 🔴 Findings

| # | 位置 | 问题 | 证据 |
|---|---|---|---|
| F-01 | `Data/DSH/profiles/web/local/dsh-custom-spaces.disabled/lib/client.js:1` ↔ `customizations/custom-spaces/lib/client.js:1` | **退役未登记**：活动件已成 no-op 桩，归档仍是真实实现；`customizations/custom-spaces/README.md:3,7` 仍称"两份同步、基线同时保护" | live 首行 `const plugin = { inject: [], apply: () => {} };`（10 行）+ `lib/client.js.bak-before-stub`/`lib/index.js.bak-before-stub`；归档 299 行 `window.__ModuleLoader__.load({` |
| F-02 | `scripts/ui-baseline.mjs:19,21,48`；`customizations/ui/baseline.json:120` | **门禁指向不存在路径**：`protectedPaths` 含 `Data/DSH/profiles/web/local/dsh-custom-spaces/lib/client.js`、`localPlugins` 含同名包；`:48` 对缺失文件判 `UI drift` | 读 `local/dsh-custom-spaces/package.json` → not found；367 项 live 清单只有 `dsh-custom-spaces.disabled/**` |
| F-03 | `Data/DSH/profiles/web/package.json:24` | **悬空 link specifier**：`"dsh-custom-spaces": "link:local\\dsh-custom-spaces"`，但 `bundles`(:37-68) 已移除该项、目标目录已改名 | `node_modules/dsh-custom-spaces/package.json` → not found |
| F-04 | `Customize/Automation-Workbench/build.mjs:18,26,30-38`；`scripts/restore-scheduled-tasks-entry.mjs:6-8` | 契约 §2 第 70 行承诺"校验原生哈希/唯一锚点…不匹配时拒绝"，**builder 实际静默接受任意版本** | `upstreamHash`/`sha256` 仅导出无比较；缺 BEGIN 标记原样返回；锚点 replace 未命中静默跳过；全仓 `scripts` grep `upstreamHash` 只有 `buildWorkbench` 引用（0 个消费者） |

## 🟠 Findings

| # | 位置 | 问题 | 证据 |
|---|---|---|---|
| F-05 | `customizations/ui-tweaks/lib/index.js`（54 行）↔ `local/dsh-ui-tweaks/lib/index.js`（81 行） | **归档落后活动件**：live 多一个 `/ui-tweaks/probe` POST 收集端（`verify-adaptive-layout.mjs` 的唯一数据源） | live:60-80 第二段 `ctx.effect` + `writeFileSync(ui-probe.json)`；归档无；同目录 `package.json`(12)、`lib/client.js`(803) 两侧一致 |
| F-06 | `scripts/ui-baseline.mjs:6-19`；`baseline.json`（files 22 条） | **`ui-tweaks` 完全不在受保护清单**，却在 profile `bundles:63` 启用并承担契约 2026-09-19/21/53 多项 | `protectedPaths` 无 ui-tweaks；baseline 无 ui-tweaks 路径 |
| F-07 | `scripts/ui-baseline.mjs:10`；`assets/browser-panel.html`、`assets/browser-workspace.js`、`local/dsh-better-sidebar/portable/embedded-browser-view.js` | **新内嵌浏览器制品未登记、退役制品仍在保护**（baseline 停在 `09-24T19:05`，落后 09-25 迁移） | `build-native-browser-card.mjs:19` 读 `embedded-browser-view.js`(203)；`browser-panel.html`(104)、`browser-workspace.js`(512) 存在；baseline 仍保护旧 `portable/browser-view.js` |
| F-08 | `customizations/ui-tweaks/README.md:183-184` | README 仍把**契约点名禁止的写法**记作"当前改法"：`#root{margin-right:min(var(--dsh-sidebar-width,0px),420px)!important…}`（420/560 状态帽 + `#root` 专用让位） | 契约表第 37 行（`writeGeometry` 唯一写者，禁 420/560 帽、`--dss-panel-width`、`#root` 专用让位）+ 红线 292（禁 CSS/`!important` 盖另一源状态）；缓和：client.js 已无该 CSS（仅 705/728/729 只读探针，67 行注明撤销） |
| F-09 | `Data/…/local/**`（活动路径） | **备份遗留**：better-sidebar `lib/{client.js.bak-20260922-fight, .bak-20260923-bounds-heartbeat, .bak-20260923-first-claim, .bak-20260924-mimo-iframe, client-registry.js.bak-icon-017-*, client-editor.js.bak-icon-017-*, client.js.bak-icon-017-*}` + `portable/` 4 个同类；hj-workbench `lib/{client.js.bak-20260922-syntaxfix, index.js.bak, client.js.bak3, client.js.bak-20260923-blank-race}`；custom-spaces.disabled `lib/{index,client}.js.bak-before-stub` | 未被 `main`/`exports` 加载但**会随 `files: lib` 打包**。**三个受审目录内 0 备份遗留** ✓ |
| F-10 | `plugins/dsh-manual/package.json:8`；`plugins/dsh-p3-tiny-watch/package.json:7,13-15,17`；`plugins/dsh-system-awareness/package.json:10-11` | 声明偏离规范：`dependencies: schemastery ^3.18.0`（应留空 + 精确钉版双写 dev/peer）；p3 用字符串 `exports`（无 `./package.json` 子路径）、peer `>=3.18.0` 非精确钉版、test 用系统 node；awareness 用 `@deepseek-ai/schemastery 3.18.2` 与另两包裸包名不一致 | **已合规**：三包均 `name`+`inject`+`apply`/`Config` 命名导出；`dsh.bundle.patch` 齐备；`files` 含 lib + cordis.patch.yml；cordis 条目均 `id`+`name`；host-only 不声明 `dsh.client` 正确；`as any`/`@ts-ignore`/`app-restart`/`app-quit`/`dshDesktopShell.action` **全 0 命中** ✓ |

## ⚪ Findings

| # | 位置 | 问题 |
|---|---|---|
| F-11 | `Customize/Automation-Workbench/build.mjs:43,30` | `workbench.js` 成死代码但仍被读取（参数 `_extension` 从未使用）；README 称其"只用于历史排查" |
| F-12 | `Customize/App-Overlay/resources/{shell,settings,startup,shortcuts,about}.html`、`theme.js` | 历史素材库与活动 `assets/` 同名，易被误当可回滚副本；全仓 `*.json/*.ps1/*.cmd/*.mjs/*.ts` grep `App-Overlay` **0 命中** ⇒ 不参与构建（符合 README） |
| F-13 | `customizations/ui/evidence/*.json`、`ui-tweaks/evidence/*.json` | 可移植性：**代码**无写死盘符/用户名 ✓；写死路径只在证据：`42a9069e….json:9,109,152`（`G:/DSH-3-Portable/宏建云系统/browsers/chrome-152.0.7977.64/chrome.exe`）、`7ac24bcc….json:900`（`C:\Program Files\Autodesk\Inventor 2027\Bin\Inventor.exe`）、`ff286f16….json:9`（`G:\DSH-3-Portable\AgentOS\CHECKPOINT.md`）、`global-style-20260919/before.json:4`（活动槽名 `1.0.65+build.8-local-c5f27cae0ed7e8dd`）；`sources/*.txt` 的 `C:/Users/u/f.ts`、`D:\work\project` 属上游自带文档/占位符 |

## 一致性代理核对（无 hash 工具，用行数）

`black-hole` client 1046=1046、core 328=328、index 118=118；`ui-tweaks` client 803=803；`better-sidebar lib/client.js` 22745=22745；`build.mjs` 49=49 均与归档/快照一致。baseline 引用的 **20 个唯一快照全部存在**于 `customizations/ui/sources/`；`baseline.history` → `2026-09-24T19-05-06-251Z.json` 存在；evidence 快照 `003f691e….json` 存在；live `dsh-sidebar-spaces/lib/client.js` **已无** `--dss-panel-width`/`#root` 规则（契约 §37 合规 ✓）。

## 无法核实项

1. 无 shell/无 hash 工具 ⇒ **22 条 sha256 未逐字节核对**（仅"快照存在 + 行数一致"作代理）。
2. 未实跑 `ui-baseline`/全测/`tsc`：F-02 的"门禁现为红"是依据脚本 `:48` 逻辑 + 路径缺失的推断。**主会话补证**：`verifyBaseline` 默认 `live = !args.includes('--source-only')`（`ui-baseline.mjs:105`）⇒ 默认即走 live 分支，F-02 成立；且 `recordBaseline:75-77` 对每个 `protectedPaths` 调 `content()`，**文件不存在会直接抛错** ⇒ `ui-baseline --record` 也已无法执行（漂移无法通过正规流程登记）。
3. `plugins/dsh-manual`、`dsh-system-awareness` 在 web profile 的 dependencies/bundles 均无、`node_modules` 探测 not found ⇒ 是否存在其它 profile/槽内安装、README 声称的 `0.1.6-alpha.2` 兼容性未核实。
4. `sources/*.txt` 数百历史快照未逐个打开；对 `customizations` 全量 `*.js` 的 `app-restart`/`app-quit`/`dshDesktopShell.action` grep 为 0 ✓。
5. `ui-tweaks` 81 行 live 版本是否即活动槽实际加载版本未核实（只确认 profile link 指向 `local/dsh-ui-tweaks`）。
