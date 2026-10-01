// Isolated CSS fixture: does not connect to the user's DSH or modify session state.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const { resolve, join } = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const out = resolve('customizations/audit-fixes/20260927/sidebar-left-align')
const scratch = resolve('Data/Temp/sidebar-alignment-render')
fs.mkdirSync(scratch, { recursive: true })
app.setPath('userData', scratch); app.setPath('sessionData', scratch)
app.disableHardwareAcceleration()
const source = fs.readFileSync(join(resolve(process.argv[2]), 'node_modules/@michengai/dsh-codex-ui/lib/client.js'), 'utf8')
const native = [...source.matchAll(/\bconst [\w$]+ = `([^`]*\.dcu-wb-[^`]*)`;/g)].map(m => m[1]).join('\n')
assert.ok(native.includes('padding-left:30px') && native.includes('.dcu-wb-session-more'))
const css = file => vm.runInNewContext(fs.readFileSync(file, 'utf8').match(/const CSS = (\[[\s\S]*?\]\.join\(''\));/)[1])
const oldCSS = css(join(out, 'client-before.js'))
const newCSS = css('customizations/ui-tweaks/lib/client.js')
const results = []
const timeout = setTimeout(() => app.exit(1), 45000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 500, height: 380, webPreferences: { offscreen: true } })
  async function render(style, width, zoom, compact = false) {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${native}${style}
      *{box-sizing:border-box}body{margin:0;font:14px Arial;background:white;color:#222}.dcu-root{width:${width}px;padding:8px;--dcu-sidebar-primary:#222;--dcu-sidebar-hover:#eee;--dcu-sidebar-secondary:#666}.dcu-wb-project-head{border:0}button{font:inherit}
      </style><aside class="dcu-root ${compact ? 'dcu-compact' : ''}"><div class="dcu-wb-project">
      <button class="dcu-wb-project-head"><span>▱</span><span>项目</span></button>
      <div class="dcu-wb-project-body"><div class="dcu-wb-session" id="normal"><span class="dcu-wb-session-title">探索 | 较长会话标题用于检查省略</span><span class="dcu-wb-session-time">5天</span></div>
      <div class="dcu-wb-session" id="running"><span class="dcu-wb-running"></span><span class="dcu-wb-session-title">运行中的会话</span></div>
      <div class="dcu-wb-nochat">无聊天</div><div class="dcu-wb-session-more"><button>展开显示</button></div></div></div>
      <div class="dcu-wb-session dcu-wb-session-flat" id="recent"><span class="dcu-wb-session-title">最近会话</span></div></aside>`))
    win.webContents.setZoomFactor(zoom)
    return win.webContents.executeJavaScript(`(() => {
      const contentLeft = s => {const e=document.querySelector(s);return e.getBoundingClientRect().left+parseFloat(getComputedStyle(e).paddingLeft)};
      const rect = s => {const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right}};
      return {folder:contentLeft('.dcu-wb-project-head'),normal:contentLeft('#normal'),more:contentLeft('.dcu-wb-session-more button'),empty:contentLeft('.dcu-wb-nochat'),running:contentLeft('#running'),spinner:rect('.dcu-wb-running'),title:rect('#normal .dcu-wb-session-title'),time:rect('.dcu-wb-session-time'),recent:contentLeft('#recent')};
    })()`)
  }
  try {
    const before=await render(oldCSS,240,1)
    assert.equal(before.normal-before.folder,22)
    assert.equal(before.more-before.folder,30)
    results.push({before})
    for(const width of [180,240,320]) for(const zoom of [.8,1,1.25,1.5]) {
      const after=await render(newCSS,width,zoom)
      assert.ok(Math.abs(after.normal-after.folder)<1)
      assert.ok(Math.abs(after.more-after.folder)<1)
      assert.ok(Math.abs(after.empty-after.folder)<1)
      assert.ok(after.running>=after.spinner.right+5)
      assert.ok(after.title.right<after.time.left)
      assert.ok(Math.abs(after.recent-after.folder)<1)
      results.push({width,zoom,after})
    }
    const compactOld=await render(oldCSS,240,1,true),compactNew=await render(newCSS,240,1,true)
    assert.deepEqual(compactNew,compactOld)
    await render(newCSS,240,1)
    fs.writeFileSync(join(out,'fixture-after.png'),(await win.webContents.capturePage()).toPNG())
    fs.writeFileSync(join(out,'results.json'),JSON.stringify({status:'pass',scope:'CSS fixture only',results},null,2))
    console.log('PASS old indentation reproduced; 12 width/zoom combinations; compact unchanged')
    clearTimeout(timeout);win.destroy();app.quit()
  } catch(e) {console.error(e);app.exit(1)}
})
