import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { MAXIMUM_PANEL_WIDTH_MARGIN, MINIMUM_PANEL_VIEWPORT_CSS, browserPanelMaxWidthCss, capBrowserWorkspacePanelWidth, normalizeBrowserPanelBounds, resolveBrowserDownloadsDrawerHeight, resolveBrowserPageTop, shouldHideBrowserPanel, shouldShowPageTabBar } from '../src/browser-panel-layout.js'

test('单网页时收起顶部标签条：判定与原生视图偏移同源', async () => {
  // 用户 2026-09-15 截图指出「只有浏览器有」的问题：面板顶部叠了 DSH 标签条 + 网页标签条 +
  // 导航条三层，只开一个网页时中间那层纯冗余（白吃约 40px）。≥2 个网页行为完全不变。
  assert.equal(shouldShowPageTabBar(0), false)
  assert.equal(shouldShowPageTabBar(1), false)
  assert.equal(shouldShowPageTabBar(2), true)
  assert.equal(shouldShowPageTabBar(5), true)
  assert.equal(shouldShowPageTabBar(Number.NaN), true) // 坏数据保持旧行为（显示）
  // 几何：标签条 40 + 导航条 42 —— 收起时必须只留导航条，否则原生视图错位 40px
  assert.equal(resolveBrowserPageTop(1, 40, 42), 42)
  assert.equal(resolveBrowserPageTop(2, 40, 42), 82)
  // 页面侧只认外壳下发的判定（单一来源），并有对应隐藏规则
  const panel = await readFile(join(process.cwd(), 'assets/browser-panel.html'), 'utf8')
  assert.match(panel, /browser\.pageTabBarVisible===false/)
  assert.match(panel, /\.browser\.single-page-tab \.browser-tabs\{display:none\}/)
})

test('浏览器面板坐标保持在 DSH 内容视口内', () => {
  assert.deepEqual(
    normalizeBrowserPanelBounds({ x: 900, y: 12, width: 500, height: 700 }, 1360, 860),
    { x: 900, y: 12, width: 320, height: 700 },
  )
})

test('窄视口下面板该收手：外壳与页面隐藏阈值共用同一把尺子', async () => {
  // 2026-09-14 实机第二症状「缩小后又出现了」：页面在 CSS 视口 < 1100px 时把面板
  // `display:none`（theme.css 的 @media），外壳不知情、仍按最小宽度 280 画原生视图
  // ⇒「一条 280px 浏览器 + 右边一片白」。判据必须与页面同坐标系（CSS px = DIP ÷ 缩放）。
  assert.equal(shouldHideBrowserPanel(1088, 1), true)
  assert.equal(shouldHideBrowserPanel(1360, 1), false)
  assert.equal(shouldHideBrowserPanel(1088 * 0.8, 0.8), true)
  assert.equal(shouldHideBrowserPanel(1375, 1.25), false)
  // 坏数据不隐藏面板（宁可不收手，也不要因坏输入把面板关掉）
  assert.equal(shouldHideBrowserPanel(0, 1), false)
  assert.equal(shouldHideBrowserPanel(Number.NaN, 1), false)
  assert.equal(shouldHideBrowserPanel(1088, 0), false)

  const css = await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')
  const media = /@media \(max-width: (\d+)px\) \{\s*body \.nArs4W_panel \{\s*display: none/.exec(css)
  assert.ok(media, 'theme.css 必须保留窄视口隐藏面板的媒体查询')
  // 跨模块一致性：外壳常量必须等于页面的媒体查询阈值，否则两侧又会各收各的手
  assert.equal(Number(media[1]), MINIMUM_PANEL_VIEWPORT_CSS)
})

test('面板宽度上限折成 CSS px：页面卡片与原生视图共用同一把尺子', () => {
  // 外壳算出的是 DIP，页面吃的是 CSS px —— 必须按网页缩放折算，否则缩放下卡片与视图
  // 会差出上百像素（2026-09-14 实机截图：右侧露出卡片白底）。
  assert.equal(browserPanelMaxWidthCss(1320, 1), 1320)
  assert.equal(browserPanelMaxWidthCss(1320, 0.8), 1650)
  assert.equal(browserPanelMaxWidthCss(1320, 1.25), 1056)
  assert.equal(browserPanelMaxWidthCss(120, 1), 280)
  assert.equal(browserPanelMaxWidthCss(0, 1), 0)
  assert.equal(browserPanelMaxWidthCss(1320, 0), 0)
  assert.equal(browserPanelMaxWidthCss(Number.NaN, 1), 0)
})

test('外壳与页面共用同一套面板宽度策略，不再各写一个常量', async () => {
  const css = await readFile(join(process.cwd(), 'assets/theme.css'), 'utf8')
  const start = css.indexOf('body .nArs4W_panel {')
  assert.notEqual(start, -1, 'theme.css 必须保留工作台面板宽度钳制')
  const rule = css.slice(start, css.indexOf('}', start) + 1)
  assert.match(rule, /var\(--dsh-browser-panel-max-width/)
  const fallback = /calc\(100vw - (\d+)px\)/.exec(rule)?.[1]
  assert.ok(fallback, 'theme.css 的兜底必须写成 calc(100vw - Npx)')
  // 这才是本轮修的那个 bug：两侧曾分别写 1040 与 900，且一个是 CSS px、一个是 DIP。
  assert.equal(Number(fallback), MAXIMUM_PANEL_WIDTH_MARGIN)
  assert.equal(capBrowserWorkspacePanelWidth(MAXIMUM_PANEL_WIDTH_MARGIN + 400, 99999), 400)
})

test('浏览器面板拒绝非有限数、标题栏外小矩形和伪数组', () => {
  assert.equal(normalizeBrowserPanelBounds({ x: 0, y: 0, width: Number.NaN, height: 700 }, 1360, 860), undefined)
  assert.equal(normalizeBrowserPanelBounds({ x: -100, y: -100, width: 120, height: 120 }, 1360, 860), undefined)
  assert.equal(normalizeBrowserPanelBounds([0, 0, 500, 700], 1360, 860), undefined)
})

test('浏览器卡片 CSS 坐标按网页缩放转换成 DIP，不受屏幕 DPI 二次影响', () => {
  assert.deepEqual(
    normalizeBrowserPanelBounds({ x: 936.25, y: 35, width: 763.75, height: 1035 }, 1920, 856, 0.8),
    { x: 749, y: 28, width: 611, height: 828 },
  )
  assert.deepEqual(
    normalizeBrowserPanelBounds({ x: 599.2, y: 35.2, width: 488.8, height: 649.6 }, 1920, 856, 1.25),
    { x: 749, y: 44, width: 611, height: 812 },
  )
  assert.equal(normalizeBrowserPanelBounds({ x: 0, y: 0, width: 500, height: 700 }, 1360, 856, 0.5), undefined)
  assert.equal(normalizeBrowserPanelBounds({ x: 0, y: 0, width: 500, height: 700 }, 1360, 856, NaN), undefined)
})

test('下载抽屉空状态保持紧凑并按记录数有限增长', () => {
  assert.equal(resolveBrowserDownloadsDrawerHeight(false, 0, 900), 0)
  assert.equal(resolveBrowserDownloadsDrawerHeight(true, 0, 900), 112)
  assert.equal(resolveBrowserDownloadsDrawerHeight(true, 1, 900), 110)
  assert.equal(resolveBrowserDownloadsDrawerHeight(true, 3, 900), 214)
  assert.equal(resolveBrowserDownloadsDrawerHeight(true, 10, 900), 248)
  assert.equal(resolveBrowserDownloadsDrawerHeight(true, 10, 240), 86)
})

test('主进程工具条高度常量与浏览器面板样式一致', async () => {
  const [panel, main] = await Promise.all([
    readFile(new URL('../../assets/browser-panel.html', import.meta.url), 'utf8'),
    readFile(new URL('../../src/main.ts', import.meta.url), 'utf8'),
  ])
  const cssHeight = (selector: string) => {
    const rule = panel.match(new RegExp(`\\${selector}\\{[^}]*?height:(\\d+)px`))
    assert.ok(rule, `样式里缺少 ${selector} 的 height`)
    return Number(rule[1])
  }
  const constant = (name: string) => {
    const declaration = main.match(new RegExp(`const ${name} = (\\d+)`))
    assert.ok(declaration, `src/main.ts 缺少 ${name}`)
    return Number(declaration[1])
  }
  assert.equal(constant('BROWSER_TABS_BAR_HEIGHT'), cssHeight('.browser-tabs'))
  assert.equal(constant('BROWSER_NAV_BAR_HEIGHT'), cssHeight('.browser-nav'))
})

test('顶部外壳不再含浏览器开关按钮，回归保护', async () => {
  const shell = await readFile(new URL('../../assets/shell.html', import.meta.url), 'utf8')
  assert.equal(/id=["']browser-toggle-btn["']/.test(shell), false, '顶部 .bar 不应再含 browser-toggle-btn，仅侧栏浏览器卡片入口保留')
  assert.equal(/data-action=["']browser-toggle["']/.test(shell), false, '顶部 .bar 不应再触发 browser-toggle 动作')
  assert.equal(/class=["']bar["'][^>]*\sdata-action=["']browser-toggle["']/.test(shell), false)
})

test('浏览器工作区 CSS 修复仍在：page-snapshot 隐藏选择器特异性高于基础规则', async () => {
  const css = await readFile(new URL('../../assets/browser-workspace.css', import.meta.url), 'utf8')
  const highRule = /\.browser\s+img\.browser-page-snapshot\[hidden\]\s*\{\s*display\s*:\s*none\s*;?\s*\}/
  assert.match(css, highRule, '必须保留 .browser img.browser-page-snapshot[hidden]{display:none} 规则以压过 .browser img.browser-page-snapshot')
})

test('顶部外壳分隔线改用 ::after，避免被 WCO 覆盖在右侧', async () => {
  const shell = await readFile(new URL('../../assets/shell.html', import.meta.url), 'utf8')
  const barRule = shell.match(/\.bar\{([^}]*)\}/)
  assert.ok(barRule, 'shell.html 缺少 .bar 样式块')
  const barBody = barRule![1]
  assert.match(barBody, /position\s*:\s*relative/, '.bar 必须 position:relative 以锚定 ::after 分隔线')
  assert.equal(/border-bottom\s*:/.test(barBody), false, '.bar 不应再用 border-bottom，避免与 ::after 重复或被 WCO 覆盖')
  const afterRule = shell.match(/\.bar::after\{([^}]*)\}/)
  assert.ok(afterRule, 'shell.html 缺少 .bar::after 伪元素')
  const afterBody = afterRule![1]
  assert.match(afterBody, /position\s*:\s*absolute/, '.bar::after 必须绝对定位以挂在 bar 底部')
  assert.match(afterBody, /top\s*:\s*100%/, '.bar::after 必须挂在 .bar 底沿，刚好绕过 WCO')
  assert.match(afterBody, /border-top\s*:\s*1px\s+solid\s+var\(--chrome-border\)/, '.bar::after 必须有 1px 边线，颜色与原 --chrome-border 一致')
})

test('工作台面板宽度钳制：比例再大也不超过视口余量（对话列保底）', () => {
  // 2026-09-14 统一到页面侧那条策略（依据**官方内容下限 680px**，见 assets/theme.css 与
  // workbench-panel-clamp.test.ts）：上限 = 视口 − MAXIMUM_PANEL_WIDTH_MARGIN(1040)。
  // 此前外壳写 900（按 ~560 保底）、页面写 1040（按官方 680），**两侧各写一套且单位还不同**
  // （DIP vs CSS px）——缩放下会差出上百像素，表现为右侧露出卡片白底或视图压住对话列。
  // 用户把比例拖到 0.75：2560 视口下面板最多 1520（= 2560 − 1040）
  assert.equal(capBrowserWorkspacePanelWidth(2560, Math.round(2560 * 0.75)), 2560 - MAXIMUM_PANEL_WIDTH_MARGIN)
  // 窄窗：1450 视口 → 面板最多 410，对话列保住官方下限
  assert.equal(capBrowserWorkspacePanelWidth(1450, 1200), 1450 - MAXIMUM_PANEL_WIDTH_MARGIN)
  // 比例本来不大时不加限制
  assert.equal(capBrowserWorkspacePanelWidth(2560, 900), 900)
  // 面板自身最小宽度 280 兜底
  assert.equal(capBrowserWorkspacePanelWidth(900, 800), 280)
})
