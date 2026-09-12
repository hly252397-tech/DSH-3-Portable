import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { capBrowserWorkspacePanelWidth, normalizeBrowserPanelBounds, resolveBrowserDownloadsDrawerHeight } from '../src/browser-panel-layout.js'

test('浏览器面板坐标保持在 DSH 内容视口内', () => {
  assert.deepEqual(
    normalizeBrowserPanelBounds({ x: 900, y: 12, width: 500, height: 700 }, 1360, 860),
    { x: 900, y: 12, width: 460, height: 700 },
  )
})

test('浏览器面板拒绝非有限数、标题栏外小矩形和伪数组', () => {
  assert.equal(normalizeBrowserPanelBounds({ x: 0, y: 0, width: Number.NaN, height: 700 }, 1360, 860), undefined)
  assert.equal(normalizeBrowserPanelBounds({ x: -100, y: -100, width: 120, height: 120 }, 1360, 860), undefined)
  assert.equal(normalizeBrowserPanelBounds([0, 0, 500, 700], 1360, 860), undefined)
})

test('浏览器卡片 CSS 坐标按网页缩放转换成 DIP，不受屏幕 DPI 二次影响', () => {
  assert.deepEqual(
    normalizeBrowserPanelBounds({ x: 936.25, y: 35, width: 763.75, height: 1035 }, 1360, 856, 0.8),
    { x: 749, y: 28, width: 611, height: 828 },
  )
  assert.deepEqual(
    normalizeBrowserPanelBounds({ x: 599.2, y: 35.2, width: 488.8, height: 649.6 }, 1360, 856, 1.25),
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
  // 用户把比例拖到旧上限 0.75：2560 视口下面板最多 1660（= 2560 - 900 对话保底余量）
  assert.equal(capBrowserWorkspacePanelWidth(2560, Math.round(2560 * 0.75)), 1660)
  // 窄窗：1450 视口 → 面板最多 550，对话列保住 ~600
  assert.equal(capBrowserWorkspacePanelWidth(1450, 1200), 550)
  // 比例本来不大时不加限制
  assert.equal(capBrowserWorkspacePanelWidth(2560, 900), 900)
  // 面板自身最小宽度 280 兜底
  assert.equal(capBrowserWorkspacePanelWidth(900, 800), 280)
})
