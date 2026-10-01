// Registered by test/earthquake-client.test.ts in the normal root test runner.
// Present-but-broken Data fails; an inactive slot never repairs missing tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeUiProfile } from '../../../scripts/lib/active-ui-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function presentData(root) {
  try {
    const entry = lstatSync(resolve(root, 'Data'));
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'Data must be an ordinary directory');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function definedTokens(directory, set) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), entry = lstatSync(path);
    assert.ok(!entry.isSymbolicLink(), 'Official UI package must not contain a link');
    if (entry.isDirectory()) definedTokens(path, set);
    else if (/\.(css|js)$/.test(name)) {
      for (const match of readFileSync(path, 'utf8').matchAll(/(--(?:dsw|ds)-[a-z0-9-]+)\s*:/g)) set.add(match[1]);
    }
  }
}

export function registerEarthquakeUiTokenTests(root = resolve(HERE, '../../..')) {
  const source = readFileSync(resolve(root, 'plugins/dsh-earthquake-alert/lib/client.js'), 'utf8');
  const cssMatch = source.match(/const CSS = `([\s\S]*?)`;/);
  assert.ok(cssMatch, 'Earthquake CSS must remain an explicit scoped template');
  const css = cssMatch[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const contractMatch = css.match(/\.dshea-root,\.dshea-banner\{([\s\S]*?)\n\}/);
  assert.ok(contractMatch, 'Local metric contract is missing');
  const contract = contractMatch[0], rest = css.replace(contract, '');

  test('earthquake UI: metrics are centralized and local variables have no dead/unknown declarations', () => {
    const declared = new Set([...contract.matchAll(/(--dshea-[a-z0-9-]+)\s*:/g)].map(match => match[1]));
    const used = new Set([...css.matchAll(/var\((--dshea-[a-z0-9-]+)/g)].map(match => match[1]));
    assert.deepEqual([...used].filter(token => !declared.has(token)), []);
    assert.deepEqual([...declared].filter(token => !used.has(token)), []);
    assert.match(contract, /--dshea-hairline:0\.5px/);
    assert.match(contract, /--dshea-content-max:1440px/);
    assert.doesNotMatch(rest, /(?:font-size|font-weight|line-height)\s*:/);
    for (const match of css.matchAll(/(?<![-\w])font:\s*([^;}]+)/g)) assert.match(match[1], /var\(--(?:dsw|dshea)-/);
    assert.doesNotMatch(css, /(?<![-\w])font:\s*inherit/);
    // 尺寸也必须来自契约变量 —— 上面只查了排版属性，尺寸是缺口。
    // 2026-10-01 全站体检实测漏网两处：胶囊「演示」标记写死 height:20px
    // （而面板同类徽标走 --dshea-badge-h=24px）、「关闭」按钮拿 space-4 当内边距
    // （而面板同类 sm 按钮走 --dshea-control-pad-sm=10px）。两处都在后加的胶囊里，
    // 靠肉眼比对面板看不出来，是全量采集渲染尺寸才发现的。
    const ROLE = /(?:pill|badge|demo|btn|input|check|control)/;
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1].trim(), body = rule[2];
      if (!ROLE.test(selector)) continue;
      const height = body.match(/(?<![-\w])height\s*:\s*([^;}]+)/);
      if (height) {
        assert.match(height[1], /var\(--dshea-/,
          `角色类 ${selector} 的 height 必须用契约变量，实为 ${height[1].trim()}`);
      }
      if (/(?:pill|badge|demo)/.test(selector)) {
        const pad = body.match(/(?<![-\w])padding\s*:\s*([^;}]+)/);
        if (pad) {
          assert.match(pad[1], /var\(--dshea-(?:badge-pad|space-)/,
            `徽标类 ${selector} 的 padding 必须用契约变量，实为 ${pad[1].trim()}`);
        }
      }
    }
  });

  test('earthquake UI: heading/body/caption scales and final scoped family follow the shared system', () => {
    assert.match(css, /\.dshea-h1\{font:var\(--dsw-font-xl-24\)\}/);
    assert.match(css, /\.dshea-root\{\s*font:var\(--dsw-font-s-14\)/);
    assert.match(css, /\.dshea-caption\{[^}]*font:var\(--dsw-font-xxs-12\)/);
    const family = '.dshea-root,.dshea-root *,.dshea-banner,.dshea-banner *';
    const final = css.lastIndexOf(family);
    assert.ok(final > css.lastIndexOf('font:'), 'Family-only rule must follow font shorthands');
    assert.match(css.slice(final), /font-family:var\(--dsh-font-ui,var\(--dsw-font-family,system-ui\)\)/);
    assert.doesNotMatch(css, /(?:^|[}\n])\s*(?:html|body|\.cm-editor|\.monaco-editor|pre|code)[\s{,]/);
    assert.doesNotMatch(css, /Montserrat|Arial|Helvetica|#(?:[\da-f]{3,8})\b/i);
  });

  test('earthquake UI: shared semantic surfaces/radius/borders and safe overlay pair stay theme-aware', () => {
    assert.match(css, /\.dshea-card\{[^}]*var\(--dsh-border-subtle/);
    assert.match(css, /\.dshea-card\{[^}]*var\(--dsh-radius-md/);
    assert.match(css, /\.dshea-card\{[^}]*var\(--dsh-bg-surface-1/);
    // 告警胶囊底色用共享层告警红 --dsh-danger 而不是中性 surface
    // （用户 2026-10-01 明确要求"红色起警示作用"）。
    // 这里断言的是**不变量**而不是某个具体 token 名：底色必须从共享 --dsh-* 桥接到
    // 官方 --dsw-alias-* 回退，前景必须是 token（不得字面色值），且必须是胶囊。
    // 原写法把 --dsh-bg-surface-2 / --dsh-text-primary 写死，等于冻结实现细节 ——
    // 产品一改配色就被迫改测试，而不变量本身并没有因此被削弱。
    const bannerRule = css.match(/(?:^|[}\n])\.dshea-banner\{([^}]*)\}/)?.[1] ?? '';
    assert.ok(bannerRule, 'banner rule missing');
    assert.match(bannerRule, /background:var\(--dsh-[a-z0-9-]+,\s*var\(--dsw-alias-[a-z0-9-]+\)\)/,
      'banner background must bridge a shared --dsh-* token with an official --dsw-alias-* fallback');
    assert.match(bannerRule, /color:var\(--(?:dsh|dsw)-[a-z0-9-]+/,
      'banner foreground must come from a token, never a literal colour');
    // 两端必须是**显式**半高，不能再写 999px 靠浏览器按比例钳制 ——
    // 实测那套钳制在本引擎下给出的圆角明显小于半高（用户 2026-10-01
    // 「我要的是两边是两个半圆」）。断言写成"等于自己的高度变量的一半"，
    // 这样换高度胶囊自然也保持半圆，不会被改回 999px。
    assert.match(bannerRule, /border-radius:calc\(var\(--dshea-banner-h\)\s*\/\s*2\)/,
      'banner ends must be explicit half-height radii, not a 999px clamp');
    assert.match(bannerRule, /corner-shape:round/,
      'banner needs corner-shape:round, same as the panel pill');
    assert.doesNotMatch(css, /border-radius:999px/,
      'no element may rely on the 999px clamp for full rounding');
    // 面板顶部必须是**常驻**带，且按页面坐标算够「胶囊上边距 + 胶囊高 + 间距」。
    // 用户先后提过「不要遮挡任何内容」和「不要影响其他界面」，两条同时成立的唯一结构
    // 就是常驻带：不预留 → 胶囊压住头部（实测 head 重叠 13922px²、副标题 920px²）；
    // 随告警开关的预留 → 面板每次上下跳 108px。这条断言把那个结构钉住。
    assert.match(css, /\.dshea-root\{[^}]*padding:calc\(var\(--dshea-overlay-top\)\s*\+\s*var\(--dshea-banner-h\)\s*\+\s*var\(--dshea-space-4\)\)/,
      'panel needs a permanent top band sized to clear the alert capsule');
    assert.doesNotMatch(css, /dshea-root-reserved|bannerVisible \?/,
      'the top band must be permanent, not toggled per alert (that would jump the layout)');
    // 居中锚点绝不能读布局 token —— 共享主题的 --dsh-sidebar-w 在侧边栏收成轨道后
    // 仍报 252px（实测导致胶囊偏右 95px）。只允许读实时几何。
    // 注意断言必须打在 **client.js 源码**上而不是 CSS 模板上：这个读取发生在 JS 里，
    // 只扫 CSS 的话断言永远不会响（我第一版就写错了位置）。用调用形态精确匹配，
    // 这样注释里提到 token 名不会误报。
    assert.doesNotMatch(source, /getPropertyValue\(\s*['"]--dsh-sidebar-w['"]\s*\)/,
      'centering must not read layout tokens; read live geometry instead');

    // 真正的保护是"文字压在底色上读不读得清"，而不是某个 token 名。
    // 共享主题 assets/theme.css 用 !important 覆写了 DSH alias 层，且历史事故正是
    // 「只改了底、没改字」（toast-bg→浅色、toast-label 仍旧白）→ 白字压浅底不可读。
    // 所以这里对胶囊的两套配色逐一算 WCAG 对比度，低于 4.5 直接判失败。
    const themeFile = resolve(root, 'assets/theme.css');
    if (existsSync(themeFile)) {
      const theme = readFileSync(themeFile, 'utf8');
      const all = name => [...theme.matchAll(new RegExp('--' + name + ':\\s*([^;}]+)', 'g'))]
        .map(m => m[1].trim()).filter(v => /^#[0-9a-fA-F]{6}$/.test(v));
      const bgToken = bannerRule.match(/background:var\(--((?:dsh|dsw)-[a-z0-9-]+)/)?.[1];
      const fgToken = bannerRule.match(/color:var\(--((?:dsh|dsw)-[a-z0-9-]+)/)?.[1];
      const bgs = bgToken ? all(bgToken) : [];
      const fgs = fgToken ? all(fgToken) : [];
      if (bgs.length && bgs.length === fgs.length) {
        const lum = hex => {
          const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
          return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
        };
        const ratios = bgs.map((bg, i) => {
          const [a, b] = [lum(bg), lum(fgs[i])].sort((x, y) => y - x);
          return Number(((a + 0.05) / (b + 0.05)).toFixed(2));
        });
        assert.ok(ratios.every(r => r >= 4.5),
          `banner contrast ${ratios.join('/')} below WCAG AA 4.5 for ${bgToken} on ${fgToken}`);
      }
    }
    for (const selector of ['.dshea-caption', '.dshea-hint', '.dshea-kv dt', '.dshea-dim']) {
      const rule = css.match(new RegExp('(?:^|[}\\n])\\s*' + selector.replaceAll('.', '\\.').replaceAll(' ', '\\s+') + '\\{([^}]*)\\}'))?.[1];
      assert.ok(rule, `Readable non-disabled text rule missing: ${selector}`);
      assert.match(rule, /color:var\(--dsw-alias-label-secondary\)/, `${selector} must not fall back to low-contrast tertiary text`);
    }
    assert.doesNotMatch(css, /--dsw-alias-toast-/);
    assert.doesNotMatch(css, /opacity:\.(?:8|9)\b/);
    assert.match(css, /prefers-reduced-motion:reduce/);
    assert.match(css, /font-variant-numeric:tabular-nums/);
  });

  test('earthquake UI: actual-column queries, a single outer scroller and wrapping labels replace viewport assumptions', () => {
    assert.match(css, /container:dshea \/ inline-size/);
    for (const width of [480, 760, 900]) assert.ok(css.includes('@container dshea (max-width:' + width + 'px)'));
    const narrowHeader = css.match(/@container dshea \(max-width:480px\)\{((?:[^{}]|\{[^{}]*\})*)\}/)?.[1];
    assert.ok(narrowHeader, 'Narrow-column query must remain a real grouped rule');
    assert.match(narrowHeader, /\.dshea-head-text\{flex:1 1 100%;width:100%\}/);
    assert.match(narrowHeader, /\.dshea-head-actions\{flex:1 1 100%;width:100%;justify-content:flex-end\}/);
    assert.match(narrowHeader, /\.dshea-head \.dshea-caption\{width:100%;max-width:none\}/);
    assert.doesNotMatch(css, /@media[^\{]*(?:max|min)-width/);
    assert.match(css, /\.dshea-root\{[^}]*min-height:0;overflow-y:auto;overflow-x:hidden/);
    assert.doesNotMatch(css, /\.dshea-list\{[^}]*overflow/);
    assert.match(css, /\.dshea-root>\*\{flex-shrink:0;min-width:0\}/);
    assert.match(css, /\.dshea-list-key\{[^}]*overflow-wrap:anywhere/);
    assert.match(css, /button:focus-visible/);
    assert.doesNotMatch(source, /dshea-hero-single/);
  });

  test('earthquake UI: referenced tokens exist in exactly the selected runtime and shared source', context => {
    if (!presentData(root)) { context.skip('Portable Data is wholly absent (CI source checkout)'); return; }
    const selected = activeUiProfile(root);
    assert.ok(selected.runtime, 'Present Data must select a runtime; do not borrow an inactive slot');
    const official = new Set();
    for (const name of ['dsh-client-ui-theme', 'dsh-client-ui-primitives']) {
      definedTokens(resolve(selected.runtime, 'node_modules/@deepseek-ai', name), official);
    }
    assert.ok(official.has('--dsw-font-s-14'), 'Selected official body scale is missing');
    assert.ok(official.has('--dsw-font-xl-24'), 'Selected official heading scale is missing');
    const shared = new Set([...readFileSync(resolve(root, 'assets/theme.css'), 'utf8').matchAll(/(--dsh-[a-z0-9-]+)\s*:/g)].map(match => match[1]));
    const used = new Set([...css.matchAll(/var\((--(?:dsw|ds|dsh)-[a-z0-9-]+)/g)].map(match => match[1]));
    assert.ok(used.size >= 20, 'Insufficient shared/official token coverage');
    assert.deepEqual([...used].filter(token => !official.has(token) && !shared.has(token)), []);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) registerEarthquakeUiTokenTests();
