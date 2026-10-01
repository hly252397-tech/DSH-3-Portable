import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

/**
 * 2026-09-30 回归护栏：hideConnectionIndicator() 漏判 slot 宿主，把整个设置入口藏了。
 *
 * 真实事故：codex-ui 1.1.18 把 `.dcu-settings-trigger`（打开设置的按钮）和
 * `.dcu-settings-page`（设置页本体）都挂在同一个 `<div data-slot="sidebar.settings">`
 * 宿主里，而那个宿主是 `.dcu-settings-seat` 的直接子元素、DIV 标签，被原实现
 * 一并写上 `display:none !important` ⇒ 顶栏「DSH 设置」点击无反应、ESC 也关不掉。
 *
 * 这里不模拟整棵 React 树，只喂一个最小的 seat 结构，断言"该藏的藏、该留的留"：
 * 带 data-slot 的宿主（设置功能本体）、两个 portal 容器、连接指示器、STYLE/BUTTON。
 */
for (const relative of ['customizations/ui-tweaks/lib/client.js', 'Data/DSH/profiles/web/local/dsh-ui-tweaks/lib/client.js']) {
  test(`UI tweaks keeps the settings slot host visible: ${relative}`, t => {
    const file = resolve(relative)
    if (!existsSync(file)) return t.skip('Optional live Profile is not installed')

    const hidden: string[] = []
    const makeChild = (label: string, tag: string, attributes: Record<string, string> = {}) => ({
      label,
      tagName: tag,
      children: [] as unknown[],
      hasAttribute: (name: string) => Object.hasOwn(attributes, name),
      style: {
        setProperty: (name: string, value: string) => {
          if (name === 'display' && value === 'none') hidden.push(label)
        },
      },
    })

    // seat 的直接子元素，顺序与实机一致：style、slot 宿主、设置页 portal、宠物 portal、连接指示器、按钮。
    const slotHost = makeChild('slot-host', 'DIV', { 'data-slot': 'sidebar.settings' })
    const children = [
      makeChild('style', 'STYLE'),
      slotHost,
      makeChild('settings-page', 'DIV', { 'data-dcu-settings-page': '' }),
      makeChild('pet-overlay', 'DIV', { 'data-dsh-pet-overlay': '' }),
      makeChild('connection-indicator', 'SPAN'),
      makeChild('trigger-button', 'BUTTON'),
    ]
    const seat = { children }

    const document = {
      readyState: 'complete',
      documentElement: { dataset: {} },
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
      getElementById: () => null,
      createElement: () => makeChild('created', 'STYLE', {}),
      querySelector: (selector: string) => (selector === '.dcu-settings-seat' ? seat : null),
      querySelectorAll: () => [],
      addEventListener: () => {},
    }
    let plugin: { apply(ctx: unknown): void } | undefined
    const window = {
      addEventListener: () => {},
      __ModuleLoader__: { load: (registration: { factory(): { apply(): void } }) => { plugin = registration.factory() } },
    }
    vm.runInNewContext(readFileSync(file, 'utf8'), {
      window, document,
      MutationObserver: class { observe(): void {} },
      fetch: async () => ({ ok: false }),
      setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {},
    })
    assert.ok(plugin)
    plugin.apply({ effect: () => () => {} })

    assert.ok(
      hidden.includes('connection-indicator'),
      '连接状态指示器仍应被隐藏（这是本函数唯一的目的）',
    )
    for (const label of ['slot-host', 'settings-page', 'pet-overlay', 'style', 'trigger-button']) {
      assert.ok(!hidden.includes(label), `${label} 必须保持可见，却收到了 display:none`)
    }
  })

  /**
   * 2026-09-30 用户拍板：左下角侧栏设置入口不要，只要顶栏齿轮。
   * 实现是**纯 CSS 藏座位**（.dcu-settings-seat → display:none），元素留在 DOM，
   * 顶栏齿轮的代点链路（querySelector('.dcu-settings-trigger') → .click()）照常工作。
   * 这里锁三件事：藏座位的规则在、别误伤设置页本体、别误伤同页脚的用量卡。
   */
  test(`UI tweaks hides the sidebar settings seat via CSS only: ${relative}`, t => {
    const file = resolve(relative)
    if (!existsSync(file)) return t.skip('Optional live Profile is not installed')
    const source = readFileSync(file, 'utf8')

    assert.ok(
      source.includes('body .dcu-settings-seat{display:none!important}'),
      '藏座位的 CSS 规则必须在场（2026-09-30 用户决定：侧栏设置入口不要）',
    )
    assert.ok(
      !source.includes('.dcu-settings-page{display:none') && !source.includes('[data-dcu-settings-page]{display:none'),
      '设置页本体（portal 到 body）绝不能被隐藏——藏了它顶栏齿轮就点不出任何东西',
    )
    assert.ok(
      !source.includes('.dcu-footer-actions{display:none') && !source.includes('VWh0dG_triggerWrap{display:none'),
      '同页脚的用量卡（sidebar.footer.action 槽）不能被连带隐藏',
    )
    assert.ok(
      !source.includes(".dcu-settings-seat')?.remove") && !source.includes('.dcu-settings-trigger")?.remove'),
      '只能 CSS 藏、不能 JS 删节点——删了顶栏代点链路就断了',
    )
  })
}
