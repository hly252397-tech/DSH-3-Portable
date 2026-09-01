(function () {
  'use strict';
  // DSH 桌面外壳主题预设 · 参考配色灵感板
  // 每组含 swatch（展示色）/ zh / en 与 dark、light 两套变量。
  // 变量约定：accent 强调色 · focus-ring 焦点环 · focus-border 聚焦边框 ·
  // active-bg 按下态底 · tint 强调色弱化底 · cta-bg/fg/hover 主按钮 · knob 开关滑钮
  var THEMES = {
    lake: {
      zh: '湖蓝系', en: 'Lake Blue', swatch: '#0961F6',
      dark: { accent: '#4D8BFF', 'focus-ring': '#4D8BFF', 'focus-border': '#3E6FD9', 'active-bg': '#26344E', tint: 'rgba(9,97,246,.16)', 'cta-bg': '#4D8BFF', 'cta-fg': '#0A1526', 'cta-hover': '#6AA0FF', knob: '#0A1526' },
      light: { accent: '#0961F6', 'focus-ring': '#0961F6', 'focus-border': '#6E97F8', 'active-bg': '#DCE7FC', tint: 'rgba(9,97,246,.18)', 'cta-bg': '#0961F6', 'cta-fg': '#FFFFFF', 'cta-hover': '#2A77F8', knob: '#FFFFFF' }
    },
    verde: {
      zh: '塞绿系', en: 'Veronese Green', swatch: '#1B5523',
      dark: { accent: '#5CB878', 'focus-ring': '#5CB878', 'focus-border': '#4E9E67', 'active-bg': '#24382B', tint: 'rgba(88,184,120,.16)', 'cta-bg': '#5CB878', 'cta-fg': '#0C1F12', 'cta-hover': '#74CB90', knob: '#0C1F12' },
      light: { accent: '#1B5523', 'focus-ring': '#1B5523', 'focus-border': '#3E7A4B', 'active-bg': '#DDEAE0', tint: 'rgba(27,85,35,.18)', 'cta-bg': '#1B5523', 'cta-fg': '#F2E3C6', 'cta-hover': '#266B30', knob: '#F2E3C6' }
    },
    vermilion: {
      zh: '朱红靛蓝系', en: 'Vermilion & Indigo', swatch: '#FF4C00',
      dark: { accent: '#FF6B2B', 'focus-ring': '#FF6B2B', 'focus-border': '#E6561A', 'active-bg': '#3D2A22', tint: 'rgba(255,76,0,.16)', 'cta-bg': '#FF6B2B', 'cta-fg': '#1F0D05', 'cta-hover': '#FF8551', knob: '#1F0D05' },
      light: { accent: '#E64A00', 'focus-ring': '#CC4000', 'focus-border': '#FF7A3D', 'active-bg': '#FDE4D8', tint: 'rgba(230,74,0,.18)', 'cta-bg': '#E64A00', 'cta-fg': '#1F0D05', 'cta-hover': '#F55C12', knob: '#1F0D05' }
    },
    slate: {
      zh: '石板春梅系', en: 'Slate & Spring Blue', swatch: '#0F95B0',
      dark: { accent: '#2FB8D4', 'focus-ring': '#2FB8D4', 'focus-border': '#269AB2', 'active-bg': '#223A42', tint: 'rgba(15,149,176,.16)', 'cta-bg': '#FDD95F', 'cta-fg': '#2A2410', 'cta-hover': '#FFE47E', knob: '#2A2410' },
      light: { accent: '#0C7E94', 'focus-ring': '#0C7E94', 'focus-border': '#35AEC6', 'active-bg': '#D8EFF4', tint: 'rgba(15,149,176,.18)', 'cta-bg': '#0B7A93', 'cta-fg': '#FFFFFF', 'cta-hover': '#12A8C6', knob: '#FFFFFF' }
    },
    gold: {
      zh: '迪奥金系', en: 'Dior Gold', swatch: '#A99563',
      dark: { accent: '#C9B37E', 'focus-ring': '#C9B37E', 'focus-border': '#AC9663', 'active-bg': '#3A3324', tint: 'rgba(169,149,99,.18)', 'cta-bg': '#C9B37E', 'cta-fg': '#241C0C', 'cta-hover': '#D9C795', knob: '#241C0C' },
      light: { accent: '#8A7A4E', 'focus-ring': '#8A7A4E', 'focus-border': '#A99563', 'active-bg': '#EFE8D6', tint: 'rgba(138,122,78,.18)', 'cta-bg': '#492D22', 'cta-fg': '#FCF5E2', 'cta-hover': '#5C3B2C', knob: '#FCF5E2' }
    }
  };
  var KEY = 'dshShellTheme';
  // 内存态作为“当前主题”唯一权威来源：选中高亮据此渲染，localStorage 失效时也不会与主题脱节
  var current = 'lake';

  function parse(id) { return (id && THEMES[id]) ? id : 'lake'; }
  function readStored() {
    try { var v = localStorage.getItem(KEY); if (v && THEMES[v]) return v; } catch (e) { /* 忽略 */ }
    return null;
  }
  function effective() { return THEMES[current] ? current : 'lake'; }

  function paint() {
    var theme = THEMES[effective()] || THEMES.lake;
    var mode = document.documentElement.dataset.colorScheme === 'light' ? 'light' : 'dark';
    var vars = theme[mode];
    var style = document.documentElement.style;
    for (var name in vars) style.setProperty('--' + name, vars[name]);
    document.documentElement.dataset.theme = effective();
  }

  window.DshThemes = {
    THEMES: THEMES,
    apply: paint,
    saved: effective,        // 渲染选中态（编辑外观页）使用
    current: effective,
    set: function (id) {
      var next = parse(id);
      current = next;
      paint();
      // 优先走原生持久化通道（多窗口与启动页一致的最佳解，前提是主进程暴露该 IPC）
      if (window.dshShell && window.dshShell.updateThemePreferences) {
        try { void window.dshShell.updateThemePreferences({ preset: next }); } catch (e) { /* 回退 */ }
      }
      try { localStorage.setItem(KEY, next); } catch (e) { /* 持久化失败：仅当前窗口生效 */ }
      return next;
    }
  };

  // 跨窗口同步：同源其它窗口（shell/startup/about/shortcuts）通过 storage 事件到达；
  // BroadcastChannel 不跨越独立 WebContents，已弃用。
  window.addEventListener('storage', function (event) {
    if (event.key === KEY) { current = parse(event.newValue || 'lake'); paint(); }
  });

  // 深浅色切换（bootstrap 覆写 data-color-scheme）时重绘主题
  var lastScheme = document.documentElement.dataset.colorScheme;
  try {
    new MutationObserver(function () {
      if (document.documentElement.dataset.colorScheme !== lastScheme) {
        lastScheme = document.documentElement.dataset.colorScheme;
        paint();
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-scheme'] });
  } catch (e) { /* 旧内核降级：主题随 bootstrap 重设即可 */ }

  current = parse(readStored() || 'lake');
  paint();
})();
