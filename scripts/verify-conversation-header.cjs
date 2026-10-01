// Isolated CSS regression. Reads installed CSS; never connects to the DSH service.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const { resolve, join } = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const out = resolve('customizations/audit-fixes/20260927/conversation-header')
const profile = resolve(process.argv[2])
const runtime = resolve(process.argv[3])
const scratch = resolve('Data/Temp/conversation-header-render')
fs.mkdirSync(scratch, { recursive: true })
app.setPath('userData', scratch); app.setPath('sessionData', scratch)
app.disableHardwareAcceleration()
const styles = source => [...source.matchAll(/\bconst css(?:\$\d+)? = ("(?:\\.|[^"\\])*");/g)].map(m => JSON.parse(m[1])).join('\n')
const native = ['dsh-client-ui-conversation', 'dsh-client-ui-subagent'].map(p => styles(fs.readFileSync(join(runtime, 'node_modules/@deepseek-ai', p, 'lib/client.js'), 'utf8'))).join('\n')
assert.ok(native.includes('.wSkVaW_headerActions{') && native.includes('.ZKlsPq_trigger{'))
const owner = fs.readFileSync(join(profile, 'local/dsh-sidebar-spaces/lib/client.js'), 'utf8').match(/const CONVERSATION_TOOLBAR_CSS = `([\s\S]*?)`;/)[1]
const tweaks = file => vm.runInNewContext(fs.readFileSync(file, 'utf8').match(/const CSS = (\[[\s\S]*?\]\.join\(''\));/)[1])
const before = tweaks(join(out, 'client-before.js'))
const after = tweaks('customizations/ui-tweaks/lib/client.js')
let window
const results = []
const timeout = setTimeout(() => { console.error('Header render timeout'); app.exit(1) }, 45000)
function html(css, width, count) {
  return `<html><head><style>${native}${owner}${css}
  body{margin:0;font:13px 'Segoe UI';background:#fff;color:#222;--dsw-alias-label-tertiary:#666;--dsw-alias-bg-base:white}
  #test{width:${width}px;height:350px}button{font:inherit;cursor:pointer}header{padding-bottom:10px!important}
  [data-dcu-inline-tabs]{display:flex;white-space:nowrap;height:28px} [data-dcu-inline-tabs] button{padding:4px 8px}
  </style></head><body><div id="test" class="wSkVaW_root"><header class="wSkVaW_header">
  <div class="wSkVaW_crumbs"><button class="wSkVaW_crumb">探索｜编码规则与工作区标题</button></div>
  <div class="wSkVaW_headerActions"><div class="ZKlsPq_root"><button class="ZKlsPq_trigger">${count} 个子智能体</button></div><button>标准模式</button></div>
  <div data-dcu-inline-tabs><button>对话</button><button>轨迹</button><button>上下文</button></div>
  <div class="wSkVaW_headerUtilities"><button>文件夹</button><button>⋯</button></div></header>
  <main class="wSkVaW_scrollBody">正文必须排在顶栏之后</main></div>
  <script>document.querySelectorAll('button').forEach(b=>b.onclick=()=>window.lastClick=b.textContent)</script></body></html>`
}
async function measure(css, width, count = 1) {
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(css, width, count)))
  return window.webContents.executeJavaScript(`(() => {
    const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const h=document.querySelector('header'),trigger=document.querySelector('.ZKlsPq_trigger'),tabs=document.querySelector('[data-dcu-inline-tabs]');
    const buttons=[...h.querySelectorAll('button')].map(e=>({text:e.textContent,...rect(e)}));
    const ranges=[...trigger.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).flatMap(n=>{const r=document.createRange();r.selectNodeContents(n);return [...r.getClientRects()].map(x=>x.height)});
    trigger.click(); const clicked=window.lastClick===trigger.textContent;
    return {header:rect(h),trigger:rect(trigger),tabs:rect(tabs),body:rect(document.querySelector('main')),buttons,lines:ranges.length,clicked};
  })()`)
}
async function run() {
  await app.whenReady()
  window = new BrowserWindow({ width: 1400, height: 420, show: false, webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false } })
  const old = await measure(before, 434)
  assert.ok(old.trigger.height > 28 || old.lines > 1, 'old 76px grid must reproduce wrapped badge')
  fs.writeFileSync(join(out, 'isolated-before.png'), (await window.webContents.capturePage()).toPNG())
  results.push({ check: 'old layout reproduction', pass: true, ...old })
  for (const zoom of [0.8, 1, 1.25, 1.5]) {
    window.webContents.setZoomFactor(zoom)
    for (const width of [280, 360, 434, 520, 521, 600, 760]) {
      for (const count of [1, 123]) {
        const s = await measure(after, width, count)
        assert.equal(s.lines, 1, `${width}: badge must remain one line`)
        assert.ok(s.trigger.height <= 28.1)
        assert.ok(s.body.top >= s.header.bottom - 1, 'body must follow full header height')
        assert.ok(s.buttons.every(b => b.left >= -0.5 && b.right <= width + 0.5 && b.top >= s.header.top && b.bottom <= s.header.bottom + 0.5), 'all header buttons contained')
        for (let i=0;i<s.buttons.length;i++) for(let j=i+1;j<s.buttons.length;j++) {
          const a=s.buttons[i],b=s.buttons[j];
          assert.ok(Math.min(a.right,b.right)-Math.max(a.left,b.left)<0.5 || Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<0.5, 'header buttons must not overlap')
        }
        assert.equal(s.clicked, true)
        results.push({check:`${width}/${zoom}/${count}`,pass:true,...s})
      }
    }
  }
  window.webContents.setZoomFactor(1)
  await measure(after, 434)
  fs.writeFileSync(join(out, 'isolated-after.png'), (await window.webContents.capturePage()).toPNG())
  fs.writeFileSync(join(out, 'isolated-results.json'), JSON.stringify({status:'pass',scope:'CSS fixture, not actual IPC',results},null,2))
  console.log(`PASS ${results.length} header CSS checks`)
}
run().catch(e=>{fs.writeFileSync(join(out,'isolated-results.json'),JSON.stringify({status:'fail',error:String(e),results},null,2));console.error(e);process.exitCode=1})
  .finally(()=>{clearTimeout(timeout);window?.destroy();app.exit(process.exitCode||0)})
