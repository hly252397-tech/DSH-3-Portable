import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

// 实机 profile 产物；全新检出（如 CI）缺失时相关用例跳过。
const spacesClientPath = join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-sidebar-spaces/lib/client.src.js')
const codexClientPath = join(process.cwd(), 'Data/DSH/profiles/web/local/dsh-codex-ui/lib/client.js')
const haveLiveSpacesClient = existsSync(spacesClientPath)
const haveLiveCodexClient = existsSync(codexClientPath)

async function navigationHarness() {
  let api: any
  let observerCallback = () => {}
  let timeoutCallback = () => {}
  let disconnected = 0
  let cleared = 0
  let dialog = false
  let buttons: any[] = []
  let launchers: any[] = []
  const source = (await readFile(spacesClientPath, 'utf8'))
    .replace('exports.apply = apply;', 'exports.navigation = openSettingsSection; exports.apply = apply;')
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(def: any) { api = def.factory(() => ({})).navigation } } },
    document: {
      body: {},
      querySelector() { return dialog ? {} : null },
      querySelectorAll(selector: string) { return selector.includes('nav button') ? buttons : launchers },
    },
    MutationObserver: class { constructor(callback: () => void) { observerCallback = callback } observe() {} disconnect() { disconnected++ } },
    setTimeout(callback: () => void) { timeoutCallback = callback; return 1 },
    clearTimeout() { cleared++ },
  })
  const button = (label: string, click: () => void, disabled = false) => ({ textContent: label, disabled, click, getAttribute: () => null })
  return {
    api, button, setDialog(value: boolean) { dialog = value }, setButtons(value: any[]) { buttons = value },
    setLaunchers(value: any[]) { launchers = value }, mutate() { observerCallback() }, expire() { timeoutCallback() },
    get cleaned() { return disconnected > 0 && cleared > 0 },
  }
}

test('extensions launcher selects Plugins once instead of leaving General open', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  const h = await navigationHarness()
  let opened = 0, selected = 0, complete = 0, missing = 0
  h.setLaunchers([
    h.button('打开配置文件设置', () => { throw new Error('must not match loosely') }),
    h.button('设置', () => { opened++; h.setDialog(true); h.setButtons([h.button('插件', () => selected++)]) }),
  ])
  h.api('plugins', () => missing++, () => complete++)
  h.mutate(); h.expire()
  assert.deepEqual({ opened, selected, complete, missing }, { opened: 1, selected: 1, complete: 1, missing: 0 })
  assert.ok(h.cleaned)
})

test('automation waits for delayed settings navigation and selects the exact section', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  const h = await navigationHarness()
  let selected = 0, missing = 0
  h.setLaunchers([h.button('Settings', () => h.setDialog(true))])
  h.api('automation', () => missing++)
  h.setButtons([h.button('Scheduled tasks', () => selected++)]); h.mutate()
  assert.equal(selected, 1); assert.equal(missing, 0); assert.ok(h.cleaned)
})

test('existing settings dialog is reused without toggling its launcher', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  const h = await navigationHarness()
  let selected = 0
  h.setDialog(true); h.setButtons([h.button('插件', () => selected++)])
  h.setLaunchers([h.button('设置', () => { throw new Error('must not toggle existing dialog') })])
  h.api('plugins', () => assert.fail('unexpected failure'))
  assert.equal(selected, 1)
})

test('missing launcher and missing target report failure and release resources', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  for (const dialog of [false, true]) {
    const h = await navigationHarness()
    let failed = 0
    h.setDialog(dialog)
    h.api('plugins', () => failed++)
    h.expire(); h.mutate()
    assert.equal(failed, 1); assert.ok(h.cleaned)
  }
})

test('cancellation, supersession and disabled controls cannot cause late navigation', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  const h = await navigationHarness()
  let failed = 0, selected = 0
  h.setDialog(true)
  const cancel = h.api('plugins', () => failed++)
  cancel()
  h.setButtons([h.button('插件', () => selected++)]); h.mutate(); h.expire()
  assert.equal(selected, 0); assert.equal(failed, 0)
  h.setButtons([])
  h.api('plugins', () => failed++)
  h.api('automation', () => failed++)
  h.setButtons([h.button('插件', () => selected++), h.button('定时任务', () => selected++, true)])
  h.mutate(); h.expire()
  assert.equal(selected, 0); assert.equal(failed, 1); assert.ok(h.cleaned)
})

test('extension browsing keeps one entry: Codex UI launches the standalone workbench', async t => {
  if (!haveLiveSpacesClient || !haveLiveCodexClient) return t.skip('实机插件产物缺失（CI 全新检出）')

  const [source, codexUi] = await Promise.all([
    readFile(spacesClientPath, 'utf8'),
    readFile(codexClientPath, 'utf8'),
  ])
  // 底部不再注册「扩展」入口。
  assert.doesNotMatch(source, /id:\s*["']dsh-extensions["']/)
  // 本插件认领可取消事件并打开独立工作台。
  assert.match(source, /event\.preventDefault\(\);\s*\n\s*openStandaloneWorkbench\("space-extensions"\);/)
  assert.match(source, /window\.addEventListener\("dsh:open-extension-page", open\);/)
  // 两处 selectPluginSection 都先派发事件；未被认领才回落到设置页。
  const launches = codexUi.match(/window\.dispatchEvent\(new CustomEvent\("dsh:open-extension-page", \{ cancelable: true \}\)\)/g) ?? []
  assert.equal(launches.length, 2)
  // 定时任务由上方导航承担，底部不再重复注册自动化入口，其设置跳转适配器随之移除。
  assert.doesNotMatch(source, /id:\s*["']dsh-automation["']/)
  assert.doesNotMatch(source, /SidebarSettingsAction/)
  assert.doesNotMatch(source, /openBuiltInSettings/)
  assert.match(source, /function AutomationApp[\s\S]*?useEffect[\s\S]*?return openSettingsSection\("automation"/)
})

test('market handoff waits for its tab without clicking the settings section twice', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  const h = await navigationHarness()
  let selected = 0, completed = 0, ready = false
  h.setDialog(true); h.setButtons([h.button('插件市场', () => selected++)])
  h.api('market', () => assert.fail('missing market'), () => completed++, () => ready)
  h.mutate()
  assert.equal(selected, 1); assert.equal(completed, 0)
  ready = true; h.mutate(); h.expire()
  assert.equal(selected, 1); assert.equal(completed, 1); assert.ok(h.cleaned)
})

test('market follow-up is cancelled when its owner is disposed', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  const h = await navigationHarness()
  let completed = 0, ready = false
  h.setDialog(true); h.setButtons([h.button('Plugin Market', () => {})])
  const cancel = h.api('market', () => assert.fail('should not fail after disposal'), () => completed++, () => ready)
  cancel(); ready = true; h.mutate(); h.expire()
  assert.equal(completed, 0); assert.ok(h.cleaned)
})

test('activity host cleanup supports remount and removes empty hosts from older bundles', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  let mount: () => () => void = () => { throw new Error('module not loaded') }
  let host: any = { hasChildNodes: () => false, remove() { host = null } }
  let mounted = 0, unmounted = 0
  const hero = {
    querySelector(selector: string) { return selector.includes('activity-host') ? host : {} },
    insertBefore(next: any) { host = next },
  }
  const source = (await readFile(spacesClientPath, 'utf8'))
    .replace('exports.apply = apply;', 'exports.mount = mountHeroActivityGrid; exports.apply = apply;')
  const deps = (name: string) => name === 'react' ? { createElement() { return {} } }
    : name === 'react-dom/client' ? { createRoot() { return { render() { mounted++ }, unmount() { unmounted++ } } } } : {}
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(def: any) { mount = def.factory(deps).mount } } },
    document: { body: {}, querySelectorAll: () => [hero], createElement: () => ({ dataset: {}, isConnected: true, hasChildNodes: () => false, remove() { host = null } }) },
    MutationObserver: class { observe() {} disconnect() {} }, queueMicrotask(callback: () => void) { callback() },
  })
  const dispose = mount()
  assert.equal(mounted, 1)
  dispose(); assert.equal(unmounted, 1); assert.equal(host, null)
  const disposeAgain = mount()
  assert.equal(mounted, 2)
  disposeAgain(); assert.equal(unmounted, 2); assert.equal(host, null)
})

test('sidebar knowledge entry is a plain tab like its siblings, renamed 知识中心', async t => {
  if (!haveLiveSpacesClient) return t.skip('实机 sidebar-spaces 产物缺失（CI 全新检出）')

  const source = await readFile(spacesClientPath, 'utf8')
  assert.match(source, /knowledge: "知识中心"/)
  const knowledge = source.slice(source.indexOf('id: "space-knowledge"'), source.indexOf('id: "space-database"'))
  const database = source.slice(source.indexOf('id: "space-database"'), source.indexOf('id: "space-inventor-2027"'))
  assert.match(knowledge, /title: \(\) => WORKBENCH_TEXT\.knowledge/)
  assert.doesNotMatch(knowledge, /title: \(\) => "知识库"/)
  // 与同类标签项一样内嵌渲染：不拒绝创建标签页，也不另开独立工作台。
  assert.doesNotMatch(knowledge, /createTab|openStandaloneWorkbench/)
  assert.match(knowledge, /component: \(props\) => h\(appShell,[\s\S]*?children: h\(KnowledgeApp, \{ service, scope: props\.scope \}\)/)
  assert.doesNotMatch(database, /createTab/)
})
