import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const text = readFileSync(resolve('customizations/ui-tweaks/lib/client.js'), 'utf8')
const block = text.split('// BEGIN SETTINGS_NAV_DISTINCT_ICONS')[1]?.split('// END SETTINGS_NAV_DISTINCT_ICONS')[0]
assert.ok(block, 'editable icon block exists')

function fixture(labels: string[]) {
  let writes = 0, observer: any, disposed = false, style: any, cleanup: any
  const frames = new Map<number, () => void>()
  const buttons = labels.map(label => ({ label, originalSvg: {}, onclick: () => 1, attrs: new Map<string, string>(),
    querySelector() { return { textContent: this.label } },
    getAttribute(name: string) { return this.attrs.get(name) ?? null }, hasAttribute(name: string) { return this.attrs.has(name) },
    setAttribute(name: string, value: string) { writes++; this.attrs.set(name, value) }, removeAttribute(name: string) { writes++; this.attrs.delete(name) },
  }))
  const nav = { nodeType: 1, closest: () => true }
  const context: any = {
    document: { head: { appendChild(value: any) { style = value } }, body: {},
      createElement: () => ({ textContent: '', setAttribute() {}, remove() { disposed = true } }),
      querySelectorAll(selector: string) { return selector.includes('[data-dsh-settings-icon]') ? buttons.filter(b => b.hasAttribute('data-dsh-settings-icon')) : buttons },
    },
    window: { requestAnimationFrame(fn: () => void) { frames.set(1, fn); return 1 }, cancelAnimationFrame(id: number) { frames.delete(id) } },
    MutationObserver: class { callback: any; options: any; disconnected = false; constructor(fn: any) { this.callback = fn; observer = this } observe(_root: any, options: any) { this.options = options } disconnect() { this.disconnected = true } },
  }
  vm.runInNewContext(block + '\nthis.install = installSettingsNavIcons; this.icons = SETTINGS_NAV_ICONS;', context)
  context.install({ effect(fn: any) { cleanup = fn() } })
  return { buttons, context, frames, observer, style, writes: () => writes, disposed: () => disposed,
    update() { observer.callback([{ target: nav, addedNodes: [] }]); const fn = frames.get(1); frames.clear(); fn?.() },
    cleanup: () => cleanup(),
  }
}

test('duplicate categories receive unique semantic icons; unknown and original categories survive', () => {
  const f = fixture(['内置插件', '自定义空间', 'Agent 预设', '通知', '更新', '多智能体交互管理', '插件配置', '连接器', '未知插件'])
  assert.deepEqual(f.buttons.map(b => b.getAttribute('data-dsh-settings-icon')), ['builtins', 'spaces', 'agent-presets', 'desktop-notifications', 'desktop-updates', 'external-agent', null, null, null])
  assert.equal(new Set(f.context.icons.map((v: any) => v.body)).size, 6)
  assert.equal(f.writes(), 6)
  for (const button of f.buttons) assert.equal(button.onclick(), 1, 'business click handlers survive')
})

test('English labels, localized changes, repeated renders and teardown remain bounded', () => {
  const f = fixture(['Built-in plugins', 'Custom Spaces', 'Agent presets', 'Notifications', 'Updates', 'Multi-agent interaction'])
  const svgs = f.buttons.map(b => b.originalSvg)
  for (let i = 0; i < 50; i++) f.update()
  assert.equal(f.writes(), 6, 'unchanged renders never rewrite attributes')
  assert.equal(f.observer.options.attributes, undefined, 'own markers cannot feed observer')
  f.buttons[0].label = 'Unknown'; f.update()
  assert.equal(f.buttons[0].hasAttribute('data-dsh-settings-icon'), false)
  f.buttons[0].label = '内置插件'; f.update()
  assert.equal(f.buttons[0].getAttribute('data-dsh-settings-icon'), 'builtins')
  assert.deepEqual(f.buttons.map(b => b.originalSvg), svgs)
  f.cleanup()
  assert.ok(f.observer.disconnected && f.disposed())
  assert.ok(f.buttons.every(b => !b.hasAttribute('data-dsh-settings-icon')))
})

test('unrelated DOM changes schedule no work and queued work is cancelled on disposal', () => {
  const f = fixture(['桌面设置'])
  f.observer.callback([{ target: { nodeType: 1, closest: () => null }, addedNodes: [] }])
  assert.equal(f.frames.size, 0)
  const nav = { nodeType: 1, closest: () => true }
  for (let i = 0; i < 10; i++) f.observer.callback([{ target: nav, addedNodes: [] }])
  assert.equal(f.frames.size, 1)
  f.cleanup(); assert.equal(f.frames.size, 0)
})

test('decorations remain scoped, theme-aware, fixed-size and non-interactive', () => {
  const f = fixture(['桌面设置'])
  assert.match(f.style.textContent, /background-color:currentColor/)
  assert.match(f.style.textContent, /width:16px;height:16px;flex:0 0 16px/)
  assert.match(f.style.textContent, /pointer-events:none/)
  assert.ok(f.style.textContent.split('\n').every((line: string) => line.startsWith('.dcu-settings-nav .dcu-settings-link[')))
  assert.equal((block.match(/\.innerHTML|\.replaceChildren|setInterval|location\.reload/g) || []).length, 0)
})
