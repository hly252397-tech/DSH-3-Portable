// Bounded live settings verification. No credentials request or task submission.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { activeUiProfile } from './lib/active-ui-profile.mjs'
const port = Number(process.argv[2])
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid live port')
const source = readFileSync(join(activeUiProfile(process.cwd()).profile, 'local/dsh-hj-workbench/lib/client.js'), 'utf8')
const token = source.match(/const BROKER_TOKEN = '([^']+)'/)?.[1]
if (!token) throw new Error('Existing local verification broker unavailable')
async function request(path, options) {
  const r = await fetch('http://127.0.0.1:8976' + path, { ...options, signal: AbortSignal.timeout(3000) })
  if (!r.ok) throw new Error('Verification broker HTTP ' + r.status)
  return r.json()
}
if ((await request('/status')).queued !== 0) throw new Error('Existing queued work; no probe submitted')
const expires = Date.now() + 30000
const code = `
if(location.origin!==${JSON.stringify('http://127.0.0.1:' + port)}||Date.now()>${expires})throw Error('Wrong origin or expired probe; no action');
const pause=()=>new Promise(r=>setTimeout(r,150));
async function until(fn){for(let i=0;i<40;i++){if(Date.now()>${expires})throw Error('Probe expired');if(fn())return;await pause()}throw Error('UI condition timeout')}
if(!document.querySelector('.dcu-settings-nav')){const e=document.querySelector('[data-dcu-settings-trigger]');if(!e)throw Error('Settings trigger missing');e.click();await until(()=>document.querySelector('.dcu-settings-nav'))}
const entries=[...document.querySelectorAll('.dcu-settings-nav button')].filter(e=>e.textContent.trim()==='多智能体交互管理');
if(entries.length!==1)throw Error('Expected one MCP settings entry, got '+entries.length);
entries[0].click();await until(()=>document.querySelector('[data-mcp-state]')?.dataset.mcpState==='online');
const page=document.querySelector('.dsh-mcp-settings');
if(/^[a-f0-9]{64}$/.test(page.querySelector('input[aria-label="Bearer 令牌"]')?.value||''))throw Error('Token not masked');
// The page was restructured into three channel cards plus collapsed detail groups.
// querySelector still pierces a collapsed <details>, so this also proves the
// credential field is present but not expanded by default.
const channels=['data-mcp-bridge-state','data-mcp-http-state','data-mcp-state'].map(a=>!!page.querySelector('['+a+']'));
if(channels.some(v=>!v))throw Error('Missing channel card: '+JSON.stringify(channels));
const groups=page.querySelectorAll('.dsh-mcp-settings details');
if(groups.length!==7)throw Error('Expected 7 collapsed groups, got '+groups.length);
if(page.querySelectorAll('.dsh-mcp-settings details[open]').length)throw Error('Something is expanded by default');
if(!page.querySelector('[data-mcp-alert="verify"]'))throw Error('Standing acceptance reminder missing');
const check=page.querySelector('[data-mcp-action="check"]');await until(()=>!check.disabled);check.click();
await until(()=>page.querySelector('[role=status]')?.textContent.includes('自检通过'));
const r=page.getBoundingClientRect();
return {origin:location.origin,entryCount:entries.length,online:true,tokenMasked:true,selfTest:page.querySelector('[role=status]').textContent,channels,groupCount:groups.length,layout:{x:r.x,right:r.right,width:r.width,viewport:innerWidth,overflow:page.scrollWidth>page.clientWidth+1},toolCount:page.querySelectorAll('ul li').length,hidden:document.hidden};`
const job = await request('/push?t=' + encodeURIComponent(token), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'page', code }) })
for (let i = 0; i < 70; i++) {
  await new Promise(r => setTimeout(r, 500))
  const status = await request('/status')
  if (status.last?.id !== job.id) continue
  const report = { sampledAt: new Date().toISOString(), id: job.id, ok: status.last.ok, result: status.last.result, error: status.last.error }
  writeFileSync('customizations/agent-mcp/evidence/settings/live.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  process.exit(status.last.ok ? 0 : 1)
}
throw new Error('Live probe timed out; no duplicate action queued')
