// Real isolated Profile/Loader, Codex UI, Slots and desktop bridge/preload.
// Only desktopSettings IPC backends are finite mocks. No production tasks,
// Bridge controls, network updates, deployments, application restart or publication.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs'), assert = require('node:assert/strict')
const { resolve, join, dirname, parse, relative, isAbsolute } = require('node:path')
const { pathToFileURL } = require('node:url')
const { randomUUID, createHash } = require('node:crypto')
const root = resolve(__dirname, '..')
function ordinaryDirectory(path) {
  const absolute = resolve(path), normalize = value => process.platform === 'win32' ? value.toLowerCase() : value
  assert.equal(normalize(fs.realpathSync(absolute)), normalize(absolute), 'Fixture/evidence path follows a junction')
  for (let cursor = absolute; cursor !== parse(cursor).root; cursor = dirname(cursor)) {
    const entry = fs.lstatSync(cursor)
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'Fixture/evidence ancestor is not ordinary')
  }
  return absolute
}
function plainJson(file) {
  ordinaryDirectory(dirname(file))
  const entry = fs.lstatSync(file)
  assert.ok(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.size <= 256 * 1024, 'Invalid metadata file')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
ordinaryDirectory(join(root, 'Data/Development'))
const evidenceRoot = join(root, 'Data/Development/settings-split-profile')
fs.mkdirSync(evidenceRoot, { recursive: true }); ordinaryDirectory(evidenceRoot)
const out = join(evidenceRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID())
fs.mkdirSync(out); ordinaryDirectory(out)
const scratch = fs.mkdtempSync(join(ordinaryDirectory(join(root, 'Data/Temp')), 'settings-split-profile-'))
ordinaryDirectory(scratch)
const home = join(scratch, 'home'), profile = join(home, 'profiles/web'), nm = join(profile, 'node_modules')
fs.mkdirSync(nm, { recursive: true })
app.setPath('userData', join(scratch, 'electron')); app.setPath('sessionData', join(scratch, 'electron'))
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {})
let win, shellWin, server, finished = false, origin, runtimeVersion, uiVersion, paintCount = 0
const results = [], errors = [], calls = [], screenshots = [], blockedRequests = [], clicks = [], sourceHashes = {}
const load = name => import(pathToFileURL(join(root, 'dist/src', name + '.js')))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const productionMetadata = ['Data/Updates/Desktop/pointer.json', 'Data/Updates/Desktop/state.json',
  'Data/Runtime/Harness/current.json', 'Data/Electron/UserData/desktop-settings.json',
  'Data/Electron/UserData/desktop-update-settings.json', 'Data/Electron/UserData/shell/theme.json', 'Data/Updates/Harness/policy.json']
function productionSnapshot() {
  return productionMetadata.map(path => {
    const file = join(root, path)
    let item
    try { item = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return { path, present: false }; throw error }
    ordinaryDirectory(dirname(file))
    assert.ok(item.isFile() && !item.isSymbolicLink() && item.nlink === 1, 'Protected metadata is not an ordinary file')
    return { path, present: true, sha256: digest(file), size: item.size, mtimeMs: item.mtimeMs }
  })
}
const js = code => win.webContents.executeJavaScript(code)
const child = () => win?.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc')
const frameJs = code => child().executeJavaScript(code)
async function until(fn, reason, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error(reason)
}
function link(target, path) { fs.mkdirSync(dirname(path), { recursive: true }); fs.symlinkSync(target, path, 'junction') }
function fixturePath(name) {
  const path = resolve(scratch, name), suffix = relative(scratch, path)
  assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'Fixture path escaped scratch')
  return path
}
async function click(contents, selector) {
  await contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});void 0`)
  await sleep(100)
  const point = await contents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing mouse target');const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{x:r.x+r.width/2,y:r.y+r.height/2,hit:r.width>0&&r.height>0&&(e===hit||e.contains(hit))}})()`)
  assert.equal(point.hit, true, 'Mouse target obstructed: ' + selector)
  await contents.executeJavaScript(`window.__splitParentTrustedClick=null;document.addEventListener('click',event=>{const e=document.querySelector(${JSON.stringify(selector)});window.__splitParentTrustedClick={trusted:event.isTrusted,target:e===event.target||!!e?.contains(event.target),clientX:event.clientX,clientY:event.clientY,label:event.target.textContent?.trim().slice(0,80),tag:event.target.tagName}},{once:true,capture:true});void 0`)
  contents.focus()
  const factor = contents.getZoomFactor(), x = Math.round(point.x * factor), y = Math.round(point.y * factor)
  for (const event of [{ type: 'mouseMove', x, y }, { type: 'mouseDown', button: 'left', clickCount: 1, x, y }, { type: 'mouseUp', button: 'left', clickCount: 1, x, y }]) contents.sendInputEvent(event)
  await until(() => contents.executeJavaScript(`window.__splitParentTrustedClick!==null`), 'Electron did not deliver parent mouse click')
  const trusted = await contents.executeJavaScript('window.__splitParentTrustedClick')
  clicks.push({ selector, zoom: factor, x, y, cssPoint: point, ...trusted })
  assert.equal(trusted.trusted, true, 'Parent action must be a trusted mouse click')
  assert.equal(trusted.target, true, 'Parent mouse action missed its exact target: ' + JSON.stringify(clicks.at(-1)))
  await sleep(100)
}
async function frameClick(selector) {
  await js(`document.querySelector('iframe[data-dsh-desktop-settings]').scrollIntoView({block:'nearest'});void 0`)
  await sleep(100)
  await frameJs(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});void 0`)
  await sleep(100)
  const point = await frameJs(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{x:r.x+r.width/2,y:r.y+r.height/2,hit:r.width>0&&r.height>0&&(e===hit||e.contains(hit))}})()`)
  assert.equal(point.hit, true, 'Iframe mouse target obstructed: ' + selector)
  const frameRect = await js(`(()=>{const e=document.querySelector('iframe[data-dsh-desktop-settings]'),r=e.getBoundingClientRect();return{x:r.x,y:r.y}})()`)
  const hit = await js(`(()=>{const e=document.querySelector('iframe[data-dsh-desktop-settings]'),r=e.getBoundingClientRect(),target=document.elementFromPoint(r.x+${point.x},r.y+${point.y});return{iframe:target===e,tag:target?.tagName,classes:target?.className||'',x:r.x+${point.x},y:r.y+${point.y}}})()`)
  assert.equal(hit.iframe, true, 'Parent document obstructs iframe target: ' + JSON.stringify(hit))
  const zoom = win.webContents.getZoomFactor(), x = Math.round((frameRect.x + point.x) * zoom), y = Math.round((frameRect.y + point.y) * zoom)
  // Offscreen Electron sendInputEvent has a BrowserWindow focus precondition.
  // Chromium's real input protocol routes into the opaque/OOPIF sandbox without
  // exposing a visible window. No DOM click/handler invocation is substituted.
  await frameJs(`window.__splitTrustedClick=null;document.addEventListener('click',event=>{const e=document.querySelector(${JSON.stringify(selector)});window.__splitTrustedClick={trusted:event.isTrusted,target:e===event.target||!!e?.contains(event.target),tag:event.target.tagName}},{once:true,capture:true});void 0`)
  win.webContents.focus()
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
  const debug = win.webContents.debugger
  const { root: doc } = await debug.sendCommand('DOM.getDocument')
  const { nodeId } = await debug.sendCommand('DOM.querySelector', { nodeId: doc.nodeId, selector: 'iframe[data-dsh-desktop-settings]' })
  assert.ok(nodeId, 'Only the current fixture settings iframe may receive input')
  const { node } = await debug.sendCommand('DOM.describeNode', { nodeId, depth: 1 })
  const { targetInfos } = await debug.sendCommand('Target.getTargets')
  const target = targetInfos.find(info => info.targetId === node.frameId && info.type === 'iframe' && info.url === 'about:srcdoc')
  const frameIdentity = { domFrameId: node.frameId, frameTree: win.webContents.mainFrame.frames.map(frame => ({ name: frame.name, url: frame.url, processId: frame.processId, routingId: frame.routingId })), iframeTargets: targetInfos.filter(info => info.type === 'iframe').map(info => ({ targetId: info.targetId, url: info.url })) }
  fs.writeFileSync(join(out, 'iframe-input-identity.json'), JSON.stringify(frameIdentity, null, 2))
  let sessionId
  if (target) {
    sessionId = (await debug.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
    const { result } = await debug.sendCommand('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)
    assert.equal(result.value, 'about:srcdoc', 'Input session is not our current srcDoc')
  }
  try {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await debug.sendCommand('Input.dispatchMouseEvent', { type, x: sessionId ? point.x : x, y: sessionId ? point.y : y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 }, sessionId)
    }
  } finally { if (sessionId) await debug.sendCommand('Target.detachFromTarget', { sessionId }) }
  await until(() => frameJs(`window.__splitTrustedClick!==null`), 'Chromium did not deliver iframe mouse click')
  const trusted = await frameJs('window.__splitTrustedClick')
  assert.equal(trusted.trusted, true, 'Iframe action must use a trusted Chromium mouse event')
  assert.equal(trusted.target, true, 'Iframe mouse click must reach its exact target')
  clicks.push({ selector: 'iframe ' + selector, zoom, x, y, inputMethod: 'Chromium Input.dispatchMouseEvent', domFrameId: node.frameId, exactSession: !!sessionId, ...trusted }); await sleep(100)
}
const fixture = {
  notifications: { turnMode: 'unfocused', approvalsEnabled: true, questionsEnabled: true }, themePreset: 'lake',
  desktop: { policy: 'manual', channel: 'stable', checkIntervalHours: 3 },
  harness: { channel: 'alpha', mode: 'manual', checkIntervalHours: 11, idleQuietSeconds: 29, shadowStartupTimeoutSeconds: 73, liveStartupTimeoutSeconds: 97, observationMinutes: 7, rollbackTimeoutSeconds: 61, maxDownloadRetries: 4, keepGoodSlots: 3, skipVersions: [], maxAutomaticDeployAttempts: 2, deployRetryCooldownHours: 13 },
}
const clone = value => structuredClone(value)
const bootstrap = () => ({ locale: 'zh-CN', platform: 'win32', version: 'fixture-desktop', colorScheme: 'light', themePreset: fixture.themePreset,
  menus: [], state: { canBack: false, canForward: false, zoomPercent: 100, browser: { visible: false }, update: { kind: 'idle' } } })
let desktopStatus = { kind: 'idle' }, harnessStatus = { phase: 'idle', currentVersion: 'fixture-runtime' }
const desktopState = () => ({ packaged: true, currentVersion: 'fixture-desktop', status: clone(desktopStatus) })
const harnessState = () => ({ available: true, running: false, policy: clone(fixture.harness), state: clone(harnessStatus) })
const handlers = {
  getBootstrap: bootstrap, getNotificationPreferences: () => clone(fixture.notifications), getUpdatePreferences: () => clone(fixture.desktop),
  getDesktopUpdateState: desktopState, getHarnessUpdateState: harnessState,
  updateNotificationPreferences: value => { fixture.notifications = clone(value); return clone(value) },
  updateThemePreferences: value => { fixture.themePreset = value.preset; return { schema: 1, preset: value.preset } },
  updateUpdatePreferences: value => { fixture.desktop = { ...fixture.desktop, ...clone(value) }; return clone(fixture.desktop) },
  updateHarnessUpdatePolicy: value => { fixture.harness = clone(value); return harnessState() },
  desktopUpdateAction: value => {
    assert.ok(['check', 'download', 'install'].includes(value), 'Forbidden fixture desktop action')
    desktopStatus = value === 'check' ? { kind: 'available', version: 'fixture-candidate' } : value === 'download' ? { kind: 'ready', version: 'fixture-candidate', detail: 'Mock only: no download occurred' } : { kind: 'completed', detail: 'Mock only: no installation or restart occurred' }
    return desktopState()
  },
  harnessUpdateAction: value => { assert.equal(value, 'check'); harnessStatus = { phase: 'blocked', currentVersion: 'fixture-runtime', detail: 'Mock safety gate: no activation occurred' }; return harnessState() },
}
async function select(label, section) {
  // Canonical ui-tweaks mirrors original nav items. Only visible left-nav buttons count.
  const selector = '.dsh-settings-groups .dsh-sg-item[data-dsh-nav-key=' + JSON.stringify(label) + ']'
  await until(() => js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);return b.length===1})()`), 'Missing/duplicate visible left-nav item: ' + label)
  await click(win.webContents, selector)
  await until(async () => !!child() && await frameJs(`document.documentElement?.dataset.dshSection===${JSON.stringify(section)}&&document.querySelector('#currentVersion')?.textContent==='fixture-desktop'`), 'Real split entry did not render: ' + label)
  const sample = await frameJs(`(()=>{const m=document.querySelector('main');return{section:document.documentElement.dataset.dshSection,visible:['notifications','updates','appearance'].filter(s=>!document.getElementById(s+'Page').hidden),internalNavVisible:getComputedStyle(document.querySelector('aside')).display!=='none',overflow:document.documentElement.scrollWidth>innerWidth+1,mainOverflow:m.scrollWidth>m.clientWidth+1,error:!document.querySelector('#settingsError').hidden}})()`)
  assert.equal(sample.section, section); assert.deepEqual(sample.visible, [section]); assert.equal(sample.internalNavVisible, false)
  assert.equal(sample.overflow, false); assert.equal(sample.mainOverflow, false); assert.equal(sample.error, false)
  assert.equal(await js(`document.querySelectorAll('iframe[data-dsh-desktop-settings]').length`), 1, 'One split page must not mount all three documents')
  if (section === 'appearance') {
    const native = await js(`(()=>{const original=document.querySelector('[data-dcu-settings-item="appearance"]'),addition=document.querySelector('[data-dcu-settings-item="desktop-appearance"]');const rows=[...document.querySelectorAll('[data-dcu-settings-item]')].map(e=>e.dataset.dcuSettingsItem);return{nativeButtons:original?.querySelectorAll('button[aria-pressed]').length||0,nativeIframe:!!original?.querySelector('iframe'),addedPanels:addition?.querySelectorAll('[data-dsh-desktop-appearance-panel]').length||0,rows}})()`)
    assert.equal(native.nativeButtons, 3, 'Native Light/Dark/System appearance controls were shadowed')
    assert.equal(native.nativeIframe, false); assert.equal(native.addedPanels, 1)
    assert.ok(native.rows.indexOf('appearance') < native.rows.indexOf('desktop-appearance') && native.rows.indexOf('desktop-appearance') < native.rows.indexOf('font-size'), 'Incremental desktop appearance must stay between order10 and11')
    results.push({ name: 'Native appearance and incremental desktop appearance coexist', ...native })
  }
  sample.nav = await js(`(()=>{const attrs=e=>({label:e.textContent.trim(),ariaCurrent:e.getAttribute('aria-current'),dataActive:e.getAttribute('data-active'),dataState:e.getAttribute('data-state'),classes:e.className});return{original:[...document.querySelectorAll('.dcu-settings-groups button.dcu-settings-link')].map(attrs),mirror:[...document.querySelectorAll('.dsh-settings-groups .dsh-sg-item')].map(e=>({...attrs(e),key:e.dataset.dshNavKey,selected:e.classList.contains('dsh-on')}))}})()`)
  return sample
}
async function openSettings() {
  await until(() => js(`!!document.querySelector('[data-dcu-settings-trigger]')&&!!window.dshDesktopShell`), 'Codex UI/real preload not ready')
  await sleep(500)
  if (await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/稍后配置|Set up later/i.test(e.textContent)&&e.getBoundingClientRect().width>0);if(b)b.dataset.splitDismiss='1';return !!b})()`)) await click(win.webContents, '[data-split-dismiss]')
  // The desktop settings seat is deliberately hidden by canonical ui-tweaks.
  // Enter through the actual shell button -> real preload -> actual client bridge.
  await click(shellWin.webContents, '#settings-btn')
  await until(() => js(`!!document.querySelector('.dcu-settings-nav')&&!!document.querySelector('.dsh-settings-groups')`), 'Real desktop-to-DSH settings entry failed')
  await sleep(300)
  assert.equal(await js(`(()=>{const visible=[...document.querySelectorAll('.dcu-settings-nav button')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).map(e=>e.textContent.replace(/\\s/g,''));return visible.includes('桌面设置')})()`), false, 'Old whole desktop-settings entry remains visible')
}
async function capture(name, section) {
  if (section) {
    // A DOM route can finish before a new OOPIF surface is presented. Warm capture,
    // wait through the actual 800ms mirror cycle and finite transitions, then require
    // fresh offscreen paint receipts before writing evidence. Never disable animations.
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await sleep(900)
    for (const evaluate of [js, frameJs]) {
      await evaluate(`(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect&&a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`)
    }
    assert.equal(await frameJs(`document.documentElement.dataset.dshSection`), section, 'Section changed before screenshot')
    const beforePaint = paintCount
    win.webContents.invalidate()
    await until(() => paintCount > beforePaint, 'Compositor did not present a fresh screenshot frame')
    await sleep(150)
    const nav = await js(`(()=>{const attrs=e=>({label:e.textContent.trim(),ariaCurrent:e.getAttribute('aria-current'),dataActive:e.getAttribute('data-active'),dataState:e.getAttribute('data-state'),classes:e.className});return{original:[...document.querySelectorAll('.dcu-settings-groups button.dcu-settings-link')].map(attrs),mirror:[...document.querySelectorAll('.dsh-settings-groups .dsh-sg-item')].map(e=>({...attrs(e),key:e.dataset.dshNavKey,selected:e.classList.contains('dsh-on')}))}})()`)
    results.push({ name: 'Screenshot ready for pixel review', file: name, section, paintCount, nav })
    const expected = { notifications: '通知', updates: '更新', appearance: '常规' }[section]
    assert.deepEqual(nav.original.filter(item => item.ariaCurrent === 'page').map(item => item.label), [expected], 'Original settings navigation must have exactly one active item')
    assert.deepEqual(nav.mirror.filter(item => item.selected).map(item => item.key), [expected], 'Mirrored navigation must match the sole original active item')
  }
  fs.writeFileSync(join(out, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); screenshots.push(name)
}
async function run() {
  const productionBefore = productionSnapshot()
  const { activeUiProfile } = await import(pathToFileURL(join(root, 'scripts/lib/active-ui-profile.mjs')))
  const active = activeUiProfile(root), runtime = active.runtime
  assert.ok(runtime, 'An exact active immutable runtime is required; do not guess a runtime')
  runtimeVersion = plainJson(join(runtime, 'package.json')).dependencies?.['@deepseek-ai/dsh']
  assert.equal(JSON.parse(fs.readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version, runtimeVersion, 'Runtime identity is not exact')
  assert.match(runtimeVersion, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
  const ui = join(active.profile, 'node_modules/@michengai/dsh-codex-ui')
  uiVersion = JSON.parse(fs.readFileSync(join(ui, 'package.json'), 'utf8')).version
  assert.equal(uiVersion, '1.1.18', 'This isolated acceptance matrix targets Codex UI1.1.18')
  const approved = plainJson(join(active.profile, 'compatibility.json')), key = '@michengai/dsh-codex-ui@' + uiVersion
  assert.ok(Array.isArray(approved[key]) && approved[key].includes(runtimeVersion), 'Missing existing exact Codex UI/runtime approval; fixture may not invent one')
  const localTweaks = fixturePath('home/profiles/web/local/dsh-ui-tweaks')
  for (const name of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js']) {
    const source = join(root, 'customizations/ui-tweaks', name), destination = join(localTweaks, name)
    const item = fs.lstatSync(source); assert.ok(item.isFile() && !item.isSymbolicLink(), 'Canonical UI source is not an ordinary file')
    fs.mkdirSync(dirname(destination), { recursive: true }); fs.copyFileSync(source, destination); sourceHashes[name] = digest(source)
  }
  // Copy, never junction, this local plugin: its probe route writes beside index.js.
  link(localTweaks, join(nm, 'dsh-ui-tweaks'))
  link(join(runtime, 'node_modules/@deepseek-ai'), join(nm, '@deepseek-ai'))
  link(ui, join(nm, '@michengai/dsh-codex-ui'))
  fs.writeFileSync(join(profile, 'compatibility.json'), JSON.stringify({ [key]: [runtimeVersion] }))
  fs.writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-settings-split-verification', private: true,
    dependencies: { '@michengai/dsh-codex-ui': uiVersion, 'dsh-ui-tweaks': 'link:local/dsh-ui-tweaks' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@michengai/dsh-codex-ui', 'dsh-ui-tweaks'] } } }, null, 2))
  fs.writeFileSync(join(profile, 'cordis.patch.yml'), '- id: workspace-controller\n  config:\n    documentsDirectory: ' + JSON.stringify(fixturePath('documents')) + '\n')
  const { installDesktopBridge } = await load('desktop-host')
  installDesktopBridge(profile, join(root, 'dist/src'))
  const bundles = plainJson(join(profile, 'package.json')).dsh.profile.bundles
  assert.deepEqual(bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@michengai/dsh-codex-ui', 'dsh-ui-tweaks', 'dsh-desktop-bridge'])
  const { GATE_NODE } = await import(pathToFileURL(join(root, 'scripts/lib/gate-node.mjs')))
  const { startDsh } = await load('dsh-process'), { SHELL_IPC } = await load('shell-contract'), embedded = await load('embedded-desktop-settings')
  const document = embedded.embeddedDesktopSettingsDocument(...['settings.html', 'theme.css', 'theme.js', 'shell-icons/chevron-down.svg'].map(name => fs.readFileSync(join(root, 'assets', name), 'utf8')))
  await app.whenReady()
  win = new BrowserWindow({ width: 1360, height: 1000, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: join(root, 'dist/src/dsh-view-preload.cjs') } })
  win.webContents.on('paint', () => { paintCount += 1 })
  shellWin = new BrowserWindow({ width: 1360, height: 90, show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: join(root, 'dist/src/shell-preload.cjs') } })
  for (const window of [win, shellWin]) window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message.replace(/([?&](?:token|authToken)=)[^\s&]+/gi, '$1[redacted]')) })
  function authorize(event) {
    assert.equal(event.sender, win.webContents, 'Unexpected embedded IPC sender')
    assert.equal(event.senderFrame, win.webContents.mainFrame, 'Embedded IPC must come from the outer DSH main frame')
    assert.ok(embedded.mayUseEmbeddedDesktopSettings('dsh', true, event.senderFrame.url, origin), 'Embedded IPC origin rejected')
  }
  ipcMain.handle(SHELL_IPC.embeddedSettingsDocument, event => { authorize(event); return document })
  ipcMain.handle(SHELL_IPC.embeddedSettingsRequest, async (event, value) => {
    authorize(event); const request = embedded.parseDesktopSettingsRequest(value)
    calls.push(clone(request)); assert.ok(Object.hasOwn(handlers, request.method), 'Unknown isolated settings method')
    await sleep(25); return handlers[request.method](request.value)
  })
  for (const [channel, method] of [[SHELL_IPC.getBootstrap, 'getBootstrap'], [SHELL_IPC.getDesktopUpdateState, 'getDesktopUpdateState']]) {
    ipcMain.handle(channel, event => { assert.equal(event.sender, shellWin.webContents); assert.equal(event.senderFrame, shellWin.webContents.mainFrame); return handlers[method]() })
  }
  ipcMain.handle(SHELL_IPC.action, (event, id) => {
    assert.equal(event.sender, shellWin.webContents); assert.equal(event.senderFrame, shellWin.webContents.mainFrame)
    assert.equal(id, 'settings', 'The isolated shell forbids all task/restart/update actions')
    win.webContents.send(SHELL_IPC.dshAction, 'settings'); return null
  })
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    let blocked = false
    if (/^(https?|wss?):/i.test(details.url)) {
      const target = new URL(details.url), expected = origin && new URL(origin)
      blocked = !expected || target.hostname !== expected.hostname || target.port !== expected.port
      if (blocked) blockedRequests.push(target.origin + target.pathname)
    }
    callback({ cancel: blocked })
  })
  // startDsh inherits process.env; NODE_OPTIONS and every caller guard stay intact.
  server = await startDsh({ nodeExecutable: GATE_NODE, bootstrapPath: join(root, 'dist/src/dsh-bootstrap.mjs'),
    runtime: { root: runtime, entry: join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js') }, workingDirectory: scratch,
    environment: { DSH_HOME: home, DSH_PROFILE_DIR: profile, DSH_PROFILE_NAME: 'web', DSH_RUNTIME_DIR: runtime, TEMP: scratch, TMP: scratch, npm_config_offline: 'true' }, startupTimeoutMs: 120000 })
  origin = new URL(server.url).origin
  await shellWin.loadFile(join(root, 'assets/shell.html')); await win.loadURL(server.url)
  await openSettings()
  for (const [label, section] of [['通知', 'notifications'], ['更新', 'updates'], ['常规', 'appearance']]) {
    results.push({ name: 'Real Loader/Slots/left navigation: ' + label, ...(await select(label, section)) })
  }
  assert.equal(calls.filter(call => /Action$/.test(call.method)).length, 0, 'Loading settings must not invoke an updater')
  // The original official appearance buttons remain operable, not merely present.
  await js(`(()=>{const b=[...document.querySelectorAll('[data-dcu-settings-item="appearance"] button')].find(e=>e.textContent.trim()==='浅色');if(!b)throw Error('Native light button missing');b.dataset.splitNativeLight='1'})()`)
  await click(win.webContents, '[data-split-native-light]')
  await until(() => js(`document.querySelector('[data-split-native-light]').getAttribute('aria-pressed')==='true'`), 'Native appearance button no longer works')
  results.push({ name: 'Real mouse keeps native appearance Light control working', pass: true })
  await select('通知', 'notifications')
  let before = calls.length
  // Checkbox inputs are visually hidden; the real clickable switch is its label/track.
  await frameClick('label[for="approvalsEnabled"] .track')
  await until(() => calls.length > before && fixture.notifications.approvalsEnabled === false, 'Notification mouse/save route failed')
  await select('更新', 'updates')
  before = calls.length; await frameClick('#policyButton'); await frameClick('#policyList [data-value="auto-on-exit"]')
  await until(() => calls.length > before && fixture.desktop.policy === 'auto-on-exit', 'Desktop preference mouse/save failed')
  before = calls.length; await frameClick('#harnessPolicyButton'); await frameClick('#harnessPolicyList [data-value="notify"]')
  await until(() => calls.length > before && fixture.harness.mode === 'notify', 'Runtime preference mouse/save failed')
  for (const action of ['check', 'download', 'install']) {
    assert.equal(await frameJs(`document.querySelector('#updateAction').dataset.action`), action)
    before = calls.length; await frameClick('#updateAction')
    await until(() => calls.length > before && calls.at(-1).method === 'desktopUpdateAction' && calls.at(-1).value === action, 'Mock desktop action was routed incorrectly: ' + action)
    await until(() => frameJs(`!document.querySelector('#updateAction').disabled`), 'Mock action did not settle')
  }
  before = calls.length; await frameClick('#harnessAction')
  await until(() => calls.length > before && calls.at(-1).method === 'harnessUpdateAction' && calls.at(-1).value === 'check', 'Mock runtime action was routed incorrectly')
  await select('常规', 'appearance'); before = calls.length; await frameClick('[data-theme-id="gold"]')
  await until(() => calls.length > before && fixture.themePreset === 'gold', 'Desktop accent mouse/save failed')
  results.push({ name: 'Trusted mouse -> real preload/bridge IPC -> isolated notification/theme/two-update handlers; no actual update operation', pass: true })
  for (const width of [1360, 900]) for (const zoom of [0.8, 1, 1.25]) {
    win.setContentSize(width, 1000); win.webContents.setZoomFactor(zoom); await sleep(180)
    for (const [label, section] of [['通知', 'notifications'], ['更新', 'updates'], ['常规', 'appearance']]) {
      const sample = await select(label, section)
      const geometry = await js(`(()=>{const r=document.querySelector('iframe[data-dsh-desktop-settings]').getBoundingClientRect();return{left:r.left,right:r.right,viewportWidth:innerWidth,outerOverflow:document.documentElement.scrollWidth>innerWidth+1}})()`)
      assert.ok(geometry.left >= -1 && geometry.right <= geometry.viewportWidth + 1); assert.equal(geometry.outerOverflow, false)
      results.push({ width, zoom, label, ...sample, ...geometry })
      await capture(`profile-${section}-${width}-${String(zoom).replace('.', '-')}.png`, section)
    }
  }
  win.setContentSize(1360, 1000); win.webContents.setZoomFactor(1)
  const committed = clone(fixture), actionCount = calls.filter(call => /Action$/.test(call.method)).length
  await win.loadURL(server.url); await openSettings()
  await select('通知', 'notifications'); assert.equal(await frameJs(`document.querySelector('#approvalsEnabled').checked`), false)
  await select('更新', 'updates'); assert.equal(await frameJs(`document.querySelector('#policyList [data-value="auto-on-exit"]').getAttribute('aria-selected')`), 'true')
  assert.equal(await frameJs(`document.querySelector('#harnessPolicyList [data-value="notify"]').getAttribute('aria-selected')`), 'true')
  await select('常规', 'appearance'); assert.equal(await frameJs(`DshThemes.current()`), 'gold')
  assert.deepEqual(fixture, committed); assert.equal(calls.filter(call => /Action$/.test(call.method)).length, actionCount)
  for (const [name, hash] of Object.entries(sourceHashes)) assert.equal(digest(join(root, 'customizations/ui-tweaks', name)), hash, 'Canonical source changed during isolated run; evidence is stale')
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [], 'Unexpected renderer egress was rejected, not allowed')
  results.push({ name: 'Real page reload retains split entries and isolated preference roundtrip without automatic update actions', pass: true })
  win.destroy(); shellWin.destroy(); await server.stop(); server = undefined
  const productionAfter = productionSnapshot()
  assert.deepEqual(productionAfter, productionBefore, 'Production pointer/pending/preferences metadata changed during the isolated run; do not accept this evidence')
  results.push({ name: 'Own isolated server stopped; seven production metadata identities/absence markers remained unchanged', pass: true })
  fs.writeFileSync(join(out, 'profile-results.json'), JSON.stringify({ status: 'pass', scope: 'isolated-real-Profile-Loader-Slots-CodexUI-canonical-uiTweaks-real-preloads-with-mock-update-backend', screenshotPixelReviewRequired: true, actualBackendVerified: false, actualDownloadInstallRestart: false, publication: false, scratch, runtimeVersion, uiVersion, bundles, inheritedNodeOptions: !!process.env.NODE_OPTIONS, sourceHashes, productionBefore, productionAfter, results, calls, clicks, screenshots, errors, blockedRequests }, null, 2))
  console.log(`PASS ${results.length} isolated real-loader/navigation/mouse/layout cases; no production update backend; evidence ${out}`)
}
async function finish(code) {
  if (finished) return
  finished = true
  try { win?.destroy(); shellWin?.destroy(); if (server) await server.stop() }
  catch (error) { console.error('Own isolated server cleanup failed:', String(error)); code = 1 }
  // Fixtures contain junctions to read-only installed packages: never recursively delete them.
  app.exit(code)
}
const timeout = setTimeout(() => { console.error('Isolated split Profile verification timed out'); void finish(1) }, 360000)
run().then(() => { clearTimeout(timeout); return finish(0) }).catch(async error => {
  clearTimeout(timeout); console.error(error)
  if (win && !win.isDestroyed()) { try { await capture('failure.png') } catch {} }
  fs.writeFileSync(join(out, 'profile-failure.json'), JSON.stringify({ status: 'fail', error: String(error), stack: error.stack, scope: 'isolated-real-loader-mock-update-backend', scratch, runtimeVersion, uiVersion, sourceHashes, results, calls, clicks, screenshots, errors, blockedRequests }, null, 2))
  return finish(1)
})
