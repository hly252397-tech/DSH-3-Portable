// Isolated Electron integration fixture. Never starts DSH or touches the active profile.
const { app, BrowserWindow, WebContentsView } = require('electron')
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')
const { stripTypeScriptTypes } = require('node:module')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const out = resolve('customizations/audit-fixes/20260927/electron-surface')
mkdirSync(out, { recursive: true })
app.setPath('userData', resolve('Tools/audit-upgrade-20260927/electron-fixture'))
app.setPath('sessionData', resolve('Tools/audit-upgrade-20260927/electron-fixture'))
const pause = ms => new Promise(done => setTimeout(done, ms))
const results = []
let window, view
let phase = 'startup'
function extract(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, 'Missing function ' + name)
  const end = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, end < 0 ? undefined : end)
}
async function run() {
  await app.whenReady()
  phase = 'load isolated view'
  window = new BrowserWindow({ width: 1000, height: 720, title: 'DSH isolated surface verification', show: true })
  // This is an interactive fixture, not a background helper. Keep only its own
  // short-lived window above other apps so native occlusion cannot pause RAF.
  window.setAlwaysOnTop(true); window.show(); window.focus()
  // Production loads the shell document before attaching DSH. An uninitialized
  // host renderer can leave the child compositor without foreground frames.
  await window.loadURL('data:text/html,<title>DSH isolated surface verification</title><body style="margin:0;background:white">Isolated shell</body>')
  view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
  window.contentView.addChildView(view)
  await view.webContents.loadURL('data:text/html,' + encodeURIComponent('<style>body{background:#eff5ff;font:18px sans-serif}button{position:absolute;left:20px;top:20px;width:180px;height:40px}input{position:absolute;left:20px;top:80px}p{margin-top:150px}</style><button onclick="window.clicks=(window.clicks||0)+1;this.textContent=window.clicks">Click test</button><input id="text"><p>Isolated DSH surface fixture — no conversations or services loaded.</p>'))
  const timers = new Set()
  await view.webContents.executeJavaScript('window.addEventListener("mousedown",e=>window.lastMouse={x:e.clientX,y:e.clientY,target:e.target.tagName});')
  const context = vm.createContext({ process, dshView: view, SHELL_BAR_HEIGHT: 42,
    mainWindowContentSuppressed: false, mainWindowLayoutDeferred: false,
    broadcastShellState() {}, publishBrowserPanelMaxWidth() {}, capBrowserWorkspacePanelWidth: w => w,
    shouldHideBrowserPanel: () => false, publishLayoutContext() {},
    setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn() }, ms); timers.add(id); return id },
    clearTimeout(id) { timers.delete(id); clearTimeout(id) },
  })
  const source = readFileSync('src/main.ts', 'utf8')
  for (const name of ['layoutDshView', 'setMainWindowContentVisible', 'installWindowSurfaceGuard']) {
    vm.runInContext(stripTypeScriptTypes(extract(source, name)), context)
  }
  const oldSource = execFileSync('git', ['show', 'HEAD:src/main.ts'], { encoding: 'utf8', windowsHide: true })
  const oldContext = vm.createContext({ ...context, mainWindowLayoutDeferred: true })
  vm.runInContext(stripTypeScriptTypes(extract(oldSource, 'layoutDshView')), oldContext)
  view.setBounds({ x: 0, y: 42, width: 100, height: 100 })
  oldContext.layoutDshView(window)
  assert.equal(view.getBounds().width, 100, 'Old source reproduces stale hit-test bounds during deferred transition')
  context.mainWindowLayoutDeferred = true
  context.layoutDshView(window)
  assert.equal(view.getBounds().width, window.getContentBounds().width)
  results.push({ name: 'old stale transition reproduced; new native bounds synchronized', ok: true })
  context.mainWindowLayoutDeferred = false
  context.installWindowSurfaceGuard(window)
  window.on('resize', () => context.layoutDshView(window))
  const { parseForwardedInput } = await import(pathToFileURL(resolve('dist/src/shell-input.js')).href)
  let expectedClicks = 0
  for (const width of [1000, 1400, 900]) {
    window.setSize(width, 720)
    await pause(350)
    for (const zoom of [0.8, 1, 1.5]) {
      view.webContents.setZoomFactor(zoom)
      context.layoutDshView(window)
      phase = `click size=${width} zoom=${zoom}`
      // Native click checks need a foreground window. Waiting for RAF before
      // focusing can hang forever when Windows occlusion throttles the view.
      window.show(); window.focus(); view.webContents.focus()
      await Promise.race([
        view.webContents.executeJavaScript('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))'),
        pause(5000).then(async () => { throw new Error('No foreground frame: ' + phase + ' ' + JSON.stringify({
          visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(), opacity: window.getOpacity(),
          bounds: view.getBounds(), page: await view.webContents.executeJavaScript('({visibility:document.visibilityState,width:innerWidth,height:innerHeight})'),
        })) }),
      ])
      await pause(250)
      assert.equal(await view.webContents.executeJavaScript('document.visibilityState'), 'visible')
      window.focus(); view.webContents.focus()
      const bounds = view.getBounds()
      assert.equal(bounds.width, window.getContentBounds().width)
      for (const type of ['mousedown', 'mouseup']) view.webContents.sendInputEvent(parseForwardedInput({ type, x: 60 * zoom, y: 40 * zoom }, bounds.width, bounds.height))
      await pause(150)
      assert.equal(await view.webContents.executeJavaScript('window.clicks'), ++expectedClicks, JSON.stringify(await view.webContents.executeJavaScript('({mouse:window.lastMouse,dpr:devicePixelRatio,width:innerWidth})')))
      results.push({ name: `click size=${width} zoom=${zoom}`, ok: true })
    }
  }
  view.webContents.setZoomFactor(1)
  for (const action of ['maximize', 'unmaximize', 'minimize', 'restore']) {
    window[action]()
    await pause(450)
    if (action !== 'minimize') {
      assert.equal(window.getOpacity(), 1)
      assert.equal(context.mainWindowContentSuppressed, false)
      assert.equal(context.mainWindowLayoutDeferred, false)
      assert.equal(view.getBounds().width, window.getContentBounds().width)
      assert.equal(view.getBounds().height, window.getContentBounds().height - 42)
    }
    results.push({ name: action + ' lifecycle', ok: true })
  }
  // Resizing must not steal focus from the shell/settings/native browser layer.
  window.webContents.focus()
  context.layoutDshView(window)
  assert.equal(view.webContents.isFocused(), false)
  results.push({ name: 'layout does not steal focus', ok: true })
  writeFileSync(resolve(out, 'surface.png'), (await view.webContents.capturePage()).toPNG())
  window.emit('maximize')
  window.destroy()
  view.webContents.close()
  assert.equal(timers.size, 0, 'Closing cancels pending reveal callbacks')
  results.push({ name: 'close cancels transition timer', ok: true })
}
const watchdog = setTimeout(() => {
  const failure = JSON.stringify({ status: 'fail', results, error: 'Fixture timeout at ' + phase }, null, 2)
  writeFileSync(resolve(out, 'results.json'), failure)
  writeFileSync(resolve(out, 'failure-' + Date.now() + '.json'), failure)
  app.exit(1)
}, 45000)
run().then(() => {
  clearTimeout(watchdog)
  const report = { status: 'pass', electron: process.versions.electron, results }
  writeFileSync(resolve(out, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  app.exit(0)
}).catch(error => {
  clearTimeout(watchdog)
  const failure = JSON.stringify({ status: 'fail', results, error: String(error.stack) }, null, 2)
  writeFileSync(resolve(out, 'results.json'), failure)
  writeFileSync(resolve(out, 'failure-' + Date.now() + '.json'), failure)
  console.error(error)
  app.exit(1)
})
