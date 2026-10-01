import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/**
 * 设置导航分组镜像的结构防回退（2026-09-29）。
 *
 * 背景：官方 codex-ui 的设置导航 DOM 是
 *   nav.dcu-settings-nav > button.dcu-settings-back
 *                      + label.dcu-settings-search > input
 *                      + div.dcu-settings-groups > section.dcu-settings-group
 *                            > h2.dcu-settings-group-label + button.dcu-settings-link
 * 第一版镜像按「按钮是 nav 直接子节点」取值，拿到 0 个入口、整段静默放弃——用户界面上
 * 完全看不出失败。本文件把真实结构写成 fixture 断言取值方式，并钉住两条易退化的行为：
 *   ① 入口取值必须是 descendant 查询（错法会让分组永远建不出来）；
 *   ② 搜索过滤的可见性判据必须是「原件是否在 DOM」，不得用 offsetParent
 *     （原件容器被我们 CSS 隐藏，offsetParent 恒为 null ⇒ 全部项被判不可见）。
 */

const SOURCE = readFileSync('customizations/ui-tweaks/lib/client.js', 'utf8')

function extractFunction(name: string): string {
  const start = SOURCE.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `未找到函数 ${name}`)
  const end = SOURCE.indexOf('\n    }', start)
  assert.ok(end > start, `函数 ${name} 未正常闭合`)
  // 剥掉行注释：本文件要断言的是「代码怎么写」，而函数里恰好写着「绝不能用 offsetParent」
  // 这类说明性注释，直接全文匹配会把注释当成违规代码。
  return SOURCE.slice(start, end).replace(/^\s*\/\/.*$/gm, '')
}

test('入口取值走 descendant 查询（nav 直接子节点假设会让分组永远建不出来）', () => {
  const body = extractFunction('installSettingsNavGroups')
  assert.match(body, /querySelectorAll\('\.dcu-settings-groups button, button\.dcu-settings-link'\)/,
    '必须按 .dcu-settings-groups 内 descendant 查入口；官方按钮不是 nav 的直接子节点')
  assert.doesNotMatch(body, /\[\.\.\.nav\.children\]\.filter/, '不得再用 nav.children 直接子节点过滤取入口')
})

test('搜索过滤可见性判据是 DOM 存在性，不得用 offsetParent', () => {
  const body = extractFunction('installSettingsNavGroups')
  assert.doesNotMatch(body, /offsetParent/, '原件容器被本插件 CSS 隐藏，offsetParent 恒 null，会把全部项判为不可见')
  assert.match(body, /findOriginalByKey\(nav, item\.dataset\.dshNavKey, Number\(item\.dataset\.dshNavOrdinal\)\)/,
    '必须按 key/同名序号回查当前 DOM 里的原件')
})

test('点击转发按 key 现查，不闭包持有原节点', () => {
  const body = extractFunction('installSettingsNavGroups')
  assert.match(body, /dataset\.dshNavKey/, '镜像按钮须记录原件 key')
  assert.doesNotMatch(body, /original\.click\(\)/, '不得直接调用建镜像时捕获的原节点（React 重建后即死按钮）')
})

test('搜索过滤时空组标题一并收起', () => {
  const body = extractFunction('installSettingsNavGroups')
  assert.match(body, /group\.hidden = \[\.\.\.group\.querySelectorAll\('\.dsh-sg-item'\)\]\.every/, '空组必须连标题一起隐藏')
})

test('分组表覆盖六大类，未识别项有兜底组', () => {
  for (const title of ['基础', '插件与扩展', '智能体', '界面定制', '自动化与消息', '会话记录', '其他']) {
    assert.ok(SOURCE.includes(`'${title}'`), `分组表缺少「${title}」`)
  }
})

/**
 * 导航图标：19 项各一枚、互不相同（2026-09-29 用户实证「图标有一样的而且颜色深浅还不一样」）。
 *
 * 官方 sectionIcon() 是「若干条 id 正则 + 一个 Box 兜底」，入口一多必然撞车：
 * /plugin/ 同时命中「内置插件」和「插件配置」，/connector|mcp/ 同时命中「连接器」和
 * 「外部智能体接入」，没被命中的全部掉进 Box 兜底。颜色不一是另一个成因——better-sidebar
 * 那一行用 ::before + currentColor 自绘，其余行是克隆来的官方内联 <svg>，颜色各随各的 CSS。
 *
 * 本文件钉住三件事：分组表每一项都有图标规则、图标两两不同、颜色统一走 currentColor。
 */
function navMembers(): string[] {
  const start = SOURCE.indexOf('const SETTINGS_NAV_GROUPS = [')
  assert.ok(start >= 0, '未找到 SETTINGS_NAV_GROUPS')
  const end = SOURCE.indexOf('];', start)
  assert.ok(end > start, 'SETTINGS_NAV_GROUPS 未正常闭合')
  const literal = SOURCE.slice(SOURCE.indexOf('[', start), end + 1)
  // eslint-disable-next-line no-new-func
  const groups = new Function(`return ${literal}`)() as [string, string[]][]
  // 必须按 navKey 形态（去空白）比对：镜像按钮上的 data-dsh-nav-key 就是 navKey() 的结果。
  // 2026-09-29 实测踩过——图标选择器用带空格的原名，「Agent 预设」这类入口一条都没匹配上，
  // 界面上就是四个空格；当时这条断言还没写，所以没拦住。
  return groups.flatMap(([, members]) => members).map((m) => m.replace(/\s+/g, ''))
}

/** Executed DOM contract, not a text-only grouping assertion. The fixture keeps the real
 * nav > back + label > input + groups > section > original buttons hierarchy. It intentionally
 * gives originals no section-id attribute: Codex UI does not expose one on its nav buttons.
 * Real Profile/Loader and pixel/IPC acceptance remain separate gates owned by the root task. */
class NavElement {
  readonly children: NavElement[] = []
  parentElement: NavElement | null = null
  className = ''
  id = ''
  type = ''
  hidden = false
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  private text = ''
  private html = ''
  private readonly listeners = new Map<string, (() => void)[]>()
  readonly tagName: string
  constructor(tag: string) { this.tagName = tag.toUpperCase() }
  get classList(): {
    contains(name: string): boolean,
    add(name: string): void,
    remove(name: string): void,
    toggle(name: string, force: boolean): void,
  } {
    const has = (name: string) => this.className.split(/\s+/).includes(name)
    return {
      contains: has,
      add: (name: string) => { if (!has(name)) this.className = `${this.className} ${name}`.trim() },
      remove: (name: string) => { this.className = this.className.split(/\s+/).filter(part => part !== name).join(' ') },
      toggle: (name: string, force: boolean) => {
        if (force) this.classList.add(name)
        else this.classList.remove(name)
      },
    }
  }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join('') }
  set textContent(value: string) { this.text = value; this.html = ''; this.children.splice(0) }
  get innerHTML(): string { return this.html || this.text }
  set innerHTML(value: string) { this.html = value; this.text = value.replace(/<[^>]*>/g, ''); this.children.splice(0) }
  appendChild(child: NavElement): NavElement {
    child.remove()
    child.parentElement = this
    this.children.push(child)
    return child
  }
  remove(): void {
    const siblings = this.parentElement?.children
    if (siblings) siblings.splice(siblings.indexOf(this), 1)
    this.parentElement = null
  }
  insertAdjacentElement(position: string, child: NavElement): void {
    assert.equal(position, 'afterend')
    assert.ok(this.parentElement)
    child.remove()
    child.parentElement = this.parentElement
    this.parentElement.children.splice(this.parentElement.children.indexOf(this) + 1, 0, child)
  }
  closest(selector: string): NavElement | null {
    for (let current: NavElement | null = this; current; current = current.parentElement) {
      if (current.matches(selector)) return current
    }
    return null
  }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const value = part.trim()
      if (value === '.dcu-settings-groups button') return this.tagName === 'BUTTON' && this.parentElement?.closest('.dcu-settings-groups') !== null
      if (value.startsWith('#')) return this.id === value.slice(1)
      if (value.startsWith('.')) return this.classList.contains(value.slice(1))
      if (value === '[aria-current]' || value === '[data-active]') return this.attributes.has(value.slice(1, -1))
      if (value === '[data-state="active"]') return this.attributes.get('data-state') === 'active'
      if (value === '[role="searchbox"]') return this.attributes.get('role') === 'searchbox'
      if (value === 'button.dcu-settings-link') return this.tagName === 'BUTTON' && this.classList.contains('dcu-settings-link')
      return this.tagName.toLowerCase() === value
    })
  }
  querySelectorAll(selector: string): NavElement[] {
    const descendants = this.children.flatMap(child => [child, ...child.allDescendants()])
    return descendants.filter(child => child.matches(selector))
  }
  private allDescendants(): NavElement[] { return this.children.flatMap(child => [child, ...child.allDescendants()]) }
  querySelector(selector: string): NavElement | null { return this.querySelectorAll(selector)[0] ?? null }
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }
  click(): void { for (const listener of this.listeners.get('click') ?? []) listener() }
}

type SectionFixture = { id: string, label: string }
const general = { id: 'general', label: '常规' }
const legacy = { id: 'desktop-settings', label: '桌面设置' }
const notifications = { id: 'desktop-notifications', label: '通知' }
const updates = { id: 'desktop-updates', label: '更新' }
const unknown = { id: 'unknown-plugin', label: '未知插件' }

function navigationFixture(initial: SectionFixture[], registry: 'present' | 'absent' | 'throws' = 'present') {
  let entries = initial
  let nav: NavElement
  let nativeGroup: NavElement
  let renderVersion = 0
  let mounted = true
  let contextSequence = 0
  const clicks: string[] = []
  const registryReads: number[] = []
  const timers = new Map<number, () => void>()
  let timerSequence = 0
  const disposers: (() => void)[] = []
  function newNav(): void {
    nav = new NavElement('nav')
    nav.className = 'dcu-settings-nav'
    const back = nav.appendChild(new NavElement('button'))
    back.className = 'dcu-settings-back'
    back.textContent = '返回应用'
    const search = nav.appendChild(new NavElement('label'))
    search.className = 'dcu-settings-search'
    search.appendChild(new NavElement('input'))
    const groups = nav.appendChild(new NavElement('div'))
    groups.className = 'dcu-settings-groups'
    nativeGroup = groups.appendChild(new NavElement('section'))
    nativeGroup.className = 'dcu-settings-group'
  }
  function render(ids = entries.map(entry => entry.id)): void {
    for (const child of [...nativeGroup.children]) child.remove()
    const heading = nativeGroup.appendChild(new NavElement('h2'))
    heading.className = 'dcu-settings-group-label'
    heading.textContent = '集成'
    const version = ++renderVersion
    for (const entry of entries.filter(entry => ids.includes(entry.id))) {
      const button = nativeGroup.appendChild(new NavElement('button'))
      button.className = 'dcu-settings-link'
      button.innerHTML = `<svg></svg><span>${entry.label}</span>`
      button.addEventListener('click', () => {
        clicks.push(`${entry.id}:${version}`)
        for (const sibling of nativeGroup.children) sibling.attributes.delete('aria-current')
        button.attributes.set('aria-current', 'page')
      })
    }
  }
  newNav()
  render()
  const document = {
    createElement: (tag: string) => new NavElement(tag),
    querySelector: (selector: string) => !mounted ? null : selector === '.dcu-settings-nav, nav[aria-label="设置"]' ? nav : nav.querySelector(selector),
  }
  const newContext = () => {
    const contextId = ++contextSequence
    const effect = (setup: () => (() => void), label: string) => {
      assert.equal(label, 'dsh-ui-tweaks: settings navigation')
      const dispose = setup()
      disposers.push(dispose)
      return dispose
    }
    return registry === 'absent' ? { effect } : { effect, slots: { entriesOfSlot: (key: string) => {
      assert.equal(key, 'settings.section')
      registryReads.push(contextId)
      if (registry === 'throws') throw new Error('registry unavailable')
      return entries.map(entry => ({ options: { id: entry.id, label: () => entry.label } }))
    } } }
  }
  const start = SOURCE.indexOf('const SETTINGS_NAV_GROUPS = [')
  const end = SOURCE.indexOf('];', start)
  const groups = vm.runInNewContext(SOURCE.slice(start, end + 2) + '\nSETTINGS_NAV_GROUPS;') as [string, string[]][]
  const window = {}
  const install = () => vm.runInNewContext(`(${extractFunction('installSettingsNavGroups')}\n})(ctx)`, {
    ctx: newContext(), document, window, SETTINGS_NAV_GROUPS: groups,
    navKey: (value: unknown) => String(value || '').replace(/\s+/g, ''),
    setInterval: (tick: () => void, delay: number) => {
      assert.equal(delay, 800)
      const id = ++timerSequence
      timers.set(id, tick)
      return id
    },
    clearInterval: (id: number) => { assert.ok(timers.delete(id), 'only the owned live timer may be cleared') },
  })
  install()
  const tick = () => { for (const timer of [...timers.values()]) timer() }
  const items = () => nav.querySelectorAll('.dsh-sg-item').filter(item => !item.hidden && !item.parentElement?.hidden)
  return {
    clicks, tick, render, items, registryReads,
    timerCount: () => timers.size,
    dispose: () => { const dispose = disposers.at(-1); assert.ok(dispose); dispose() },
    getDisposer: () => { const dispose = disposers.at(-1); assert.ok(dispose); return dispose },
    reapply: install,
    nav: () => nav,
    originalButtons: () => nativeGroup.querySelectorAll('button.dcu-settings-link'),
    version: () => renderVersion,
    groupItems: (title: string) => nav.querySelectorAll('.dsh-sg-group')
      .filter(group => !group.hidden && group.children[0]?.textContent === title)
      .flatMap(group => group.querySelectorAll('.dsh-sg-item').filter(item => !item.hidden).map(item => item.textContent)),
    setEntries: (next: SectionFixture[]) => { entries = next; render() },
    replaceNav: () => { newNav(); render() },
    closeNav: () => { mounted = false },
    reopenNav: () => { newNav(); render(); mounted = true },
    click: (label: string, ordinal = 0) => {
      const button = items().filter(item => item.textContent === label)[ordinal]
      assert.ok(button, `mirror missing: ${label}/${ordinal}`)
      button.click()
    },
  }
}

test('executed navigation: legacy host keeps its sole real desktop entry and unknown routes', () => {
  const fixture = navigationFixture([general, legacy, unknown])
  assert.deepEqual(fixture.groupItems('基础'), ['常规'])
  assert.deepEqual(fixture.groupItems('其他'), ['桌面设置', '未知插件'])
  fixture.click('桌面设置')
  assert.deepEqual(fixture.clicks, ['desktop-settings:1'])
  assert.ok(fixture.items().find(item => item.textContent === '桌面设置')?.classList.contains('dsh-on'))
  assert.equal(fixture.originalButtons().length, 3, 'only mirror changes; native buttons survive')
})

test('executed navigation: new host groups real notifications and updates without synthetic forwarding', () => {
  const fixture = navigationFixture([general, notifications, updates, unknown])
  assert.deepEqual(fixture.groupItems('基础'), ['常规', '更新'])
  assert.deepEqual(fixture.groupItems('自动化与消息'), ['通知'])
  assert.deepEqual(fixture.groupItems('其他'), ['未知插件'])
  fixture.click('通知')
  fixture.click('更新')
  assert.deepEqual(fixture.clicks, ['desktop-notifications:1', 'desktop-updates:1'])
  assert.ok(!fixture.items().some(item => item.textContent === '桌面设置'))
})

test('executed navigation: mixed host retires only the known monolith after both split sections exist', () => {
  const fixture = navigationFixture([general, legacy, notifications, updates, unknown])
  assert.deepEqual(fixture.groupItems('基础'), ['常规', '更新'])
  assert.deepEqual(fixture.groupItems('自动化与消息'), ['通知'])
  assert.deepEqual(fixture.groupItems('其他'), ['未知插件'])
  assert.equal(fixture.originalButtons().length, 5, 'retirement never removes native/React nodes')
  const back = fixture.nav().children.find(child => child.className.includes('dcu-settings-back'))
  assert.ok(back?.classList.contains('dsh-nav-keep'))
  assert.equal(fixture.nav().querySelector('input')?.parentElement?.parentElement, fixture.nav())
})

test('executed navigation: searches do not revive retired desktop settings and clearing search restores routes', () => {
  const fixture = navigationFixture([general, legacy, notifications, updates, unknown])
  fixture.render(['desktop-settings', 'unknown-plugin'])
  fixture.tick()
  assert.deepEqual(fixture.groupItems('其他'), ['未知插件'])
  assert.ok(!fixture.items().some(item => item.textContent === '桌面设置'))
  assert.deepEqual(fixture.groupItems('基础'), [])
  fixture.render(['desktop-notifications'])
  fixture.tick()
  assert.deepEqual(fixture.groupItems('自动化与消息'), ['通知'])
  fixture.click('通知')
  assert.deepEqual(fixture.clicks, ['desktop-notifications:3'])
  fixture.render([])
  fixture.tick()
  assert.deepEqual(fixture.items(), [])
  assert.ok(!fixture.nav().classList.contains('dsh-grouped'), 'empty rendering cannot leave a broken hidden original nav')
  fixture.render()
  fixture.tick()
  assert.deepEqual(fixture.groupItems('基础'), ['常规', '更新'])
  assert.deepEqual(fixture.groupItems('其他'), ['未知插件'])
})

test('executed navigation: React button rebuild, whole-nav remount and late plugin registration stay clickable', () => {
  const fixture = navigationFixture([general, notifications, updates])
  const existingMirror = fixture.items().find(item => item.textContent === '更新')
  assert.ok(existingMirror)
  fixture.render()
  existingMirror.click()
  assert.deepEqual(fixture.clicks, ['desktop-updates:2'], 'click must resolve the fresh original without waiting for poll')
  fixture.setEntries([general, notifications, updates, unknown])
  fixture.tick()
  fixture.click('未知插件')
  fixture.replaceNav()
  fixture.tick()
  fixture.click('通知')
  assert.deepEqual(fixture.clicks, ['desktop-updates:2', 'unknown-plugin:3', 'desktop-notifications:4'])
  assert.deepEqual(fixture.groupItems('其他'), ['未知插件'])
})

test('executed navigation: same-label unknown plugins are not retired or sent to the first matching route', () => {
  const unrelated = { id: 'unrelated-plugin', label: '桌面设置' }
  const onlyUnrelated = navigationFixture([general, notifications, updates, unrelated])
  onlyUnrelated.click('桌面设置')
  assert.deepEqual(onlyUnrelated.clicks, ['unrelated-plugin:1'])
  const duplicate = navigationFixture([general, legacy, notifications, updates, unrelated])
  assert.deepEqual(duplicate.groupItems('其他'), ['桌面设置', '桌面设置'])
  duplicate.click('桌面设置', 0)
  duplicate.click('桌面设置', 1)
  assert.deepEqual(duplicate.clicks, ['desktop-settings:1', 'unrelated-plugin:1'])
  duplicate.render()
  duplicate.click('桌面设置', 1)
  assert.equal(duplicate.clicks.at(-1), 'unrelated-plugin:2')
})

test('executed navigation: partial/missing registry preserves fallback; actual slot unload restores it', () => {
  const fixture = navigationFixture([general, legacy, notifications])
  assert.deepEqual(fixture.groupItems('其他'), ['桌面设置'])
  fixture.setEntries([general, legacy, notifications, updates])
  fixture.tick()
  assert.deepEqual(fixture.groupItems('其他'), [])
  fixture.setEntries([general, legacy, notifications])
  fixture.tick()
  fixture.click('桌面设置')
  assert.deepEqual(fixture.clicks, ['desktop-settings:3'])
  for (const registry of ['absent', 'throws'] as const) {
    const unavailable = navigationFixture([general, legacy, notifications, updates], registry)
    unavailable.click('桌面设置')
    assert.deepEqual(unavailable.clicks, ['desktop-settings:1'])
  }
})

test('executed navigation lifecycle: closing settings releases its mirror and reopening builds a fresh one', () => {
  const fixture = navigationFixture([general, notifications, updates, unknown])
  const closedNav = fixture.nav()
  fixture.closeNav()
  fixture.tick()
  assert.equal(closedNav.querySelector('#dsh-settings-groups'), null)
  assert.ok(!closedNav.classList.contains('dsh-grouped'))
  assert.equal(fixture.timerCount(), 1, 'plugin stays mounted while just the settings page is closed')
  fixture.reopenNav()
  fixture.tick()
  assert.deepEqual(fixture.groupItems('基础'), ['常规', '更新'])
  fixture.click('未知插件')
  assert.deepEqual(fixture.clicks, ['unknown-plugin:2'])
  fixture.dispose()
  assert.equal(fixture.timerCount(), 0)
})

test('executed navigation lifecycle: dispose restores originals and remount uses the new slots context only', () => {
  const fixture = navigationFixture([general, legacy, unknown])
  const oldNav = fixture.nav()
  const oldMirror = fixture.items().find(item => item.textContent === '桌面设置')
  assert.ok(oldMirror)
  const oldDispose = fixture.getDisposer()
  const originals = fixture.originalButtons()
  oldNav.classList.add('another-plugin-marker')
  assert.equal(fixture.timerCount(), 1)
  fixture.dispose()
  assert.equal(fixture.timerCount(), 0)
  assert.equal(oldNav.querySelector('#dsh-settings-groups'), null)
  assert.ok(!oldNav.classList.contains('dsh-grouped'))
  assert.ok(oldNav.classList.contains('another-plugin-marker'))
  assert.ok(!oldNav.children[0]?.classList.contains('dsh-nav-keep'))
  assert.deepEqual(fixture.originalButtons(), originals, 'disposal must not remove or reconstruct originals')
  oldMirror.click()
  assert.deepEqual(fixture.clicks, [], 'detached old mirror cannot dispatch after disposal')
  fixture.setEntries([general, legacy, notifications, updates, unknown])
  fixture.registryReads.splice(0)
  fixture.reapply()
  assert.equal(fixture.timerCount(), 1)
  assert.deepEqual(fixture.groupItems('基础'), ['常规', '更新'])
  assert.deepEqual(fixture.groupItems('其他'), ['未知插件'])
  fixture.click('通知')
  assert.deepEqual(fixture.clicks, ['desktop-notifications:2'])
  assert.ok(fixture.registryReads.length > 0)
  assert.ok(fixture.registryReads.every(contextId => contextId === 2), 'disposed ctx must not read or authorize slots')
  oldDispose()
  assert.equal(fixture.timerCount(), 1, 'late repeated old cleanup cannot clear the new timer/token')
  fixture.dispose()
  assert.equal(fixture.timerCount(), 0)
})

test('executed navigation lifecycle: React removing only the mirror does not transfer original-class ownership', () => {
  const fixture = navigationFixture([general, notifications, updates, unknown])
  const nav = fixture.nav()
  const removed = nav.querySelector('#dsh-settings-groups')
  assert.ok(removed)
  removed.remove()
  assert.ok(nav.classList.contains('dsh-grouped'), 'fixture reproduces an independently removed mirror')
  fixture.tick()
  const rebuilt = nav.querySelector('#dsh-settings-groups')
  assert.ok(rebuilt)
  assert.notEqual(rebuilt, removed)
  fixture.click('更新')
  assert.deepEqual(fixture.clicks, ['desktop-updates:1'])
  fixture.dispose()
  assert.equal(nav.querySelector('#dsh-settings-groups'), null)
  assert.ok(!nav.classList.contains('dsh-grouped'), 'prior ownership must survive a same-nav mirror rebuild')
  assert.equal(fixture.originalButtons().length, 4)
  assert.equal(fixture.timerCount(), 0)
})

function iconRules(): Map<string, string> {
  const map = new Map<string, string>()
  const re = /\.dsh-settings-groups \.dsh-sg-item\[data-dsh-nav-key="([^"]+)"\]::before\{mask:url\("([^"]+)"\)/g
  for (const m of SOURCE.matchAll(re)) map.set(m[1]!, m[2]!)
  return map
}

test('分组表每一项都有专属图标规则', () => {
  const rules = iconRules()
  const missing = navMembers().filter((name) => !rules.has(name))
  assert.deepEqual(missing, [], `这些入口没有图标规则，会退回官方内联 <svg>（即回到撞车状态）：${missing.join('、')}`)
})

test('导航图标两两不同（用户实证「图标有一样的」）', () => {
  const rules = iconRules()
  const byUri = new Map<string, string[]>()
  for (const [name, uri] of rules) {
    byUri.set(uri, [...(byUri.get(uri) ?? []), name])
  }
  const collisions = [...byUri.entries()].filter(([, names]) => names.length > 1)
  assert.deepEqual(collisions.map(([uri, names]) => `${names.join('=')}(${uri.slice(0, 48)}…)`), [],
    '以下入口共用同一枚图标，视觉上分不出来')
})

test('图标颜色统一走 currentColor + 固定不透明度', () => {
  const base = SOURCE.match(/\.dsh-settings-groups \.dsh-sg-item::before\{[^}]*\}/)
  assert.ok(base, '未找到图标 ::before 基础规则')
  assert.match(base[0]!, /background:currentColor/, '图标必须走 currentColor（跟随文字色），不得各写各的颜色')
  assert.match(base[0]!, /opacity:\.\d+/, '图标必须固定不透明度，否则同一列里深浅不一')
  assert.match(SOURCE, /\.dsh-settings-groups \.dsh-sg-item>svg\{display:none\}/,
    '克隆来的官方 <svg> 必须隐掉，否则两枚图标叠在一起')
})
