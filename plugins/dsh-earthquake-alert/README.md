# dsh-earthquake-alert · 地震预警

在 DSH 中展示第三方转发的中国地震预警网（CENC）信息、最近地震，以及关注地点的距离和波到达粗估。它是辅助信息面板，不是官方预警渠道，也不能预测地震或保证提前量。

## ⛔ 改这个插件之前（强制前置）

**2026-10-01 事故教训**：本插件的契约测试与受保护源码清单**一直存在，命令就写在本文档第 144 行**，但改动者只跑了自建的 `test/ui-tokens.test.mjs` 和浏览器实测，结果契约测试 27 项挂 10 项、**告警静音**，并让另一个会话的重建门禁失效。根因不是信息不足，而是**把既有验收换成了自己临时造的验收**——自建护栏编码的是作者自己的设计意图，结构上测不到作者的盲区。以下五条是那次事故的直接产物。

**① 改动前先跑基线，改动后跑同一命令**（两个文件都要，缺一个都不算）：

```powershell
cd <便携根>
& '.\Tools\node-v26.10.0\node.exe' '.\node_modules\typescript\bin\tsc'
& '.\Tools\node-v26.10.0\node.exe' '.\scripts\run-tests.mjs' '.\dist\test\earthquake-client.test.js' '.\dist\test\earthquake-host.test.js'
```

基线（2026-10-01 实测）：客户端 **27/27**、宿主 **17/17**。单跑一个文件同样走运行器，不要裸跑 `node --test`。

**② 本插件有 5 个文件在受保护清单里**（`customizations/preservation.json` → `pluginName: dsh-earthquake-alert`）：
`cordis.patch.yml` · `lib/client.js` · `lib/index.js` · `lib/preferences.js` · `package.json`。
**动其中任何一个都会让发布门禁 fail**，收工前必须跑：

```powershell
& '.\Tools\node-v26.10.0\node.exe' '.\dist\scripts\check-customization-preservation.js' --source-only
```

- 漂移是自己的 → 按规程补齐（差异说明 → 归档到 `customizations/earthquake-alert/` → 正反向验收 → **只更新本插件那一条 sha256**，先备份清单）。
- 漂移不是自己的 → 如实上报，**不替他人背书、不改其哈希**。
- ⚠️ **不要凭窗口切片或印象认定"哪些文件受保护"**：2026-10-01 我就是用一个 1200 字符的切片去数条目，切片越过了下一个插件的块，把 README.md / apply.mjs 误当成受保护文件；随后按这个错误前提写脚本改清单，`$newBlock` 为 null 导致**整个插件条目被从清单里删掉**（JSON 仍合法，自检没拦住，靠 853 字节的体积差与 `pluginName` 计数才发现）。**正确做法**：先定位 `pluginName` 到下一个 `pluginName` 之间的完整块，再在该块内取 `path`，并核对还原后的条目数与体积。

**③ 结构重写（动 JSX 布局）前先列「契约面」，逐项标注"保留 / 显式改契约"**：
`data-dshea-action` 动作钩子、`data-dshea-banner|status|notice|form-error` 标记、`role`、`aria-live`/`aria-label`、测试查询的类名（`.dshea-banner-head` / `.dshea-banner-body` / `.dshea-pill.dshea-pill-test`）、i18n 占位符（`{n}` `{at}` `{latest}`）。
**外观重写最容易连带删掉的就是这些，它们在 diff 里看着像装饰。** 无障碍与动作钩子不是可选装饰，删了就是契约破坏。

**④ 声称"等价重构"必须指名观察者。** 实例：

```js
event => bus.enableSound?.(event)          // 返回值 = promise
event => { …; bus.enableSound?.(event); }  // 返回值 = undefined —— 丢了
```

浏览器**忽略 click 处理器的返回值**，所以应用里完全看不出差别；只有会 `await onClick(...)` 的契约测试能发现。**没有观察者的等价声明是自我安慰。**

**⑤ 调试本插件客户端代码的环境事实**（契约测试跑在纯净 vm 沙箱里，`document` 只有 `createElement/head`，`window` 只有 `ModuleLoader/AudioContext/localStorage`）：

- 锚定/测量类 effect 必须做 DOM 能力探测（`querySelector` / `getComputedStyle` / `addEventListener`）**并降级**——锚定是纯视觉增强，缺能力时绝不能让横幅本身挂掉（否则就是 8 项连片失败）。
- 诊断别用同步 `throw`：会被 `load()` 的 catch 吞成 `refreshFailed`，信息出不了沙箱。把状态编码进可从断言 `actual` 读出的量（如 `oscillator.start()` 次数）。
- 写"二分"探针前**先数目标字符串出现次数**——同一闸门可能在文件里写了两遍，只中和一处就不是二分，拿它当结论会连错两轮。


2026-10-01：时效、阈值、计时、持久偏好与全局UI一致性的源码修正及隔离真实链路验证已通过，**尚未部署到现役**。最终类型检查0错，正式定点47/47；全量1161项中1135通过、0失败、26跳过。真实Profile/Loader验收保留65条记录、32次可信鼠标、17张逐张复核截图，覆盖24组实际主列宽度/缩放/明暗主题。来源保护仍阻止本轮2项及此前5项未接受漂移，新偏好模块也须合法登记；没有改保护哈希放行，没有重启生产。完整证据及未完成项见 [工作记录](../../docs/01-当前工作/20261001-地震预警功能与全局UI统一.md)。

## 它长在哪

| 落点 | 形态 | 说明 |
|---|---|---|
| `sidebar.panellist` | 侧边栏图标 | 点击切到主面板；图标 id 与 `main` 的 key 同名 |
| `main` | 主面板 | 当前预警、影响判定、关注地点、最近地震、数据健康 |
| `shell.overlay` | 全屏横幅 | **只在存在「活动且相关」的预警时出现**，可关闭 |

## 数据源

宿主半侧轮询，客户端只读本插件同源端点（`/dsh-earthquake-alert/api`），页面侧不直连第三方。

| 用途 | 默认端点 |
|---|---|
| 秒级预警（EEW） | `https://api.wolfx.jp/cenc_eew.json` |
| 地震速报目录 | `https://api.wolfx.jp/cenc_eqlist.json` |

两个端点都是 **Wolfx 对中国地震预警网数据的第三方转发**，不是官方授权通道。无数据时插件保持沉默并显示健康度，不会伪造一条预警。

## 判定口径（源报告与本地估算分开）

- **源报告字段（第三方转发）**：震级、震源深度、震中地名、经纬度、最大烈度（`MaxIntensity`）、发震时刻、报告次数。不能把转发字段标为本插件已核验的官方原样数据。
- **本插件几何计算**：震中距 —— 半正矢公式，纯几何，可复核。
- **本插件速度模型估算**：P/S 波余量按均匀速度模型 P = 6.0 km/s、S = 3.5 km/s，估算走时扣除发震后已过时间；深度未知时明确说明简化假设，余量归零后显示估算已到达。**不是官方发布的到达时间，不能用于确定人员安全或保证倒计时。**
- **本插件未实现**：地点预估烈度。面板显示的是源报告 `MaxIntensity`，不是你的地点烈度。

## 报警条件

```
横幅弹出 ⟺ 时间有效、非未来、未超报警窗口（默认180 s），
             EEW抓取仍新鲜，震级≥阈值（默认M4.0），且：
  · 已配置关注地点 → 至少一个地点落在报警半径内（默认300 km）
  · 未配置关注地点 → 按全国震级阈值提醒，明确说明尚未配置地点
```

未来、过期、无效数据或EEW失联不当作实时预警；最近地震目录不触发预警。面板「测试横幅」使用独立演示数据、标明演示，15秒自动消失且可手动关闭，不触发真实告警声音。

## 使用步骤

1. 侧边栏点「地震预警」图标 → 打开主面板。
2. 在「关注地点」填名称 + 纬度 + 经度 → 添加，最多20个地点；空坐标不视为0。
3. 调整报警半径（10–2000 km）、最小震级（0–10）、报警窗口（30–3600秒）后保存。成功提示仅在宿主提交成功后出现；失败保留草稿，冲突需读取当前配置再选择。
4. 需要声音提醒时，使用页面显式音频启用操作。浏览器需要用户手势；重载后即使偏好仍开启，也需重新启用音频。启用失败会明确反馈，不保证自动播放。

## 稳定偏好与迁移

DSH默认随机本机端口，不能把按origin区分的localStorage当作跨重启真源。偏好由宿主通过自身同源、连接鉴权的 `GET/POST /dsh-earthquake-alert/api/preferences` 维护，POST携带revision；原快照GET端点保留。缺少鉴权能力时写操作失败关闭。

便携环境保存到 `DSH_PORTABLE_ROOT/Data/Plugins/dsh-earthquake-alert/preferences.json`（自身schema1）；非便携仅使用明确DSH_HOME下插件专属目录，不猜cwd。第一次读取不创建文件，只有用户保存才原子写入；路径链接、非法字段、超限请求、旧revision会被拒绝。不改会话、Profile格式或其他插件数据。

旧localStorage只能作为当前origin的迁移建议，由用户明确点击迁移后保存；已保存的宿主配置优先，不能静默被旧缓存覆盖。当前origin看不到别的历史端口localStorage，不宣称自动找回所有旧配置。隔离测试使用单独临时便携根，不读取生产地点。

## 宿主配置（Schemastery）

在插件管理页可改；也可以直接写在 `cordis.patch.yml` 的 `config:` 里。

| 键 | 默认 | 说明 |
|---|---|---|
| `eewUrl` | Wolfx CENC EEW | 秒级预警源 |
| `listUrl` | Wolfx CENC 目录 | 速报目录源 |
| `pollSeconds` | 5 | 预警轮询间隔（秒） |
| `listSeconds` | 60 | 目录刷新间隔（秒） |
| `timeoutSeconds` | 12 | 单次抓取超时（秒） |
| `maxResponseBytes` | 1048576 | 单次上游JSON体积上限，允许1024–4194304字节 |

> 轮询是对免费第三方服务的真实请求。默认 5 秒 ≈ 12 次/分钟，够快也够克制；调更短前请先确认上游能承受。

## ⚠️ 免责声明

**本插件不是官方预警服务。** 数据为第三方转发，可能延迟、丢包或中断；到达时间为速度模型粗估。保留官方发布渠道，不把本插件当作唯一预警手段。地震预警发生在地震之后、利用地震波传播时间差，不等于震前预测：[中国地震局官方发布会说明](https://www.mem.gov.cn/xw/xwfbh/2025n05y12xwfbh/)。

## 目录

```
package.json          清单：dsh.bundle.patch + dsh.client(platform: web)
cordis.patch.yml      bundle 补丁：insert 一行 id/name
lib/index.js          宿主半侧：有限轮询、形状校验、去重、独立健康、HTTP端点
lib/preferences.js    自身稳定偏好：验证、revision、原子持久化和路径守卫
lib/client.js         客户端半侧：图标 + 主面板 + 告警横幅 + 度量契约块
test/ui-tokens.test.mjs  护栏：禁止样式退回死值（见下节）
```

## 🎯 全局设计系统对齐契约（后续大改 UI 必读）

**目标**：全局改设计系统时，本插件必须跟着改，不能"改了这块那块还是原样"。
因此样式分两层，**每一层都有唯一真源**：

### 第 1 层 · 官方已 token 化 → 直接引用，改 token 即跟随

| 维度 | 引用 | 定义处 |
|---|---|---|
| 排版（size/weight/line-height） | `--dsw-font-<字阶>` | theme 的 `body` 块 |
| 字体family | `--dsh-font-ui`，兼容回退 `--dsw-font-family` | DSH统一theme与官方theme |
| 颜色 | `--dsw-alias-*` | theme 的 `body` 块 |
| 圆角 | `--dsw-radius-*` | theme 的 `:root` 块 |
| 阴影 / 浮层 | `--dsw-shadow-*` / `--dsw-elevation-*` | theme 的 `body` 块 |
| 过渡 / 缓动 | `--ds-transition-*` / `--ds-ease-*` | theme 的 `:root` 块 |
| 聚焦环 | `--dsw-focus-ring-*` | theme |

官方字阶（值取自 theme，注意 `m-18` 实际是 16px，**不要按名字猜**）：

```
--dsw-font-xxxs-11  11px/14px   --dsw-font-xxs-12   12px/18px
--dsw-font-xs-13    13px/20px   --dsw-font-s-14     14px/22px
--dsw-font-base-16  16px/24px   --dsw-font-xl-24    600 24px/32px
strong 变体为 500 字重（不是 600）：--dsw-font-s-strong-14 等
```

页面普通正文14、紧凑表单/事实与字段标签13、辅助说明12、同类页面标题24；各角色沿用同一全局语义字阶，大震级是业务读数例外。统一不是所有文字同大小。font简写之后显式使用统一family，避免被品牌字体带偏；不全局覆盖代码/终端/外站。实际中文字形须以运行时字体检测核验，不只比较CSS字符串。

### 第 2 层 · 官方未 token 化 → 集中成 `--dshea-*` 契约块

官方**没有**把控件高度、间距、浮层定位 token 化。这些值集中声明在
`lib/client.js` 的 `const CSS` 顶部 `.dshea-root,.dshea-banner{ ... }` 块里，
已有度量标注来源文件，新度量集中定义，不散落组件：

```
--dshea-control-h-md:36px   ← primitives/Button.module.css .md
--dshea-control-h-sm:28px   ← primitives/Button.module.css .sm
--dshea-field-h:34px        ← primitives/settings-form/fields.module.css .input
--dshea-badge-h:24px        ← primitives/Pill.module.css .pill
--dshea-space-1..6          ← 官方 CSS 模块中实际出现的间距取值集合
--dshea-hairline:0.5px      ← 官方全站半像素描边约定
--dshea-overlay-top/z       ← primitives/Toast.module.css
--dshea-magnitude-size:44px ← 本插件自有（官方最大字阶 24px 承载不了面板主读数）
```

**全局大改 UI 时的操作**：官方 token 变了无需动这里；若官方新增/调整了未 token 化的度量，
**改这一个块**即全插件跟随。

实际主列宽度决定地点行、输入与列表换行，包含侧栏/右面板导致的窄列；不可只用浏览器视口断点。≤480px时页头说明占整行，操作另行，不把说明挤成窄条。重要说明/字段标签沿全局次级文字色，实测明暗主题文字对比，不把“用了token”当成可读性验收。控件保持可访问名称、键盘焦点与保存/刷新反馈；每秒计时不让整张卡片反复aria-live播报。

### 护栏：禁止退化回死值

```powershell
cd G:\DSH-3-Portable
& '.\Tools\node-v26.10.0\node.exe' '.\node_modules\typescript\bin\tsc'
& '.\Tools\node-v26.10.0\node.exe' '.\scripts\run-tests.mjs' '.\dist\test\earthquake-client.test.js' '.\dist\test\earthquake-host.test.js'
```

护栏会失败的四类改动（都是"改了这块那块还是原样"的成因）：

1. 契约块之外出现字面 `font-size` / `font-weight` / `line-height`
2. `font:` 简写引用了字面量，或退回 `font:inherit`（会被 `main` 面板的品牌字体污染，
   而 Montserrat 没有中文字形 → 中英文分属两套字形）
3. 引用了官方未定义的 token，或未声明的契约变量
4. 出现字面圆角 / 写死颜色

护栏按实际活动Profile/运行时基线定位官方tokens，不以所有历史槽token并集放行；只有整个Data不存在的干净CI跳过实机token检查。客户端与宿主测试使用canonical源码和受控夹具，真实Profile/Loader/UI验收由 `scripts/verify-earthquake-alert.cjs` 单独记录，不把mock测试冒充真实部署。

> ⚠️ **超出样式层的风险（结构耦合，本插件无法自保）**：本插件挂在三个官方声明式插槽
> `sidebar.panellist` / `main` / `shell.overlay` 上。若大改 UI 时**换掉声明这些插槽的插件**
> （如 `michengai-codex-ui`），插槽契约变化会让插件消失或错位——那不是样式问题，
> 改动前需先确认这三个插槽在新 UI 中仍存在。


## 🔴 部署形态与踩坑记录（2026-09-30，实测）

**`<profile>/local/<插件>` 必须是真实目录，不能是 junction。** 对照复现：

```
dsh-manual（local/ 下真实目录）          → OK    exports=[Config, apply, inject, name]
dsh-earthquake-alert（local/ 下 junction）→ FAIL  ERR_MODULE_NOT_FOUND
    Cannot find package 'schemastery'
    imported from G:\DSH-3-Portable\plugins\dsh-earthquake-alert\lib\index.js
```

Node 的 ESM 解析会 **realpath 穿透 junction**，落到真实目标再向上找 `node_modules`。
把 `local/<插件>` 指向便携根 `plugins/` 会让它**解析不到 profile 的 `schemastery`**，
表现为 host 模块加载失败、插件行 `status: inactive`、客户端 slot 无 occupant。

正确的两层形态（与另 16 个本地插件一致）：

```
<profile>/local/<插件>              真实目录（本包的部署副本）
<profile>/node_modules/<插件>       Junction → <profile>/local/<插件>
```

**源码变化必须经合法保护审阅后进入部署副本，才能生效。** 本轮只在隔离Profile装配；未经确认不改现役。先读取实际家园/活动Profile/指针/patch与链接，检查目标及祖先是否为链接，精确备份文件；停止相应运行后只同步已审阅文件，不删除整个插件/家园。新 `lib/preferences.js` 必须随包携带，不能只复制两个旧JS。

随后通过真实Loader确认host/client加载、API鉴权、侧栏/main/overlay、偏好恢复和字体/缩放行为；候选启动验收成功前保留旧制品与回滚路径。遇到junction/路径不明先停止，禁止混用shell递归删除或绕过删除守卫。

保护清单 `customizations/preservation.json` 已登记此插件；新增文件与行为需完成差异、负向对照、真实组合验收后合法登记，不用修改哈希或兼容豁免让未验源码变绿。后续构建/内核更新必须保持插件源码、正确真实目录/link、启用状态与稳定Data偏好；不能只热改生产副本导致升级退回旧版。
