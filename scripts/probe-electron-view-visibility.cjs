// Minimal isolated diagnostic: no DSH profile, services or production modules.
const { app, BrowserWindow, WebContentsView } = require('electron')
const { resolve } = require('node:path')
const { mkdirSync, writeFileSync } = require('node:fs')
const out = resolve('customizations/audit-fixes/20260927/electron-visibility')
mkdirSync(out, { recursive: true })
app.setPath('userData', resolve('Tools/audit-upgrade-20260927/electron-visibility'))
const pause = ms => new Promise(r => setTimeout(r, ms))
const results = []
let window, view
async function sample(name) {
  await pause(800)
  results.push({ name, visible: window.isVisible(), viewVisible: view.getVisible(), bounds: view.getBounds(),
    page: await view.webContents.executeJavaScript('({visibility:document.visibilityState,width:innerWidth,height:innerHeight,frames:window.framesSeen})') })
}
const watchdog = setTimeout(() => { console.log('TIMEOUT', results); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1000, height: 720, show: true })
  if (process.argv.includes('--foreground-probe')) {
    window.setAlwaysOnTop(true); window.show(); window.focus()
  }
  await window.loadURL('data:text/html,Isolated host')
  view = new WebContentsView()
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 42, width: 984, height: 613 })
  await view.webContents.loadURL('data:text/html,<script>window.framesSeen=0;function tick(){window.framesSeen++;requestAnimationFrame(tick)}tick()</script>Visible test')
  await sample('initial')
  view.setBounds({ x: 0, y: 42, width: 100, height: 100 })
  await sample('small')
  view.setBounds({ x: 0, y: 42, width: 984, height: 613 })
  view.webContents.setZoomFactor(0.8)
  await sample('restored and zoomed')
  view.setVisible(false); view.setVisible(true)
  await sample('child hide/show')
  window.hide(); window.show(); window.focus()
  await sample('window hide/show')
  const report = { electron: process.versions.electron, results }
  writeFileSync(resolve(out, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  clearTimeout(watchdog); app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
