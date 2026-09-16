// dsh-ui-tweaks —— 客户端：① 界面样式覆盖 ② 把「输入框工具行」右侧的
// 【平价消耗胶囊 + 模型选择】搬到「黑洞空间」那一行的右端（贴右、同一行）
// ③ 客户端热重载：轮询宿主 /ui-tweaks/reload-token，令牌变了只刷新页面。
//
// 为什么放在插件里（而不是外壳 assets/theme.css）：
//   外壳 theme.css 在**不可变槽**里，改一行要构建 + 重启 App；
//   插件目录 Data/DSH/profiles/web/local/** 是**可变**的，改完刷新页面即生效。
//
// 真实 DOM 锚点（来源＝官方/插件源码，不是猜的）：
//   · 黑洞空间那一行： `.dbh-dock`   ← dsh-black-hole 注册在 conversation.input.dock
//   · 输入区容器：     `.wSkVaW_composerStack`（dock 行与输入卡片是它的兄弟）
//   · 输入卡片：       `.uV2eYG_card` / 行 `.uV2eYG_row` / 右侧 `.uV2eYG_trailing`
//   · 模型选择座位：   `._7KE1Ra_root` ← @deepseek-ai/dsh-client-ui-model-selection（slot conversation.input.model）
//   · 平价消耗胶囊：   usage-billing 注入 conversation.input.right，文案「平价 / 峰时」+「¥…」
//
// 定位策略（踩过的三个坑都在这）：
//   1) 用 position:fixed + 视口坐标（黑洞行右端 - 8px，垂直居中），落位后量一次把线性偏差修回来。
//      坑 A：曾经用 `right:14px`（视口右缘）→ 控件被送出可视区；改为按黑洞行右端算。
//      坑 B：曾经用 position:absolute 从卡片里往外放 → 会被祖先 overflow 裁掉；fixed 逃得掉。
//      坑 C：槽位外层可能是 display:contents（rect 全 0）→ 先解析出真正有盒子的内层元素再搬。
//   2) 收尾做**可见性校验**：视口内 + 贴在黑洞行那条横带（±14px）+ 有实际尺寸；
//      校验不过 → 清掉内联样式整块回退，控件留在输入框原位（宁可不动，绝不弄丢控件）。
//
// 热重载（2026-09-15 用户指出「重启后会话就停了」之后的机制修复）：
//   外壳的 `.dsh-reload-request` 是**整运行时回收**，会杀掉正在对话的 DSH；
//   页面刷新足够（bundle 每次请求现读磁盘）。所以这里轮询宿主令牌，变化即 location.reload()，
//   并且只在输入框为空时刷新（不打断/不丢草稿）。
window.__ModuleLoader__.load({
  id: 'dsh-ui-tweaks',
  factory: () => {
    const module = { exports: {} };

    const CSS = [
      // —— 输入框工具行：不允许挤压，允许尾部容器收缩（防止芯片互相压住）——
      '.uV2eYG_row>button,.uV2eYG_row>div:not(.uV2eYG_trailing){flex:0 0 auto!important}',
      '.uV2eYG_trailing{flex:0 1 auto!important;min-width:0!important}',
      // 模型名过长时截断，别把黑洞行撑开
      '._7KE1Ra_trigger{max-width:150px!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}',
      // —— 黑洞图标：细线风格（圆 + 斜环），与左侧导航图标一致 ——
      'img[src^="data:image/webp;base64,UklGRvaKAABXRUJQVlA4IOqKAACQmwKdASoABgAC"]{',
      'content:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%2371717a\' stroke-width=\'1.6\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><circle cx=\'12\' cy=\'12\' r=\'5.6\'/><ellipse cx=\'12\' cy=\'12\' rx=\'9.4\' ry=\'3.6\' transform=\'rotate(-20 12 12)\'/></svg>")!important;',
      'width:18px!important;height:18px!important;object-fit:contain!important}',
      // —— 被搬上去的块：保持可点、别被压扁 ——
      '.dsh-tweaks-lifted{position:fixed!important;z-index:60!important;pointer-events:auto!important;flex:none!important;margin:0!important}',
      // —— 侧栏页脚用量卡降噪（2026-09-16 用户「这里太丑了」）——
      // 实测病点：数值 22px/600/JetBrains Mono（旁边「设置」13px Inter → 字号跳三级 + 换字体，像塞了张
      // 大字报）；卡片 146×50px 带边框/背景/阴影/12px 圆角，而同伴是 36px 扁平幽灵按钮；
      // .dcu-foot 又是 grid + align-items:end → 两者基线不对齐、重心歪。
      // 作用域**只限页脚**（.dcu-foot），插件仪表盘里的大数字保持原设计不动。
      '.dcu-foot{align-items:center!important;gap:4px!important}',
      '.dcu-foot .VWh0dG_triggerWrap{height:auto!important}',
      '.dcu-foot .VWh0dG_trigger{height:36px!important;padding:4px 8px!important;border-radius:9px!important;',
      'background:transparent!important;border-color:transparent!important;box-shadow:none!important;gap:6px!important}',
      '.dcu-foot .VWh0dG_trigger:hover{background:rgba(127,127,127,.12)!important}',
      '.dcu-foot .VWh0dG_triggerIcon{width:22px!important;height:22px!important}',
      '.dcu-foot .VWh0dG_triggerMetric{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif!important;',
      'font-size:14px!important;font-weight:600!important;line-height:20px!important;height:auto!important}',
      '.dcu-foot .VWh0dG_triggerYen{font-size:11px!important}',
      // —— 收起态（图标轨）页脚重合修复（2026-09-16 用户「图二重合了」）——
      // 先说清因果：对照实验证明**重叠是本来就有的**——停掉本插件样式再量，几何完全相同
      // （foot 36px、rail [24..60]、gear [44..52]、横向重叠 16px、grid 列 0px 12px 8px）。
      // codex-ui 的设计意图是「36px 单列纵向堆叠」（.dcu-compact .dcu-foot{width:36px}、
      // .dcu-settings-seat{width:36px}、按钮 width:100%），但实测列被算成三列，
      // 圆钮 36px 溢出 12px 格 → 压住 8px 宽的齿轮格，两个字形叠成一团。
      // 这里把意图落实：收起态改用 flex 纵向堆叠。
      // 特异性证据（诊断实例枚举全部匹配规则）：压住页脚的是外壳 theme.css 的
      //   body .dcu-root .dcu-foot:has(.dcu-settings-seat > [data-slot="sidebar.settings"]
      //        > :not(style):not([data-dcu-settings-trigger]):not([data-dcu-settings-page]):not([data-slot]))
      //   { display:grid !important }   → 特异性 (0,7,1)
      // 它按展开态 252px 设计，在 36px 图标轨里把 track 挤成 8px，才造成圆钮压齿轮。
      // 因此必须**照抄同一条 :has() 链再加一层 .dcu-compact**（→ (0,8,1)）才能压过；
      // 只写 .dcu-root.dcu-compact（(0,3,1)）会被压回 grid——实测过。
      'body .dcu-root.dcu-compact .dcu-foot:has(.dcu-settings-seat > [data-slot="sidebar.settings"] > :not(style):not([data-dcu-settings-trigger]):not([data-dcu-settings-page]):not([data-slot])){',
      'display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:flex-end!important;gap:6px!important;',
      // 贴底：实测收起态页脚高 130px 但可见内容只到 714（齿轮底），下方多出 30px 空白 —— 页脚里
      // 有不可见子项在贡献高度（实测 hover/popover 之类），而 justify-content:flex-end 对它无效。
      // 所以不追那个子项，改为**只按内容高度排布**（height/min-height 归零 + fit-content），
      // 由导航的 flex:1 把页脚整体顶到栏底，空白自然消失。
      'height:auto!important;min-height:0!important;padding:4px 0 6px!important;margin:0 auto!important;width:36px!important}',
      // 「这一列要对齐」：实测导航图标 36×36 于 [17..53]（中线 35），而页脚用量圆钮在 [7..43]（中线 25，偏左 10px）、
      // 齿轮 [19..43]（24 宽，中线 31）。原因是页脚只有 36px 宽且**靠左**，而导航是在 54px 轨道里居中。
      // 修法：页脚宽度 36 + `margin:0 auto` 居中 → 与导航同列；两个子项统一 36px 宽，中心自然一致。
      'body .dcu-root.dcu-compact .dcu-foot .dcu-settings-trigger{width:36px!important;height:36px!important;min-height:36px!important;',
      // 实测齿轮被右对齐（[28..52]，中线 40），而导航列中线是 35 → 必须显式居中（align-self + 两侧 auto 外边距）
      'align-self:center!important;margin-left:auto!important;margin-right:auto!important;',
      'flex:none!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:0!important}',
      // 「图标格式要统一」：导航=16px 实心路径，齿轮=16px 细线(stroke1.6)；而用量图标是 26px + 40×40 viewBox
      // + 四层透明度(0.16/1/0.7/0.38)的分层弧——尺寸与语言都不是一套。这里藏掉插件的分层弧，
      // 用与齿轮/导航同语言的 16px 细线仪表盘顶上（不改插件逻辑，只改观感）。
      'body .dcu-root.dcu-compact .dcu-foot .VWh0dG_railButton svg{display:none!important}',
      'body .dcu-root.dcu-compact .dcu-foot .VWh0dG_railButton{background-image:url("data:image/svg+xml;utf8,',
      '<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\' fill=\'none\' stroke=\'%234e5253\' stroke-width=\'1.6\' stroke-linecap=\'round\' stroke-linejoin=\'round\'>',
      '<path d=\'M2.2 12.3a6.3 6.3 0 1 1 11.6 0\'/><path d=\'M8 12.3 10.6 7.6\'/></svg>")!important;',
      'background-repeat:no-repeat!important;background-position:center!important;background-size:16px 16px!important}',
      // 展开态卡片里同一枚仪表盘也统一成细线
      'body .dcu-root:not(.dcu-compact) .dcu-foot .VWh0dG_triggerIcon svg{display:none!important}',
      'body .dcu-root:not(.dcu-compact) .dcu-foot .VWh0dG_triggerIcon{background-image:url("data:image/svg+xml;utf8,',
      '<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\' fill=\'none\' stroke=\'%234e5253\' stroke-width=\'1.6\' stroke-linecap=\'round\' stroke-linejoin=\'round\'>',
      '<path d=\'M2.2 12.3a6.3 6.3 0 1 1 11.6 0\'/><path d=\'M8 12.3 10.6 7.6\'/></svg>")!important;',
      'background-repeat:no-repeat!important;background-position:center!important;background-size:16px 16px!important}',
      // 「为什么不贴底」的真凶：页脚里还排着一个**无类名空 div**（12×24、flex、无文本无背景，
      // 即外壳的连接状态位，视觉上不画任何东西），它排在齿轮**下方**，占走 24px + 6px 间隙 = 30px，
      // 于是两个可见项看着悬在半空。这里只把它 `order:-1` 挪到最前（**不隐藏**任何功能元素），
      // 两个可见项就自然落到栏底。
      'body .dcu-root.dcu-compact .dcu-foot div:empty{order:-1!important}',
      'body .dcu-root.dcu-compact .dcu-foot .VWh0dG_railButton{width:36px!important;height:36px!important;flex:none!important;',
      // 「用量为什么带个框」：插件给 railButton 默认画了白底 + 1px 圆角边框（卡片语言），
      // 且 :hover / :focus-visible 会把边框染成 --ds-blue（用户截图里的蓝框即这两态之一）；
      // 而导轨其余图标都是扁平的、没有盒子。这里拆掉盒子，hover/focus 改成与 .dcu-icon 同一套反馈。
      // ⚠️ 必须用 background-color 简写以外的长写：`background:transparent` 会把上面那条
      // background-image（细线仪表盘）一起重置掉，实测 railBgSize 从 16px 16px 掉回 auto、图标消失。
      'background-color:transparent!important;border-color:transparent!important;border-radius:9px!important;box-shadow:none!important}',
      'body .dcu-root.dcu-compact .dcu-foot .VWh0dG_railButton:hover{background-color:var(--dcu-sidebar-hover)!important;',
      'color:var(--dcu-sidebar-primary)!important;border-color:transparent!important;outline:none!important}',
      'body .dcu-root.dcu-compact .dcu-foot .VWh0dG_railButton:focus-visible{background-color:var(--dcu-sidebar-hover)!important;',
      'border-color:transparent!important;outline:2px solid var(--dcu-sidebar-primary)!important;outline-offset:-2px!important}',
      // —— 黑洞行三修（2026-09-16 用户：黑洞背景不要 / 计价框和模型对齐 / 计价和其他不统一）——
      // ① 暗底来自插件自身 `.dbh-orb{background:#090e19;border-radius:8px}`（不是我换的细线图标）；
      // ② 计价胶囊自带 JetBrains Mono 22px 数字 + 999px 填充药丸 + 警示配色，与右侧纯文本模型块不是一套语言；
      // ③ 胶囊 22px vs 模型 28px，而我按顶对齐 → 中线差 3px；统一高度后顶与中线同时对齐。
      '.dbh-dock .dbh-orb{background:transparent!important;box-shadow:none!important}',
      // 「新建会话这里」修（2026-09-16 用户）：空白态里黑洞那一行被挤进输入框那一行、压在占位文字上。
      // 实测（诊断实例）：它的槽容器是 display:contents，内容直接参与 composerStack 的纵向 flex，
      // 且 DOM 顺序**在输入行之前** → 只要让槽容器独占一整行，它就回到输入框上方（与会话态一致）；
      // 不能用 order:-1（那会跑到标题/卡片上面去）。
      '.wSkVaW_composerHero [data-slot="conversation.input.dock"]{display:block!important;width:100%!important;flex:0 0 100%!important}',
      // 「做成这样」（2026-09-16 用户：空白态那一行要跟会话态同格式）：
      // 空白态是黑洞插件的 hero 变体——orb 带径向渐变圆底 + 光环、`放进黑洞`带紫色胶囊；
      // 会话态是裸图标 + 纯文字。这里用更高特异性 + 简写把两者压平（背景图/阴影/边框/圆角一起清）。
      'body .wSkVaW_composerHero .dbh-dock .dbh-orb, body .dbh-dock .dbh-orb{',
      'background:transparent!important;background-image:none!important;box-shadow:none!important;border-radius:0!important}',
      'body .wSkVaW_composerHero .dbh-dock .dbh-dock-wrap > button{',
      'background:transparent!important;border-color:transparent!important;border-radius:0!important;padding:0!important;box-shadow:none!important}',
      // 输入区旁边的黑洞图标统一为「右面板菜单里那一枚」（2026-09-16 用户选 A：以菜单为准）——
      // 原样取自黑洞插件给右面板注册的图标：倾斜椭圆 rx7/ry3.5 旋转 -30° + 中心实心圆 r2，stroke 1.5。
      '.dbh-dock .dbh-orb{content:url("data:image/svg+xml;utf8,',
      '<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\' fill=\'none\' stroke=\'%234e5253\' stroke-width=\'1.5\'>',
      '<ellipse cx=\'8\' cy=\'8\' rx=\'7\' ry=\'3.5\' transform=\'rotate(-30 8 8)\'/>',
      '<circle cx=\'8\' cy=\'8\' r=\'2\' fill=\'%234e5253\' stroke=\'none\'/></svg>")!important}',
      '.dsh-tweaks-lifted{height:28px!important;display:flex!important;align-items:center!important;',
      // 「计价和模型盖住黑洞选项」的根治（2026-09-16 用户）：原来用 position:fixed 贴右，固定定位不看邻居，
      // 必然可能压住该行自己的「＋放进黑洞」。改为**正常流 + margin-left:auto** 排到最右，
      // CSS !important 压掉 JS 写的行内 position/left/top，JS 逻辑不动。
      'position:static!important;left:auto!important;top:auto!important;right:auto!important;',
      'margin-left:auto!important;flex:none!important;min-width:0!important}',
      '.dsh-tweaks-lifted ~ .dsh-tweaks-lifted{margin-left:0!important}',
      '.dbh-dock{display:flex!important;align-items:center!important;gap:8px!important;flex-wrap:wrap!important}',
      // 「自适应靠右」：左边那组（黑洞空间 / ＋放进黑洞）**不被压缩**，右边的计价与模型用自动外边距顶到最右；
      // 宽度不够时 flex-wrap 让它们换到第二行（仍在同一行容器内），不会互相覆盖，也不会把左边挤走。
      '.dbh-dock > :not(.dsh-tweaks-lifted){flex:0 0 auto!important;min-width:max-content!important}',
      // 撤回「只显示图标」（2026-09-16）：实测模型座**只有文字 + 下拉箭头、没有真图标**，
      // 藏掉文字后只剩一个 ⌄，整行认不出（用户："我已经看不清这一行了"）。必须保留文字。
      // 行内已用 flex 流 + nowrap，不会再压盖邻居，因此无需再藏。
      // 模型名必须完整可读：**不可压缩**（min-width:max-content），一行放不下就换到第二行，绝不被挤成只剩箭头。
      // 模型名可读且不撑破一行：给 min-width:0（允许省略号截断），而不是 max-content
      // —— max-content 会让它按**完整模型名**占宽（实测因此被挤到第二行）。
      // 模型位收成一枚「图标」（用户 2026-09-16：把模型名做成图标，点它可下拉看模型列表）
      // ① 只藏纯文字节点；svg 与"含 svg 的容器"一律保留 → 原来的点击元素与下拉箭头都还在，点击行为不变；
      // ② ::before 画一枚模型图标（芯片造型，16px，与整体细线语言一致）；
      // ③ 固定 26px 窄宽度，长模型名不再把这一行撑到第二行。
      '.dsh-tweaks-model{width:26px!important;min-width:26px!important;max-width:26px!important;height:26px!important;',
      'padding:0!important;overflow:hidden!important;justify-content:center!important;position:relative!important;cursor:pointer!important;',
      // 收成 26px 固定盒后，插件自带的底色会露成一个小方块（用户 2026-09-16："为什么背景有个小方块"）→ 底色清零；
      // hover 才给与导轨图标一致的淡灰反馈，圆角 8px。
      'background-color:transparent!important;border-color:transparent!important;box-shadow:none!important;border-radius:8px!important}',
      '.dsh-tweaks-model:hover{background-color:rgba(127,127,127,.12)!important}',
      // 灰方块是**内层元素或其伪元素**画的（只清 background-color 不够）→ 用 background 简写把颜色与图片一起清掉，
      // 并覆盖 ::before/::after；hover 反馈仍在外层，不受影响。
      '.dsh-tweaks-model *:not(svg):not(svg *),',
      '.dsh-tweaks-model *:not(svg):not(svg *)::before,',
      '.dsh-tweaks-model *:not(svg):not(svg *)::after{',
      'background:transparent!important;background-image:none!important;border-color:transparent!important;box-shadow:none!important}',
      // 「回到底部」悬浮按钮：**往下**挪进"最后一行 ↔ 黑洞行"之间的空隙（往上抬过，仍压在同一列文字上），
      // 并做成不透明标准按钮（半透明时文字透出来，看着像笔画被切）。不改行为、不隐藏。
      '.dsh-tweaks-float{transform:translateY(30px)!important;background:Canvas!important;',
      'border:1px solid rgba(0,0,0,.08)!important;box-shadow:0 2px 8px rgba(0,0,0,.10)!important}',
      '.dsh-tweaks-model :not(svg):not(svg *):not(:has(svg)){display:none!important}',
      '.dsh-tweaks-model::before{content:""!important;position:absolute!important;left:0!important;right:0!important;top:0!important;bottom:0!important;margin:auto!important;',
      'width:16px!important;height:16px!important;pointer-events:none!important;background-repeat:no-repeat!important;background-position:center!important;background-size:16px 16px!important;',
      'background-image:url("data:image/svg+xml;utf8,',
      '<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\' fill=\'none\' stroke=\'%234e5253\' stroke-width=\'1.5\' stroke-linecap=\'round\'>',
      '<rect x=\'2.2\' y=\'4.6\' width=\'11.6\' height=\'8.8\' rx=\'2.2\'/>',
      '<path d=\'M5.8 4.6V3.4c0-.7.6-1.2 1.2-1.2h2c.7 0 1.2.5 1.2 1.2v1.2\'/>',
      '<path d=\'M6.2 9h3.6\'/></svg>")!important}',
      // 「调」（2026-09-16 用户）：目标是让黑洞行四项回到一行 —— 只缩计价胶囊的字号/内边距并收紧行内间距，
      // **不删任何信息**（"平价"保留，只是变紧凑），模型名不做任何裁剪。
      '.dbh-dock{gap:6px!important}',
      '.dsh-tweaks-lifted .VWh0dG_feeInline{font-size:11px!important;height:18px!important;padding:0 4px!important}',
      '.dsh-tweaks-lifted .VWh0dG_triggerMetric{font-size:13px!important;line-height:18px!important}',
      '.dsh-tweaks-lifted .VWh0dG_triggerYen{font-size:11px!important;line-height:18px!important}',
      // seat 容器承载「整体贴右」：内部计价与模型并排（nowrap），所以**不会再互相断行**。
      '.dsh-tweaks-seat{display:flex!important;align-items:center!important;gap:8px!important;',
      'margin-left:auto!important;flex:0 0 auto!important;flex-wrap:nowrap!important}',
      '.dsh-tweaks-lifted .VWh0dG_triggerPrimary,.dsh-tweaks-lifted .VWh0dG_triggerMetric,.dsh-tweaks-lifted .VWh0dG_triggerYen,',
      '.dsh-tweaks-lifted .VWh0dG_feeInline,.dsh-tweaks-lifted .VWh0dG_triggerLabel{font-family:Inter,ui-sans-serif,system-ui,sans-serif!important;',
      'font-size:14px!important;font-weight:600!important;line-height:20px!important;color:inherit!important;',
      'background-color:transparent!important;border-color:transparent!important;box-shadow:none!important;',
      'height:auto!important;min-height:0!important;padding:0!important;border-radius:0!important}',
      // —— 对话到底部要「渐隐消失」，而不是压在图标上（2026-09-16 用户）——
      // 根因：输入区这一层背景是透明的，对话滚到底就直接透出来压在黑洞/计价/模型那一行上。
      // 修法：① 给输入区底色（用 Canvas 系统色，跟随主题，不写死颜色）；② 上沿加一条透明→底色的过渡带，形成渐隐。
      '.wSkVaW_composerStack{position:relative!important;background:Canvas!important}',
      '.wSkVaW_composerStack::before{content:""!important;position:absolute!important;left:0!important;right:0!important;',
      'top:-14px!important;height:14px!important;pointer-events:none!important;background:linear-gradient(to bottom,transparent,Canvas)!important}',
      // 同一问题在「黑洞那一行」上还有一份：它可能不在 composerStack 的覆盖范围内（2026-09-16 用户图二：对话文字压住
      // 黑洞空间/放进黑洞 那行）。`.dbh-dock` 是实测存在的锚点，直接给它底色 + 同款渐隐带。
      '.dbh-dock{position:relative!important;background:Canvas!important;z-index:2!important}',
      '.dbh-dock::before{content:""!important;position:absolute!important;left:0!important;right:0!important;',
      'top:-10px!important;height:10px!important;pointer-events:none!important;background:linear-gradient(to bottom,transparent,Canvas)!important}',
      // 收起态图标轨的悬停名称气泡（fixed 定位，避免被 root 的 overflow:hidden 裁掉）
      '.tw-rail-tip{position:fixed;left:-9999px;top:0;z-index:2147483000;pointer-events:none;opacity:0;',
      'background:#fff;color:#18181b;border:1px solid rgba(0,0,0,.08);border-radius:8px;',
      'box-shadow:0 6px 18px rgba(0,0,0,.12);padding:4px 8px;font-size:12px;line-height:16px;',
      'font-family:Inter,ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;white-space:nowrap;transition:opacity .12s}',
      '.tw-rail-tip.on{opacity:1}',
      'body[data-color-scheme="dark"] .tw-rail-tip{background:#1f1f22;color:#f4f4f5;border-color:rgba(255,255,255,.12)}'
    ].join('');

    const LIFT = 'dsh-tweaks-lifted';
    const state = (v) => { document.documentElement.dataset.tw = v; };

    function injectStyle() {
      if (document.getElementById('dsh-ui-tweaks-style')) return;
      const style = document.createElement('style');
      style.id = 'dsh-ui-tweaks-style';
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    }

    /** 「黑洞空间」那一行。找不到返回 null（那就什么都不做）。 */
    const findDock = () => document.querySelector('.dbh-dock');

    /** 模型选择座位（真实类名，来自官方 model-selection 包）。 */
    const findModelSeat = () => document.querySelector('._7KE1Ra_root');

    /** 「平价消耗胶囊」：usage-billing 注入 conversation.input.right（在 .uV2eYG_trailing 里），
     *  实测锚点＝内层 span 的 `aria-label="本轮 ¥x · 会话 ¥y"`（比猜文案稳），退回文案兜底；
     *  再上溯到输入行的直接子节点作为搬运单位。 */
    function findCostChip() {
      const trailing = document.querySelector('.uV2eYG_trailing');
      if (!trailing) return null;
      const hit = trailing.querySelector('[aria-label^="本轮 "]')
        || [...trailing.querySelectorAll('*')].find(
          (el) => el.children.length === 0 && /^(平价|峰时|¥)/.test((el.textContent || '').trim())
        );
      if (!hit) return null;
      let node = hit;
      while (node.parentElement && node.parentElement !== trailing) node = node.parentElement;
      return node.parentElement === trailing ? node : null;
    }

    /** 解析出真正有盒子的元素：槽位外层可能是 display:contents（rect 全 0），往下找内层。 */
    function boxOf(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) return el;
      for (const child of el.children) {
        const found = boxOf(child);
        if (found) return found;
      }
      return null;
    }

    const saved = new Map();

    // 2026-09-16 结构修正：计价与模型放进**内层 seat 容器**，`margin-left:auto` 挂在这个容器上。
    // 之前直接给计价挂 auto 外边距 → Chromium 断行时把 auto 当成已占用，模型永远放不下、被挤到第二行。
    // 现在容器整体贴右，容器内部两件并排（flex 默认 nowrap），不会再互相断行。
    const SEAT = 'dsh-tweaks-seat';

    function ensureSeat(dock) {
      let seat = null;
      for (const child of dock.children) if (child.classList && child.classList.contains(SEAT)) { seat = child; break; }
      if (!seat) {
        seat = document.createElement('div');
        seat.className = SEAT;
        dock.appendChild(seat);
      }
      return seat;
    }

    // 「如果没有就不显示」：revert 时**无条件移除座位**并把里面节点原位放回（2026-09-16 用户 B）。
    // 实测空白/欢迎态 .dbh-dock 里残留一个 8px 宽 seat（里面是被压成 8px 的残余节点，所以按"可见性"判断会漏掉）。
    function dropSeatIfEmpty(dock) {
      if (!dock) return;
      for (const child of [...dock.children]) {
        if (!child.classList || !child.classList.contains(SEAT)) continue;
        for (const el of [...child.children]) {
          const prev = saved.get(el);
          if (prev && prev.parent && prev.parent.isConnected && el.parentElement !== prev.parent) {
            const anchor = prev.next && prev.next.parentElement === prev.parent ? prev.next : null;
            prev.parent.insertBefore(el, anchor);
          }
        }
        child.remove();
      }
    }

    function lift(el, dock) {
      if (!saved.has(el)) {
        saved.set(el, { style: el.getAttribute('style'), parent: el.parentElement, next: el.nextElementSibling });
      }
      el.classList.add(LIFT);
      el.style.removeProperty('position');
      el.style.removeProperty('left');
      el.style.removeProperty('top');
      el.style.removeProperty('margin');
      const seat = ensureSeat(dock);
      if (el.parentElement !== seat) seat.appendChild(el);
    }

    function unLift(el) {
      const prev = saved.get(el);
      el.classList.remove(LIFT);
      if (prev) {
        if (prev.style !== null && prev.style !== undefined) el.setAttribute('style', prev.style);
        else el.removeAttribute('style');
        if (prev.parent && prev.parent.isConnected && el.parentElement !== prev.parent) {
          const anchor = prev.next && prev.next.parentElement === prev.parent ? prev.next : null;
          prev.parent.insertBefore(el, anchor);
        }
      }
      saved.delete(el);
    }

    // 「回到底部」悬浮按钮（官方前端渲染，类名未知、不在 codex-ui/theme.css 里）会压住正文最后一行。
    // 按**几何特征**定位：小尺寸 + 纯图标（无文字）+ 已定位 + 紧贴在黑洞行上方。只加类，CSS 里把它抬高 16px。
    function markFloatingButtons(dock) {
      const dr = dock.getBoundingClientRect();
      for (const el of document.querySelectorAll('button,[role="button"]')) {
        const s = getComputedStyle(el);
        if (s.position !== 'fixed' && s.position !== 'absolute') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 12 || r.width > 48 || r.height < 12 || r.height > 48) continue;
        if ((el.textContent || '').trim() !== '') continue;
        if (!el.querySelector('svg')) continue;
        if (r.bottom > dr.top + 4 || r.right < dr.left) continue;
        el.classList.add('dsh-tweaks-float');
      }
    }

    function revert(dock, els) {      for (const el of els) if (el && saved.has(el)) unLift(el);
      dropSeatIfEmpty(dock);
      if (dock) dock.style.removeProperty('padding-right');
    }

    function applyAll() {
      injectStyle();
      const dock = findDock();
      if (!dock) { state('nodock'); return; }
      const modelRaw = findModelSeat();
      if (!modelRaw) { state('nomodel'); return; }
      const dr0 = dock.getBoundingClientRect();
      // 只认「横跨输入区的那一行」：hero/欢迎态下 .dbh-dock 只是标题旁的一枚小胶囊，那种情况一律不动。
      const stack = dock.parentElement;
      const stackW = stack ? stack.getBoundingClientRect().width : 0;
      const fullRow = stackW > 4 ? dr0.width >= stackW * 0.6 : dr0.width >= 260;
      if (dr0.width < 160 || dr0.height < 12 || dr0.top < 0 || !fullRow) {
        revert(dock, [modelRaw]);
        state('skip');
        return;
      }

      const model = boxOf(modelRaw);
      if (!model) {
        revert(dock, [modelRaw]);
        state('nomodel');
        return;
      }
      const chipRaw = findCostChip();
      const chip = chipRaw && chipRaw !== modelRaw && !dock.contains(chipRaw) ? boxOf(chipRaw) : null;
      const modelW = Math.round(model.getBoundingClientRect().width) || 90;
      const mh = model.getBoundingClientRect().height || 28;
      const chipW = chip ? Math.round(chip.getBoundingClientRect().width) || 80 : 0;

      // 黑洞行自己已有的内容（黑洞空间 / ＋放进黑洞 …）右边界。
      // 绝对定位块**不参与**行内布局，所以这里绝不给行加 padding：
      // 加过一次 → 行内换行、行被撑高、顶进上面的状态条（2026-09-16 实拍）。
      let contentRight = dr0.left;
      for (const child of dock.children) {
        if (child === model || child === chip) continue;
        const cr = child.getBoundingClientRect();
        if (cr.width > 4 && cr.height > 4) contentRight = Math.max(contentRight, cr.right);
      }

      const rightEdge = dr0.right - 8;
      const room = rightEdge - (contentRight + 8);
      // 2026-09-16 用户要求：模型也要在那一行。**不再降级**——计价与模型一律一起搬进黑洞行；
      // 一排放不下就靠行内 flex-wrap 换到第二行（仍在同一行容器里），而不是留在输入框里。
      const items = [chip, model].filter(Boolean);
      if (items.length === 0) {
        revert(dock, [modelRaw]);
        state('narrow');
        return;
      }

      // 交给行自己的 flex 排：左边那组不被压缩，计价/模型 margin-left:auto 顶到最右；放不下自动换行（仍在行内）。
      for (const el of items) lift(el, dock);
      // 用户 2026-09-16：「他可以只显示图标」——模型块在黑洞行里只留图标（文字由 CSS 收起，见 .dsh-tweaks-model 规则），
      // 悬停用原生 title 显示全名。只加类名、不写行内样式，回退时不会留下残留。
      modelRaw.classList.add('dsh-tweaks-model');
      const modelText = (modelRaw.textContent || '').replace(/\s+/g, ' ').trim();
      if (modelText !== '' && !modelRaw.getAttribute('title')) modelRaw.setAttribute('title', modelText);
      markFloatingButtons(dock);
      state('moved');

      // 校验不再比对像素坐标（节点现在真的在行里）：只验「挂上了 + 有尺寸 + 没溢出右边界」
      const dr = dock.getBoundingClientRect();
      const bad = [];
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        if (!dock.contains(el)) { bad.push(`detached[${i}]`); continue; }
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) bad.push(`tiny[${i}]`);
        else if (r.right > dr.right + 2) bad.push(`overflow[${i}]`);
      }
      if (bad.length > 0) {
        revert(dock, items);
        state('reverted');
        return;
      }
      state('moved');
    }

    // ===== 热重载：宿主令牌变了就刷新页面（DSH 运行时不动，会话不丢）=====
    const TOKEN_URL = '/ui-tweaks/reload-token';
    function clientInputBusy() {
      const editable = document.querySelector('[contenteditable="true"]');
      if (editable && (editable.innerText || '').trim() !== '') return true;
      return false;
    }
    function watchClientBundle() {
      let seen = null;
      const tick = async () => {
        try {
          const response = await fetch(TOKEN_URL, { cache: 'no-store' });
          if (!response.ok) return;
          const body = await response.json();
          if (!body || body.ok !== true || typeof body.token !== 'number' || body.token <= 0) return;
          if (seen === null) { seen = body.token; return; }
          if (body.token === seen) return;
          if (clientInputBusy()) return; // 输入框有内容就不刷，别丢草稿
          seen = body.token;
          window.location.reload();
        } catch { /* 宿主没起来就下次再试 */ }
      };
      tick();
      setInterval(tick, 1500);
    }

    // ===== 侧栏标题区：取消「单击」动作，只保留「双击」（2026-09-16 用户要求）=====
    // 事实：dsh-desktop-bridge 只在 document 捕获阶段注册了 **dblclick**（.dcu-brand → toggleSidebar）；
    // 单击动作来自 codex-ui 的原生绑定，仍在生效。用户要求：这里只留双击。
    // 做法：捕获阶段拦掉品牌区内的 click（stopImmediatePropagation 让后注册的 React/插件处理器收不到），
    // **完全不碰 dblclick**（浏览器在第二次点击后仍会派发 dblclick，与 click 的拦截互不影响）。
    // 例外：点在品牌区内的交互控件（如搜索按钮）上必须放行，否则会把搜索点死。
    function suppressBrandSingleClick() {
      if (window.__dshTweaksBrandClick === true) return;
      const interactiveSelector = 'button,a,input,select,textarea,[role="button"],[role="link"],[role="tab"]';
      const onClickCapture = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const brand = target.closest('.dcu-brand');
        if (brand === null) return;
        const interactive = target.closest(interactiveSelector);
        // 点在品牌自身（或其非交互子元素）→ 拦掉单击；点在内部交互控件（搜索等）→ 放行
        if (interactive !== null && interactive !== brand) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      };
      document.addEventListener('click', onClickCapture, true);
      window.__dshTweaksBrandClick = true;
    }

    // ===== 收起态图标轨：悬停显示功能名称（2026-09-16 用户要求）=====
    // 关键约束：收起态 root 带 overflow:hidden，气泡用 absolute 会被裁掉 → 用 position:fixed + JS 定位。
    // 名称来源：优先 aria-label，其次 title，再退到元素/最近按钮的可见文本（收起态文本被隐藏但仍在 DOM 里）。
    function installRailTooltips() {
      if (window.__dshTweaksRailTip === true) return;
      const tip = document.createElement('div');
      tip.className = 'tw-rail-tip';
      document.body.appendChild(tip);

      // 覆盖两个容器：首项（展开侧边栏）在 .dcu-compact-shell，其余在 .dcu-compact-nav —— 只写 nav 会漏掉第一个（用户实拍指出）。
      const RAIL_ITEM = '.dcu-root.dcu-compact .dcu-icon, .dcu-root.dcu-compact .dcu-foot button';
      const railLabel = (el) => {
        const scope = el.closest('button,a,[role="button"]') || el;
        const raw = scope.getAttribute('aria-label') || scope.getAttribute('title') || scope.textContent || '';
        return raw.replace(/\s+/g, ' ').trim().slice(0, 28);
      };
      const place = (el) => {
        const label = railLabel(el);
        if (label === '') return false;
        tip.textContent = label;
        tip.classList.add('on');
        const rect = el.getBoundingClientRect();
        const box = tip.getBoundingClientRect();
        const left = Math.min(rect.right + 8, window.innerWidth - box.width - 8);
        const top = Math.max(4, Math.min(rect.top + rect.height / 2 - box.height / 2, window.innerHeight - box.height - 4));
        tip.style.left = Math.round(left) + 'px';
        tip.style.top = Math.round(top) + 'px';
        return true;
      };
      const onOver = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const item = target.closest(RAIL_ITEM);
        if (item === null || item.getBoundingClientRect().width === 0) { tip.classList.remove('on'); return; }
        place(item);
      };
      const onOut = (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest(RAIL_ITEM) !== null) tip.classList.remove('on');
      };
      document.addEventListener('mouseover', onOver, true);
      document.addEventListener('mouseout', onOut, true);
      document.addEventListener('scroll', () => tip.classList.remove('on'), true);
      window.__dshTweaksRailTip = true;
    }

    function apply() {
      injectStyle();
      suppressBrandSingleClick();
      installRailTooltips();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyAll, { once: true });
      } else {
        applyAll();
      }
      const mo = new MutationObserver(() => { applyAll(); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      window.addEventListener('resize', applyAll);
      setInterval(applyAll, 4000); // 轻量兜底：React 重渲染后仍能纠正
      watchClientBundle();
    }

    module.exports.apply = apply;
    module.exports.inject = [];
    return module.exports;
  }
});
