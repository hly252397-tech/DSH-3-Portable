// Real disposable Profile + Loader. Never loads user settings or submits a task.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), mode = process.argv.includes('--fixed') ? 'fixed' : 'before';
const out = path.join(root, 'customizations/ui-tweaks/evidence/plugin-config-20260928');
fs.mkdirSync(out, { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, 'Data/Temp/plugin-config-profile-'));
const home = path.join(scratch, 'home'), profile = path.join(home, 'profiles/web'), nm = path.join(profile, 'node_modules');
fs.mkdirSync(nm, { recursive: true });
app.setPath('userData', path.join(scratch, 'electron'));app.disableHardwareAcceleration();
let server, win, finished = false;
const errors = [], results = [], sleep = ms => new Promise(r => setTimeout(r, ms));
function link(target, dest) { fs.mkdirSync(path.dirname(dest), { recursive: true });fs.symlinkSync(target, dest, 'junction'); }
const js = code => win.webContents.executeJavaScript(code);
async function until(fn, message, ms = 20000) { const end = Date.now() + ms;while (Date.now() < end) { if (await fn()) return;await sleep(150); }throw Error(message); }
async function click(selector) {
 const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 await sleep(100);const z = win.webContents.getZoomFactor(), x = Math.round(point.x*z), y = Math.round(point.y*z);
 win.webContents.sendInputEvent({type:'mouseMove',x,y});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x,y});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x,y});await sleep(500);
}
async function open() {
 await until(()=>js(`!!document.querySelector('[data-dcu-settings-trigger]')`),'settings trigger missing');
 await sleep(800);
 if(await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/稍后配置|Set up later/i.test(e.textContent));if(b)b.dataset.dismissProbe='1';return !!b})()`))await click('[data-dismiss-probe]');
 await click('[data-dcu-settings-trigger]');
 await until(()=>js(`!!document.querySelector('.dcu-settings-nav')`),'settings missing');
 await js(`(()=>{const b=[...document.querySelectorAll('.dcu-settings-link')].find(e=>e.textContent.trim()==='插件配置');if(!b)throw Error('Plugin config missing before click');b.dataset.configProbe='1'})()`);
 await click('[data-config-probe]');await sleep(1500);
}
async function run() {
 const { activeUiProfile } = await import(pathToFileURL(path.join(root,'scripts/lib/active-ui-profile.mjs')));
 const active = activeUiProfile(root), runtime = active.runtime;
 link(path.join(runtime,'node_modules/@deepseek-ai'),path.join(nm,'@deepseek-ai'));
 link(path.join(active.profile,'node_modules/@michengai/dsh-codex-ui'),path.join(nm,'@michengai/dsh-codex-ui'));
 const bundles=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@michengai/dsh-codex-ui'];
 if(mode==='fixed') { link(path.join(root,'customizations/ui-tweaks'),path.join(nm,'dsh-ui-tweaks'));bundles.push('dsh-ui-tweaks'); }
 fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({name:'plugin-config-verification',private:true,dsh:{profile:{bundles}}}));
 fs.writeFileSync(path.join(profile,'cordis.patch.yml'),'- id: workspace-controller\n  config:\n    documentsDirectory: '+JSON.stringify(path.join(scratch,'documents'))+'\n');
 const { startDsh } = await import(pathToFileURL(path.join(root,'dist/src/dsh-process.js')));
 server=await startDsh({nodeExecutable:path.join(root,'Tools/node-v26.10.0/node.exe'),bootstrapPath:path.join(root,'dist/src/dsh-bootstrap.mjs'),runtime:{root:runtime,entry:path.join(runtime,'node_modules/@deepseek-ai/dsh/lib/bin.js')},workingDirectory:scratch,environment:{DSH_HOME:home,DSH_PROFILE_DIR:profile,DSH_PROFILE_NAME:'web',DSH_RUNTIME_DIR:runtime,TEMP:scratch,TMP:scratch,NODE_OPTIONS:'',npm_config_offline:'true'},startupTimeoutMs:60000});
 await app.whenReady();win=new BrowserWindow({show:false,width:1360,height:950,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>{if(e.level==='error'||e.level==='warning')errors.push(e.message.replace(/[a-f0-9]{64}/g,'[redacted]'))});
 await win.loadURL(server.url);await open();
 const state=await js(`({section:document.querySelector('.dcu-settings-inner')?.dataset.settingsSection,configPage:!!document.querySelector('.dcu-plugin-config'),panel:!!document.querySelector('[data-plugin-panel]'),entry:[...document.querySelectorAll('.dcu-settings-link')].some(e=>e.textContent.trim()==='插件配置'),text:document.querySelector('.dcu-settings-inner')?.innerText.slice(0,1400)})`);
 results.push(state);
 fs.writeFileSync(path.join(out,mode+'.png'),(await win.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(out,mode+'.json'),JSON.stringify({mode,results,errors,scratch},null,2));
 console.log(JSON.stringify({mode,results,errors}));
 if(mode==='fixed')assert.ok(state.entry&&state.panel&&state.section==='plugin-config');
}
async function finish(code){if(finished)return;finished=true;clearTimeout(deadline);win?.destroy();await server?.stop().catch(()=>{});app.exit(code)}
const deadline=setTimeout(()=>{console.error('Probe timeout');void finish(1)},120000);
run().then(()=>finish(0),error=>{fs.writeFileSync(path.join(out,mode+'-error.json'),JSON.stringify({error:String(error),errors,scratch},null,2));console.error(String(error));void finish(1)});
