// Bounded checks through the already-running local UI probe; never sends model messages.
import { readFileSync, writeFileSync } from 'node:fs'
const allowed = new Set(['inspect', 'settings', 'spaces', 'probe', 'close'])
const action = process.argv[2] || 'inspect'
if (!allowed.has(action)) throw new Error('Unknown verification action')
const verifiedPort = Number(process.argv[3])
if (!Number.isInteger(verifiedPort) || verifiedPort < 1 || verifiedPort > 65535) throw new Error('Supply the port verified against the active backend PID')
const source = readFileSync('Data/DSH-generations/v4-rc2b/home/profiles/web/local/dsh-hj-workbench/lib/client.js', 'utf8')
const token = source.match(/const BROKER_TOKEN = '([^']+)'/)[1]
const base = 'http://127.0.0.1:8976'
async function request(path, options) {
  const res = await fetch(base + path, { ...options, signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error('Probe HTTP ' + res.status)
  return res.json()
}
const status = await request('/status')
if (status.queued !== 0) throw new Error('Another queued UI task; no command submitted')
const code = `
if (location.origin !== ${JSON.stringify('http://127.0.0.1:' + verifiedPort)}) throw new Error('Not the verified DSH page: '+location.origin);
const action=${JSON.stringify(action)};
let probeResponse=null;
if(action==='close') {
 const back=[...document.querySelectorAll('.dcu-settings-nav button')].find(e=>e.textContent.trim()==='返回应用');
 back?.click();
}
if(action==='settings') {
 if(!document.querySelector('.dcu-settings-nav')) {
  const trigger=document.querySelector('[data-dcu-settings-trigger]');
  if(!trigger) throw new Error('Settings trigger missing');
  trigger.click();
 }
}
if(action==='spaces') {
 const nav=[...document.querySelectorAll('.dcu-settings-nav button')].find(e=>e.textContent.trim()==='自定义空间');
 if(!nav) throw new Error('Spaces navigation missing; no click');
 nav.click();
}
if(action==='probe') {
 const button=[...document.querySelectorAll('.hjw-service-section button')].find(e=>e.textContent==='只探活');
 if(!button || button.disabled) throw new Error('Probe button unavailable');
 // Observe the real button's request, pass every fetch through, then restore immediately.
 const originalFetch=window.fetch;
 let pending=null;
 const observe=function(input,options) {
  const result=originalFetch.call(this,input,options);
  if(String(input).endsWith('/api/dsh-hj-workbench/status')) pending=result.then(async response=>({status:response.status,method:options?.method||'GET',running:(await response.clone().json()).running}));
  return result;
 };
 try {
  window.fetch=observe;
  button.click();
 } finally { if(window.fetch===observe) window.fetch=originalFetch; }
 if(!pending) throw new Error('Probe click did not issue its request');
 probeResponse=await pending;
}
const card=document.querySelector('.hjw-service-section');
return {
 url:location.origin,probeResponse,nav:[...document.querySelectorAll('.dcu-settings-nav button')].map(e=>e.textContent.trim()),
 headings:[...document.querySelectorAll('.hjw-service-title')].map(e=>e.textContent),
 form:!!document.querySelector('.dcs-form'),inputs:document.querySelectorAll('.dcs-form input').length,
 buttons:[...document.querySelectorAll('.hjw-service-section button')].map(e=>({text:e.textContent,disabled:e.disabled})),
 serviceText:card?.innerText, viewport:{width:innerWidth,height:innerHeight},
 card:card?(()=>{const r=card.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,scrollWidth:card.scrollWidth,clientWidth:card.clientWidth}})():null,
 statusRequests:performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/dsh-hj-workbench/status')).length,
 settingsStyle: (()=>{const e=document.querySelector('.dcu-settings-page');return e?{position:getComputedStyle(e).position,display:getComputedStyle(e).display,styles:[...document.querySelectorAll('style')].filter(s=>s.textContent.includes('.dcu-settings-page{')).map(s=>({length:s.textContent.length,disabled:s.sheet?.disabled,rules:s.sheet?.cssRules.length}))}:null})(),
};`
const job = await request('/push?t=' + encodeURIComponent(token), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'page', code }) })
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 500))
  const s = await request('/status')
  if (s.last?.id !== job.id) continue
  if (!s.last.ok) throw new Error(s.last.error)
  writeFileSync(`customizations/audit-fixes/20260927/spaces-service-merge/live-${action}.json`, JSON.stringify(s.last.result, null, 2))
  console.log(JSON.stringify(s.last.result));process.exit(0)
}
throw new Error('UI result timed out; not verified (do not duplicate queued actions)')
