// Bounded live desktop inspection. No preferences, messages, restart or update actions.
import { readFileSync, writeFileSync } from 'node:fs'
const port = Number(process.argv[2])
const action = process.argv[3] || 'inspect'
if (!Number.isInteger(port) || port < 1 || port > 65535 || !['inspect', 'open', 'desktop', 'close'].includes(action)) throw new Error('Invalid probe arguments')
const source = readFileSync('Data/DSH-generations/v4-rc2b/home/profiles/web/local/dsh-hj-workbench/lib/client.js', 'utf8')
const token = source.match(/const BROKER_TOKEN = '([^']+)'/)[1]
const base = 'http://127.0.0.1:8976'
async function request(path, options) {
  const r = await fetch(base + path, { ...options, signal: AbortSignal.timeout(3000) })
  if (!r.ok) throw new Error('Probe HTTP ' + r.status)
  return r.json()
}
if ((await request('/status')).queued !== 0) throw new Error('Another queued task; no action submitted')
const code = `
if(location.origin!==${JSON.stringify('http://127.0.0.1:' + port)})throw new Error('Wrong origin');
const action=${JSON.stringify(action)};
if(action!=='inspect'){
 if(!window.dshDesktopShell?.desktopSettings)throw new Error('Not the new desktop bridge; no click');
 const selector=action==='open'?'[data-dcu-settings-trigger]':'.dcu-settings-nav button';
 const el=action==='open'?document.querySelector(selector):[...document.querySelectorAll(selector)].find(e=>e.textContent.trim()===(action==='desktop'?'通知':'返回应用'));
 if(!el)throw new Error('Target unavailable; no click');
 el.click();await new Promise(r=>setTimeout(r,500));
}
const frame=document.querySelector('[data-dsh-desktop-settings]');
return {origin:location.origin,title:document.title,hidden:document.hidden,viewport:{w:innerWidth,h:innerHeight,dpr:devicePixelRatio},bridge:!!window.dshDesktopShell,settingsBridge:!!window.dshDesktopShell?.desktopSettings,buttonCount:document.querySelectorAll('button').length,nav:[...document.querySelectorAll('.dcu-settings-nav button')].map(e=>e.textContent.trim()),frame:frame?{sandbox:frame.getAttribute('sandbox'),width:frame.getBoundingClientRect().width,height:frame.getBoundingClientRect().height}:null};`
const job = await request('/push?t=' + encodeURIComponent(token), { method: 'POST', headers: {'content-type':'application/json'}, body:JSON.stringify({kind:'page',code}) })
for(let i=0;i<60;i++){
  await new Promise(r=>setTimeout(r,500))
  const s=await request('/status')
  if(s.last?.id!==job.id)continue
  const report={id:job.id,action,ok:s.last.ok,result:s.last.result,error:s.last.error}
  writeFileSync('customizations/audit-fixes/20260927/settings-entry/live-'+action+'-20260928.json',JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
  process.exit(s.last.ok?0:1)
}
throw new Error('Probe timed out; do not duplicate queued action')
