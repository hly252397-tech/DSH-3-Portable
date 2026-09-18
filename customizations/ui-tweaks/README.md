# customizations/ui-tweaks —— 界面微调插件（本地可变路径的入库归档）

> 为什么这里有一份：插件实体在 `Data/DSH/profiles/web/local/dsh-ui-tweaks/`，
> 而 **`Data/` 被 `.gitignore` 忽略**（第 21 行）。也就是说实体**没有版本历史**。
> 这份归档是它的**入库副本**，用于追溯、比对和灾难恢复；改东西请改实体，再同步到这里。

## 它解决什么问题

1. **输入区右上角布局**：把输入框工具行右侧的「平价/峰时 消耗胶囊 + 模型选择」
   搬到「黑洞空间」那一行的右端（贴右、同一行）。
   用户 2026-09-15 要求：「放到对话框右上角，贴右显示，和黑洞放在一行」＋「这个（平价）可以挪走」。
2. **界面改动免重启**：样式/布局放在**可变**的插件目录里，改完不需要构建、不需要重启桌面 App。
   宿主侧提供 `GET /ui-tweaks/reload-token`（client.js 的 mtime），客户端轮询到令牌变化就
   `location.reload()` —— **只刷新页面，不回收 DSH 运行时**（回收会把正在对话的会话一起杀掉，
   2026-09-15 实测事故，根因见 `docs/01-当前工作/机制-界面样式免重启生效与自验.md`）。
3. 黑洞图标换成细线风格（圆 + 斜环，与左侧导航图标一致）。

## 真实 DOM 锚点（全部来自源码/实机取证，不是猜的）

| 锚点 | 真实来源 |
| --- | --- |
| `.dbh-dock` | `dsh-black-hole` 注册在 `conversation.input.dock`（sibling 于输入卡片之上） |
| `.wSkVaW_composerStack` | `@deepseek-ai/dsh-client-ui-conversation` 的 `composerStack` |
| `.uV2eYG_card/_row/_tools/_trailing` | 同上（输入卡片/工具行/尾部容器） |
| `._7KE1Ra_root / _7KE1Ra_trigger` | `@deepseek-ai/dsh-client-ui-model-selection`（`conversation.input.model`） |
| `[aria-label^="本轮 "]` | `@kenz1117/dsh-ui-usage-billing` 的平价胶囊（注入 `conversation.input.right`） |

⚠️ 实机 aria-label 清单（2026-09-16 从运行中的 DSH 读出）：
`指令` / `添加附件` / `访问模式，当前：…` / `PUA（当前会话已开启）` / `本轮 ¥0 · 会话 ¥0` /
`选择模型，当前 …，推理等级 …` / `发送消息`。
**「专家」没有 aria-label**（是 agency-agents 的 `.aag-btn` 里一个无类 span）——
早期副本里 `:has(> [aria-label*="专家"])` 是编的，永远不命中，已删。

## 定位算法（踩过的三个坑都写在代码注释里）

- `position:fixed` + 视口坐标（黑洞行右端 − 8px、垂直居中），落位后量一次修回线性偏差。
  - 坑 A：曾用 `right:14px`（视口右缘）→ 控件被送出可视区；
  - 坑 B：曾用 `position:absolute` 从卡片往外放 → 被祖先 overflow 裁掉；
  - 坑 C：槽位外层可能是 `display:contents`（rect 全 0）→ 先解析出真正有盒子的内层再搬。
- **绝不给黑洞行加 padding**：加过一次 → 行内换行、行被撑高、顶进上面的状态条（2026-09-16 实拍）。
- 两档降级：① 平价 + 模型 一起上；② 放不下就只把模型搬上去；③ 连模型都放不下 → 原地不动。
- 收尾可见性校验（视口内 + 贴横带 ±14px + 有尺寸），不通过就整块回退 —— 宁可不动，绝不弄丢控件。

## 安装/恢复步骤

1. 把本目录复制回 `Data/DSH/profiles/web/local/dsh-ui-tweaks/`；
2. 在 `Data/DSH/profiles/web/package.json`：
   - `dependencies` 加 `"dsh-ui-tweaks": "link:local\\dsh-ui-tweaks"`；
   - `dsh.profile.bundles` 追加 `"dsh-ui-tweaks"`；
3. 建 Junction：`node_modules/dsh-ui-tweaks` → `local/dsh-ui-tweaks`
   （缺这三样，DSH 自愈会把加载失败的条目**从 bundles 里摘掉** —— 这是 2026-09-15 的坑）；
4. 触发一次 DSH 运行时回收（`.dsh-reload-request`，**注意会中断正在跑的会话**，要延后到空闲时）。

## 本轮验收证据（2026-09-16）

- `evidence/accepted-dock-row-wide-20260916.png`：1376px 宽窗口，黑洞行右端＝`峰时 ¥30.4  DeepSeek-V41-Fl… ⌄`，单行不重叠。
- `evidence/accepted-narrow-fallback-20260916.png`：1150px 窄窗，放不下 → 自动降级（胶囊留在输入行），不压字不换行。
- 取数方式：`scripts/look-ui.ps1` 只抓应用窗口矩形（临时置顶再抓，抓完取消置顶），再用 `read_image` 自己判。

## 侧栏页脚用量卡降噪（2026-09-16 用户「这里太丑了」）

**病点（实测计算样式，不是感觉）**：

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 数值 `9.10` | 22px / 600 / **JetBrains Mono** | **14px / 600 / Inter** |
| 卡片 | 146×**50px**，白底 78% + 1px 边框 + 阴影 + 12px 圆角 | 146×**36px**，背景/边框/阴影全透明，9px 圆角 |
| 图标 | 32px | 22px |
| 与「设置」对齐 | 卡顶 719 vs 设置…基线不齐（`.dcu-foot` 是 `align-items:end`） | 同轴 719（改 `center`） |

同伴是 36px 扁平幽灵按钮 `button.dcu-settings-trigger`，而卡片 50px + 盒子装饰 → 两种视觉语言并排 = 丑。
**作用域只限 `.dcu-foot`**，插件仪表盘里的大数字保持原设计。

证据：`evidence/before-sidebar-footer-20260916.png`（用户原始截图）→ `evidence/accepted-sidebar-footer-after-20260916.png`（改后）。

⚠️ **验收环境口径（重要）**：诊断实例**没有**外壳 `assets/theme.css`，而该文件在浅色下强制
`body[data-color-scheme="light"] .dcu-root{background:#fff!important}`（诊断实例默认淡绿底）。
所以只在诊断实例里看图会**误判**——必须先把 `theme.css` 以 `text/css` 喂进去 + 设 `data-color-scheme=light`
再验收（本轮已按此对照，数字与观感均成立）。另外 `data-dsh-preset="qoder"` 下外壳另有
`.dcu-footer-actions{display:flex;flex-direction:column}` 等规则；本机不是 qoder 预设，故未触发。

**未验收项（如实标注）**：App 自身的展开态像素未由我直接抓取——用户 App 的左栏当时处于**收起态**
（`.dcu-root.dcu-compact`，页脚只渲染 `VWh0dG_railButton`，不渲染本卡），而 Ctrl+B（SendKeys 与
keybd_event 各一次）都未能切换其展开态（两次截图 sha256 完全相同，说明窗口内容零变化）。
**该未验项已由用户侧实拍闭合**：用户随后发来的展开态截图（`¥9.70` + 设置，判定"可以了"）
就是 App 自身渲染结果，证明本插件的热重载通道在 App 里确实生效。

## 收起态（图标轨）页脚重合修复（2026-09-16 用户「图二重合了」）

**因果先说清（对照实验）**：停掉本插件样式再量，收起态几何**完全相同**
（foot 36px、rail x=24..60、gear x=44..52、横向重叠 16px、`grid-template-columns: 0px 12px 8px`）
→ **重叠是本来就有的**，不是本插件改出来的（本插件此前只把 `.dcu-foot` 的 `align-items` 由 end 改 center）。

**真凶 = 外壳 `assets/theme.css`**（诊断实例枚举全部匹配规则拿到的地面真相）：

```css
body .dcu-root .dcu-foot:has(.dcu-settings-seat > [data-slot="sidebar.settings"]
     > :not(style):not([data-dcu-settings-trigger]):not([data-dcu-settings-page]):not([data-slot]))
  { display: grid !important }        /* 特异性 (0,7,1) */
```

它按**展开态 252px** 设计，在 36px 图标轨里把 track 挤成 0/12/8 → 36px 圆钮溢出 12px 格、压住 8px 齿轮格。

**修法（插件侧，免构建免重启）**：照抄同一条 `:has()` 链**再加一层 `.dcu-compact`** → 特异性 (0,8,1)
压过它，改为 `flex/column` 纵向堆叠、两者各 36px 居中。
> 试错记录：只写 `.dcu-root.dcu-compact`（(0,3,1)）被压回 grid；只改 `grid-template-columns`
> 会把齿轮挤到侧栏外 x=72；**照抄 `:has()` 链（(0,5,1)）仍不够**——因为外壳那条 `:has()` 里还有
> 三个 `:not()`，实际是 (0,7,1)。最终 (0,8,1) 才压过。

**证据**：`evidence/before-compact-footer-20260916.png`（用户图二：弧与齿轮叠成一团）→
`evidence/accepted-compact-footer-after-20260916.png`（白底同环境下：圆钮在上、齿轮在下，各 36px/24px 独立）。

**已知脆弱点**：本规则与外壳 `:has()` 链耦合——若外壳日后改那条链，本规则会静默失配（退回 grid）。
届时要么同步改本规则，要么把该规则搬到 `theme.css` 里由外壳单方拥有（代价：改 theme.css 需构建+重启）。

## 空白态（欢迎页）与会话态**完全统一**：那一行的位置 + 外观（2026-09-17）

**用户要求（两轮）**：① 截图圈出输入卡片左下角的「模型选择器」＝红框1、标题行下面「👁 黑洞空间 ｜ ＋ 放进黑洞」右侧空白＝红框2，
原话「把红框1挪到2的位置」；② 交付后追问「能不能做到全局对话统一呢，这个区域」，并拍板 **「位置+外观都统一成会话态」**。

**改动前的事实（探针实测，非推测）**：红框1 ＝ `._7KE1Ra_root`（`conversation.input.model` 槽，
`IconDataOutline16` + 模型名 + `IconChevronDownOutline14`），在空白态因 2026-09-16 遗留的
`.dsh-tweaks-model`（26px 图标态）而只剩图标；输入行放不下 → `flex-wrap` 把它连同行尾的发送键换到第二行。
红框2 ＝ `.dbh-dock`（`dsh-black-hole` 注册在 `conversation.input.dock`）——**同一个元素**两种状态位置不同：
会话态在输入卡片正上方；空白态被插件 `observeHomeDockPlacement()` 用 `left/top:var(--dbh-home-dock-*)`
**绝对定位**到标题旁（宽屏 `inline`）/标题下一行（窄窗 `stacked`），还给标题加 `--dbh-home-title-shift` 左移。

**改法**：① 删掉 `applyAll()` 里「空白态一律短路」，空白态也走同一条 `lift()`；空白态几何守卫换成
「有最小尺寸 + 行里确实有 `.dbh-btn`」（原 `width>=260 / 横跨输入区` 在空白态恒不成立：父级是 `display:contents`，`stackW=0`）。
② 把那一行**拉回正常流**并统一外观：`…dbh-home-dock-host:has(.dsh-tweaks-seat) .dbh-dock{position:static; width:calc(100% - 2*留白); max-width:卡片最大宽; margin:0 auto}`，
标题 `transform:none`，并去掉首页变体的 1px 竖分隔线 / 紫色胶囊 / 弱化字色，改成与会话态同一套按钮形态。

**四个必须记住的坑（都在代码注释里）**：
1. 旧规则 `.dbh-dock:has(.dsh-tweaks-seat){position:relative!important}` 会压过黑洞插件的**非 important**
   `position:absolute` → dock 被甩到 y=930（视口外）。已加 `:not(.dbh-home-dock-host *)` 只作用于会话态。
2. 落点靠**插件自己的 order**：`composerStack` 是 column flex，卡片 `order:3`、工作区条 `order:4`，这一行缺省 `order:0`
   ⇒ 静态化后自然落在「标题内容之后、输入卡片之前」。**不要**给这一行写 `order`，那是插件的输出域。
3. 行宽必须**照抄卡片算式**（`calc(100% - 2*var(--dsh-composer-side-clearance))` 再受 `--dsh-composer-card-max-width` 限制 + `margin:0 auto`），
   否则座位（`margin-left:auto`）会贴到比卡片更靠右的位置；实测两种视口下「模型右缘 − 卡片右缘 = 0」。
4. 仍**不写** `data-dbh-dock-placement` 与 `--dbh-home-dock-*`（插件每次 sync 先删后按实测重算，两个写者会互抢）。
   另：插件首页摆放效果在它自己休眠时（页面重载后偶发不注册 observer）会让这一行落到「正常流」分支——
   两种分支下本插件的落点与外观一致（都已实测），所以不依赖插件状态。

**验收证据（2026-09-17）**：
- `evidence/before-hero-model-in-composer-20260917.png`：用户截图裁剪（红框1 在输入卡片第二行、红框2 空白）。
- `evidence/accepted-hero-unified-1384-20260917.png`：1384px 视口实拍——黑洞行**紧贴输入卡片上方**，行尾是模型图标，
  输入行 `[+ 📎 权限 专家 PUA | ↑]`，工作区条仍在卡片下方。
- `evidence/accepted-hero-unified-984-20260917.png`：984px 视口同形态。
- `evidence/accepted-active-dock-row-20260917.png`：会话态（应用窗口实机）行尾仍是 `平价 ¥51.2 + 模型图标`，未回归。
- DOM 实测（`dsh web` 诊断实例，同一 Profile/运行时槽，已补 `settings.yaml` 复现主题属性）：
  1384px `dock 101,391 661x32 pos=static` vs 卡片 `101,439 661x113` → 左右差 0、间距 16px、模型右缘差 0、`row=[tools|发送]`、`headline transform=none`；
  984px `dock 138,374 768x32` vs 卡片 `138,422 768x120` → 左右差 0、模型右缘差 0；按钮 `color rgb(15,17,21)/pad 6px 8px/radius 8px/minH 32px`、`::before content:none`。
- 旧的两张「stacked / inline 各自形态」截图（`accepted-hero-narrow-stacked-*`、`accepted-hero-wide-inline-*`）保留为**历史中间态**，
  它们记录的 `--dsh-tw-hero-dock-width` 做法已被本轮替换（见 git 历史与契约 §8）。
- 取数方式：`scripts/look-ui.ps1`（应用窗口最大化时需 `-AllowFullScreen`）＋ 诊断实例读 DOM；探针只用于定位，已删除。



## 中缝白带根治：#root 让位镜像上游状态帽（2026-09-17 用户「修复这里」第三轮）

**故障**：对话列与右栏之间一条全高空白竖带（红框 x≈697-862 即此区域）。探针实测 69px：
#root 让位 629px、面板渲染只 560px（修复前一轮是 594/560=34px 变体）。上一轮删掉的
x=818/825 两根 1px 缝线本轮已确认消失（像素扫描无全高线列）。

**根因（不在本插件，在 dsh-better-sidebar 自己）**：包内两条规则系互相矛盾——
面板侧 `/* seam-exact */` 块按内容状态给 `max-width` 帽（editorPlaceholder→420px /
paneEmptyCards→560px / 其余 none），布局推送侧 layout.css 却让 #root 按
`var(--dsh-sidebar-width)` 全值让位。持久化宽度 629 在空卡片态被压到 560 ⇒
69px 让位-渲染差 = 白带。panelDiag：inlineWidth 629 / computedWidth 560 / maxWidth 560。

**失败尝试（如实记录）**：本轮曾在线上副本加 `installReserveSync()`（MutationObserver +
400ms 稳定闸 + 4s 兜底，把渲染宽度写回变量）——真机稳态实测无效：writeGeometry 是另一个
写入者、会把全值写回去，自愈永远慢一拍；且探针只在页面加载后 0.5s/2s 采样，**永远拍不到
稳态**（验证盲区差点造成"已修"误判）。整段已删，panelDiag.syncInstalled 字段随之移除。

**改法（确定性 CSS，无 JS、无时序）**：把上游两条 `:has()` 状态帽**逐条镜像**到 #root——

```
html body:has(.nArs4W_panel .nArs4W_editorPlaceholder) #root{margin-right:min(var(--dsh-sidebar-width,0px),420px)!important;width:calc(100% - min(var(--dsh-sidebar-width,0px),420px))!important}
html body:has(.nArs4W_panel .nArs4W_paneEmptyCards)   #root{margin-right:min(var(--dsh-sidebar-width,0px),560px)!important;width:calc(100% - min(var(--dsh-sidebar-width,0px),560px))!important}
```

让位与渲染从此共用同一公式，任何状态/视口/拖拽中间帧都不可能分叉；收起态变量=0，min 后
仍 0。`body:has(...)` 不依赖面板 DOM 挂载位置；!important + (1,0,3) 压过上游 #root (1,0,0)。
**脆弱点**：上游给 `.nArs4W_panel` 新增状态帽时这里必须同步加一条，否则该状态白带复发
（与缝线修复的 :has() 耦合同类）。

**顺带核实（地雷登记）**：`node_modules/dsh-better-sidebar/lib/client.js` 存在既往会话的
**原位补丁**（writeGeometry 内「2026-09-17 修复：收起时…width=0」注释 + `/* seam-exact */`
块含 `body .pI_x6G_frame` 宿主样式）。插件更新/重装会冲掉它们 ⇒ 收起态 280px 空条与无帽态
白带会复发，届时先查这里。

**验收（2026-09-17 真机 1360×1000）**：
- 部署即热重载（22:45:08 写入 → 22:45:11 探针）：rootMarginRight **560** / rootWidth **800** /
  panelRect **[800,560]** —— 面板左缘 = 对话列右缘，零缝。
- `scripts/verify-adaptive-layout.mjs --refresh` **7/8 PASS**（修复前同日 3/8、5/8）：
  「无 body 带」✓「两框贴合 800=800」✓「拖动柄中点 797≈800」✓。
- 证据：`evidence/seam-strip-before-adaptive-verify-20260917.json`（FAIL 态数字）→
  `evidence/seam-strip-after-adaptive-verify-20260917.json`（PASS 态）+
  `evidence/accepted-seam-zoom-20260917.png`（边界 2× 放大：无竖线、无色差断层）。
- 未决项（顺手发现，非本轮引入、不代改）：有后台任务时「3 个后台任务」徽标被挤成竖排
  （左上 x≈118，43×114），修复前轮次即复现，待另立任务。
