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

**未验收项（如实标注）**：App 自身像素未验——用户 App 的左栏处于**收起态**（`.dcu-root.dcu-compact`，
页脚只渲染 `VWh0dG_railButton`，不渲染本卡），而 Ctrl+B（SendKeys 与 keybd_event 各一次）都未能切换
其展开态（两次截图 sha256 完全相同，说明窗口内容零变化）。未去改用户界面状态凑验收。

