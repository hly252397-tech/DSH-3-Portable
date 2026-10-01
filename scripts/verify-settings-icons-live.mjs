// Read-only UI checks; no settings saved, credentials read, or tasks submitted.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { activeUiProfile } from './lib/active-ui-profile.mjs'
const port = Number(process.argv[2]), mode = process.argv[3]
if (!Number.isInteger(port) || port < 1 || port > 65535 || !['before', 'after', 'baseline'].includes(mode)) throw Error('Usage: port before|after|baseline')
const source = readFileSync(join(activeUiProfile(process.cwd()).profile, 'local/dsh-hj-workbench/lib/client.js'), 'utf8')
const token = source.match(/const BROKER_TOKEN = '([^']+)'/)?.[1]
if (!token) throw Error('Broker unavailable')
async function request(path, options) {
  const r = await fetch('http://127.0.0.1:8976' + path, { ...options, signal: AbortSignal.timeout(3000) })
  if (!r.ok) throw Error('Broker HTTP ' + r.status)
  return r.json()
}
if ((await request('/status')).queued !== 0) throw Error('Existing queued work; abort')
const expires = Date.now() + 30000
const code = `
if(location.origin!==${JSON.stringify('http://127.0.0.1:' + port)}||Date.now()>${expires})throw Error('Wrong origin or expired');
const pause=()=>new Promise(r=>setTimeout(r,200));
if(!document.querySelector('.dcu-settings-nav')){document.querySelector('[data-dcu-settings-trigger]')?.click();await pause()}
const buttons=()=>[...document.querySelectorAll('.dcu-settings-nav .dcu-settings-link')];
if(!buttons().length)throw Error('No live settings navigation');
const label=b=>b.querySelector(':scope > span')?.textContent.trim();
const original=label(buttons().find(b=>b.getAttribute('aria-current')==='page')||buttons()[0]);
const rows=buttons().map(b=>{const s=getComputedStyle(b,'::before');return {label:label(b),icon:b.getAttribute('data-dsh-settings-icon'),svg:b.querySelector('svg')?.innerHTML,svgDisplay:b.querySelector('svg')?getComputedStyle(b.querySelector('svg')).display:null,mask:s.maskImage,color:s.backgroundColor,width:s.width,height:s.height,pointer:s.pointerEvents}});
const expected=['内置插件','自定义空间','Agent 预设','通知','更新','多智能体交互管理'];
const selected=rows.filter(r=>expected.includes(r.label));
if(selected.length!==5)throw Error('Missing expected entries');
const checks=[];
if(${JSON.stringify(mode)}!=='before'){
 if(${JSON.stringify(mode)}==='after'&&(new Set(selected.map(r=>r.icon)).size!==5||selected.some(r=>!r.icon||r.mask==='none'||r.svgDisplay!=='none'||r.width!=='16px'||r.pointer!=='none')))throw Error('Icons not applied');
 try{for(const name of [...expected,'插件配置','连接器']){
 if(Date.now()>${expires})throw Error('Expired');
 const button=buttons().find(b=>label(b)===name);
 if(!button){checks.push({name,unavailable:true});continue}
 button.click();await pause();
 const active=buttons().find(b=>b.getAttribute('aria-current')==='page');
 const section=document.querySelector('.dcu-settings-inner')?.getAttribute('data-settings-section');
 const reached=label(active||document.createElement('button'))===name&&Boolean(section);
 checks.push({name,section,reached,stillRegistered:buttons().some(b=>label(b)===name)});
 if(!reached&&name!=='插件配置')throw Error('Navigation failed: '+name);
 }}finally{buttons().find(b=>label(b)===original)?.click();await pause()}
}
return {origin:location.origin,original,rows,checks,styleCount:document.querySelectorAll('[data-dsh-settings-icons-style]').length,viewport:{width:innerWidth,height:innerHeight}};`
const job = await request('/push?t=' + encodeURIComponent(token), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'page', code }) })
for (let i = 0; i < 70; i++) {
  await new Promise(r => setTimeout(r, 500))
  const status = await request('/status')
  if (status.last?.id !== job.id) continue
  const report = { sampledAt: new Date().toISOString(), ok: status.last.ok, result: status.last.result, error: status.last.error }
  const dir = 'customizations/ui-tweaks/evidence/settings-icons-20260928'
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, mode + '.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ok:report.ok, error:report.error, checks:report.result?.checks, entries:report.result?.rows?.map(r=>({label:r.label,icon:r.icon})), styleCount:report.result?.styleCount}))
  process.exit(report.ok ? 0 : 1)
}
throw Error('Probe timed out; no duplicate queued')
