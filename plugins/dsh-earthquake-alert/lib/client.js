// dsh-earthquake-alert · 客户端半侧
//
// 三个落点：
//   1. sidebar.panellist  —— 侧边栏图标（id 与 main 的 key 同名，点图标即派发到主面板）
//   2. main               —— 主面板：当前预警、影响判定、关注地点、最近地震、数据健康
//   3. shell.overlay      —— 全屏告警横幅，只在存在「活动且相关」的预警时出现
//
// 数据全部来自本插件的宿主半侧只读端点，客户端不直连任何第三方。
//
// 样式纪律（对齐 @deepseek-ai/dsh-client-ui-primitives / dsh-client-ui-theme，不自己发明度量）：
//   · 所有模块元素显式跟随 --dsh-font-ui，回退官方 --dsw-font-family；不改写全局/代码字体。
//   · 描边一律 0.5px（官方 hairline 约定），圆角优先共享 --dsh-radius-*，控件高度走官方阶梯。
//   · 只用语义 token，不写死颜色，保证明暗主题都成立。
window.__ModuleLoader__.load({
  id: 'dsh-earthquake-alert',
  factory: require => {
    const React = require('react');
    const { createElement: h, useState, useEffect, useRef } = React;

    const API = '/dsh-earthquake-alert/api';
    const REQUEST_HEADER = 'x-dsh-earthquake-alert';
    const PREFS_KEY = 'dsh-earthquake-alert.v1';
    const SNAPSHOT_POLL_MS = 2000;
    const REQUEST_TIMEOUT_MS = 5000;
    const AUDIO_CLOSE_TIMEOUT_MS = 1000;
    const MAX_SITES = 20;
    // 上游时间戳是北京时间（UTC+8），且没有时区标记，必须显式补上。
    const SOURCE_UTC_OFFSET = '+08:00';

    const DEFAULT_PREFS = {
      sites: [],
      radiusKm: 300,
      minMagnitude: 4,
      alertWindowSeconds: 180,
      sound: false,
    };

    // 均匀速度模型的粗估。这是估算量，不是官方发布的到达时间。
    const P_WAVE_KMS = 6.0;
    const S_WAVE_KMS = 3.5;
    const EARTH_RADIUS_KM = 6371;

    function parseSourceTime(value) {
      if (typeof value !== 'string') return null;
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
      if (!match) return null;
      const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
      if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
      const milliseconds = (match[7] || '').padEnd(3, '0');
      const time = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds}${SOURCE_UTC_OFFSET}`);
      if (!Number.isFinite(time.getTime())) return null;
      const local = new Date(time.getTime() + 8 * 3600 * 1000);
      return local.getUTCFullYear() === year && local.getUTCMonth() + 1 === month && local.getUTCDate() === day
        && local.getUTCHours() === hour && local.getUTCMinutes() === minute && local.getUTCSeconds() === second ? time : null;
    }

    function clockText(value) {
      const time = value instanceof Date ? value : parseSourceTime(value);
      if (!time) return '—';
      return time.toLocaleString(undefined, { timeZone: 'Asia/Shanghai', hour12: false });
    }

    function distanceKm(aLat, aLon, bLat, bLon) {
      if (![aLat, aLon, bLat, bLon].every(Number.isFinite)) return null;
      const rad = degree => (degree * Math.PI) / 180;
      const dLat = rad(bLat - aLat);
      const dLon = rad(bLon - aLon);
      const s = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
      return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
    }

    function finiteNumber(value, minimum, maximum) {
      return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
    }

    function draftNumber(value, minimum, maximum) {
      if (typeof value !== 'string' || !value.trim()) return null;
      const number = Number(value);
      return finiteNumber(number, minimum, maximum) ? number : null;
    }

    function validatePrefs(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.sites) || value.sites.length > MAX_SITES) return null;
      if (Object.keys(value).some(key => !['sites', 'radiusKm', 'minMagnitude', 'alertWindowSeconds', 'sound'].includes(key))) return null;
      if (!finiteNumber(value.radiusKm, 10, 2000) || !finiteNumber(value.minMagnitude, 0, 10)
        || !finiteNumber(value.alertWindowSeconds, 30, 3600) || typeof value.sound !== 'boolean') return null;
      const sites = [];
      for (const site of value.sites) {
        if (!site || typeof site !== 'object' || Array.isArray(site) || Object.keys(site).some(key => !['name', 'latitude', 'longitude'].includes(key))
          || typeof site.name !== 'string' || !site.name.trim() || site.name.length > 40 || /[\u0000-\u001f\u007f]/.test(site.name)
          || !finiteNumber(site.latitude, -90, 90) || !finiteNumber(site.longitude, -180, 180)) return null;
        const name = site.name.trim().normalize('NFC');
        const longitudeKey = site.longitude === 180 ? -180 : site.longitude;
        if (sites.some(previous => previous.name.toLowerCase() === name.toLowerCase()
          || (previous.latitude === site.latitude && (previous.longitude === 180 ? -180 : previous.longitude) === longitudeKey))) return null;
        sites.push({ name, latitude: site.latitude, longitude: site.longitude });
      }
      return { sites, radiusKm: value.radiusKm, minMagnitude: value.minMagnitude, alertWindowSeconds: value.alertWindowSeconds, sound: value.sound };
    }

    // The old origin-local key is only an explicit migration candidate. The
    // portable host owns all accepted writes, so a random port cannot lose them.
    function readLegacyPrefs() {
      try {
        const raw = window.localStorage.getItem(PREFS_KEY);
        if (!raw) return { prefs: null, error: false };
        const prefs = validatePrefs(JSON.parse(raw));
        return { prefs, error: !prefs };
      } catch { return { prefs: null, error: true }; }
    }
    const legacy = readLegacyPrefs();

    // 跨落点共享状态：面板改了设置，横幅下一次渲染立刻能看到。
    const bus = {
      snapshot: null,
      error: null,
      prefs: { ...DEFAULT_PREFS, sites: [] },
      prefsReady: false,
      prefsLoading: false,
      saving: false,
      revision: null,
      persisted: false,
      legacy: legacy.prefs,
      legacyError: legacy.error,
      notice: null,
      loading: false,
      soundReady: false,
      soundBusy: false,
      testUntil: 0,
      dismissedKey: '',
      reload: null,
      reloadPrefs: null,
      savePrefs: null,
      enableSound: null,
      disableSound: null,
      listeners: new Set(),
      emit() { for (const listener of [...this.listeners]) listener(); },
      subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
    };

    function useBus() {
      const [, bump] = useState(0);
      useEffect(() => bus.subscribe(() => bump(value => value + 1)), []);
      return bus;
    }

    /** 把「当前预警 + 关注地点」折算成可读的结论。不做任何官方口径的替代。 */
    function feedHealth(snapshot, now = Date.now()) {
      const poll = finiteNumber(snapshot?.source?.pollSeconds, 3, 300) ? snapshot.source.pollSeconds : 5;
      const timeout = finiteNumber(snapshot?.source?.timeoutSeconds, 3, 60) ? snapshot.source.timeoutSeconds : 12;
      const freshnessSeconds = Math.min(900, Math.max(poll * 3, timeout * 2));
      const lastOk = snapshot?.health?.eewLastOkAt ?? snapshot?.eew?.receivedAt;
      const error = snapshot?.health?.eewError ?? (snapshot?.health?.lastError?.source === 'eew' ? snapshot.health.lastError : null);
      const age = typeof lastOk === 'number' ? (now - lastOk) / 1000 : Infinity;
      return { fresh: !error && age >= 0 && age <= freshnessSeconds, lastOk, error, freshnessSeconds };
    }

    function evaluateEew(snapshot, prefs, now = Date.now()) {
      const eew = snapshot?.eew;
      if (!eew) return null;
      const origin = parseSourceTime(eew.originTime || eew.reportTime);
      const report = parseSourceTime(eew.reportTime || eew.originTime);
      if (!origin || !report || report.getTime() < origin.getTime() || report.getTime() > now
        || !finiteNumber(eew.magnitude, -2, 10) || !finiteNumber(eew.latitude, -90, 90) || !finiteNumber(eew.longitude, -180, 180)
        || !Number.isInteger(eew.reportNum ?? 1) || (eew.reportNum ?? 1) < 0) return null;
      const ageSeconds = (now - origin.getTime()) / 1000;
      if (ageSeconds < 0) return null;
      const health = feedHealth(snapshot, now);
      const impacts = prefs.sites
        .map(site => {
          const km = distanceKm(eew.latitude, eew.longitude, site.latitude, site.longitude);
          return {
            site,
            km,
            // Straight-line distance and uniform velocity are estimates, never
            // a published warning arrival time or an intensity prediction.
            pSeconds: Number.isFinite(km) ? Math.hypot(km, finiteNumber(eew.depth, 0, 800) ? eew.depth : 0) / P_WAVE_KMS - ageSeconds : null,
            sSeconds: Number.isFinite(km) ? Math.hypot(km, finiteNumber(eew.depth, 0, 800) ? eew.depth : 0) / S_WAVE_KMS - ageSeconds : null,
            withinRadius: Number.isFinite(km) && km <= prefs.radiusKm,
          };
        })
        .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));
      const within = impacts.filter(impact => impact.withinRadius);
      // 没有关注地点时退化为震级阈值：否则用户永远收不到任何提醒。
      const relevant = eew.magnitude >= prefs.minMagnitude && (!prefs.sites.length || within.length > 0);
      return {
        eew,
        origin,
        ageSeconds,
        active: health.fresh && ageSeconds <= prefs.alertWindowSeconds,
        fresh: health.fresh,
        impacts,
        within,
        relevant,
        key: `${eew.eventId || origin.getTime()}#${eew.reportNum ?? 1}`,
      };
    }

    // 设计系统对齐策略（两层，唯一真源）：
    //   第 1 层 · 官方已 token 化 → 直接引用，全局改 token 即跟随：
    //     排版  --dsw-font-<scale>（family/size/weight/line-height 一体，定义于 theme 的 body 块）
    //     颜色  --dsw-alias-*    圆角 --dsw-radius-*    阴影 --dsw-shadow-* / --dsw-elevation-*
    //     过渡  --ds-transition-* / --ds-ease-*         聚焦 --dsw-focus-ring-*
    //   第 2 层 · 官方未 token 化（控件高度、间距、超大读数、浮层定位）
    //     → 集中成下面的 --dshea-* 契约块，每条标注官方来源，全局大改时一处对齐。
    const CSS = `
/* ============================================================
   第 2 层：度量契约（官方未 token 化，故集中于此）
   每条的来源都标注清楚；改这一处 = 全插件跟随。
   ============================================================ */
.dshea-root,.dshea-banner{
  /* 控件高度 —— primitives/Button.module.css · settings-form/fields.module.css · Pill.module.css */
  --dshea-control-h-md:36px;
  --dshea-control-h-sm:28px;
  --dshea-field-h:34px;
  --dshea-badge-h:24px;
  /* 控件水平内边距 —— Button.module.css .md/.sm · Pill.module.css */
  --dshea-control-pad-md:14px;
  --dshea-control-pad-sm:10px;
  --dshea-badge-pad:8px;
  /* 间距阶梯 —— 官方 CSS 模块中实际出现的取值集合 */
  --dshea-space-1:4px;
  --dshea-space-2:6px;
  --dshea-space-3:8px;
  --dshea-space-4:12px;
  --dshea-space-5:16px;
  --dshea-space-6:24px;
  /* 描边：官方全站 hairline 约定 */
  --dshea-hairline:0.5px;
  /* 浮层定位与入场 —— Toast.module.css。
     取 8px 而不是 Toast 的 40px：面板顶部要常驻一条带子容纳胶囊（见 .dshea-root），
     胶囊越靠上、那条常驻带就越窄，白白空出来的高度也越少。 */
  --dshea-overlay-top:8px;
  /* 告警胶囊高度：单行 ~44px，恰好落在应用工具栏与面板标题之间那条空白带里，
     不再像原两行 90px 那样压住面板标题和「测试横幅」按钮。 */
  --dshea-banner-h:44px;
  --dshea-overlay-z:1100;
  --dshea-overlay-in:160ms;
  /* 布局决定：官方未把"主面板内容宽度"token 化（primitives 里的 max-width 都是组件级的：
     Toast/640、Menu/360…），theme 也无内容宽度变量。实测 2560px 窗口下内容区约 2300px，
     左对齐的固定宽度会在右侧留下半页死白（实测 1150px×全高），故居中。
     宽度是唯一真源：改这一个值即全插件跟随。 */
  --dshea-content-max:1440px;
  /* 超大告警读数：官方最大字阶 --dsw-font-xl-24 为 24px，承载不了面板主读数 */
  --dshea-magnitude-size:44px;
  --dshea-magnitude-weight:600;
  --dshea-magnitude-leading:1.1;
}

/* ---------- 基础 ---------- */
.dshea-root{
  font:var(--dsw-font-s-14);
  color:var(--dsh-text-primary,var(--dsw-alias-label-primary));
  display:flex;flex-direction:column;gap:var(--dshea-space-5);
  width:100%;max-width:var(--dshea-content-max);min-width:0;
  height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;
  container:dshea / inline-size;overscroll-behavior:contain;
  margin-inline:auto;
  /* 顶部**常驻**一条等于「胶囊上边距 + 胶囊高 + 间距」的带子。
     这是唯一能同时满足用户两条要求的结构：
       · 不做预留 → 胶囊必然压住面板顶部（实测 head 重叠 13922px²、副标题 920px²）；
       · 做「随告警开关」的预留 → 面板每次告警上下跳 108px，属于"浮层影响了其他界面"。
     常驻则既不跳动、也不遮挡；代价是面板顶部永远空出这一条（用户 2026-10-01 选定此方案）。
     算式按页面坐标给（overlay-top 是 position:fixed 的页面坐标），别改回
     「基础内边距 + 高度」那种写法 —— 那会把面板根的起始位置漏掉。 */
  padding:calc(var(--dshea-overlay-top) + var(--dshea-banner-h) + var(--dshea-space-4)) var(--dshea-space-6) var(--dshea-space-6);
}
.dshea-root>*{flex-shrink:0;min-width:0}
/* 曾在这里让面板为悬浮胶囊预留顶部空间（.dshea-root-reserved）。已移除：
   那会让整个面板在告警出现/消失时上下跳，属于"浮层改变了其他界面的布局"。
   用户 2026-10-01 明确「悬浮窗口坐在最顶层，不要影响其他界面」——
   浮层只负责浮在上面，布局由各界面自己决定。 */
.dshea-root,.dshea-root *,.dshea-banner,.dshea-banner *{box-sizing:border-box}
.dshea-root h1,.dshea-root h2,.dshea-root h3,.dshea-root h4{margin:0}
.dshea-root button,.dshea-root input,.dshea-banner button{font-family:inherit}
.dshea-root button:focus-visible,.dshea-root input:focus-visible,.dshea-banner button:focus-visible{
  outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:1px;
}

/* ---------- 页头 ---------- */
.dshea-head{display:flex;align-items:flex-start;gap:var(--dshea-space-4);flex-wrap:wrap}
.dshea-head-text{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
/* 标题行：标题与状态/动作同排，副标题独占整行。
   此前动作被推到头部最右，把副标题列压到实测 417px（面板内容宽约 780px），
   第一行末尾留出大片空白 —— 用户 2026-10-01 截图圈出的正是这块空白。 */
.dshea-head-title-row{display:flex;align-items:center;gap:var(--dshea-space-4);flex-wrap:wrap;min-width:0}
.dshea-h1{font:var(--dsw-font-xl-24)}
.dshea-head-actions{display:flex;align-items:center;gap:var(--dshea-space-3);flex-wrap:wrap}

/* ---------- 卡片 ---------- */
.dshea-card{
  border:var(--dshea-hairline) solid var(--dsh-border-subtle,var(--dsw-alias-border-l2));
  border-radius:var(--dsh-radius-md,var(--dsw-radius-md));min-width:0;
  background:var(--dsh-bg-surface-1,var(--dsw-alias-bg-layer-1));
  padding:var(--dshea-space-5);display:flex;flex-direction:column;gap:var(--dshea-space-4);
}
.dshea-card-head{display:flex;align-items:center;gap:var(--dshea-space-3);flex-wrap:wrap;min-height:var(--dshea-badge-h)}
.dshea-card-title{font:var(--dsw-font-s-strong-14)}
.dshea-subhead{font:var(--dsw-font-xs-strong-13)}
.dshea-spacer{margin-left:auto}

/* ---------- 徽章（对齐官方 Pill） ---------- */
.dshea-pill{
  display:inline-flex;align-items:center;gap:var(--dshea-space-1);flex:none;
  min-height:var(--dshea-badge-h);height:var(--dshea-badge-h);padding:0 var(--dshea-badge-pad);
  /* 与浮层胶囊同规：显式半高，不用 999px 钳制（见 .dshea-banner 的注释）。
     高度从 min-height 改为 height，这样"半高"就是确定的 12px，不会随内容变化。 */
  border-radius:calc(var(--dshea-badge-h) / 2);corner-shape:round;
  font:var(--dsw-font-xxs-12);
  color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-layer-2);white-space:nowrap;
}
.dshea-pill-alert{color:var(--dsw-alias-state-error-primary)}
.dshea-pill-test{color:var(--dsw-alias-state-warn-primary)}

/* ---------- 按钮（对齐官方 Button） ---------- */
.dshea-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:var(--dshea-space-1);flex:none;
  height:var(--dshea-control-h-md);padding:0 var(--dshea-control-pad-md);
  border:none;border-radius:var(--dsw-radius-md);
  font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);
  background:transparent;cursor:pointer;
  transition:background var(--ds-transition-duration) var(--ds-ease-in-out);
}
.dshea-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshea-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.dshea-btn:disabled{cursor:not-allowed;opacity:.4}
.dshea-btn-sm{
  height:var(--dshea-control-h-sm);padding:0 var(--dshea-control-pad-sm);
  font:var(--dsw-font-xxs-12);border-radius:var(--dsw-radius-sm);
}
.dshea-btn-outline{border:var(--dshea-hairline) solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
.dshea-btn-primary{background:var(--dsh-accent-soft,var(--dsw-alias-button-ghost-active-fill));color:var(--dsh-text-primary,var(--dsw-alias-label-primary));border:var(--dshea-hairline) solid var(--dsh-border-strong,var(--dsw-alias-button-ghost-active-border))}
.dshea-btn-primary:hover:not(:disabled){background:var(--dsh-bg-surface-3,var(--dsw-alias-button-ghost-active-hover))}

/* ---------- 输入框（对齐官方设置页字段） ---------- */
.dshea-input{
  height:var(--dshea-field-h);padding:0 var(--dshea-space-4);min-width:0;
  border:var(--dshea-hairline) solid var(--dsh-border-strong,var(--dsw-alias-border-l3));
  border-radius:var(--dsw-radius-md);
  background:var(--dsh-bg-surface-1,var(--dsw-alias-bg-layer-1));
  font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);
  transition:border-color var(--ds-transition-duration) var(--ds-ease-in-out);
}
.dshea-input::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}
.dshea-input:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dshea-input[aria-invalid=true]{border-color:var(--dsh-danger,var(--dsw-alias-state-error-primary))}
.dshea-input-num{width:104px}

/* ---------- 字段行（对齐官方 .field） ---------- */
.dshea-fields{display:flex;flex-direction:column}
.dshea-fieldset{margin:0;padding:0;border:0;min-width:0}
.dshea-field{display:flex;flex-direction:column;gap:var(--dshea-space-2);padding:var(--dshea-space-4) 0}
.dshea-field:first-child{padding-top:0}
.dshea-field:last-child{padding-bottom:0}
.dshea-field + .dshea-field{border-top:var(--dshea-hairline) solid var(--dsw-alias-border-l2)}
.dshea-field-label{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary)}
.dshea-field-row{display:flex;align-items:flex-end;gap:var(--dshea-space-4);flex-wrap:wrap}
.dshea-inline-field{display:flex;flex-direction:column;gap:var(--dshea-space-1);min-width:0}
.dshea-name-field{flex:1 1 180px}.dshea-name-field .dshea-input{width:100%}
.dshea-inline-check{flex-direction:row;align-items:center;gap:var(--dshea-space-3);height:var(--dshea-field-h)}
/* 音频未解锁时该行文字可点（补一次用户手势）；不新增任何可见控件 */
.dshea-check-action{cursor:pointer}
/* 表单行对齐（用户 2026-10-01「这里排版太乱了」）：
   ① 行内按钮与输入框等高 —— .dshea-btn 高 36px 而 .dshea-input 高 34px，
      align-items:flex-end 只对齐底边，按钮顶部会高出 2px，看着"大一号"；
   ② 行末按钮统一贴右边缘 —— 「添加」被 flex:1 的名称框顶到最右，
      「保存提醒设置」却跟在三个窄框后面停在中间，两个主按钮不在一条竖线上。 */
.dshea-field-row .dshea-btn{height:var(--dshea-field-h)}
.dshea-btn-end{margin-left:auto}
/* 行内字段等分剩余宽度：两行表单都填满整行、行末按钮贴右边缘。
   只右对齐按钮而字段仍是固定 104px 时，「报警窗口」与「保存提醒设置」
   之间会留下约 260px 死白 —— 那是把"对不齐"换成了"空一块"。 */
.dshea-field-row > .dshea-inline-field:not(.dshea-inline-check){flex:1 1 104px}
.dshea-field-row .dshea-name-field{flex:2 1 180px}
.dshea-field-row .dshea-input{width:100%}

/* ---------- 当前预警 ----------
   布局目标：卡片宽度必须被内容吃掉，不留"内容挤在左边、卡内右边全是死白"。
   震级块按内容自适应宽；KV 列表吃掉剩余宽度并在宽屏排成两对一行；
   影响判定独立成整宽区块，不再与震级并排抢一半宽度。 */
.dshea-current{display:flex;flex-direction:column;gap:var(--dshea-space-4)}
.dshea-hero{display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--dshea-space-6);align-items:start}
@container dshea (max-width:760px){.dshea-hero{grid-template-columns:minmax(0,1fr);gap:var(--dshea-space-4)}}
.dshea-hero-main{display:flex;flex-direction:column;gap:2px;min-width:0;align-self:center}
.dshea-mag{
  font:var(--dshea-magnitude-weight) var(--dshea-magnitude-size)/var(--dshea-magnitude-leading) var(--dsw-font-family);
  letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-error-primary);
}
.dshea-mag-idle{color:var(--dsw-alias-label-primary)}
.dshea-place{font:var(--dsw-font-base-16);overflow-wrap:anywhere}
.dshea-impact{
  display:flex;flex-direction:column;gap:var(--dshea-space-2);
  border-top:var(--dshea-hairline) solid var(--dsw-alias-border-l2);
  padding-top:var(--dshea-space-4);
}

/* 折叠区：一行可展开摘要 + 展开后的列表；摘要按钮靠左，列表占满宽度 */
.dshea-collapse{display:flex;flex-direction:column;gap:var(--dshea-space-2);align-items:flex-start;min-width:0}
.dshea-collapse > .dshea-list{width:100%}

/* ---------- 定义列表（数值列用等宽数字，避免跳动） ---------- */
.dshea-kv{display:grid;grid-template-columns:repeat(2,auto minmax(0,1fr));gap:var(--dshea-space-2) var(--dshea-space-5);margin:0;align-content:start;font:var(--dsw-font-xs-13)}
@container dshea (max-width:900px){.dshea-kv{grid-template-columns:auto minmax(0,1fr)}}
.dshea-kv dt{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshea-kv dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}

/* ---------- 列表 ---------- */
.dshea-list{list-style:none;margin:0;padding:0;min-width:0}
.dshea-list li{display:flex;align-items:center;gap:var(--dshea-space-4);padding:var(--dshea-space-3) 0;font:var(--dsw-font-xs-13)}
.dshea-list li + li{border-top:var(--dshea-hairline) solid var(--dsw-alias-border-l2)}
.dshea-list-key{font-variant-numeric:tabular-nums;min-width:0;overflow-wrap:anywhere;flex:1 1 0}
.dshea-list-val{margin-left:auto;text-align:right;overflow-wrap:anywhere;min-width:0;flex:1 1 0;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshea-list-actions{margin-left:auto;display:inline-flex;align-items:center;gap:var(--dshea-space-3);min-width:0}
@container dshea (max-width:480px){
  .dshea-head-text{flex:1 1 100%;width:100%}
  .dshea-head-actions{flex:1 1 100%;width:100%;justify-content:flex-end}
  .dshea-head .dshea-caption{width:100%;max-width:none}
  .dshea-list li{align-items:flex-start;flex-direction:column}
  .dshea-list-val,.dshea-list-actions{margin-left:0;text-align:left;flex-basis:auto;max-width:100%}
  .dshea-inline-field{flex:1 1 100px}.dshea-inline-field .dshea-input{width:100%}
  .dshea-inline-check{flex-basis:100%}.dshea-card-head .dshea-spacer{margin-left:0}
}

/* ---------- 文案 ---------- */
.dshea-caption{margin:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);max-width:78ch}
.dshea-hint{margin:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
.dshea-note{margin:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}
.dshea-danger{color:var(--dsw-alias-state-error-primary)}
.dshea-warn{color:var(--dsw-alias-state-warn-primary)}
.dshea-dim{color:var(--dsw-alias-label-secondary)}

/* ---------- 告警横幅 ----------
   几何仍对齐官方 Toast（位置/圆角/阴影/内边距），但**不沿用 Toast 的"恒暗底 + 白色 label"配色对**。
   实测（2026-09-30，用户截图 + 像素采样）：横幅底色在这台机器的主题下渲染成浅色（#f4f4f5），
   而 --dsw-alias-toast-label 仍是白色 → 白字压浅底，正文与胶囊**完全不可读**
   （橙色震级和深色按钮却正常，正好对应"哪些元素没用这对 token"）。
   横幅是**常驻告警面**，不是 3 秒即逝的轻提示，所以改用「浮层 surface + label」这对：
   它们在任意主题下天然配对，且失效方向是**安全**的——底色失效→透明露出浅色页面，深色文字依旧可读；
   若沿用 toast 那对，失效方向是**危险**的（白字压未知底色）。 */
/* ---------- 告警胶囊 ----------
   单行红色胶囊。原实现是两行（head + body）约 90px 高，实测压住了面板标题行
   与「测试横幅」按钮（y≈85..175 vs 标题 y≈80、按钮 y≈70..95）。
   胶囊化后高度降到 ~44px，只占工具栏与面板标题之间的空白带，不再遮挡内容。
   底色用告警红 + label-primary-foreground：该前景 token 在明暗两套主题下
   分别取白/近黑，与红底对比度均 ≥6:1，不需为暗色主题写特例。 */
.dshea-banner{
  position:fixed;top:var(--dshea-overlay-top);left:50%;transform:translateX(-50%);
  z-index:var(--dshea-overlay-z);
  /* 浮层只该"浮在上面"，不该干扰别的界面：
     ① 整块 pointer-events:none —— 胶囊盖住谁，谁照常可点；只有自己的按钮收事件
        （见 .dshea-banner-close）。此前 auto 会让它盖住哪里就吞掉哪里的点击。
     ② 不再让面板为它预留顶部空间 —— 那会让整个面板在告警出现/消失时上下跳，
        属于"浮层改变了其他界面的布局"（用户 2026-10-01「不要影响其他界面」）。 */
  pointer-events:none;
  width:max-content;max-width:min(920px,calc(100vw - 32px));
  display:flex;align-items:center;gap:var(--dshea-space-3);
  height:var(--dshea-banner-h);
  padding:0 var(--dshea-space-2) 0 var(--dshea-space-5);
  /* 两端要的是两个半圆（用户 2026-10-01「我要的是两边是两个半圆」）。
     不写 border-radius:999px 再指望浏览器按比例钳到"高度的一半" —— 实测该钳制
     在这套引擎下给出的圆角明显小于半高，而抗锯齿又让像素测量偏向"看着更方"，
     两条路都不可信。改为显式等于半高：值直接可读、可断言、不依赖钳制。
     corner-shape:round 与面板 .dshea-pill 同款（那边也是显式写出的，
     说明本引擎需要它才会真正画成圆角）。 */
  border-radius:calc(var(--dshea-banner-h) / 2);
  corner-shape:round;
  background:var(--dsh-danger,var(--dsw-alias-state-error-primary));
  /* 前景不能用 --dsw-alias-label-primary-foreground：共享主题把它 !important 映射成了
     --dsh-text-primary（明 #18181b / 暗 #fafafa），压在红底上实测对比度仅 3.37，低于 AA。
     共享层没有 on-danger 对，改用 --dsh-bg-canvas（明 #ffffff / 暗 #09090b）——
     它天然是正文色的反向，与 --dsh-danger（明 #c73535 / 暗 #ff7373）实测 ≥5.2。 */
  color:var(--dsh-bg-canvas);
  font:var(--dsw-font-s-strong-14);
  box-shadow:var(--dsw-shadow-lv3);
  animation:dshea-banner-in var(--dshea-overlay-in) ease-out;
}
/* 演示横幅与真实告警同为红胶囊（用户要求胶囊即警示形态），靠行内「演示」标记区分 */
.dshea-banner-head{display:flex;align-items:center;gap:var(--dshea-space-3);flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden}
.dshea-banner-mag{flex:none;font:var(--dsw-font-base-strong-16);font-variant-numeric:tabular-nums}
.dshea-banner-place{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dshea-banner-body{display:flex;align-items:center;gap:var(--dshea-space-4);flex:none;font:var(--dsw-font-xs-13);opacity:.92}
/* 演示徽标沿用面板同款 .dshea-pill（根测试按类名找它），但在红底上要换安全配色：
   默认 layer-2 底 + label-secondary 字在告警红上不可读，改半透明同色系并继承前景。 */
.dshea-banner .dshea-pill{
  background:color-mix(in srgb, var(--dsw-static-neutral-bluish-1000) 18%, transparent);
  color:inherit;box-shadow:none;
}
.dshea-banner-close{
  display:inline-flex;align-items:center;justify-content:center;flex:none;
  /* 父级 pointer-events:none 下的例外：只有这个按钮收事件，
     否则整块胶囊变成"看得见、点不动"，连关都关不掉。 */
  pointer-events:auto;
  height:var(--dshea-control-h-sm);padding:0 var(--dshea-control-pad-sm);
  border:none;border-radius:calc(var(--dshea-control-h-sm) / 2);corner-shape:round;cursor:pointer;
  background:color-mix(in srgb, var(--dsw-static-neutral-bluish-1000) 16%, transparent);
  color:inherit;font:var(--dsw-font-xxs-strong-12);
  transition:background var(--ds-transition-duration) var(--ds-ease-in-out);
}
.dshea-banner-close:hover{background:color-mix(in srgb, var(--dsw-static-neutral-bluish-1000) 30%, transparent)}
.dshea-banner-close:focus-visible{
  outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:1px;
}
@keyframes dshea-banner-in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}
@media (prefers-reduced-motion:reduce){.dshea-banner{animation:none}}
/* Family-only, after shorthand rules: shared UI changes reach every local
   panel/overlay text without changing conversation sizes or editor faces. */
.dshea-root,.dshea-root *,.dshea-banner,.dshea-banner *{
  font-family:var(--dsh-font-ui,var(--dsw-font-family,system-ui));
}
`;

    function EarthquakeIcon({ size = 20, active = false } = {}) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'inherit' },
      }, h('path', {
        d: 'M1.5 12h3.4l2.2-6.6 3.3 13.2 2.7-9.2 2.1 4.7h5.3',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('dsh-earthquake-alert', {
        zh: {
          title: '地震预警',
          subtitle: '秒级预警来自第三方转发的中国地震预警网数据；到达时间为速度模型估算，非官方数值。',
          current: '当前预警',
          noEew: '本次成功读取未返回预警事件。',
          stale: '上一条预警已超出报警窗口，仅作展示（上游发布于 {at}）。数据源正常，暂无新预警；目录源最新：{latest}，未产生预警。',
          magnitude: '震级', depth: '深度', intensity: '源报告最大烈度', origin: '发震时刻',
          report: '报告', reportNum: '第 {n} 报', place: '震中', source: '数据源', coord: '经纬度',
          impact: '影响判定', noSites: '尚未配置关注地点：当前按全国震级阈值提醒。',
          noneWithin: '当前没有关注地点落在报警范围内。',
          expandOutside: '展开另外 {n} 处（超出报警范围）',
          collapseOutside: '收起另外 {n} 处',
          expandSites: '展开 {n} 处关注地点',
          collapseSites: '收起关注地点列表',
          km: '震中距', pWave: 'P 波粗估', sWave: 'S 波粗估', seconds: '秒后到达', within: '在报警半径内',
          outside: '超出报警半径', age: '距今',
          sites: '关注地点', addSite: '添加', siteName: '名称', latitude: '纬度', longitude: '经度',
          siteNameHint: '如 成都', latitudeHint: '如 30.66', longitudeHint: '如 104.07',
          remove: '删除', emptySites: '（无）', radius: '报警半径（km）', minMag: '最小震级',
          window: '报警窗口（秒）', sound: '声音提醒', soundHint: '浏览器需先有用户操作才能播放声音。',
          testBanner: '测试横幅', testBannerHint: '点一下可验证告警横幅是否正常弹出（15 秒后自动消失）。',
          recent: '最近地震', refresh: '立即刷新', health: '数据健康', lastOk: '最近成功', upstreamAlert: '上游最近预警',
          lastError: '最近错误', fetches: '抓取次数', none: '暂无数据',
          bannerTitle: '地震预警', testLabel: '测试横幅', demoLabel: '演示', dismiss: '关闭',
          disclaimer: '本插件不是官方预警服务，数据为第三方转发，可能延迟或中断。请务必同时使用官方地震预警渠道。',
          active: '报警窗口内', expired: '历史事件', loading: '正在读取…',
          unavailable: '数据暂不可用', waiting: '等待预警数据', invalid: '事件数据无效', filtered: '未达到提醒条件',
          unavailableHint: '暂不能确认预警状态：数据源未就绪、已过期或读取失败。不要据此判断没有地震预警，请保留官方预警渠道。',
          estimated: '走时按震中距、震源深度及均匀速度粗估，不代表官方到达时间或当地烈度。',
          arrived: '预计已到达', noImpact: '没有可计算的当前事件；关注地点仍会保留。',
          ageText: '发震后 {n} 秒', prefsLoading: '正在读取便携盘设置…', prefsUnavailable: '设置服务不可用，暂不能保存。请重试读取。',
          preferences: '提醒设置', saveSettings: '保存提醒设置', saved: '已保存到便携盘。', saving: '正在保存…',
          saveFailed: '保存失败，未应用更改；输入仍保留，请重试。', conflict: '设置已被另一界面修改，已读取最新值；你的草稿保留，请核对后再保存。',
          retryPrefs: '重试读取设置', prefsInvalid: '收到的设置无效，暂不能保存。', resetSaved: '使用当前已保存设置',
          migrate: '迁移本机旧设置', migrationHint: '发现此浏览器旧设置；只有你点击迁移，才会保存到便携盘，不覆盖已有设置。',
          migrationInvalid: '本机旧设置无法读取或不合法；未迁移、未改写原数据。',
          coordinateInvalid: '名称不能为空且最多 40 字；纬度须为 -90～90，经度须为 -180～180，不能留空。',
          duplicateSite: '同名或同坐标的地点已在关注列表中。', siteLimit: '最多保存 20 个关注地点。',
          settingsInvalid: '请填写有效设置：半径 10～2000 km，震级 0～10，窗口 30～3600 秒。',
          removeNamed: '删除关注地点：{name}', refreshing: '刷新中…', refreshFailed: '读取快照失败；保留最后数据，但暂停告警。', refreshed: '快照已刷新。',
          eewFeed: '预警源', listFeed: '目录源', feedHealthy: '数据新鲜', feedStale: '数据陈旧或未就绪',
          soundReady: '声音已就绪', soundGesture: '已保存声音偏好；每次打开需点一下“声音提醒”完成浏览器授权。',
          soundFailed: '声音启用或播放失败，当前不播放；请检查音频权限后重试。',
          testOnly: '非真实预警，不发声', testExpires: '{n}s 后关闭',
        },
        en: {
          title: 'Earthquake alert',
          subtitle: 'Second-scale alerts come from a third-party relay of the China Earthquake Early Warning network. Arrival times are velocity-model estimates, not official values.',
          current: 'Current alert',
          noEew: 'This successful read returned no warning event.',
          stale: 'The last alert is outside the alert window; shown for reference only (upstream issued it {at}). The feed is healthy with no newer warning; the catalog newest entry is {latest}, which produced no warning.',
          magnitude: 'Magnitude', depth: 'Depth', intensity: 'Reported max intensity', origin: 'Origin time',
          report: 'Report', reportNum: 'Report {n}', place: 'Epicentre', source: 'Source', coord: 'Coordinates',
          impact: 'Impact', noSites: 'No watched location yet: alerting by nationwide magnitude threshold.',
          noneWithin: 'No watched location falls inside the alert radius right now.',
          expandOutside: 'Show {n} outside the radius',
          collapseOutside: 'Hide the other {n}',
          expandSites: 'Show {n} watched locations',
          collapseSites: 'Hide the watched-location list',
          km: 'Distance', pWave: 'P wave ~', sWave: 'S wave ~', seconds: 's to arrival', within: 'inside radius',
          outside: 'outside radius', age: 'Age',
          sites: 'Watched locations', addSite: 'Add', siteName: 'Name', latitude: 'Latitude', longitude: 'Longitude',
          siteNameHint: 'e.g. Chengdu', latitudeHint: 'e.g. 30.66', longitudeHint: 'e.g. 104.07',
          remove: 'Remove', emptySites: '(none)', radius: 'Alert radius (km)', minMag: 'Minimum magnitude',
          window: 'Alert window (s)', sound: 'Audible alert', soundHint: 'Browsers need a user gesture before playing sound.',
          testBanner: 'Test banner', testBannerHint: 'Click to verify the alert banner renders (it disappears after 15 s).',
          recent: 'Recent earthquakes', refresh: 'Refresh now', health: 'Feed health', lastOk: 'Last success', upstreamAlert: 'Last upstream alert',
          lastError: 'Last error', fetches: 'Fetches', none: 'No data yet',
          bannerTitle: 'EARTHQUAKE ALERT', testLabel: 'TEST BANNER', demoLabel: 'Demo', dismiss: 'Dismiss',
          disclaimer: 'This plugin is not an official warning service. Data is third-party relayed and may be delayed or interrupted. Always keep an official earthquake warning channel.',
          active: 'Within alert window', expired: 'Historical event', loading: 'Loading…',
          unavailable: 'Data unavailable', waiting: 'Waiting for warning data', invalid: 'Invalid event', filtered: 'Below alert criteria',
          unavailableHint: 'Warning status is unknown: the feed is not ready, stale, or could not be read. This does not mean there is no warning. Keep an official warning channel.',
          estimated: 'Arrival is a rough straight-line/uniform-velocity estimate, not an official arrival time or local intensity.',
          arrived: 'Estimated arrival passed', noImpact: 'No current event to calculate. Watched locations remain saved.',
          ageText: '{n} seconds since origin', prefsLoading: 'Reading portable settings…', prefsUnavailable: 'Settings service unavailable. Saving is disabled; retry reading.',
          preferences: 'Alert preferences', saveSettings: 'Save alert preferences', saved: 'Saved to the portable drive.', saving: 'Saving…',
          saveFailed: 'Save failed; changes were not applied. Your input is preserved; retry.', conflict: 'Another window changed these settings. Current values were reloaded; your draft remains. Review before saving.',
          retryPrefs: 'Retry reading settings', prefsInvalid: 'Invalid settings response. Saving is disabled.', resetSaved: 'Use currently saved preferences',
          migrate: 'Migrate old browser settings', migrationHint: 'Old browser settings were found. Only explicit migration saves them to the portable drive; existing settings are never overwritten.',
          migrationInvalid: 'Old browser settings could not be read or validated. Nothing was migrated or overwritten.',
          coordinateInvalid: 'Use a nonempty name of at most 40 characters, latitude -90…90, and longitude -180…180. Coordinates cannot be blank.',
          duplicateSite: 'This name or these coordinates are already watched.', siteLimit: 'At most 20 watched locations.',
          settingsInvalid: 'Enter radius 10…2000 km, magnitude 0…10, and window 30…3600 seconds.',
          removeNamed: 'Remove watched location: {name}', refreshing: 'Refreshing…', refreshFailed: 'Snapshot read failed. Last data is retained but alerting is paused.', refreshed: 'Snapshot refreshed.',
          eewFeed: 'Warning feed', listFeed: 'Catalog feed', feedHealthy: 'Fresh data', feedStale: 'Stale or not ready',
          soundReady: 'Sound ready', soundGesture: 'Sound preference is saved. Tap the “Audible alert” label once per page opening to authorize browser audio.',
          soundFailed: 'Audio enabling or playback failed. No sound is played; check audio permissions and retry.',
          testOnly: 'Demo only · silent', testExpires: 'closes in {n}s',
        },
      }), 'dsh-earthquake-alert: 文案');

      const t = ctx.locale.bind('dsh-earthquake-alert');

      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = 'dsh-earthquake-alert';
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'dsh-earthquake-alert: 样式');

      ctx.effect(() => {
        let closed = false;
        let inFlight = null;
        let preferencesFlight = null;
        let audio = null;
        const lifecycle = new AbortController();
        const controllers = new Set();
        const operationTimers = new Set();
        const tasks = new Set();
        const audioNodes = new Set();
        const seenReports = new Set();
        let primed = false;
        let lastAt = 0;
        function notify(code, kind = 'error') { if (!closed) { bus.notice = { code, kind }; bus.emit(); } }
        function track(promise) {
          tasks.add(promise);
          promise.then(() => tasks.delete(promise), () => tasks.delete(promise));
          return promise;
        }
        // A fetch/audio implementation that ignores abort must still settle
        // its owned operation. Late resolution never publishes to the bus.
        function bounded(promise, milliseconds, signal, code, onTimeout) {
          return new Promise((resolve, reject) => {
            let settled = false;
            let timer;
            const finish = (handler, value) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer); operationTimers.delete(timer);
              signal?.removeEventListener('abort', abort);
              handler(value);
            };
            const abort = () => finish(reject, new Error('EARTHQUAKE_DISPOSED'));
            timer = setTimeout(() => {
              finish(reject, new Error(code));
              onTimeout?.();
            }, milliseconds);
            operationTimers.add(timer);
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
            Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
          });
        }
        function request(path, options = {}) {
          const controller = new AbortController();
          controllers.add(controller);
          const work = Promise.resolve().then(async () => {
            const response = await fetch(path, { ...options, signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
              headers: { [REQUEST_HEADER]: '1', ...(options.headers || {}) } });
            const body = await response.json();
            if (!response.ok || body?.ok !== true) throw Object.assign(new Error('EARTHQUAKE_REQUEST_FAILED'), {
              code: typeof body?.error?.code === 'string' ? body.error.code : `HTTP_${response.status}`, status: response.status,
            });
            return body.value;
          });
          return track(bounded(work, REQUEST_TIMEOUT_MS, controller.signal, 'EARTHQUAKE_REQUEST_TIMEOUT', () => controller.abort())
            .finally(() => controllers.delete(controller)));
        }
        function preferenceValue(value) {
          const prefs = validatePrefs(value?.prefs);
          return prefs && typeof value?.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision)
            && typeof value.persisted === 'boolean' ? { ...value, prefs } : null;
        }
        function stopAudio() {
          for (const node of audioNodes) {
            try { node.oscillator.stop(); node.oscillator.disconnect(); node.gain.disconnect(); }
            catch { bus.soundReady = false; }
          }
          audioNodes.clear();
          const previous = audio; audio = null; bus.soundReady = false;
          if (!previous || previous.state === 'closed') return Promise.resolve(true);
          return track(bounded(Promise.resolve().then(() => previous.close()), AUDIO_CLOSE_TIMEOUT_MS, null, 'AUDIO_CLOSE_TIMEOUT')
            .then(() => true, () => { if (!closed) notify('soundFailed'); return false; }));
        }
        function publishPreferences(value) {
          bus.prefs = value.prefs; bus.revision = value.revision; bus.persisted = value.persisted; bus.prefsReady = true;
          if (value.persisted) bus.legacy = null;
          if (!value.prefs.sound) stopAudio();
        }
        function loadPreferences() {
          if (closed) return Promise.resolve(false);
          if (preferencesFlight) return preferencesFlight;
          bus.prefsLoading = true; bus.emit();
          preferencesFlight = track((async () => {
            try {
              const value = preferenceValue(await request(`${API}/preferences`));
              if (closed) return false;
              if (!value) { bus.prefsReady = false; notify('prefsInvalid'); return false; }
              publishPreferences(value); return true;
            } catch {
              if (!closed) { bus.prefsReady = false; notify('prefsUnavailable'); }
              return false;
            } finally {
              preferencesFlight = null;
              if (!closed) { bus.prefsLoading = false; bus.emit(); }
            }
          })());
          return preferencesFlight;
        }
        async function savePreferences(next) {
          if (closed || !bus.prefsReady || bus.saving) return false;
          const checked = validatePrefs(next);
          if (!checked) { notify('settingsInvalid'); return false; }
          const revision = bus.revision;
          bus.saving = true; bus.notice = null; bus.emit();
          try {
            const value = preferenceValue(await request(`${API}/preferences`, {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, prefs: checked }),
            }));
            if (closed) return false;
            if (!value || !value.persisted || JSON.stringify(value.prefs) !== JSON.stringify(checked)) { notify('saveFailed'); return false; }
            publishPreferences(value); notify('saved', 'success'); return true;
          } catch (error) {
            if (!closed && (error?.status === 409 || error?.code === 'REVISION_CONFLICT')) {
              await loadPreferences(); notify('conflict');
            } else if (!closed) notify('saveFailed');
            return false;
          } finally { if (!closed) { bus.saving = false; bus.emit(); } }
        }
        function load(manual = false) {
          if (closed) return Promise.resolve(false);
          if (inFlight) return inFlight;
          bus.loading = true; bus.emit();
          inFlight = track((async () => {
            try {
              const value = await request(`${API}?_=${Date.now()}`);
              if (closed) return false;
              if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SNAPSHOT');
              bus.error = null; bus.snapshot = value;
              if (manual) notify('refreshed', 'success');
              return true;
            } catch {
              if (!closed) { bus.error = 'refreshFailed'; if (manual) notify('refreshFailed'); }
              return false;
            } finally { inFlight = null; if (!closed) { bus.loading = false; bus.emit(); } }
          })());
          return inFlight;
        }
        async function enableSound(event) {
          if (closed || !bus.prefsReady || bus.saving || bus.soundBusy) return false;
          if (!(event?.isTrusted || event?.nativeEvent?.isTrusted)) { notify('soundFailed'); return false; }
          bus.soundBusy = true; bus.emit();
          try {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) throw new Error('AUDIO_UNAVAILABLE');
            audio ||= new Ctor();
            await bounded(Promise.resolve().then(() => audio.resume()), REQUEST_TIMEOUT_MS, lifecycle.signal, 'AUDIO_RESUME_TIMEOUT');
            if (closed) { stopAudio(); return false; }
            if (audio.state !== 'running') throw new Error('AUDIO_NOT_RUNNING');
            bus.soundReady = true;
            if (!bus.prefs.sound && !await savePreferences({ ...bus.prefs, sound: true })) { stopAudio(); return false; }
            notify('soundReady', 'success'); return true;
          } catch { stopAudio(); if (!closed) notify('soundFailed'); return false; }
          finally { if (!closed) { bus.soundBusy = false; bus.emit(); } }
        }
        async function disableSound() {
          const saved = await savePreferences({ ...bus.prefs, sound: false });
          if (saved) stopAudio();
          return saved;
        }
        function playSound() {
          if (!audio || audio.state !== 'running' || !bus.soundReady) return;
          try {
            const start = audio.currentTime;
            [0, 0.28, 0.56].forEach((offset, index) => {
              const oscillator = audio.createOscillator(), gain = audio.createGain();
              const node = { oscillator, gain }; audioNodes.add(node);
              oscillator.type = 'sine'; oscillator.frequency.value = index === 2 ? 1180 : 880;
              gain.gain.setValueAtTime(0.0001, start + offset);
              gain.gain.exponentialRampToValueAtTime(0.34, start + offset + 0.02);
              gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.22);
              oscillator.connect(gain).connect(audio.destination);
              oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); audioNodes.delete(node); };
              oscillator.start(start + offset); oscillator.stop(start + offset + 0.26);
            });
          } catch { stopAudio(); notify('soundFailed'); }
        }
        const offSound = bus.subscribe(() => {
          if (!bus.snapshot) return;
          const evaluation = evaluateEew(bus.snapshot, bus.prefs);
          const key = evaluation?.key;
          if (!primed) { primed = true; if (key) seenReports.add(key); return; }
          if (!key || seenReports.has(key)) return;
          seenReports.add(key);
          while (seenReports.size > 100) seenReports.delete(seenReports.values().next().value);
          // 只在「服务端就绪 + 事件有效且在关注范围内 + 声音已启用且已解锁」时才响；
          // 10 秒闸门防止同一事件的连续报次打连环炮。
          if (!bus.prefsReady || bus.error || !evaluation.active || !evaluation.relevant || !bus.prefs.sound || !bus.soundReady) return;
          if (Date.now() - lastAt < 10_000) return;
          lastAt = Date.now();
          playSound();
        });
        bus.reload = () => load(true); bus.reloadPrefs = loadPreferences;
        bus.savePrefs = next => track(savePreferences(next));
        bus.enableSound = event => track(enableSound(event)); bus.disableSound = () => track(disableSound());
        const timer = setInterval(() => { void load(); }, SNAPSHOT_POLL_MS);
        const clock = setInterval(() => { if (!closed) bus.emit(); }, 1000);
        void load(); void loadPreferences();
        return async () => {
          closed = true; clearInterval(timer); clearInterval(clock); offSound(); lifecycle.abort();
          for (const controller of controllers) controller.abort();
          controllers.clear(); stopAudio();
          bus.reload = null; bus.reloadPrefs = null; bus.savePrefs = null; bus.enableSound = null; bus.disableSound = null;
          bus.testUntil = 0; bus.prefsReady = false; bus.loading = false; bus.prefsLoading = false; bus.saving = false; bus.soundBusy = false;
          // Abort-aware reads and the explicit audio-close deadline keep unload
          // finite even when a browser adapter never resolves its native call.
          await bounded(Promise.allSettled([...tasks]), REQUEST_TIMEOUT_MS + AUDIO_CLOSE_TIMEOUT_MS, null, 'EARTHQUAKE_DISPOSE_TIMEOUT');
          for (const pending of operationTimers) clearTimeout(pending);
          operationTimers.clear();
        };
      }, 'dsh-earthquake-alert: 有界读取、持久提交与声音生命周期');

      function testBanner() {
        bus.dismissedKey = '';
        bus.testUntil = Date.now() + 15000;
        bus.emit();
      }

      function AlertBanner() {
        const state = useBus();
        const now = Date.now();
        const forced = state.testUntil > now;
        // Compute on every owned clock emission, including while fetch is down.
        const evaluation = evaluateEew(state.snapshot, state.prefs, now);
        const shown = forced || (state.prefsReady && !state.error && evaluation?.active && evaluation.relevant
          && state.dismissedKey !== evaluation.key);
        // 横幅住在 shell.overlay（帧级浮层）。两个约束叠在一起：
        // ① 面板在屏上时按面板水平中心，不在时不能退回"窗口"中心 ——
        //    窗口比可用区宽：实测 overlay 容器只有 0..884，而 window.innerWidth=1360，
        //    按窗口居中会让右端伸到右侧浏览器卡片底下；那是独立 WebContentsView 合成层，
        //    永远盖在外壳 HTML 之上，z-index 穿不透（AGENTS.md 已记此坑）。
        // ② 因此统一以「overlay 容器」为安全区：优先面板中心，否则容器中心，最后夹住范围。
        const [anchor, setAnchor] = useState(null);
        const bannerRef = useRef(null);
        useEffect(() => {
          if (!shown) return undefined;
          // 锚定是**纯视觉增强**，不是横幅的功能前提。纯净环境（根测试的 vm 沙箱）
          // 没有这些 DOM API —— 缺能力时直接放弃测量，绝不能让横幅本身挂掉：
          // 实测删按钮那轮之后，这里在沙箱里一炸就是 8/27 项连片失败，
          // 还挡住了别的会话的重建门禁。功能（显示/关闭/告警语义）不得依赖锚定。
          const measurable = typeof document?.querySelector === 'function'
            && typeof getComputedStyle === 'function'
            && typeof window?.addEventListener === 'function';
          if (!measurable) return undefined;
          // 从自己往上找第一个"有宽度且定位过"的祖先 = overlay 容器；
          // 不按类名找（DSH 的 CSS module 类名带哈希，会随构建变）。
          const findHost = node => {
            let element = node?.parentElement;
            while (element) {
              const rect = element.getBoundingClientRect();
              if (rect.width > 0 && getComputedStyle(element).position !== 'static') return element;
              element = element.parentElement;
            }
            return null;
          };
          const measure = () => {
            const banner = bannerRef.current;
            if (!banner) return;
            const panel = document.querySelector('.dshea-root')?.getBoundingClientRect();
            const hostEl = findHost(banner);
            const host = hostEl ? hostEl.getBoundingClientRect() : null;
            const half = banner.getBoundingClientRect().width / 2;
            // 用户要的是"始终在对话框居中"，而对话框列不是 overlay 层的全宽。
            // 实测框架 pI_x6G_frame 的子元素：sidebarCol(6..62 轨道模式) /
            // centerCol(68..878) / rightbarCol(878..878) / overlayLayer(0..884)。
            // 该居中的是 centerCol（中心 473），不是 overlayLayer（中心 442）。
            // 曾用共享主题 --dsh-sidebar-w 推算，实测它不跟随布局：侧边栏收成轨道后
            // 仍报 252px，胶囊偏右 95px。**所以这里绝不能读任何布局 token** ——
            // 只读实时几何，侧边栏全宽/轨道/隐藏三态自动跟随。
            //   · 完全落在左半边的兄弟 → 侧边栏，取它的右缘作内容列左界；
            //   · 完全落在右半边的兄弟 → 右栏，取它的左缘作内容列右界；
            //   · 跨中线的那一个（就是内容列自己）不参与判定 —— 早先按 left<mid 分类
            //     会把它当成左侧元素，把左界算成它的右缘，整条规则失效。
            const contentColumn = () => {
              const frame = hostEl?.parentElement;
              if (!frame) return null;
              const box = frame.getBoundingClientRect();
              if (!(box.width > 0)) return null;
              const mid = box.left + box.width / 2;
              const siblings = [...frame.children]
                .filter(child => child !== hostEl)
                .map(child => child.getBoundingClientRect())
                .filter(rect => rect.width > 0);
              if (!siblings.length) return null;
              const sidebarRight = Math.max(box.left, ...siblings.filter(r => r.right <= mid).map(r => r.right));
              const rightbarLeft = Math.min(box.right, ...siblings.filter(r => r.left >= mid).map(r => r.left));
              return rightbarLeft > sidebarRight ? { left: sidebarRight, right: rightbarLeft } : null;
            };
            let center;
            if (panel && panel.width > 0) center = panel.left + panel.width / 2;
            else {
              const column = contentColumn();
              if (column) center = (column.left + column.right) / 2;
              else if (host && host.width > 0) center = (host.left + host.right) / 2;
              else center = window.innerWidth / 2;
            }
            if (half > 0 && host && host.width > 0) {
              center = Math.min(Math.max(center, host.left + half + 8), host.right - half - 8);
            }
            const next = Math.round(center);
            setAnchor(current => (current === next ? current : next));
          };
          measure();
          const target = document.querySelector('.dshea-root');
          const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
          if (observer && target) observer.observe(target);
          window.addEventListener('resize', measure);
          // 浏览器卡片开合不一定改动面板尺寸（也不一定触发 window.resize），兜一个低频轮询。
          const timer = setInterval(measure, 1000);
          return () => {
            observer?.disconnect();
            window.removeEventListener('resize', measure);
            clearInterval(timer);
          };
        }, [shown]);
        if (!shown) return null;
        const eew = forced ? null : evaluation?.eew;
        const nearest = evaluation?.impacts?.[0];
        // 胶囊只放"扫一眼就能决策"的信息：震级、震中、报告序号、最近关注地点的距离与
        // S 波倒计时、官方最大烈度。发震时刻/深度等留在面板里 —— 胶囊塞满就没法扫了。
        // 结构契约（根测试 earthquake-client.test.ts 钉死的，胶囊化时不能一并删掉）：
        //   · .dshea-banner-head —— role=alert（主信息行）
        //   · .dshea-banner-body —— aria-live=off（次要事实，避免读屏重复播报）
        //   · 演示徽标必须是 .dshea-pill.dshea-pill-test，文本恰好一个「演示」
        //   · 文本里必须含「第 N 报」（报告序号是预警的核心语义之一）
        const row = forced
          ? [
            h('span', { key: 'mag', className: 'dshea-banner-mag' }, t('testLabel')),
            h('span', { key: 'place', className: 'dshea-banner-place' }, t('title')),
            h('span', { key: 'demo', className: 'dshea-pill dshea-pill-test' }, t('demoLabel')),
            h('span', { key: 'body', className: 'dshea-banner-body', 'aria-live': 'off' },
              h('span', { key: 'only' }, t('testOnly')),
              h('span', { key: 'exp' }, t('testExpires').replace('{n}', String(Math.ceil((state.testUntil - now) / 1000))))),
          ]
          : [
            h('span', { key: 'mag', className: 'dshea-banner-mag' }, `M${eew?.magnitude ?? '?'}`),
            h('span', { key: 'place', className: 'dshea-banner-place' }, eew?.place || t('place')),
            h('span', { key: 'body', className: 'dshea-banner-body', 'aria-live': 'off' },
              h('span', { key: 'num' }, t('reportNum').replace('{n}', String(eew?.reportNum ?? 1))),
              nearest
                ? h('span', { key: 'near' },
                  `${nearest.site.name} · ${t('km')} ${Math.round(nearest.km)} km · ${t('sWave')} ${nearest.sSeconds <= 0 ? t('arrived') : `${Math.ceil(nearest.sSeconds)}${t('seconds')}`}`)
                : h('span', { key: 'none' }, t('noSites')),
              h('span', { key: 'int' }, `${t('intensity')} ${eew?.maxIntensity ?? '—'}`)),
          ];
        return h('section', {
          ref: bannerRef,
          className: `dshea-banner${forced ? ' dshea-banner-test' : ''}`,
          'data-dshea-banner': forced ? 'test' : 'live',
          'aria-label': t('bannerTitle'),
          style: anchor === null ? undefined : { left: `${anchor}px` },
        },
          h('div', { className: 'dshea-banner-head', role: 'alert', 'aria-live': 'assertive', 'aria-atomic': true }, row),
          h('button', {
            type: 'button',
            className: 'dshea-banner-close',
            'data-dshea-action': 'dismiss-banner',
            'aria-label': t('dismiss'),
            onClick: () => {
              bus.dismissedKey = forced ? '' : evaluation.key;
              bus.testUntil = 0;
              bus.emit();
            },
          }, t('dismiss')));
      }

      function EarthquakePanel() {
        const state = useBus();
        const [draft, setDraft] = useState({ name: '', latitude: '', longitude: '' });
        const [formError, setFormError] = useState('');
        const [settings, setSettings] = useState({ radiusKm: String(bus.prefs.radiusKm), minMagnitude: String(bus.prefs.minMagnitude), alertWindowSeconds: String(bus.prefs.alertWindowSeconds) });
        const [dirty, setDirty] = useState(false);
        // 列表折叠：关注地点一多，「影响判定」就退化成一堵内容完全相同的
        // 「超出报警半径」重复行，面板被噪声占满（实测 15 处 → 12 行同文案）。
        // 两个列表默认收起，只留一行可展开摘要；添加成功后自动收起。
        const [showSites, setShowSites] = useState(null);
        const [showOutside, setShowOutside] = useState(false);
        const alive = useRef(true);
        useEffect(() => {
          alive.current = true;
          return () => { alive.current = false; };
        }, []);
        useEffect(() => {
          if (!dirty && state.prefsReady) setSettings({ radiusKm: String(state.prefs.radiusKm), minMagnitude: String(state.prefs.minMagnitude), alertWindowSeconds: String(state.prefs.alertWindowSeconds) });
        }, [state.prefs, state.prefsReady, dirty]);

        const now = Date.now();
        const prefs = state.prefs || DEFAULT_PREFS;
        // 未配置地点时默认展开（否则新用户找不到添加入口）；配置过之后默认收起。
        const sitesExpanded = showSites === null ? prefs.sites.length === 0 : showSites;
        const evaluation = evaluateEew(state.snapshot, prefs, now);
        const freshness = feedHealth(state.snapshot, now);
        const health = state.snapshot?.health;
        const source = state.snapshot?.source;
        const list = Array.isArray(state.snapshot?.list) ? state.snapshot.list : [];
        const eew = state.snapshot?.eew;
        const disabled = !state.prefsReady || state.saving || state.soundBusy;
        // A missing event after a failed first feed read is an unknown status,
        // not evidence that no warning exists. Readiness precedes event absence.
        const status = state.error || freshness.error ? 'unavailable' : !state.snapshot ? 'waiting'
          : !freshness.fresh ? 'unavailable' : !eew ? 'none' : !evaluation ? 'invalid' : evaluation.active ? 'active' : 'expired';
        const addSite = async () => {
          const latitude = draftNumber(draft.latitude, -90, 90), longitude = draftNumber(draft.longitude, -180, 180);
          const name = draft.name.trim().normalize('NFC');
          if (latitude === null || longitude === null || !name || draft.name.length > 40 || /[\u0000-\u001f\u007f]/.test(draft.name)) return setFormError('coordinateInvalid');
          if (bus.prefs.sites.length >= MAX_SITES) return setFormError('siteLimit');
          if (bus.prefs.sites.some(site => site.name.toLowerCase() === name.toLowerCase()
            || (site.latitude === latitude && (site.longitude === 180 ? -180 : site.longitude) === (longitude === 180 ? -180 : longitude)))) return setFormError('duplicateSite');
          setFormError('');
          const saved = await bus.savePrefs?.({ ...bus.prefs, sites: [...bus.prefs.sites, { name, latitude, longitude }] });
          if (saved && alive.current) { setDraft({ name: '', latitude: '', longitude: '' }); setShowSites(false); }
        };
        const saveSettings = async () => {
          const radiusKm = draftNumber(settings.radiusKm, 10, 2000), minMagnitude = draftNumber(settings.minMagnitude, 0, 10), alertWindowSeconds = draftNumber(settings.alertWindowSeconds, 30, 3600);
          if (radiusKm === null || minMagnitude === null || alertWindowSeconds === null) return setFormError('settingsInvalid');
          setFormError('');
          const saved = await bus.savePrefs?.({ ...bus.prefs, radiusKm, minMagnitude, alertWindowSeconds });
          if (saved && alive.current) setDirty(false);
        };

        const statusPill = h('span', {
          className: `dshea-pill${status === 'active' && evaluation?.relevant ? ' dshea-pill-alert' : ''}`,
        }, status === 'active' && !evaluation.relevant ? t('filtered') : t(status));

        const head = h('header', { className: 'dshea-head' },
          h('div', { className: 'dshea-head-text' },
            h('div', { className: 'dshea-head-title-row' },
              h('h2', { className: 'dshea-h1' }, t('title')),
              h('div', { className: 'dshea-head-actions' },
                statusPill,
                h('button', {
                  type: 'button', className: 'dshea-btn dshea-btn-sm dshea-btn-outline', 'data-dshea-action': 'test-banner', onClick: testBanner,
                }, t('testBanner')))),
            h('p', { className: 'dshea-caption' }, t('subtitle'))));

        const impactRow = impact => h('li', {
          key: `${impact.site.name}-${impact.site.latitude}-${impact.site.longitude}`,
        },
          h('span', { className: 'dshea-list-key' }, impact.site.name),
          h('span', {
            className: `dshea-list-val${impact.withinRadius ? ' dshea-warn' : ''}`,
            'data-dshea-countdown': 's', 'data-dshea-seconds': Number.isFinite(impact.sSeconds) ? Math.ceil(impact.sSeconds) : undefined,
          }, `${t('km')} ${Number.isFinite(impact.km) ? Math.round(impact.km) : '—'} km · ${t('sWave')} ${impact.sSeconds <= 0 ? t('arrived') : `${Math.ceil(impact.sSeconds)}${t('seconds')}`} · ${impact.withinRadius ? t('within') : t('outside')}`));

        // 半径内的照常列全；半径外的折叠成一行摘要 —— 地点一多时它们文案完全相同，
        // 全列出来只会淹没有效信息。
        const impacts = evaluation?.impacts || [];
        const withinImpacts = impacts.filter(impact => impact.withinRadius);
        const outsideImpacts = impacts.filter(impact => !impact.withinRadius);

        const impactList = prefs.sites.length === 0
          ? h('p', { className: 'dshea-hint' }, t('noSites'))
          : !evaluation ? h('p', { className: 'dshea-hint' }, t('noImpact'))
          : h('div', { className: 'dshea-collapse' },
            withinImpacts.length
              ? h('ul', { className: 'dshea-list' }, withinImpacts.map(impactRow))
              : h('p', { className: 'dshea-hint' }, t('noneWithin')),
            outsideImpacts.length
              ? h('button', {
                type: 'button', className: 'dshea-btn dshea-btn-sm dshea-btn-outline',
                'data-dshea-action': 'toggle-outside', 'aria-expanded': showOutside,
                onClick: () => setShowOutside(value => !value),
              }, t(showOutside ? 'collapseOutside' : 'expandOutside').replace('{n}', String(outsideImpacts.length)))
              : null,
            showOutside ? h('ul', { className: 'dshea-list' }, outsideImpacts.map(impactRow)) : null);

        const currentBody = !state.snapshot
          ? h('p', { className: `dshea-hint${state.error ? ' dshea-danger' : ''}` },
            state.error ? t('refreshFailed') : t('loading'))
          : (!eew
            ? h('p', { className: `dshea-hint${status === 'unavailable' ? ' dshea-warn' : ''}` }, t(status === 'unavailable' ? 'unavailableHint' : 'noEew'))
            : h('div', { className: 'dshea-current' },
              h('div', { className: 'dshea-hero' },
                h('div', { className: 'dshea-hero-main' },
                  h('div', { className: `dshea-mag${status === 'active' && evaluation?.relevant ? '' : ' dshea-mag-idle'}` },
                    `M${eew.magnitude ?? '?'}`),
                  h('div', { className: 'dshea-place' }, eew.place || t('place'))),
                h('dl', { className: 'dshea-kv' },
                  h('dt', null, t('origin')),
                  h('dd', null, `${clockText(evaluation?.origin)} · ${t('reportNum').replace('{n}', String(eew.reportNum ?? 1))}`),
                  h('dt', null, t('depth')), h('dd', null, `${eew.depth ?? '—'} km`),
                  h('dt', null, t('intensity')), h('dd', null, `${eew.maxIntensity ?? '—'}`),
                  h('dt', null, t('age')), h('dd', null, evaluation ? t('ageText').replace('{n}', String(Math.floor(evaluation.ageSeconds))) : '—'),
                  h('dt', null, t('coord')), h('dd', null, `${eew.latitude ?? '—'}, ${eew.longitude ?? '—'}`))),
              // 卡片停在旧事件时最容易被当成"坏了"（用户 2026-10-01「为啥左上的信息没有更新？」）。
              // 实测上游 cenc_eew.json 自 09-30 18:31 起未发布新预警，而我们的 receivedAt 是"刚刚"
              // —— 管道活着、上游安静。所以这里必须把"上游何时发布"和"数据源正常"写出来，
              // 否则每次上游安静都会被误读成故障。
              // 用户两次问「为什么还没有新消息」—— 只写"上游安静"不够，必须把**目录源的最新一条**
              // 一起摆出来，否则卡片像死的：上游 cenc_eew.json 的 Last-Modified 停在 09-30 18:31
              // （实测响应 Date 是当前时刻，不是缓存），而目录源一直在进新条目。
              status === 'expired' ? h('p', { className: 'dshea-hint' },
                t('stale')
                  .replace('{at}', clockText(eew.reportTime || eew.originTime))
                  .replace('{latest}', list[0] ? `${list[0].time} ${list[0].place} M${list[0].magnitude}` : '—')) : status === 'unavailable' || status === 'invalid' ? h('p', { className: 'dshea-hint dshea-warn' }, t(status)) : null,
              h('div', { className: 'dshea-impact' },
                h('h4', { className: 'dshea-subhead' }, t('impact')),
                impactList,
                h('p', { className: 'dshea-hint' }, t('estimated')))));

        const currentCard = h('section', {
          className: 'dshea-card', 'aria-label': t('current'), 'data-dshea-status': status,
        },
          h('div', { className: 'dshea-card-head' },
            h('h3', { className: 'dshea-card-title' }, t('current')),
            statusPill),
          currentBody,
          !evaluation?.active ? h('p', { className: 'dshea-hint' }, t('testBannerHint')) : null);

        const siteRows = prefs.sites.length === 0
          ? h('p', { className: 'dshea-hint' }, t('emptySites'))
          : h('div', { className: 'dshea-collapse' },
            h('button', {
              type: 'button', className: 'dshea-btn dshea-btn-sm dshea-btn-outline',
              'data-dshea-action': 'toggle-sites', 'aria-expanded': sitesExpanded,
              onClick: () => setShowSites(!sitesExpanded),
            }, t(sitesExpanded ? 'collapseSites' : 'expandSites').replace('{n}', String(prefs.sites.length))),
            sitesExpanded ? h('ul', { className: 'dshea-list' }, prefs.sites.map((site, index) => h('li', {
              key: `${site.name}-${index}`,
            },
              h('span', { className: 'dshea-list-key' }, site.name),
              h('span', { className: 'dshea-list-actions' },
                h('span', { className: 'dshea-list-val' }, `${site.latitude}, ${site.longitude}`),
                h('button', {
                  type: 'button', className: 'dshea-btn dshea-btn-sm',
                    'data-dshea-action': 'remove-site', 'data-dshea-site': index, disabled,
                    'aria-label': t('removeNamed').replace('{name}', site.name),
                    onClick: () => bus.savePrefs?.({ ...bus.prefs, sites: bus.prefs.sites.filter((_, position) => position !== index) }),
                }, t('remove')))))) : null);

        const sitesCard = h('section', { className: 'dshea-card' },
          h('div', { className: 'dshea-card-head' },
            h('h3', { className: 'dshea-card-title' }, t('sites'))),
          siteRows,
          h('fieldset', { className: 'dshea-fieldset dshea-fields', disabled },
            h('div', { className: 'dshea-field' },
              h('h4', { className: 'dshea-subhead' }, t('addSite')),
              h('div', { className: 'dshea-field-row' },
                h('label', { className: 'dshea-inline-field dshea-name-field', htmlFor: 'dshea-site-name' },
                  h('span', { className: 'dshea-field-label' }, t('siteName')),
                  h('input', {
                    id: 'dshea-site-name', className: 'dshea-input', placeholder: t('siteNameHint'),
                    value: draft.name, maxLength: 40, disabled, 'aria-invalid': formError === 'coordinateInvalid',
                    onChange: event => setDraft({ ...draft, name: event.target.value }),
                  })),
                h('label', { className: 'dshea-inline-field', htmlFor: 'dshea-latitude' },
                  h('span', { className: 'dshea-field-label' }, t('latitude')),
                  h('input', {
                    id: 'dshea-latitude', className: 'dshea-input dshea-input-num', placeholder: t('latitudeHint'), disabled,
                    value: draft.latitude, inputMode: 'decimal', 'aria-invalid': formError === 'coordinateInvalid',
                    onChange: event => setDraft({ ...draft, latitude: event.target.value }),
                  })),
                h('label', { className: 'dshea-inline-field', htmlFor: 'dshea-longitude' },
                  h('span', { className: 'dshea-field-label' }, t('longitude')),
                  h('input', {
                    id: 'dshea-longitude', className: 'dshea-input dshea-input-num', placeholder: t('longitudeHint'), disabled,
                    value: draft.longitude, inputMode: 'decimal', 'aria-invalid': formError === 'coordinateInvalid',
                    onChange: event => setDraft({ ...draft, longitude: event.target.value }),
                  })),
                h('button', { type: 'button', className: 'dshea-btn dshea-btn-primary', 'data-dshea-action': 'add-site', disabled, onClick: addSite }, state.saving ? t('saving') : t('addSite'))),
              formError ? h('p', { className: 'dshea-hint dshea-danger', role: 'alert', 'data-dshea-form-error': formError }, t(formError)) : null),
            h('div', { className: 'dshea-field' },
              h('h4', { className: 'dshea-subhead' }, t('preferences')),
              h('div', { className: 'dshea-field-row' },
                h('label', { className: 'dshea-inline-field' },
                  h('span', { className: 'dshea-field-label' }, t('radius')),
                  h('input', {
                    id: 'dshea-radius', className: 'dshea-input dshea-input-num', type: 'number', min: 10, max: 2000, disabled,
                    value: settings.radiusKm, 'aria-invalid': formError === 'settingsInvalid',
                    onChange: event => { setSettings({ ...settings, radiusKm: event.target.value }); setDirty(true); },
                  })),
                h('label', { className: 'dshea-inline-field' },
                  h('span', { className: 'dshea-field-label' }, t('minMag')),
                  h('input', {
                    id: 'dshea-min-magnitude', className: 'dshea-input dshea-input-num', type: 'number', min: 0, max: 10, step: 0.1, disabled,
                    value: settings.minMagnitude, 'aria-invalid': formError === 'settingsInvalid',
                    onChange: event => { setSettings({ ...settings, minMagnitude: event.target.value }); setDirty(true); },
                  })),
                h('label', { className: 'dshea-inline-field' },
                  h('span', { className: 'dshea-field-label' }, t('window')),
                  h('input', {
                    id: 'dshea-alert-window', className: 'dshea-input dshea-input-num', type: 'number', min: 30, max: 3600, disabled,
                    value: settings.alertWindowSeconds, 'aria-invalid': formError === 'settingsInvalid',
                    onChange: event => { setSettings({ ...settings, alertWindowSeconds: event.target.value }); setDirty(true); },
                  })),
                h('button', { type: 'button', className: 'dshea-btn dshea-btn-primary dshea-btn-end', 'data-dshea-action': 'save-settings', disabled,
                  onClick: saveSettings }, state.saving ? t('saving') : t('saveSettings'))),
              h('div', { className: 'dshea-field-row' },
                h('label', {
                  className: `dshea-inline-field dshea-inline-check${prefs.sound && !state.soundReady ? ' dshea-check-action' : ''}`,
                  // 已勾选但浏览器音频尚未解锁时（例如页面重开后偏好仍在），点一下这行文字
                  // 补一次用户手势。原实现为此专门渲染一个「启用声音」按钮，用户判定
                  // "太突兀、不属于重要提示"（2026-10-01），故去掉按钮，把同一能力挂到
                  // 本就在屏上的文字上 —— 不新增任何视觉元素。
                  // ① data-dshea-action="enable-sound" 必须保留在**常驻**元素上：根测试
                  //    earthquake-client.test.ts 的 action() 辅助函数靠它定位并直接调
                  //    onClick —— 删按钮时把这个钩子一起带走了，27 项挂 10 项，还挡住了
                  //    别的会话的重建（gate 3）。挂到 label 上：契约在，按钮不在。
                  // ② onClick 必须**恒存在**：测试是无条件调用 props.onClick 的，
                  //    锁定与否只能在函数体内判断，不能靠条件渲染。
                  // ③ preventDefault 要用可选调用：测试传的是裸对象 { isTrusted: false }，
                  //    没有 preventDefault 方法。
                  'data-dshea-action': 'enable-sound',
                  // 必须 **return** 这个 promise：调用方（根测试的 action() 辅助函数、
                  // 以及任何 await 这个 onClick 的地方）靠它判断"解锁是否真的完成"。
                  // 写成块箭头却不 return，await 会立刻通过 —— 表现为 resumes 已 +1
                  // 但 soundReady/audio 尚未落定，随后的时钟推进会把 bounded 超时定时器
                  // 一并触发，enable 走 catch → stopAudio() 把音频置空，告警再也响不了。
                  // 这正是 26/27 → 25/27 那 10 项连片失败的残余根因。
                  onClick: event => {
                    if (!(prefs.sound && !state.soundReady)) return undefined; // 未锁定：走默认勾选行为
                    event.preventDefault?.();
                    return bus.enableSound?.(event);
                  },
                },
                  h('input', {
                    type: 'checkbox', checked: prefs.sound, disabled, 'aria-label': t('sound'),
                    onChange: event => event.target.checked ? bus.enableSound?.(event) : bus.disableSound?.(),
                  }),
                  h('span', { className: 'dshea-field-label' }, t('sound')))),
              h('p', { className: 'dshea-hint' }, state.soundReady ? t('soundReady') : prefs.sound ? t('soundGesture') : t('soundHint')))));

        const recentCard = h('section', { className: 'dshea-card' },
          h('div', { className: 'dshea-card-head' },
            h('h3', { className: 'dshea-card-title' }, t('recent')),
            h('span', { className: 'dshea-pill dshea-spacer' },
              `${t('fetches')} EEW ${health?.eewFetches ?? 0} · list ${health?.listFetches ?? 0}`),
            h('button', {
              type: 'button', className: 'dshea-btn dshea-btn-sm dshea-btn-outline',
              'data-dshea-action': 'refresh', disabled: state.loading,
              onClick: () => { bus.reload?.(); },
            }, state.loading ? t('refreshing') : t('refresh'))),
          list.length === 0
            ? h('p', { className: 'dshea-hint' }, t('none'))
            : h('ul', { className: 'dshea-list' }, list.slice(0, 20).map((row, index) => h('li', {
              key: `${row.eventId}-${index}`,
            },
              h('span', { className: 'dshea-list-key' }, row.time || row.reportTime || '—'),
              h('span', { className: 'dshea-list-val' },
                `M${row.magnitude ?? '?'} · ${row.place || '—'}${row.depth != null ? ` · ${row.depth} km` : ''}`)))));

        const healthCard = h('section', { className: 'dshea-card' },
          h('div', { className: 'dshea-card-head' },
            h('h3', { className: 'dshea-card-title' }, t('health'))),
          h('dl', { className: 'dshea-kv' },
            h('dt', null, t('source')), h('dd', null, source?.eewUrl || '—'),
            h('dt', null, t('eewFeed')), h('dd', { 'data-dshea-feed': 'eew' }, !state.error && freshness.fresh ? t('feedHealthy') : t('feedStale')),
            // 「抓取成功」不等于「有预警」：上游安静时卡片会停在旧事件上。
            // 把上游最近一次预警的发布时间单列出来，用户一眼就能区分"我们没抓到"和"上游没发"。
            h('dt', null, t('upstreamAlert')),
            h('dd', null, eew ? clockText(eew.reportTime || eew.originTime) : '—'),
            h('dt', null, t('lastOk')), h('dd', null, typeof freshness.lastOk === 'number' ? clockText(new Date(freshness.lastOk)) : '—'),
            h('dt', null, t('listFeed')), h('dd', { 'data-dshea-feed': 'list' }, health?.listError?.code || (typeof health?.listLastOkAt === 'number' ? clockText(new Date(health.listLastOkAt)) : '—')),
            h('dt', null, t('lastError')),
            h('dd', { className: (state.error || freshness.error) ? 'dshea-danger' : '' },
              state.error ? t('refreshFailed') : freshness.error?.code || '—')),
          h('p', { className: 'dshea-note dshea-warn' }, t('disclaimer')));
        const prefsFeedback = h('div', { className: 'dshea-fields' },
          state.prefsLoading ? h('p', { className: 'dshea-hint', role: 'status' }, t('prefsLoading')) : null,
          !state.prefsReady ? h('div', { className: 'dshea-field-row' },
            h('p', { className: 'dshea-hint dshea-warn' }, t('prefsUnavailable')),
            h('button', { type: 'button', className: 'dshea-btn dshea-btn-outline', 'data-dshea-action': 'load-preferences', disabled: state.prefsLoading,
              onClick: () => bus.reloadPrefs?.() }, t('retryPrefs'))) : null,
          state.notice ? h('p', { className: `dshea-note${state.notice.kind === 'error' ? ' dshea-danger' : ''}`,
            role: state.notice.kind === 'error' ? 'alert' : 'status', 'data-dshea-notice': state.notice.code }, t(state.notice.code)) : null,
          state.notice?.code === 'conflict' && state.prefsReady ? h('button', {
            type: 'button', className: 'dshea-btn dshea-btn-outline', 'data-dshea-action': 'reset-draft', disabled,
            onClick: () => {
              setSettings({ radiusKm: String(state.prefs.radiusKm), minMagnitude: String(state.prefs.minMagnitude), alertWindowSeconds: String(state.prefs.alertWindowSeconds) });
              setDirty(false); setFormError('');
            },
          }, t('resetSaved')) : null,
          !state.persisted && state.prefsReady && state.legacy ? h('div', { className: 'dshea-field-row' },
            h('p', { className: 'dshea-hint' }, t('migrationHint')),
            h('button', { type: 'button', className: 'dshea-btn dshea-btn-outline', 'data-dshea-action': 'migrate', disabled,
              onClick: () => bus.savePrefs?.(state.legacy) }, t('migrate'))) : null,
          state.legacyError ? h('p', { className: 'dshea-hint dshea-warn' }, t('migrationInvalid')) : null);
        return h('section', { className: 'dshea-root', 'data-dshea-panel': true, 'aria-label': t('title') },
          head, prefsFeedback, currentCard, sitesCard, recentCard, healthCard);
      }

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'dsh-earthquake-alert', order: 30, label: () => t('title'),
      }, EarthquakeIcon));

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'dsh-earthquake-alert',
      }, EarthquakePanel));

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'dsh-earthquake-alert', order: 60, label: () => t('title'),
      }, AlertBanner));
    }

    return { inject: ['locale', 'slots'], apply };
  },
});
