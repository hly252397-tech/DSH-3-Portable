// Isolated actual Profile/Loader, canonical earthquake host/client and Codex UI.
// Local upstream fixtures are the only data source. No production preference,
// task, notification, audio, update, restart or deployment is performed.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), http = require('node:http'), assert = require('node:assert/strict')
const { join, dirname, resolve, relative, isAbsolute, parse } = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const childProcess = require('node:child_process'), { syncBuiltinESMExports } = require('node:module')
const root = resolve(__dirname, '..'), args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--legacy-plugin-dir', 'Only --legacy-plugin-dir is supported')
const legacy = args.length > 0, pluginSource = legacy ? resolve(args[1]) : join(root, 'plugins/dsh-earthquake-alert')
function ordinary(directory) {
  const absolute = resolve(directory), lower = value => process.platform === 'win32' ? value.toLowerCase() : value
  assert.equal(lower(fs.realpathSync(absolute)), lower(absolute), 'Fixture/evidence ancestor follows a junction')
  for (let cursor = absolute; cursor !== parse(cursor).root; cursor = dirname(cursor)) {
    const item = fs.lstatSync(cursor)
    assert.ok(item.isDirectory() && !item.isSymbolicLink(), 'Fixture/evidence ancestor is not ordinary')
  }
  return absolute
}
function plainJson(file) {
  ordinary(dirname(file)); const item = fs.lstatSync(file)
  assert.ok(item.isFile() && !item.isSymbolicLink() && item.nlink === 1 && item.size < 1024 * 1024, 'Unsafe fixture metadata')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function installedPackage(file) {
  // The immutable runtime is legitimately deduplicated with hardlinks. Reading
  // its package identity is allowed; mutable fixtures/production metadata still
  // require a single ordinary link, and no installed package is ever written.
  ordinary(dirname(file)); const item = fs.lstatSync(file)
  assert.ok(item.isFile() && !item.isSymbolicLink() && item.size < 1024 * 1024)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
if (legacy) {
  const base = ordinary(join(root, 'Data/Development/earthquake-unification')), suffix = relative(base, pluginSource)
  assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'Legacy comparison must be an explicit Development backup')
}
ordinary(pluginSource); ordinary(join(root, 'Data/Development')); ordinary(join(root, 'Data/Temp'))
const evidenceRoot = join(root, 'Data/Development/earthquake-unification/runtime')
fs.mkdirSync(evidenceRoot, { recursive: true }); ordinary(evidenceRoot)
const out = join(evidenceRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID())
fs.mkdirSync(out); ordinary(out)
const scratch = fs.mkdtempSync(join(root, 'Data/Temp/earthquake-profile-')); ordinary(scratch)
const portable = join(scratch, 'portable'), home = join(portable, 'Data/DSH-home'), profile = join(home, 'profiles/web')
const nm = join(profile, 'node_modules'), prefsFile = join(portable, 'Data/Plugins/dsh-earthquake-alert/preferences.json')
fs.mkdirSync(nm, { recursive: true })
app.setName('DSH isolated earthquake verification')
app.setPath('userData', join(scratch, 'electron')); app.setPath('sessionData', join(scratch, 'electron'))
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {})
let win, server, upstream, origin, fixtureOrigin, finished = false, paintCount = 0, runtime, runtimeVersion, uiVersion, stage = 'preflight'
const results = [], errors = [], expectedErrors = [], clicks = [], screenshots = [], blockedRequests = [], feedRequests = [], sourceHashes = {}, sourceFiles = []
const startupDiagnostics = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sourceKey = file => relative(root, file).replace(/\\/g, '/')
const redact = value => String(value).replace(/([?&](?:token|authToken)=)[^\s&"']+/gi, '$1[redacted]')
function checkpoint(next) {
  stage = next
  fs.writeFileSync(join(out, 'checkpoint.json'), JSON.stringify({ stage, legacy, scratch, runtimeVersion, uiVersion, completedCases: results.length, clicks: clicks.length }, null, 2))
}
async function finite(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ISOLATED_STEP_TIMEOUT: ' + label)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
const js = expression => finite(win.webContents.executeJavaScript(expression), 12000, 'renderer executeJavaScript at ' + stage)
async function until(fn, message, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100) }
  throw new Error(message)
}
function fixturePath(name) {
  const path = resolve(scratch, name), suffix = relative(scratch, path)
  assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'Fixture escaped scratch')
  return path
}
function link(target, path) { fs.mkdirSync(dirname(path), { recursive: true }); fs.symlinkSync(target, path, 'junction') }
function copySource(base, names, destination) {
  for (const name of names) {
    const file = join(base, name), item = fs.lstatSync(file)
    assert.ok(item.isFile() && !item.isSymbolicLink() && item.nlink === 1, 'Canonical source is not ordinary')
    const expectedHash = hash(file)
    const to = join(destination, name); fs.mkdirSync(dirname(to), { recursive: true }); fs.copyFileSync(file, to)
    assert.equal(hash(to), expectedHash, 'Actual fixture copy differs from reported canonical bytes')
    assert.equal(hash(file), expectedHash, 'Canonical source changed while copied; evidence cannot proceed')
    sourceFiles.push(file); sourceHashes[sourceKey(file)] = expectedHash
  }
}
const productionFiles = ['Data/Updates/Desktop/pointer.json', 'Data/Updates/Desktop/state.json', 'Data/Runtime/Harness/current.json',
  'Data/Electron/UserData/desktop-settings.json', 'Data/Electron/UserData/desktop-update-settings.json',
  'Data/Electron/UserData/shell/theme.json', 'Data/Updates/Harness/policy.json', 'Data/Plugins/dsh-earthquake-alert/preferences.json']
function productionSnapshot() {
  return productionFiles.map(path => {
    const file = join(root, path); let item
    try { item = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return { path, present: false }; throw error }
    ordinary(dirname(file)); assert.ok(item.isFile() && !item.isSymbolicLink() && item.nlink === 1)
    return { path, present: true, sha256: hash(file), size: item.size, mtimeMs: item.mtimeMs }
  })
}
const sourceTime = milliseconds => new Date(milliseconds + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')
let fixture = { eew: null, list: [], eewStatus: 200, listStatus: 200, delay: 0 }
function event(id, age = 5, magnitude = 5.6, report = 1) {
  const originAt = Date.now() - age * 1000, reportAt = age < 0 ? originAt + 1000 : Date.now()
  return { EventID: id, OriginTime: sourceTime(originAt), ReportTime: sourceTime(reportAt), ReportNum: report,
    HypoCenter: '隔离演练·极长震中名称用于验证窄列换行和全局中文字形，不是真实地震', Magnitude: magnitude, Depth: 10, Latitude: 30, Longitude: 104, MaxIntensity: 5 }
}
async function startUpstream() {
  fixture.eew = event('fixture-future', -86400)
  fixture.list = Array.from({ length: 30 }, (_, index) => ({ EventID: 'list-' + index, time: sourceTime(Date.now() - (index + 1) * 3600000),
    location: '隔离速报·长地点名称验证列表可读性与本地滚动第' + index + '条，不是真实地震', magnitude: 3 + index / 100, depth: 10, latitude: 30, longitude: 104 }))
  upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, fixtureOrigin || 'http://127.0.0.1')
    const kind = url.pathname === '/eew' ? 'eew' : url.pathname === '/list' ? 'list' : null
    if (!kind) { res.writeHead(404); res.end(); return }
    const record = { kind, startedAt: Date.now(), status: fixture[kind + 'Status'], report: fixture.eew?.ReportNum, id: fixture.eew?.EventID }
    feedRequests.push(record); const body = structuredClone(fixture[kind]), delay = fixture.delay
    await sleep(delay)
    if (res.destroyed) { record.aborted = true; return }
    res.writeHead(record.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(record.status === 200 ? body : { fixture: 'upstream unavailable' })); record.finishedAt = Date.now()
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  fixtureOrigin = 'http://127.0.0.1:' + upstream.address().port
}
function installNetworkGuard() {
  const file = fixturePath('network-guard.cjs'), record = fixturePath('node-egress.jsonl'), allowedPort = new URL(fixtureOrigin).port
  // This hook is appended to, not substituted for, caller NODE_OPTIONS. It only
  // applies to our own DSH child; pipes and localhost fixture HTTP remain usable.
  fs.writeFileSync(file, `const fs=require('node:fs'),net=require('node:net');const port=${JSON.stringify(allowedPort)},record=${JSON.stringify(record)};function reject(host,p){fs.appendFileSync(record,JSON.stringify({host,port:p,at:Date.now()})+'\\n');throw Error('ISOLATED_EGRESS_FORBIDDEN')}const original=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){let a=args[0];if(Array.isArray(a))a=a[0];if(a&&typeof a==='object'&&a.path)return original.apply(this,args);let host=typeof a==='object'?a.host:typeof args[1]==='string'?args[1]:'localhost',p=typeof a==='object'?a.port:a;if(p!==undefined&&(!['127.0.0.1','localhost','::1'].includes(host)||String(p)!==port))reject(host,p);return original.apply(this,args)};const originalFetch=globalThis.fetch;globalThis.fetch=function(input,init){const u=new URL(typeof input==='string'?input:input.url||String(input));if(u.hostname!=='127.0.0.1'||u.port!==port)reject(u.hostname,u.port);return originalFetch(input,init)};`)
  return { file, record }
}
async function click(selector) {
  await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing mouse target');e.scrollIntoView({block:'center',inline:'nearest'})})()`)
  await sleep(120)
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);window.__quakeClick=null;document.addEventListener('click',event=>{const selected=document.querySelector(${JSON.stringify(selector)});window.__quakeClick={trusted:event.isTrusted,target:selected===event.target||!!selected?.contains(event.target),tag:event.target.tagName,label:event.target.textContent?.trim().slice(0,80)}},{once:true,capture:true});return{x,y,width:r.width,height:r.height,hit:r.width>0&&r.height>0&&(hit===e||e.contains(hit)),hitTag:hit?.tagName,hitClass:hit?.className,hitText:hit?.textContent?.trim().slice(0,160),disabled:e.disabled===true}})()`)
  assert.equal(point.hit, true, 'Mouse target is obstructed: ' + selector + ' ' + JSON.stringify(point)); assert.equal(point.disabled, false, 'Mouse target is disabled: ' + selector)
  win.webContents.focus(); const zoom = win.webContents.getZoomFactor(), x = Math.round(point.x * zoom), y = Math.round(point.y * zoom)
  for (const input of [{ type: 'mouseMove', x, y }, { type: 'mouseDown', button: 'left', clickCount: 1, x, y }, { type: 'mouseUp', button: 'left', clickCount: 1, x, y }]) win.webContents.sendInputEvent(input)
  await until(() => js('window.__quakeClick!==null'), 'Actual mouse did not reach the current target')
  const actual = await js('window.__quakeClick'); clicks.push({ selector, zoom, x, y, ...actual })
  assert.equal(actual.trusted, true); assert.equal(actual.target, true, 'Mouse action missed exact target'); await sleep(100)
}
async function fill(selector, value) {
  await click(selector)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
  await win.webContents.insertText(String(value)); await sleep(60)
  assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).value`), String(value), 'Real input value did not settle')
}
async function api(path = '', options = {}) {
  return js(`(async()=>{const response=await fetch('/dsh-earthquake-alert/api'+${JSON.stringify(path)},{credentials:'same-origin',cache:'no-store',headers:{'x-dsh-earthquake-alert':'1',${options.body ? "'content-type':'application/json'," : ''}},method:${JSON.stringify(options.method || 'GET')},${options.body ? 'body:' + JSON.stringify(JSON.stringify(options.body)) + ',' : ''}});return{status:response.status,body:await response.json()}})()`)
}
async function snapshot(id, healthPredicate) {
  let value
  await until(async () => { const response = await api(); value = response.body.value; return response.status === 200 && response.body.ok && (!id || value.eew?.eventId === id) && (!healthPredicate || healthPredicate(value.health)) }, 'Canonical host never committed expected feed: ' + id)
  return value
}
const action = name => '[data-dshea-action=' + JSON.stringify(name) + ']'
async function openPanel() {
  await until(() => js(`!!document.querySelector('.dcu-global-panel[aria-label="地震预警"]')`), 'Actual Loader did not register earthquake sidebar/main slot')
  await freshPaint()
  if (await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/稍后配置|Set up later/i.test(e.textContent)&&e.getBoundingClientRect().width>0);if(b)b.dataset.quakeDismiss='1';return!!b})()`)) await click('[data-quake-dismiss]')
  await click('.dcu-global-panel[aria-label="地震预警"]')
  await until(() => js(`document.querySelectorAll('.dshea-root').length===1`), 'Actual sidebar mouse route did not render canonical main')
}
async function freshPaint() {
  await finite(win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }), 10000, 'warm compositor capture'); await sleep(850)
  await js(`(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect&&a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`)
  const before = paintCount; win.webContents.invalidate()
  await until(() => paintCount > before, 'Fresh compositor paint did not arrive'); await sleep(120)
}
async function capture(name) {
  await freshPaint()
  const navigation = await js(`[...document.querySelectorAll('.dcu-global-panel[aria-current="page"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}).map(e=>e.getAttribute('aria-label'))`)
  assert.deepEqual(navigation, ['地震预警'], 'Screenshot must show actual selected earthquake panel')
  fs.writeFileSync(join(out, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
  screenshots.push(name); results.push({ name: 'Fresh screenshot for required human pixel review', file: name, navigation, paintCount })
}
async function layout(width, zoom, theme) {
  win.webContents.setZoomFactor(zoom)
  // Resize the real window against its actual main-column measurement. Window
  // width is never substituted for available width, including responsive sidebar.
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await js(`document.querySelector('.dshea-root').getBoundingClientRect().width`)
    if (Math.abs(current - width) <= 2) break
    const size = win.getContentSize(); win.setContentSize(Math.max(250, Math.round(size[0] + (width - current) * zoom)), 950); await sleep(150)
  }
  win.webContents.send('dsh-shell:desktop-theme', { colorScheme: theme, preset: 'deep-sea' }); await sleep(200)
  await js(`(()=>{const root=document.querySelector('.dshea-root');root.scrollTop=0;root.scrollLeft=0;root.scrollIntoView({block:'start'});return root.scrollTop})()`)
  const measured = await js(`(()=>{const root=document.querySelector('.dshea-root'),r=root.getBoundingClientRect(),head=root.querySelector('.dshea-head').getBoundingClientRect(),caption=root.querySelector('.dshea-caption'),nav=document.querySelector('.dcu-global-panel[aria-label="地震预警"]'),rootStyle=getComputedStyle(root);const style=e=>{const s=getComputedStyle(e);return{family:s.fontFamily,size:s.fontSize,color:s.color,background:s.backgroundColor,border:s.borderColor}};return{actualWidth:r.width,left:r.left,right:r.right,viewport:innerWidth,viewportHeight:innerHeight,scrollTop:root.scrollTop,head:{top:head.top,bottom:head.bottom,height:head.height},contentWidth:root.clientWidth-parseFloat(rootStyle.paddingLeft)-parseFloat(rootStyle.paddingRight),captionWidth:caption.getBoundingClientRect().width,rootOverflow:root.scrollWidth>root.clientWidth+1,pageOverflow:document.documentElement.scrollWidth>innerWidth+1,cards:[...root.querySelectorAll('.dshea-card')].map(e=>({width:e.clientWidth,scroll:e.scrollWidth,overflow:e.scrollWidth>e.clientWidth+1})),root:style(root),heading:style(root.querySelector('.dshea-h1')),caption:style(caption),nav:style(nav),dark:document.body.hasAttribute('data-ds-dark-theme'),bodyColor:getComputedStyle(document.body).color}})()`)
  assert.ok(Math.abs(measured.actualWidth - width) <= 2, 'Could not create exact available column: ' + JSON.stringify(measured))
  assert.equal(measured.rootOverflow, false, 'Earthquake main overflows its actual parent'); assert.equal(measured.pageOverflow, false)
  assert.equal(measured.cards.some(card => card.overflow), false, 'Card content overflows its actual width')
  assert.equal(measured.scrollTop, 0, 'Matrix capture must begin at the actual scrollable main top')
  assert.ok(measured.head.top >= 0 && measured.head.bottom <= measured.viewportHeight, 'Actual page header must be fully visible in matrix screenshot')
  assert.equal(measured.heading.family, measured.nav.family, 'Heading/UI sidebar font stack must be globally identical')
  assert.equal(measured.root.family, measured.nav.family, 'Main/UI sidebar font stack must be globally identical')
  assert.equal(measured.caption.family, measured.nav.family, 'Caption must use the same family without brand fallback')
  assert.equal(measured.dark, theme === 'dark'); assert.equal(measured.heading.size, '24px')
  if (width <= 480) assert.ok(measured.captionWidth >= measured.contentWidth - 4, 'Narrow-column source caption must have a full readable line, not be squeezed beside actions: ' + JSON.stringify(measured))
  const contrasts = await js(`(()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d',{willReadFrequently:true});
    const rgba=color=>{context.clearRect(0,0,1,1);context.fillStyle='rgba(0,0,0,0)';context.fillStyle=color;context.fillRect(0,0,1,1);return[...context.getImageData(0,0,1,1).data].map(v=>v/255)};
    const over=(front,back)=>{const a=front[3]+back[3]*(1-front[3]);return a?[...front.slice(0,3).map((v,i)=>(v*front[3]+back[i]*back[3]*(1-front[3]))/a),a]:[0,0,0,0]};
    const luminance=color=>color.slice(0,3).map(v=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const values=[];
    for(const e of document.querySelectorAll('.dshea-root .dshea-caption,.dshea-root .dshea-hint,.dshea-root .dshea-kv dt,.dshea-root .dshea-dim,.dshea-root .dshea-note')){
      const r=e.getBoundingClientRect(),style=getComputedStyle(e);if(!e.textContent.trim()||!r.width||!r.height||style.visibility!=='visible'||e.closest('[disabled],[aria-disabled="true"]'))continue;
      let p=e,chain=[],opacity=1;while(p){const s=getComputedStyle(p);if(s.backgroundImage!=='none')throw Error('Contrast target requires actual image/gradient sampling');chain.push({tag:p.tagName,classes:typeof p.className==='string'?p.className:'',background:s.backgroundColor});opacity*=Number(s.opacity);p=p.parentElement}
      let background=[0,0,0,0];for(const ancestor of chain.reverse())background=over(rgba(ancestor.background),background);
      if(background[3]<.999)throw Error('Contrast target has no confirmed opaque rendered ancestor background');
      const foreground=rgba(style.color);foreground[3]*=opacity;const text=over(foreground,background),one=luminance(text),two=luminance(background),ratio=(Math.max(one,two)+.05)/(Math.min(one,two)+.05);
      values.push({selector:e.className||e.tagName,text:e.textContent.trim().slice(0,120),foreground:style.color,background:background.map(v=>Math.round(v*1000000)/1000000),opacity,ratio,chain});
    }
    return values;
  })()`)
  assert.ok(contrasts.length > 5, 'Caption/hint/KV/dim contrast coverage is incomplete')
  assert.equal(contrasts.some(entry => entry.ratio < 4.5), false, 'Actual small text contrast must be >=4.5 without rounding up: ' + JSON.stringify(contrasts.filter(entry => entry.ratio < 4.5)))
  measured.contrasts = contrasts
  results.push({ name: 'Actual main-column layout/font/theme', width, zoom, theme, ...measured })
  return measured
}
async function platformFonts(selector) {
  const debug = win.webContents.debugger
  if (!debug.isAttached()) debug.attach('1.3')
  await debug.sendCommand('DOM.enable'); await debug.sendCommand('CSS.enable')
  const { root: document } = await debug.sendCommand('DOM.getDocument')
  const { nodeId } = await debug.sendCommand('DOM.querySelector', { nodeId: document.nodeId, selector })
  assert.ok(nodeId, 'Chinese font target missing: ' + selector)
  const { fonts } = await debug.sendCommand('CSS.getPlatformFontsForNode', { nodeId })
  return fonts.filter(font => font.glyphCount > 0).map(font => ({ familyName: font.familyName, postScriptName: font.postScriptName, glyphCount: font.glyphCount, isCustomFont: font.isCustomFont }))
}
async function loadPage(url, sharedTheme, legacySeed) {
  // A never-navigated hidden webContents has no renderer/CDP Page target. Create
  // only a bounded blank document before installing the next-document guard;
  // the real authenticated DSH URL remains the sole application navigation.
  checkpoint('create-blank-renderer')
  if (!win.webContents.getURL()) await finite(win.loadURL('about:blank'), 15000, 'initial blank renderer')
  const debug = win.webContents.debugger
  checkpoint('install-next-document-audio-guard')
  if (!debug.isAttached()) debug.attach('1.3')
  await finite(debug.sendCommand('Page.enable'), 10000, 'CDP Page.enable')
  const before = `window.__quakeAudioAttempts=0;for(const key of ['AudioContext','webkitAudioContext'])if(window[key])window[key]=class{constructor(){window.__quakeAudioAttempts++;throw Error('ISOLATED_AUDIO_FORBIDDEN')}};${legacySeed ? 'try{if(!localStorage.getItem("dsh-earthquake-alert.v1"))localStorage.setItem("dsh-earthquake-alert.v1",' + JSON.stringify(JSON.stringify(legacySeed)) + ')}catch{}' : ''}`
  const { identifier } = await finite(debug.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: before }), 10000, 'install audio guard')
  checkpoint('navigate-authenticated-dsh-document')
  await finite(win.loadURL(url), 45000, 'real authenticated DSH loadURL')
  checkpoint('apply-actual-desktop-theme')
  await finite(win.webContents.insertCSS(sharedTheme), 10000, 'shared production theme CSS')
  win.webContents.send('dsh-shell:desktop-theme', { colorScheme: 'light', preset: 'deep-sea' })
  await finite(debug.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier }), 10000, 'remove next-document guard')
  checkpoint('navigate-actual-earthquake-sidebar')
  await openPanel()
}
async function run() {
  await app.whenReady()
  checkpoint('runtime-identities')
  const productionBefore = productionSnapshot(), { activeUiProfile } = await import(pathToFileURL(join(root, 'scripts/lib/active-ui-profile.mjs')))
  const active = activeUiProfile(root); runtime = active.runtime; assert.ok(runtime, 'Exact active immutable runtime required')
  runtimeVersion = installedPackage(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json')).version
  assert.equal(runtimeVersion, '0.2.0-rc.2', 'This acceptance matrix requires actual rc.2 runtime')
  const ui = join(active.profile, 'node_modules/@michengai/dsh-codex-ui')
  uiVersion = JSON.parse(fs.readFileSync(join(ui, 'package.json'), 'utf8')).version; assert.equal(uiVersion, '1.1.18')
  const key = '@michengai/dsh-codex-ui@' + uiVersion, compatibility = plainJson(join(active.profile, 'compatibility.json'))
  assert.ok(compatibility[key]?.includes(runtimeVersion), 'Do not invent a compatibility override')
  const localPlugin = join(profile, 'local/dsh-earthquake-alert'), quakeFiles = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js']
  if (!legacy) quakeFiles.push('lib/preferences.js')
  copySource(pluginSource, quakeFiles, localPlugin)
  const localTweaks = join(profile, 'local/dsh-ui-tweaks')
  copySource(join(root, 'customizations/ui-tweaks'), ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js'], localTweaks)
  const sharedThemeFile = join(root, 'assets/theme.css'), sharedTheme = fs.readFileSync(sharedThemeFile, 'utf8')
  sourceFiles.push(sharedThemeFile); sourceHashes['assets/theme.css'] = hash(sharedThemeFile)
  for (const path of ['dist/src/dsh-view-preload.cjs', 'dist/src/dsh-process.js', 'dist/src/dsh-bootstrap.mjs', 'dist/src/readiness.js', 'scripts/verify-earthquake-alert.cjs']) {
    const file = join(root, path), entry = fs.lstatSync(file)
    assert.ok(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1)
    sourceFiles.push(file); sourceHashes[path] = hash(file)
  }
  link(join(runtime, 'node_modules/@deepseek-ai'), join(nm, '@deepseek-ai')); link(ui, join(nm, '@michengai/dsh-codex-ui'))
  const schemaPackage = join(active.profile, 'node_modules/schemastery')
  assert.equal(installedPackage(join(schemaPackage, 'package.json')).version, '3.18.0', 'Use the actual accepted plugin dependency, not a guessed runtime-root package')
  link(schemaPackage, join(localPlugin, 'node_modules/schemastery'))
  link(localPlugin, join(nm, 'dsh-earthquake-alert')); link(localTweaks, join(nm, 'dsh-ui-tweaks'))
  fs.writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-earthquake-verification', private: true,
    dependencies: { '@michengai/dsh-codex-ui': uiVersion, 'dsh-earthquake-alert': 'link:local/dsh-earthquake-alert', 'dsh-ui-tweaks': 'link:local/dsh-ui-tweaks' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@michengai/dsh-codex-ui', 'dsh-ui-tweaks', 'dsh-earthquake-alert'] } } }, null, 2))
  fs.writeFileSync(join(profile, 'compatibility.json'), JSON.stringify({ [key]: [runtimeVersion] }))
  await startUpstream(); const guard = installNetworkGuard()
  fs.writeFileSync(join(profile, 'cordis.patch.yml'), '- id: workspace-controller\n  config:\n    documentsDirectory: ' + JSON.stringify(fixturePath('documents')) + '\n- id: dsh-earthquake-alert\n  config:\n    eewUrl: ' + JSON.stringify(fixtureOrigin + '/eew') + '\n    listUrl: ' + JSON.stringify(fixtureOrigin + '/list') + '\n    pollSeconds: 3\n    listSeconds: 15\n    timeoutSeconds: 6\n')
  const { GATE_NODE } = await import(pathToFileURL(join(root, 'scripts/lib/gate-node.mjs'))), { startDsh, resolveDesktopWebPort } = await import(pathToFileURL(join(root, 'dist/src/dsh-process.js')))
  assert.equal(resolveDesktopWebPort(process.env.DSH_DESKTOP_WEB_PORT), '0', 'Verification requires an ephemeral port, never an inherited production port')
  await app.whenReady()
  win = new BrowserWindow({ width: 1360, height: 950, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: join(root, 'dist/src/dsh-view-preload.cjs') } })
  win.webContents.setAudioMuted(true); win.webContents.on('paint', () => paintCount++)
  win.webContents.on('console-message', entry => {
    if (entry.level !== 'error') return
    const message = entry.message.replace(/([?&](?:token|authToken)=)[^\s&]+/gi, '$1[redacted]')
    if (/\/dsh-earthquake-alert\/api\/preferences(?:\?|$)/.test(entry.sourceId || '') && /(?:409|503)/.test(message)) expectedErrors.push({ source: '/dsh-earthquake-alert/api/preferences', message })
    else errors.push(message)
  })
  win.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    let blocked = false
    if (/^(https?|wss?):/i.test(request.url)) { const url = new URL(request.url); blocked = !origin || url.origin.replace(/^ws/, 'http') !== origin; if (blocked) blockedRequests.push(url.origin + url.pathname) }
    callback({ cancel: blocked })
  })
  const start = async () => {
    checkpoint('start-isolated-host')
    const originalSpawn = childProcess.spawn, originalFetch = globalThis.fetch
    const diagnostic = { sequence: startupDiagnostics.length + 1, readySeen: false, health: [], inheritedNodeOptions: !!process.env.NODE_OPTIONS }
    startupDiagnostics.push(diagnostic)
    let readyOrigin
    childProcess.spawn = function (command, argv, options) {
      const child = originalSpawn(command, argv, options)
      if (command === GATE_NODE && argv?.[0] === join(root, 'dist/src/dsh-bootstrap.mjs') && options?.cwd === scratch) {
        diagnostic.pid = child.pid
        for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
          let buffer = ''
          stream.on('data', chunk => {
            buffer += String(chunk)
            for (;;) {
              const end = buffer.indexOf('\n'); if (end < 0) break
              const line = buffer.slice(0, end + 1); buffer = buffer.slice(end + 1)
              fs.appendFileSync(join(out, `host-${diagnostic.sequence}-${name}.log`), redact(line))
              const match = line.match(/dsh web:[ \t]*(https?:\/\/[^\s\r\n]+)/i)
              if (match) {
                const parsed = new URL(match[1]); readyOrigin = parsed.origin
                Object.assign(diagnostic, { readySeen: true, queryKeyNames: [...parsed.searchParams.keys()], hasToken: parsed.searchParams.has('token'), hostname: parsed.hostname, port: parsed.port, lineHasLanSuffix: /\(LAN:/.test(line) })
              }
            }
            if (buffer.length > 128 * 1024) { diagnostic.overlongOutputLine = true; buffer = ''; }
            fs.writeFileSync(join(out, 'startup-diagnostics.json'), JSON.stringify(startupDiagnostics, null, 2))
          })
        }
      }
      return child
    }
    syncBuiltinESMExports()
    globalThis.fetch = async function (input, options) {
      const response = await originalFetch(input, options)
      const parsed = new URL(typeof input === 'string' ? input : input.url || String(input))
      if (parsed.origin === readyOrigin) {
        const location = response.headers.get('location')
        diagnostic.health.push({ status: response.status, hasToken: parsed.searchParams.has('token'), hasSetCookie: !!response.headers.get('set-cookie'), locationOriginSame: location ? new URL(location, parsed).origin === parsed.origin : null })
        fs.writeFileSync(join(out, 'startup-diagnostics.json'), JSON.stringify(startupDiagnostics, null, 2))
      }
      return response
    }
    try {
      server = await startDsh({ nodeExecutable: GATE_NODE, bootstrapPath: join(root, 'dist/src/dsh-bootstrap.mjs'), runtime: { root: runtime, entry: join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js') }, workingDirectory: scratch,
        environment: { DSH_PORTABLE_ROOT: portable, DSH_HOME: home, DSH_PROFILE_DIR: profile, DSH_PROFILE_NAME: 'web', DSH_RUNTIME_DIR: runtime,
          NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require ' + JSON.stringify(guard.file.replace(/\\/g, '/')),
          TEMP: scratch, TMP: scratch, TMPDIR: scratch, npm_config_cache: fixturePath('npm-cache'), npm_config_offline: 'true' }, startupTimeoutMs: 120000 })
    } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); globalThis.fetch = originalFetch }
    origin = new URL(server.url).origin
    checkpoint('load-actual-client')
  }
  await start()
  const legacySeed = { sites: [{ name: '旧配置·演练关注地点', latitude: 30.5, longitude: 104 }], radiusKm: 300, minMagnitude: 4, alertWindowSeconds: 180, sound: false }
  await loadPage(server.url, sharedTheme, legacy ? null : legacySeed)
  checkpoint('future-counterexample')
  const initial = legacy
    ? await snapshot('fixture-future')
    : await snapshot(null, health => health.eewFetches > 0 && health.listFetches > 0 && health.eewError?.code === 'FUTURE_REPORT')
  assert.ok(initial.health.eewFetches > 0 && initial.health.listFetches > 0)
  if (!legacy) assert.equal(initial.eew, null, 'Future payload must be rejected before committing a host snapshot')
  await sleep(2400)
  if (legacy) {
    results.push({ name: 'Actual old-file future-alert diagnostic (not a positive acceptance)',
      sample: await js(`(()=>{const h=document.querySelector('.dshea-h1');return{heading:h.textContent,headingSize:getComputedStyle(h).fontSize,banners:[...document.querySelectorAll('.dshea-banner')].map(e=>e.textContent),current:document.querySelector('.dshea-current')?.textContent}})()`),
      eew: initial.eew, health: initial.health })
    await capture('legacy-future-known-defect.png')
  }
  assert.equal(await js(`document.querySelectorAll('.dshea-banner:not(.dshea-banner-test)').length`), 0, 'Future event incorrectly triggers a real alert (old-version counterexample)')
  results.push({ name: 'Actual host/API plus Loader sidebar/main: future event never alerts', pass: true })
  if (legacy) throw new Error('Legacy comparison unexpectedly passed the future-alert counterexample; audit fixture before accepting')
  assert.equal(await js(`document.querySelector('.dshea-root [data-dshea-status]').dataset.dsheaStatus`), 'unavailable', 'Rejected future feed must show unknown/unavailable, never no warning')
  checkpoint('preferences-real-roundtrip')
  await until(() => js(`!!document.querySelector(${JSON.stringify(action('migrate'))})`), 'Explicit legacy migration action was not offered')
  const untouched = await api('/preferences'); assert.equal(untouched.status, 200); assert.equal(untouched.body.value.persisted, false); assert.equal(untouched.body.value.prefs.sites.length, 0)
  assert.equal(fs.existsSync(prefsFile), false, 'Merely reading legacy localStorage must not persist it')
  await click(action('migrate'))
  await until(async () => { const value = await api('/preferences'); return value.body.value.persisted && value.body.value.prefs.sites[0]?.name === legacySeed.sites[0].name }, 'Actual migration/save host path failed')
  assert.ok(fs.existsSync(prefsFile)); results.push({ name: 'Explicit trusted migration persists stable portable preferences, never implicit read-time migration', pass: true })
  await click(action('remove-site') + '[data-dshea-site="0"]')
  await until(async () => (await api('/preferences')).body.value.prefs.sites.length === 0, 'Actual remove-site/save route failed')
  await fill('#dshea-site-name', '隔离演练关注地点·长名称验证窄列布局'); await click(action('add-site'))
  await until(() => js(`!!document.querySelector('[data-dshea-form-error="coordinateInvalid"]')`), 'Empty coordinates did not report validation error')
  assert.equal((await api('/preferences')).body.value.prefs.sites.length, 0, 'Empty coordinates were saved as zero')
  results.push({ name: 'Real empty-coordinate rejection produces accessible error without saving0,0', pass: true })
  await fill('#dshea-latitude', '30.5'); await fill('#dshea-longitude', '104')
  await click(action('add-site')); await until(async () => (await api('/preferences')).body.value.prefs.sites.length === 1, 'Actual add-site/save route failed')
  await fill('#dshea-radius', '250'); await fill('#dshea-min-magnitude', '4.5'); await fill('#dshea-alert-window', '180'); await click(action('save-settings'))
  await until(async () => { const value = (await api('/preferences')).body.value.prefs; return value.radiusKm === 250 && value.minMagnitude === 4.5 && value.sound === false }, 'Actual settings save failed')
  const committed = (await api('/preferences')).body.value
  assert.match(committed.revision, /^[a-f0-9]{64}$/); results.push({ name: 'Trusted real add/remove/field-save -> canonical authenticated API -> stable preferences file', pass: true })
  // Force a real revision race through the real local endpoint, not a response mock.
  const external = await api('/preferences', { method: 'POST', body: { revision: committed.revision, prefs: { ...committed.prefs, radiusKm: 333 } } })
  assert.equal(external.status, 200)
  await fill('#dshea-radius', '444'); await click(action('save-settings'))
  await until(() => js(`!!document.querySelector('[data-dshea-notice="conflict"]')`), 'Real rejected save did not show revision conflict')
  assert.equal((await api('/preferences')).body.value.prefs.radiusKm, 333); assert.equal(await js(`document.querySelector('#dshea-radius').value`), '444', 'Conflict silently discarded draft')
  await click(action('reset-draft')); await until(() => js(`document.querySelector('#dshea-radius').value==='333'`), 'Explicit draft reset did not use committed preferences')
  results.push({ name: 'Real revision-conflict rejection preserves draft and committed state; explicit draft reset uses authoritative re-read values', pass: true })
  // Create a filesystem-level failure only at the exact isolated preferences
  // path, preserving its original bytes. No production file is read or moved.
  ordinary(dirname(prefsFile)); const preferencesBackup = fixturePath('preferences-before-io-failure.json')
  fs.renameSync(prefsFile, preferencesBackup); fs.mkdirSync(prefsFile); ordinary(prefsFile)
  try {
    await fill('#dshea-radius', '555'); await click(action('save-settings'))
    await until(() => js(`!!document.querySelector('[data-dshea-notice="saveFailed"]')`), 'Real I/O save failure did not report failure')
    assert.equal(await js(`document.querySelector('#dshea-radius').value`), '555', 'I/O failure discarded the draft')
    assert.equal(fs.readdirSync(prefsFile).length, 0, 'Unsafe preferences directory was unexpectedly written')
    results.push({ name: 'Real filesystem save rejection retains draft and preserved original bytes, never false saved', pass: true })
  } finally {
    const item = fs.lstatSync(prefsFile); assert.ok(item.isDirectory() && !item.isSymbolicLink())
    assert.deepEqual(fs.readdirSync(prefsFile), [])
    fs.rmdirSync(prefsFile); fs.renameSync(preferencesBackup, prefsFile)
  }
  // Successful retry demonstrates that a rejected write did not poison state.
  await click(action('save-settings')); await until(async () => (await api('/preferences')).body.value.prefs.radiusKm === 555, 'Actual successful save retry failed')
  fixture.eew = event('fixture-expired', 3600); await snapshot('fixture-expired'); await sleep(2300)
  checkpoint('feed-live-safety')
  assert.equal(await js(`document.querySelectorAll('[data-dshea-banner="live"]').length`), 0)
  assert.equal(await js(`document.querySelector('.dshea-root [data-dshea-status]').dataset.dsheaStatus`), 'expired')
  // A slow actual HTTP feed spans a polling tick. It must remain single-flight;
  // the next accepted report wins and a subsequent older report is rejected.
  const slowStart = feedRequests.length
  fixture.eew = event('fixture-slow', 3, 0.1, 1); fixture.delay = 4200
  await until(() => feedRequests.slice(slowStart).some(item => item.kind === 'eew' && item.id === 'fixture-slow'), 'Slow local fixture request never started')
  fixture.eew = { ...fixture.eew, ReportNum: 2, ReportTime: sourceTime(Date.now()) }; fixture.delay = 0
  await until(async () => (await api()).body.value?.eew?.eventId === 'fixture-slow' && (await api()).body.value?.eew?.reportNum === 2, 'Actual slow/new report sequence did not settle', 20000)
  const slowRequests = feedRequests.slice(slowStart).filter(item => item.kind === 'eew' && item.id === 'fixture-slow')
  assert.ok(slowRequests.length >= 2 && slowRequests[0].finishedAt - slowRequests[0].startedAt >= 4000)
  for (let index = 1; index < slowRequests.length; index++) assert.ok(slowRequests[index].startedAt >= slowRequests[index - 1].finishedAt, 'Actual upstream fetches overlap despite single-flight')
  fixture.eew = { ...fixture.eew, ReportNum: 1 }
  await snapshot('fixture-slow', health => health.eewError?.code === 'STALE_REPORT')
  assert.equal((await api()).body.value.eew.reportNum, 2, 'Older upstream report overwrote accepted latest report')
  results.push({ name: 'Actual delayed upstream HTTP remains single-flight and old report cannot replace accepted new report', slowRequests, pass: true })
  fixture.eew = event('fixture-low', 3, 0.1); await snapshot('fixture-low'); await sleep(2300)
  assert.equal(await js(`document.querySelectorAll('[data-dshea-banner="live"]').length`), 0, 'Nearby low-magnitude event bypassed minimum magnitude')
  results.push({ name: 'Expired and nearby low-magnitude feeds never create a live warning', pass: true })
  fixture.eew = event('fixture-live', 2, 5.6); await snapshot('fixture-live')
  await until(() => js(`document.querySelectorAll('[data-dshea-banner="live"]').length===1`), 'Fresh relevant fixture must show exactly one live warning')
  const countdownSample = () => js(`(()=>{const e=document.querySelector('.dshea-list-val[data-dshea-countdown="s"]');if(!e)throw Error('No current remaining S-wave marker');return{text:e.textContent,seconds:Number(e.dataset.dsheaSeconds)}})()`)
  const countdownBefore = await countdownSample(); await sleep(2200); const countdownAfter = await countdownSample()
  const beforeSeconds = countdownBefore.seconds, afterSeconds = countdownAfter.seconds
  assert.ok(Number.isFinite(beforeSeconds) && Number.isFinite(afterSeconds) && beforeSeconds > 0)
  assert.ok(countdownBefore.text.includes(String(beforeSeconds)) && countdownAfter.text.includes(String(afterSeconds)), 'Concrete remaining seconds must be visible, not only a data attribute')
  assert.ok(beforeSeconds > afterSeconds && beforeSeconds - afterSeconds >= 1 && beforeSeconds - afterSeconds <= 4,
    'Remaining S-wave seconds must decrease by elapsed2s, not merely change text')
  await click(action('dismiss-banner')); await sleep(2300)
  assert.equal(await js(`document.querySelectorAll('[data-dshea-banner="live"]').length`), 0, 'Same report must remain dismissed')
  fixture.eew = { ...fixture.eew, ReportNum: 2 }; await snapshot('fixture-live', health => !health.eewError)
  await until(() => js(`document.querySelectorAll('[data-dshea-banner="live"]').length===1`), 'New report did not refresh dismissed warning')
  fixture.eewStatus = 503; await snapshot('fixture-live', health => !!health.eewError)
  await until(() => js(`document.querySelectorAll('[data-dshea-banner="live"]').length===0`), 'Failed EEW feed kept alarming from stale state')
  results.push({ name: 'Fresh warning ticks/dismisses/deduplicates; new report updates; disconnected EEW stops warning', countdownBefore, countdownAfter, beforeSeconds, afterSeconds, pass: true })
  fixture.eewStatus = 200; fixture.eew = event('fixture-history', 3600, 6.4); fixture.listStatus = 503
  // A correct host rejects older events in the same live process. Clear only our
  // own host's in-memory feed by an actual normal stop/start before history case.
  const historyBeforeOrigin = origin
  await server.stop(); server = undefined; await start(); assert.notEqual(origin, historyBeforeOrigin)
  await loadPage(server.url, sharedTheme)
  await snapshot('fixture-history', health => !health.eewError && !!health.listError)
  await sleep(2300)
  const independent = (await api()).body.value.health; assert.ok(independent.listError); assert.equal(independent.eewError, null)
  results.push({ name: 'Successful EEW never masks independent catalog failure', health: independent, pass: true })
  await click(action('refresh')); await until(() => js(`!document.querySelector(${JSON.stringify(action('refresh'))}).disabled`), 'Refresh never settled')
  assert.equal(await js(`document.querySelectorAll('[data-dshea-banner="live"]').length`), 0)
  await click(action('test-banner')); await until(() => js(`document.querySelectorAll('[data-dshea-banner="test"]').length===1`), 'Explicit demonstration banner did not open')
  const demonstration = await js(`document.querySelector('[data-dshea-banner="test"]').textContent`)
  assert.ok(!demonstration.includes('M6.4') && !demonstration.includes('隔离演练·极长震中'), 'Demonstration reused historical earthquake facts')
  await capture('test-banner-light.png'); await click(action('dismiss-banner'))
  await until(() => js(`!document.querySelector('[data-dshea-banner]')`), 'Trusted demonstration dismissal failed')
  await click(action('test-banner')); await sleep(15600)
  assert.equal(await js(`document.querySelectorAll('[data-dshea-banner]').length`), 0, 'Demonstration failed to expire after15s')
  results.push({ name: 'Test banner independent of historical data, no audio, trusted dismiss and real15s expiry', demonstration, pass: true })
  const retained = (await api('/preferences')).body.value, firstOrigin = origin
  checkpoint('cross-port-preferences')
  await server.stop(); server = undefined; await start(); assert.notEqual(origin, firstOrigin, 'Cross-port restart must actually use another local port')
  await loadPage(server.url, sharedTheme)
  await until(async () => JSON.stringify((await api('/preferences')).body.value) === JSON.stringify(retained), 'Preferences were lost across actual different-port host restart')
  assert.equal(await js('window.__quakeAudioAttempts'), 0)
  await loadPage(server.url, sharedTheme)
  assert.deepEqual((await api('/preferences')).body.value, retained)
  results.push({ name: 'Actual second localhost port plus real page reload retain stable host preferences', origins: [firstOrigin, origin], revision: retained.revision, pass: true })
  fixture.listStatus = 200
  await until(async () => { const value = (await api()).body.value; return value.list.length === 30 && !value.health.listError && value.health.listLastOkAt > 0 }, 'Actual long catalog never recovered for layout matrix')
  results.push({ name: 'Catalog failure recovers through actual feed polling; all30 rows committed before layout evidence', pass: true })
  await layout(900, 1, 'light')
  const headingFonts = await platformFonts('.dshea-h1'), sidebarFonts = await platformFonts('.dcu-global-panel[aria-label="地震预警"]')
  assert.ok(headingFonts.length && sidebarFonts.length, 'Actual Chinese glyph font data unavailable')
  assert.deepEqual([...new Set(headingFonts.map(font => font.familyName))].sort(), [...new Set(sidebarFonts.map(font => font.familyName))].sort(), 'Actual Chinese glyph font differs from the global sidebar')
  results.push({ name: 'Chromium actual Chinese platform glyph fonts equal sidebar, not computed-family alone', headingFonts, sidebarFonts, pass: true })
  const dynamicBefore = await js(`(()=>{const e=document.querySelector('.dshea-root'),c=document.querySelector('.dshea-card'),h=document.querySelector('.dshea-h1');return{family:getComputedStyle(e).fontFamily,heading:getComputedStyle(h).fontSize,border:getComputedStyle(c).borderColor}})()`)
  const tokens = ['--dsh-font-ui', '--dsw-font-xl-24', '--dsh-border-subtle']
  const savedTokens = await js(`(()=>{const body=document.body,html=document.documentElement;return${JSON.stringify(tokens)}.map(name=>({name,body:body.style.getPropertyValue(name),bodyPriority:body.style.getPropertyPriority(name),html:html.style.getPropertyValue(name),htmlPriority:html.style.getPropertyPriority(name)}))})()`)
  await js(`document.documentElement.style.setProperty('--dsh-font-ui','"Microsoft YaHei UI", sans-serif','important');document.body.style.setProperty('--dsw-font-xl-24','600 28px/36px var(--dsh-font-ui)');document.body.style.setProperty('--dsh-border-subtle','rgb(111, 77, 188)','important');void 0`)
  const dynamicAfter = await js(`(()=>{const e=document.querySelector('.dshea-root'),c=document.querySelector('.dshea-card'),h=document.querySelector('.dshea-h1'),nav=document.querySelector('.dcu-global-panel[aria-label="地震预警"]');return{family:getComputedStyle(e).fontFamily,nav:getComputedStyle(nav).fontFamily,heading:getComputedStyle(h).fontSize,border:getComputedStyle(c).borderColor}})()`)
  assert.notEqual(dynamicAfter.family, dynamicBefore.family); assert.equal(dynamicAfter.family, dynamicAfter.nav)
  assert.equal(dynamicAfter.heading, '28px'); assert.equal(dynamicAfter.border, 'rgb(111, 77, 188)')
  await js(`(()=>{for(const entry of${JSON.stringify(savedTokens)})for(const [scope,key]of[[document.body,'body'],[document.documentElement,'html']]){if(entry[key])scope.style.setProperty(entry.name,entry[key],entry[key+'Priority']);else scope.style.removeProperty(entry.name)}})()`)
  results.push({ name: 'Live global font family/title scale/shared border tokens propagate without reload and are restored', dynamicBefore, dynamicAfter, pass: true })
  // A genuine invalid draft stays visible through the responsive matrix. This
  // is not an injected error DOM: use the canonical form and trusted input route.
  const prefsBeforeInvalidDraft = hash(prefsFile)
  await fill('#dshea-site-name', '隔离演练长关注地点·空坐标错误验证窄列提示')
  await click(action('add-site'))
  await until(() => js(`!!document.querySelector('[data-dshea-form-error="coordinateInvalid"]')`), 'Responsive long-name invalid draft lost its accessible coordinate error')
  assert.equal(hash(prefsFile), prefsBeforeInvalidDraft, 'Invalid draft changed saved preferences')
  await layout(320, 1, 'light'); await capture('validation-long-name-320-light.png')
  results.push({ name: 'Trusted long-name empty-coordinate error remains readable at actual320px without modifying saved preferences', pass: true })
  for (const theme of ['light', 'dark']) for (const width of [320, 480, 900]) for (const zoom of [0.8, 1, 1.25, 1.5]) {
    checkpoint(`layout-${theme}-${width}-${zoom}`)
    await layout(width, zoom, theme)
    if (zoom === 1 || zoom === 1.5) await capture(`main-${theme}-${width}-${String(zoom).replace('.', '-')}.png`)
  }
  // A parent-constrained column is independent of viewport media queries: this
  // reproduces a wide viewport with a narrow right-pane-constrained main parent.
  checkpoint('wide-viewport-narrow-actual-parent')
  await layout(900, 1, 'light')
  const parentState = await js(`(()=>{let e=document.querySelector('.dshea-root').parentElement;const skipped=[];while(e&&getComputedStyle(e).display==='contents'){skipped.push({tag:e.tagName,classes:e.className});e=e.parentElement}if(!e||e===document.body||e===document.documentElement)throw Error('No boxed actual main parent');e.dataset.quakeConstrainedParent='1';const original=e.getAttribute('style'),computed=getComputedStyle(e),identity={tag:e.tagName,classes:e.className,display:computed.display,flex:computed.flex,skipped};for(const [name,value]of[['width','320px'],['max-width','320px'],['min-width','0'],['flex','0 0 320px']])e.style.setProperty(name,value,'important');return{original,identity}})()`)
  await sleep(200)
  const constrained = await js(`(()=>{const e=document.querySelector('.dshea-root'),p=document.querySelector('[data-quake-constrained-parent]'),r=e.getBoundingClientRect(),s=getComputedStyle(p);return{width:r.width,viewport:innerWidth,parent:{width:p.getBoundingClientRect().width,display:s.display,flex:s.flex},overflow:e.scrollWidth>e.clientWidth+1,cards:[...e.querySelectorAll('.dshea-card')].map(c=>c.scrollWidth>c.clientWidth+1)}})()`)
  results.push({ name: 'Actual parent constraint apparatus measurements before strict acceptance', identity: parentState.identity, ...constrained })
  assert.ok(constrained.width <= 320 && constrained.viewport > 900, 'Real narrow boxed parent was not established: ' + JSON.stringify(constrained)); assert.equal(constrained.overflow, false); assert.equal(constrained.cards.some(Boolean), false)
  await capture('wide-viewport-narrow-parent.png')
  await js(`(()=>{const e=document.querySelector('[data-quake-constrained-parent]');${parentState.original === null ? "e.removeAttribute('style')" : 'e.setAttribute("style",' + JSON.stringify(parentState.original) + ')'};delete e.dataset.quakeConstrainedParent})()`)
  results.push({ name: 'Wide real viewport with constrained320px parent never overflows (not viewport-only breakpoints)', ...constrained, pass: true })
  await js(`document.querySelector('[data-dshea-feed="list"]').scrollIntoView({block:'center'});void 0`)
  await capture('high-scroll-feed-health.png')
  const scrollState = await js(`(()=>{const e=document.querySelector('[data-dshea-feed="list"]'),r=e.getBoundingClientRect();let c=e;const scroll=[];while(c){if(c.scrollHeight>c.clientHeight+1)scroll.push({tag:c.tagName,classes:c.className,top:c.scrollTop,height:c.clientHeight,total:c.scrollHeight});c=c.parentElement}return{top:r.top,bottom:r.bottom,viewportHeight:innerHeight,scroll}})()`)
  assert.ok(scrollState.top >= 0 && scrollState.bottom <= scrollState.viewportHeight)
  assert.ok(scrollState.scroll.some(container => container.top > 0), 'Long content did not use a real scroll container')
  results.push({ name: 'Long content reaches actual feed-health controls by real parent scrolling', ...scrollState, pass: true })
  assert.equal(await js('window.__quakeAudioAttempts'), 0, 'Any AudioContext construction is forbidden in this isolated run')
  await layout(1120, 1, 'light')
  assert.equal(await js(`(()=>{const nav=[...document.querySelectorAll('.dcu-global-panel[aria-label="地震预警"]')].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});return nav.getBoundingClientRect().width>120&&nav.textContent.includes('地震预警')})()`), true, 'Desktop overview must include actual full sidebar Chinese navigation, not only icons')
  await capture('desktop-wide-light-overview.png')
  for (const file of sourceFiles) assert.equal(hash(file), sourceHashes[sourceKey(file)], 'Canonical source changed during run; evidence stale')
  assert.deepEqual(blockedRequests, [], 'Renderer attempted unexpected egress; it was rejected, not silently allowed')
  assert.equal(fs.existsSync(guard.record), false, 'DSH child attempted non-fixture egress; it was rejected')
  assert.deepEqual(errors, [], 'Unexpected renderer error')
  win.destroy(); win = undefined; await server.stop(); server = undefined
  await new Promise(resolve => upstream.close(resolve)); upstream = undefined
  const productionAfter = productionSnapshot(); assert.deepEqual(productionAfter, productionBefore)
  results.push({ name: 'Own isolated processes stopped, source hashes and eight production metadata identities unchanged', pass: true })
  fs.writeFileSync(join(out, 'results.json'), JSON.stringify({ status: 'pass', scope: 'isolated-actual-Profile-Loader-rc2-CodexUI-canonical-earthquake-host-client-with-local-upstream-fixture', screenshotPixelReviewRequired: true,
    actualHostVerified: true, realEarthquakeDataFetched: false, productionAlertOrAudio: false, productionRestartOrDeployment: false, legacy, scratch, runtimeVersion, uiVersion,
    sourceHashes, productionBefore, productionAfter, results, screenshots, clicks, errors, expectedErrors, blockedRequests, startupDiagnostics, feedRequests }, null, 2))
  console.log(`PASS ${results.length} actual-isolated-host/UI cases; ${clicks.length} trusted clicks; evidence ${out}`)
}
async function finish(code) {
  if (finished) return; finished = true
  try { win?.destroy(); if (server) await server.stop(); if (upstream) await new Promise(resolve => upstream.close(resolve)) }
  catch (error) { console.error('Own isolated cleanup failed:', redact(error)); code = 1 }
  // Fixtures contain read-only installed-package junctions. Never recursively delete.
  app.exit(code)
}
function writeFailure(error) {
  fs.writeFileSync(join(out, 'failure.json'), JSON.stringify({ status: 'fail', stage, legacy, error: redact(error), stack: redact(error.stack || ''), scratch, runtimeVersion, uiVersion, sourceHashes, results, screenshots, clicks, errors, expectedErrors, blockedRequests, startupDiagnostics, feedRequests }, null, 2))
}
const timeout = setTimeout(() => { const error = new Error('ISOLATED_TOTAL_TIMEOUT'); writeFailure(error); console.error(error.message); void finish(1) }, 600000)
run().then(() => { clearTimeout(timeout); return finish(0) }).catch(async error => {
  console.error(redact(error.stack || error))
  // Never wait for an uninitialized renderer before persisting the failure and
  // stopping our own host. Failed screenshot capture is bounded and nonessential.
  writeFailure(error)
  if (win && !win.isDestroyed() && win.webContents.getURL() && !win.webContents.isLoadingMainFrame()) {
    try {
      await finite((async () => { await freshPaint(); fs.writeFileSync(join(out, 'failure.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); screenshots.push('failure.png') })(), 4000, 'failure document capture')
    }
    catch { /* Document may be incomplete; failure metadata remains authoritative. */ }
  }
  writeFailure(error); clearTimeout(timeout)
  return finish(1)
})
