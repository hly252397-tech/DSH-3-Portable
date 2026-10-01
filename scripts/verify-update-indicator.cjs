// Offscreen renderer only: no DSH service, account, profile or update operation.
const { app, BrowserWindow } = require('electron')
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const assert = require('node:assert/strict')
const out = resolve('customizations/audit-fixes/20260927/settings-entry/update-indicator')
const scratch = resolve('Data/Temp/update-indicator-render')
mkdirSync(out, { recursive: true })
mkdirSync(scratch, { recursive: true })
app.setPath('userData', scratch)
app.setPath('sessionData', scratch)
app.disableHardwareAcceleration()
const oldPath = process.argv[2]
let window
const results = []
const timeout = setTimeout(() => { console.error('Offscreen render timed out'); app.exit(1) }, 45000)
function documentFor(source) {
  const render = source.match(/function renderDesktopUpdate\(value\)\{[\s\S]*?\n    \}/)[0]
  const body = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('<link rel="stylesheet" href="theme.css">', `<style>${readFileSync('assets/theme.css', 'utf8')}</style>`)
    .replace(/src="(shell-icons\/[^"<>]+)"/g, (_, name) => `src="data:image/svg+xml;base64,${readFileSync(join('assets', name)).toString('base64')}"`)
  return body.replace('</body>', `<script>function shellZh(){return true}${render}</script></body>`)
}
async function load(source) {
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(documentFor(source)))
}
async function sample(kind, progress = 1, theme = 'light') {
  return window.webContents.executeJavaScript(`(async () => {
    document.documentElement.dataset.colorScheme=${JSON.stringify(theme)};
    renderDesktopUpdate({packaged:true,status:{kind:${JSON.stringify(kind)},overallProgress:${progress}}});
    const b=document.getElementById('settings-btn')||document.getElementById('update-btn');
    getComputedStyle(b,'::before').opacity;
    await Promise.all(b.getAnimations({subtree:true}).filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
    const p=getComputedStyle(b,'::before'),badge=getComputedStyle(b,'::after'),r=b.getBoundingClientRect();
    const settings=document.querySelector('[data-action="settings"]').getBoundingClientRect();
    return {indicator:b.dataset.indicator,opacity:p.opacity,mask:p.maskImage,animation:p.animationName,
      pointerEvents:p.pointerEvents,badge:badge.opacity,disabled:b.disabled,width:r.width,height:r.height,
      gap:b.id==='settings-btn'?0:r.left-settings.right,progress:b.style.getPropertyValue('--update-progress')};
  })()`)
}
async function run() {
  await app.whenReady()
  window = new BrowserWindow({ width: 1360, height: 220, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const source = readFileSync('assets/shell.html', 'utf8')
  if (oldPath) {
    await load(readFileSync(oldPath, 'utf8'))
    const before = await sample('checking')
    assert.equal(before.mask, 'none', 'old running artifact reproduces solid wedge')
    assert.equal(before.opacity, '1')
    writeFileSync(join(out, 'before.png'), (await window.webContents.capturePage()).toPNG())
    results.push({ name: 'old artifact control', pass: true, before })
  }
  await load(source)
  for (const width of [900, 1360]) {
    window.setContentSize(width, 220)
    for (const zoom of [0.8, 1, 1.25, 1.5]) {
      window.webContents.setZoomFactor(zoom)
      for (const theme of ['light', 'dark']) {
        for (const kind of ['checking', 'downloading', 'verifying', 'building', 'deploying', 'validating', 'completed', 'error', 'rolled-back', 'none', 'idle', 'available', 'ready']) {
          const s = await sample(kind, 1, theme)
          const busy = ['checking', 'downloading', 'verifying', 'building', 'deploying', 'validating'].includes(kind)
          assert.equal(s.indicator, !busy ? 'none' : kind === 'downloading' ? 'progress' : 'spinner')
          assert.equal(s.opacity, busy ? '1' : '0')
          assert.notEqual(s.mask, 'none')
          assert.equal(s.pointerEvents, 'none')
          assert.equal(s.disabled, false)
          assert.equal(s.animation, busy && kind !== 'downloading' ? 'update-indicator-spin' : 'none')
          assert.ok(s.width >= 29 && s.height >= 29 && s.gap >= 0, 'toolbar geometry retained')
          if (kind === 'completed') assert.equal(s.badge, '0')
          results.push({ name: `${width}/${zoom}/${theme}/${kind}`, pass: true, ...s })
        }
      }
    }
  }
  window.webContents.setZoomFactor(1)
  window.setContentSize(1360, 220)
  for (const kind of ['checking', 'downloading', 'completed']) {
    await sample(kind, 1)
    writeFileSync(join(out, `${kind}.png`), (await window.webContents.capturePage()).toPNG())
  }
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  const reduced = await sample('checking')
  assert.equal(reduced.animation, 'none')
  results.push({ name: 'reduced motion', pass: true, ...reduced })
  window.webContents.debugger.detach()
  writeFileSync(join(out, 'results.json'), JSON.stringify({ status: 'pass', scope: 'isolated-offscreen-not-deployed', electron: process.versions.electron, results }, null, 2))
  console.log(`PASS ${results.length} offscreen checks; ${out}`)
}
run().catch(error => {
  writeFileSync(join(out, 'results.json'), JSON.stringify({ status: 'fail', error: String(error), results }, null, 2))
  console.error(error); process.exitCode = 1
}).finally(() => { clearTimeout(timeout); window?.destroy(); app.exit(process.exitCode || 0) })
