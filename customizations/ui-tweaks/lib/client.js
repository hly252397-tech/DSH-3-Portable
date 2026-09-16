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
      '.dsh-tweaks-lifted{height:28px!important;display:flex!important;align-items:center!important}',
      '.dsh-tweaks-lifted .VWh0dG_triggerPrimary,.dsh-tweaks-lifted .VWh0dG_triggerMetric,.dsh-tweaks-lifted .VWh0dG_triggerYen,',
      '.dsh-tweaks-lifted .VWh0dG_feeInline,.dsh-tweaks-lifted .VWh0dG_triggerLabel{font-family:Inter,ui-sans-serif,system-ui,sans-serif!important;',
      'font-size:14px!important;font-weight:600!important;line-height:20px!important;color:inherit!important;',
      'background-color:transparent!important;border-color:transparent!important;box-shadow:none!important;',
      'height:auto!important;min-height:0!important;padding:0!important;border-radius:0!important}',
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

    function lift(el, targetLeft, targetTop) {
      if (!saved.has(el)) saved.set(el, el.getAttribute('style'));
      el.classList.add(LIFT);
      el.style.position = 'fixed';
      el.style.left = Math.round(targetLeft) + 'px';
      el.style.top = Math.round(targetTop) + 'px';
      el.style.margin = '0';
      // fixed 的视口坐标理论值＝目标值；若祖先带 transform 会整体偏移，量一次修回来
      for (let pass = 0; pass < 2; pass++) {
        const r = el.getBoundingClientRect();
        const dx = targetLeft - r.left;
        const dy = targetTop - r.top;
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) break;
        el.style.left = Math.round(parseFloat(el.style.left) + dx) + 'px';
        el.style.top = Math.round(parseFloat(el.style.top) + dy) + 'px';
      }
    }

    function unLift(el) {
      const prev = saved.get(el);
      el.classList.remove(LIFT);
      if (prev !== null && prev !== undefined) el.setAttribute('style', prev);
      else el.removeAttribute('style');
      saved.delete(el);
    }

    function revert(dock, els) {
      for (const el of els) if (el && saved.has(el)) unLift(el);
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
      // 两档降级：① 平价 + 模型 一起上去；② 只把模型搬上去（平价留在原行）
      let items = null;
      if (chip && chipW + 8 + modelW <= room) items = [chip, model];
      else if (modelW <= room) items = [model];
      if (!items) {
        // 连模型块都放不下（窄窗）→ 原地不动，控件留在输入框里
        revert(dock, [modelRaw]);
        state('narrow');
        return;
      }

      const widths = items.map((el) => (el === model ? modelW : chipW));
      const topEdge = dr0.top + Math.max(0, (dr0.height - mh) / 2);
      let cursor = rightEdge;
      for (let i = items.length - 1; i >= 0; i--) {
        lift(items[i], cursor - widths[i], topEdge);
        cursor -= widths[i] + 8;
      }

      // 可见性校验（用当下的黑洞行矩形，避免 React 重排后拿旧值判）
      const dr = dock.getBoundingClientRect();
      const band = dr.top + Math.max(0, (dr.height - mh) / 2);
      const bad = [];
      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        const inView = r.left >= 0 && r.right <= window.innerWidth + 1 && r.top >= 0 && r.bottom <= window.innerHeight + 1;
        const onBand = Math.abs(r.top - band) <= 14 && r.right <= dr.right + 2 && r.left >= Math.min(dr.left - 60, 0);
        if (!inView) bad.push(`offview[${i}]`);
        else if (!onBand) bad.push(`band[${i}]dy=${Math.round(r.top - band)}r=${Math.round(r.right)}/${Math.round(dr.right)}`);
        else if (r.width < 8 || r.height < 8) bad.push(`tiny[${i}]`);
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

      const RAIL_ITEM = '.dcu-root.dcu-compact .dcu-compact-nav .dcu-icon, .dcu-root.dcu-compact .dcu-foot button';
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
