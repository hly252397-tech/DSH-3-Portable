# 审核单元 E 取证报告（assets/ 界面素材与 UI 契约）

> 来源：穷尽式只读审核单元 E（子代理会话），2026-09-26。本文是**证据留档**，未修改任何文件。
> 索引见 [全项目审核总报告](../便携版3-全项目审核总报告与修复清单.md)。
> 范围：`assets/**` 全部 **57 个文件**（29 文本 + 28 二进制）。

## 结论

**前后端契约 100% 对齐、0 缺失 id、0 缺失 API、`extraResources` 全覆盖、安全面干净；无 🔴 项；🟠 6 条 / ⚪ 9 条。** 最实的一条是**本仓红线字面违规**：`assets/theme.css` 与现役 `dsh-ui-tweaks/lib/client.js` 对同一批 UI 状态各写一遍近乎逐字相同的 `!important` 规则（两个便携写入者）。

## 门禁 PASS 结论（正向证据，可直接复用）

1. **契约正向**：`browser-workspace.js` 绑定的 **62 个 id 全部存在**于 `browser-panel.html`（该脚本唯一加载方；`shell.html` 已不加载且被 `test/main-safety.test.ts:380-391` 用 `doesNotMatch(/browser-workspace\.js/)` 钉住）。历史上"`shell.html` 缺 `menuExternal` ⇒ 顶层 `create()` 抛错 ⇒ 其后 `addEventListener` 一行未执行"的故障在当前结构下**不可能复现**。`shell.html` 的 8 个 id 全部有绑定。
2. **契约反向**：`browser-panel.html` 无"存在但无人绑定"的 id；`whale-particles.js:7-10` 用的 4 个 id 全在 `startup.html:206-210`。
3. **API 契约**：assets 用到的全部 `api.*` 逐项命中实际加载的 preload（`browser.*` 38 个使用项；`browser-panel-preload.cts:65-123`、`shell-preload.cts:78-183`）。
4. **安全**：assets 内 `postMessage`/`require(`/`nodeIntegration`/`eval(`/`new Function`/`document.write` **零命中**；`innerHTML` 全为字面量或布尔分支，**无 XSS**。
5. **构建归属**：运行时素材 100% 有 `extraResources` 条目且 `from`/`to` 与实际引用路径一致（`package.json:122-199`）；`branding/`、`screenshots/`、`repository-social-preview.png`、`icons/taskbar-optical.svg`、`icons/icon.icns` 为 README/构建期专用，**有意不入包**，正确。
6. `startup.html:207` 的 `./taskbar.png` **不是缺陷**：打包路径正确，dev 下由 `whale-particles.js:379-382` 回退 `./icons/taskbar.png`，属有意双路径回退。

## Findings

| # | 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|---|
| E-F1 | 🟠（**红线字面违规**） | `assets/theme.css:873-882, 919-924, 932-943` ↔ `Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js:43-50`（源在 `customizations/ui-tweaks/lib/client.js:44-50`） | **同一视觉状态存在两个便携写入者**：theme.css 由外壳 `insertCSS` 注入、插件写 `<style id="dsh-ui-tweaks-style">`，选择器与声明近乎逐字相同，最终**由加载顺序决定谁生效** ⇒ 只改一侧会"改了看不到" | 三组逐字重复：①`img[src^="data:image/webp;base64,UklGRvaKAABXRUJQVlA4IOqKAACQmwKdASoABgAC"]{content:url(<同一 SVG>);width/height:18px;object-fit:contain}`（**主会话已实读确认**：`theme.css:919-923` 与插件 `:48-50` 同 base64 前缀 + 同 SVG + 同 18px/contain/`!important`）；②`.uV2eYG_trailing{flex:0 1 auto!important;min-width:0!important}`；③`._7KE1Ra_trigger{…}`（theme.css 用 `min-width:96px`、插件用 `max-width:150px`，其余三条相同） | 收敛为**单一所有者**（建议留 theme.css、删插件副本），另一侧只留指向所有者的注释；改完走实机验证 + 记录 |
| E-F2 | 🟠 | `theme.css:330-335, 356-359, 376-379, 458-461, 463-469, 564-569, 619-623` | 用 `font-size:0` 抹掉**组件渲染的文案**再由 `::after{content:…}` 改写（红线），且文案是**硬编码中文、只作用于浅色** ⇒ 英文界面下这些位置仍显示中文 | `content:"编程"`(:331)、`"新的任务"`(:357)、`"搜索"`(:377,:620)、`"不止于编程"`(:459)、`"用 DSH 创造了不起的事物"`(:464)、`.dcu-brand::after{content:"编程"}`(:565)。**I021 已把 `content:"编程"` 判为"死规则、应删除"**（`docs/01-当前工作/I021-工作模式两档切换/00-迭代总览.md:64`），本轮仍在线 ⇒ **退役不彻底** | 删 `content` 注入，文案交回组件/本地化 |
| E-F3 | 🟠 | `theme.css:602-623` | 用**位置选择器** `.dcu-head-actions > button:last-child` 把第三方按钮绝对定位到 `top:78px;left:8px` 并注入文案"搜索"——依赖插件 DOM 顺序，插件改版即静默错位/丢文案；且与同文件 `:925-931` 自己写下的复盘结论（"外壳 CSS 无法把元素搬进另一个容器…已停止在外壳侧硬搬"）**自相矛盾** | `:602-617` 绝对定位 + `:619-623` `content:"搜索"` vs `:925-931` | 改用稳定属性定位（`[aria-label]`/`data-*`）并补回归断言；或按已有结论交回插件侧 |
| E-F4 | 🟠 | `assets/browser-panel.html:39-67`、`assets/browser-workspace.js`（~35 处 + 4 处 `confirm()`） | 规范「UI 文案由本地化字典拥有」：嵌入浏览器**整卡无英文**（仅地址栏 placeholder 与 3 个 tooltip 走 `zh()`）；两个 preload **都没有**暴露字典/`t()` 通道 | `browser-panel.html:40-55`（约 30 处静态中文）；`browser-workspace.js` 多处；`src/shell-preload.cts:78-183`、`src/browser-panel-preload.cts:65-123` 均无字典通道 | 集中成 zh/en 表，或在两个 preload 增开只读字典通道；**不要**逐个内联 `if` |
| E-F5 | 🟠 | `theme.css:665-675`（无暗色孪生块）、`:524-536` | `--dcu-sidebar-*` 全 8 变量**只在浅色覆盖**；暗色落到 codex-ui 自身 `body[data-ds-dark-theme] .dcu-root` 的淡绿偏暗调（`#1d2120`/`#303432`/`rgba(255,255,255,.08)`），与便携 zinc（`#18181b`/`#27272a`/`#3f3f46`）不同源；`--dcu-sidebar-expanded-width`、`--dcu-tip-shadow` 未覆盖 | codex-ui `lib/client.js:6979`（浅/暗两套默认值同处声明） | 补 `body[data-ds-dark-theme]`（或 `:not([data-color-scheme="light"])`）下同一组覆盖，实机比对深色侧栏与设置页左栏 |
| E-F6 | 🟠 | `theme.css:525-532` vs `:667-674` | **同文件两处写同一批变量且取值不同**：`--dcu-sidebar-hover` `#e4e4e7`（:531 无限定）vs `#f4f4f5 !important`（:668）；同源 `!important` 必胜 ⇒ `:526-532` 的 7 条声明**恒不生效（死声明）**；`--dcu-sidebar-wide-width` 又在 `:786` 重复第三次 | `:525-532`、`:667-674`、`:786` | 删失效那组或合并为单一权威声明 |
| E-F7 | ⚪ | `theme.css:722-724`（注释） | 注释写"视口 − **1040px**"，实现已是 **640**（`:720 --dsh-panel-margin:640px`、`src/browser-panel-layout.ts:14`）⇒ 过期注释会诱导改错"两把尺子" | `:720`/`:731-735` vs `:722-724` | 按实测值改写注释并点名唯一事实源 |
| E-F8 | ⚪ | `theme.css:36-38, 40-41, 95-97, 99-100` | `:root` 上的 `--dcu-tip-bg`/`--dcu-composer-bg`/`--sp-*` 被第三方在**更近祖先**重声明 ⇒ 这些 `:root` 值可能全是死声明（结论依赖「无法核实项 1」） | 插件 `client.js:6979`、`:7011`、`:9424/9425` | 先实机确认；确认无效即删除或改挂同层选择器 |
| E-F9 | ⚪ | `shell.html:26, 31, 32, 71, 89` | `#workspace-label` 被 `:31` **恒定 `display:none`**（无断点重显），却仍保留 focus/hover 样式与本地化文案 ⇒ 死控件 + 死样式 + 死分支。**能力未失**（`main.ts:3166` 的 `home` 与 browser-panel 主页按钮共用 `openHomepageGroup()`） | `shell.html:31/71/89` | 整段删除 |
| E-F10 | ⚪ | `shell.html:78-79` | `class="nav optional"` 在 shell.html 内**无 `.optional` 规则**，类名残留且与浏览器面板同名语义撞车 | vs `browser-panel.html:26` | 删除或改名 |
| E-F11 | ⚪ | `shell.html:24` vs `:50`（+ `:51`） | `.nav.restart.spinning` 的 `opacity:.5`（:24）与 `opacity:.6`（:50）后者胜、前者死；`:51 animation:none` 是空操作（全文件无该动画） | — | 合并为一条 |
| E-F12 | ⚪ | `assets/shell-icons/gear.svg`、`panel-right.svg` | **死素材仍打包**：现役零引用（仅历史快照），随 `extraResources` 进包 | `package.json:197-199` | 确认无引用后删除（删前跑 `pnpm test` + `ui-baseline`） |
| E-F13 | ⚪ | `browser-panel.html:26, 46-48`；`browser-workspace.css:26`；`browser-workspace.js:363-366, 384-386` | `.browser-tool.optional{display:none}`（**同一规则重复两处**）使三个控件永久隐藏，但脚本仍维护文案/`aria-pressed`/点击监听；功能已由 overflow 菜单重复提供 ⇒ **无功能损失**，仅死 DOM/死监听/重复 CSS | — | 二选一，不要两套入口长期并存 |
| E-F14 | ⚪ | `about.html:59`、`shortcuts.html:28`、`browser-panel.html:78,79,81` | **无 XSS**（`innerHTML` 全为字面量/布尔分支，外部数据走 `textContent`）；仅建议统一写法以消除"日后改成插值"的面 | — | 统一 `createElement` + `textContent` |
| E-F15 | ⚪ | `assets/task-badges/**` + `src/app-icon.ts:74`、`src/main.ts:3296` | 契约侧边界：`count` 为 `NaN` 时得 `NaN.png`（不存在）→ `nativeImage` 空 → 托盘徽标静默不显示；调用点无有限性校验。素材命名与 `extraResources` 完全一致 | `app-icon.ts:74-78`、`main.ts:3296-3300` | 调用点加 `Number.isFinite(count) && count > 0` 守卫（一行） |

## 文件清单（57）

- `.html`(7)：`about`、`browser-panel`、`feature-panels`、`settings`、`shell`、`shortcuts`、`startup`
- `.css`(2)：`browser-workspace.css`、`theme.css`
- `.js`(3)：`browser-workspace.js`、`theme.js`、`whale-particles.js`
- `.svg`(16)：`shell-icons/` 15 个 + `icons/taskbar-optical.svg`
- `.txt`(1)：`shell-icons/FONT-AWESOME-LICENSE.txt`（165 行，**随包属合规必需**）
- 二进制(28)：`.png` 23、`.webp` 1、`.ico` 3、`.icns` 1

## 无法核实项

1. **`.dcu-root` 是否在独立 iframe 文档内**（最高优先级）：codex-ui `lib/client.js:8330/8331` 往 frame 文档注入整套 `:root{…}`。**若在 iframe 内，`theme.css` 对 `.dcu-root` 的全部规则（`524-536`/`665-675`/`780-787`）落空；若在同文档，则 E-F8 的 `:root` 覆盖被更近声明遮蔽**——两种结论相反，需 DevTools 看 `ownerDocument` 与计算值。
2. 深色下未覆盖 `--dcu-sidebar-*` 的实际观感（E-F5）。
3. `.dcu-head-actions > button:last-child` 在当前 codex-ui 1.1.x DOM 里是否仍指向"搜索"按钮（E-F3）。
4. E-F1 两个写入者的最终生效者（`theme.css:919` 的 base64 前缀已核对确实命中 `dsh-black-hole/lib/client.js:23 BANNER_IMAGE`，规则是活的；但外壳 `insertCSS` 与插件 `<style>` 的先后需实机确认）。
5. 二进制素材内容（ico 帧尺寸、png 像素、icns 结构、task-badges 小尺寸可辨识度）——静态不可判。
6. `startup.html` 首帧硬编码中文在英文 locale 下的表现（`#msg`"正在启动"、`aria-label` 无 locale 通道；后续文案由 `src/startup-progress.ts:26-61` 下发）。
