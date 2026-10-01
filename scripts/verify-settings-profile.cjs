// Real Profile/Loader + candidate client/preload + original main IPC registration.
// Separate DSH_HOME and Electron storage; never load the user's conversations/settings.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const { join, resolve, dirname } = require('node:path')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '..')
const uiOverride = process.argv.find(arg => arg.startsWith('--ui-package='))?.slice('--ui-package='.length)
const bundled = process.argv.includes('--bundled') || !!uiOverride
const evidenceLabel = process.argv.find(arg => arg.startsWith('--evidence-label='))?.slice('--evidence-label='.length) ?? ''
assert.ok(!evidenceLabel || /^[a-z0-9-]+$/.test(evidenceLabel))
const out = join(root, 'customizations/audit-fixes/20260927/settings-entry', (bundled ? 'bundled-profile-validation' : 'profile-validation') + (evidenceLabel ? '-' + evidenceLabel : ''))
fs.mkdirSync(out, { recursive: true })
const scratch = fs.mkdtempSync(join(root, 'Data/Temp/settings-profile-'))
const home = join(scratch, 'home'), profile = join(home, 'profiles/web'), nm = join(profile, 'node_modules')
fs.mkdirSync(nm, { recursive: true })
app.setPath('userData', join(scratch, 'electron')); app.setPath('sessionData', join(scratch, 'electron'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
let server, win, shellWin, fallback
const results = [], errors = [], channels = [], links = [], clickTrace = []
const serverDiagnostics = []
const childProcess = require('node:child_process'), originalSpawn = childProcess.spawn
childProcess.spawn = function (...args) {
  const child = originalSpawn.apply(this, args)
  if (args[1]?.some(value => String(value).endsWith('dsh-bootstrap.mjs'))) {
    const inspect = chunk => {
      const lines = String(chunk).split(/\r?\n/).filter(line => /error|cannot|failed|not found|plugin|bundle/i.test(line))
      serverDiagnostics.push(...lines.map(line => line.replace(/([?&](?:token|authToken)=)[^\s&]+/gi, '$1[redacted]')))
    }
    child.stdout?.on('data', inspect); child.stderr?.on('data', inspect)
  }
  return child
}
require('node:module').syncBuiltinESMExports()
const timeout = setTimeout(() => { console.error('Settings Profile verification timed out'); void finish(1) }, bundled ? 600000 : 180000)
let finished = false
const load = name => import(pathToFileURL(join(root, 'dist/src', name + '.js')))
const sleep = ms => new Promise(r => setTimeout(r, ms))
function link(target, path) { fs.mkdirSync(dirname(path), { recursive: true }); fs.symlinkSync(target, path, 'junction'); links.push(path) }
async function until(fn, message, limit = 30000) {
  const end = Date.now() + limit
  while (Date.now() < end) { if (await fn()) return; await sleep(150) }
  throw new Error(message)
}
async function click(contents, selector) {
  const point = await contents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing click target');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  contents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) })
  contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(point.x), y: Math.round(point.y) })
  contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(point.x), y: Math.round(point.y) })
}
async function run() {
  const runtimePointer = JSON.parse(fs.readFileSync(join(root, 'Data/Runtime/Harness/current.json')))
  const runtime = join(root, 'Data/Runtime', runtimePointer.current.relativePath)
  const active = join(root, 'Data/DSH-generations/v4-rc2b/home/profiles/web')
  let uiPackage = uiOverride ? resolve(uiOverride) : join(active, 'node_modules/@michengai/dsh-codex-ui')
  if (bundled && !uiOverride) {
    const seed = join(scratch, 'bundled-seed')
    const { seedBundledPlugins } = await load('plugin-seed')
    const { STORE_PACKAGES } = await load('bundled-plugins')
    const { preparePnpmInvocation } = await load('plugin-toolchain')
    const execFile = require('node:util').promisify(require('node:child_process').execFile)
    const nodeExecutable = join(root, 'Tools/node-v26.10.0/node.exe')
    const pnpmEntry = join(root, 'Tools/pnpm-v12.7.0/node_modules/pnpm/bin/pnpm.mjs')
    console.log('Preparing isolated bundled plugin seed from completed offline store')
    await seedBundledPlugins({ nodeExecutable, profileDir: seed,
      pluginStoreDir: join(root, 'runtime-plugins/store'), catalog: STORE_PACKAGES,
      pnpmEntry, runner: async args => {
        assert.ok(args.includes('--offline'), 'Verification must not silently fall back to online installation')
        const invocation = preparePnpmInvocation(args, { ...process.env, CI: 'true', NODE_OPTIONS: '', TEMP: scratch, TMP: scratch,
          PATH: dirname(nodeExecutable) + ';' + process.env.PATH })
        await execFile(nodeExecutable, [pnpmEntry, ...invocation.args], { windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024,
          env: invocation.env })
      } })
    uiPackage = join(seed, 'node_modules/@michengai/dsh-codex-ui')
  }
  if (bundled) {
    // Node resolves the plugin's host imports from its real package location.
    // Give this test-only seed the same official peer visibility as the active Profile.
    assert.ok(uiPackage.startsWith(join(root, 'Data/Temp') + require('node:path').sep))
    const peerScope = join(dirname(dirname(uiPackage)), '@deepseek-ai')
    for (const name of fs.readdirSync(join(runtime, 'node_modules/@deepseek-ai'))) {
      if (name.startsWith('dsh') && !fs.existsSync(join(peerScope, name))) link(join(runtime, 'node_modules/@deepseek-ai', name), join(peerScope, name))
    }
  }
  const uiVersion = JSON.parse(fs.readFileSync(join(uiPackage, 'package.json'), 'utf8')).version
  link(join(runtime, 'node_modules/@deepseek-ai'), join(nm, '@deepseek-ai'))
  link(uiPackage, join(nm, '@michengai/dsh-codex-ui'))
  fs.writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'settings-verification-profile', private: true,
    dependencies: { '@michengai/dsh-codex-ui': uiVersion }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@michengai/dsh-codex-ui'] } } }, null, 2))
  fs.writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  const { installDesktopBridge } = await load('desktop-host')
  installDesktopBridge(profile, join(root, 'dist/src'))
  const { startDsh } = await load('dsh-process')
  console.log('Starting isolated Profile/Loader; active DSH is not restarted')
  server = await startDsh({ nodeExecutable: join(root, 'Tools/node-v26.10.0/node.exe'), bootstrapPath: join(root, 'dist/src/dsh-bootstrap.mjs'),
    runtime: { root: runtime, entry: join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js') }, workingDirectory: scratch,
    environment: { DSH_HOME: home, DSH_PROFILE_DIR: profile, DSH_PROFILE_NAME: 'web', DSH_RUNTIME_DIR: runtime,
      TEMP: scratch, TMP: scratch, NODE_OPTIONS: '', npm_config_offline: 'true' }, startupTimeoutMs: 60000 })
  const origin = new URL(server.url).origin
  const { SHELL_IPC } = await load('shell-contract')
  const policy = await load('shell-ipc-policy'), embedded = await load('embedded-desktop-settings')
  const notifications = await load('desktop-notifications'), themes = await load('desktop-theme'), updates = await load('desktop-updater')
  const state = { canBack: false, canForward: false, browser: { visible: false }, zoomPercent: 100 }
  const sandbox = {
    ...policy, ...embedded, ...notifications, ...themes, ...updates, ipcMain, SHELL_IPC,
    join, dirname, readFileSync: fs.readFileSync, allowedOrigin: origin,
    resolveShellAsset: name => join(root, 'assets', name), currentShellState: () => state,
    notificationPreferences: notifications.DEFAULT_NOTIFICATION_PREFERENCES,
    themePreferences: themes.DEFAULT_DESKTOP_THEME_PREFERENCES, updatePreferences: updates.DEFAULT_UPDATE_PREFERENCES,
    notificationPreferencesPath: () => join(scratch, 'notifications.json'), themePreferencesPath: () => join(scratch, 'theme.json'),
    updatePreferencesPath: () => join(scratch, 'update.json'),
    shellRendererKind: sender => sender === win?.webContents ? 'dsh' : sender === shellWin?.webContents ? 'main' : sender === fallback?.webContents ? 'settings' : 'unknown',
    shellBootstrap: () => bootstrap(), broadcastShellBootstrap: () => win.webContents.send(SHELL_IPC.bootstrap, bootstrap()),
    desktopUpdateSnapshot: () => ({ currentVersion: 'isolated-test', packaged: false, status: { kind: 'idle' } }),
    harnessUpdateSnapshot: () => ({ available: false, policy: { mode: 'manual' }, running: false }),
    updateStatus: { kind: 'idle' }, harnessUpdaterContext: undefined,
    handleDesktopUpdateSettingsAction: () => { throw new Error('Download/install disabled in verification') },
  }
  function bootstrap() { return { locale: 'zh-CN', platform: 'win32', colorScheme: 'light', themePreset: sandbox.themePreferences.preset,
    state, actions: [], menus: [], version: 'isolated-test' } }
  const main = fs.readFileSync(join(root, 'dist/src/main.js'), 'utf8')
  const start = main.indexOf('const settingsHandlers = new Map()'), end = main.indexOf('ipcMain.handle(SHELL_IPC.closeDesktopSettings', start)
  assert.ok(start >= 0 && end > start)
  vm.runInNewContext(main.slice(start, end), sandbox, { filename: 'candidate-main-settings-ipc.js' })
  ipcMain.handle(SHELL_IPC.getBootstrap, () => bootstrap())
  ipcMain.handle(SHELL_IPC.action, (_e, action) => { channels.push(action); win.webContents.send(SHELL_IPC.dshAction, action) })
  ipcMain.handle(SHELL_IPC.popupMenu, () => {})
  ipcMain.handle(SHELL_IPC.browserEmbeddedConfig, () => ({ enabled: false }))
  await app.whenReady()
  win = new BrowserWindow({ width: 1360, height: 900, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true,
    preload: join(root, 'dist/src/dsh-view-preload.cjs'), backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  await win.loadURL(server.url)
  await until(() => win.webContents.executeJavaScript(`!!document.querySelector('[data-dcu-settings-trigger]')`), 'Real codex-ui did not load')
  await sleep(1200)
  const onboarding = await win.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/稍后配置|Set up later/i.test(e.textContent));if(b)b.dataset.settingsTestDismiss='true';return !!b})()`)
  if (onboarding) await click(win.webContents, '[data-settings-test-dismiss]')
  await until(() => win.webContents.executeJavaScript(`![...document.querySelectorAll('button')].some(e=>/稍后配置|Set up later/i.test(e.textContent)&&e.getBoundingClientRect().width>0)`), 'Onboarding still obstructs settings')
  results.push({ name: 'real Profile Loader loaded codex-ui', pass: true, origin })
  shellWin = new BrowserWindow({ width: 1360, height: 160, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true,
    preload: join(root, 'dist/src/shell-preload.cjs'), backgroundThrottling: false } })
  await shellWin.loadFile(join(root, 'assets/shell.html'))
  await click(shellWin.webContents, '#settings-btn')
  await until(() => win.webContents.executeJavaScript(`!!document.querySelector('.dcu-settings-nav')`), 'Shell click did not open DSH settings')
  await win.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('.dcu-settings-nav button')].filter(e=>e.textContent.trim()==='通知');if(e.length!==1)throw new Error('Expected one notifications settings entry, got '+e.length);e[0].click()})()`)
  await until(() => win.webContents.executeJavaScript(`!!document.querySelector('[data-dsh-desktop-settings]')`), 'Desktop child did not mount')
  const child = () => win.webContents.mainFrame.frames.find(f => f.url === 'about:srcdoc')
  async function clickChild(selector) {
    await child().executeJavaScript(`if(!window.__testClicks){window.__testClicks=[];document.addEventListener('click',e=>window.__testClicks.push({tag:e.target.tagName,id:e.target.id,cls:e.target.className}),true)}`)
    await child().executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`)
    await sleep(80)
    const point = await child().executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    const offset = await win.webContents.executeJavaScript(`(()=>{const f=document.querySelector('[data-dsh-desktop-settings]'),r=f.getBoundingClientRect();return {x:r.x,y:r.y}})()`)
    assert.equal(await win.webContents.executeJavaScript(`document.elementFromPoint(${offset.x + point.x},${offset.y + point.y})===document.querySelector('[data-dsh-desktop-settings]')`), true, 'Iframe click is occluded')
    win.webContents.focus()
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
    const { targetInfos } = await win.webContents.debugger.sendCommand('Target.getTargets')
    const target = targetInfos.find(t => t.type === 'iframe' && t.url === 'about:srcdoc')
    const sessionId = target ? (await win.webContents.debugger.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId : undefined
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type,
      x: sessionId ? point.x : offset.x + point.x, y: sessionId ? point.y : offset.y + point.y, button: 'left', clickCount: 1 }, sessionId)
    if (sessionId) await win.webContents.debugger.sendCommand('Target.detachFromTarget', { sessionId })
    await sleep(100)
    clickTrace.push({ selector, point, offset, target: target?.type, events: await child().executeJavaScript('window.__testClicks') })
  }
  await until(async () => child() && await child().executeJavaScript(`document.querySelector('#approvalsEnabled')?.checked===true`), 'Settings IPC bootstrap failed')
  results.push({ name: 'real shell click to DSH settings to sandbox child using real preload and main IPC', pass: true })
  await clickChild('label[for="approvalsEnabled"] .track')
  await until(() => fs.existsSync(join(scratch, 'notifications.json')), 'Notification preference did not persist')
  assert.equal(JSON.parse(fs.readFileSync(join(scratch, 'notifications.json'))).approvalsEnabled, false)
  await clickChild('#appearanceNav'); await clickChild('[data-theme-id="gold"]')
  await until(() => fs.existsSync(join(scratch, 'theme.json')), 'Theme preference did not persist')
  assert.equal(JSON.parse(fs.readFileSync(join(scratch, 'theme.json'))).preset, 'gold')
  await clickChild('#updatesNav'); await clickChild('#policyButton'); await clickChild('#policyList [data-value="manual"]')
  await until(() => fs.existsSync(join(scratch, 'update.json')), 'Update policy did not persist')
  assert.equal(JSON.parse(fs.readFileSync(join(scratch, 'update.json'))).policy, 'manual')
  results.push({ name: 'original notification theme update-policy persistence writes only isolated paths', pass: true })
  for (const width of [1360, 1000]) for (const zoom of [0.9, 1, 1.1]) {
    win.setContentSize(width, 900); win.webContents.setZoomFactor(zoom)
    await sleep(150)
    const geometry = await win.webContents.executeJavaScript(`(()=>{const f=document.querySelector('[data-dsh-desktop-settings]'),r=f.getBoundingClientRect();return {x:r.x,right:r.right,width:r.width,viewport:innerWidth}})()`)
    assert.ok(geometry.x >= 0 && geometry.right <= geometry.viewport + 1 && geometry.width > 200)
    assert.equal(await child().executeJavaScript(`document.querySelector('main').scrollWidth<=document.querySelector('main').clientWidth+1`), true)
    assert.equal(await child().executeJavaScript(`new Set([...document.querySelectorAll('aside .nav-item')].map(e=>Math.round(e.getBoundingClientRect().top))).size===1`), true, 'Three settings tabs must share one row')
    results.push({ name: `real settings geometry ${width}/${zoom}`, pass: true, ...geometry })
  }
  win.webContents.setZoomFactor(1); win.setContentSize(1360, 900)
  await child().executeJavaScript(`document.getElementById('notificationsNav').click()`)
  await sleep(250)
  fs.writeFileSync(join(out, 'real-profile-settings.png'), (await win.webContents.capturePage()).toPNG())
  await child().executeJavaScript(`window.dshShell.closeDesktopSettings()`)
  await until(() => win.webContents.executeJavaScript(`!document.querySelector('.dcu-settings-nav')`), 'Embedded Escape/close did not return to app')
  await click(shellWin.webContents, '#settings-btn')
  await until(() => win.webContents.executeJavaScript(`!!document.querySelector('.dcu-settings-nav')`), 'Settings reopen failed')
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.dcu-settings-nav button')].find(e=>e.textContent.trim()==='通知').click()`)
  await until(async () => child() && await child().executeJavaScript(`document.querySelector('#approvalsEnabled')?.checked===false && window.DshThemes?.current()==='gold'`), 'Remounted settings did not reload saved preferences')
  results.push({ name: 'close remount and reload preferences without leaked listeners', pass: true })
  const denied = await win.webContents.executeJavaScript(`dshDesktopShell.desktopSettings.request({method:'browserPanelExecuteJs'}).then(()=>false,()=>true)`)
  assert.equal(denied, true)
  results.push({ name: 'real IPC rejects unknown capabilities', pass: true })
  fallback = new BrowserWindow({ width: 860, height: 700, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true,
    preload: join(root, 'dist/src/shell-preload.cjs'), backgroundThrottling: false } })
  await fallback.loadFile(join(root, 'assets/settings.html'), { query: { theme: 'light', preset: 'gold' } })
  await until(() => fallback.webContents.executeJavaScript(`document.querySelector('#approvalsEnabled')?.checked===false && !document.querySelector('#settingsError').textContent`), 'Standalone fallback did not load original shared preferences')
  await click(fallback.webContents, '#updatesNav')
  assert.equal(await fallback.webContents.executeJavaScript(`!document.querySelector('#updatesPage').hidden`), true)
  results.push({ name: 'standalone settings file and original IPC remain usable without DSH navigation', pass: true })
  fs.writeFileSync(join(out, 'results.json'), JSON.stringify({ status: 'pass', scope: 'isolated-real-profile-preload-main-ipc-preferences; updater execution not exercised', uiVersion, bundled, results, errors, channels, scratch, clickTrace }, null, 2))
  console.log(`PASS ${results.length} real Profile checks; preferences only in isolated fixture`)
}
async function finish(code) {
  if (finished) return; finished = true; clearTimeout(timeout)
  fallback?.destroy(); shellWin?.destroy(); win?.destroy(); await server?.stop().catch(() => {})
  // Keep the small isolated fixture for diagnosis. No recursive deletion of linked packages.
  app.exit(code)
}
run().then(() => finish(0), async error => {
  if (win && !win.isDestroyed()) {
    fs.writeFileSync(join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG())
    fs.writeFileSync(join(out, 'failure-page.txt'), await win.webContents.executeJavaScript('document.body.innerText'))
  }
  fs.writeFileSync(join(out, 'failure.json'), JSON.stringify({ error: String(error), results, errors, scratch, clickTrace, serverDiagnostics }, null, 2))
  console.error(String(error)); await finish(1)
})
