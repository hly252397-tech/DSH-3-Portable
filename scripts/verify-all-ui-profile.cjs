// Fresh UI inspection through the real installed Profile/Loader and Electron.
// This is an offline, isolated coverage audit, never a deployment/acceptance tool.
// Registered but credential/task/install-dependent surfaces remain explicitly blocked.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs'), http = require('node:http'), assert = require('node:assert/strict')
const { join, dirname, resolve, relative, parse, isAbsolute } = require('node:path')
const { createHash, randomUUID } = require('node:crypto'), { pathToFileURL } = require('node:url')
const cp = require('node:child_process'), { syncBuiltinESMExports } = require('node:module')
const yaml = require('yaml')
const root = resolve(__dirname, '..'), args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--preflight', 'Only --preflight is supported')
const preflight = args.length === 1
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const key = file => relative(root, file).replace(/\\/g, '/')
const redact = text => String(text).replace(/([?&](?:token|authToken)=)[^\s&"']+/gi, '$1[redacted]')
  .replace(/((?:agentToken|authorization|bearer|password|apiKey)["'\s:=]+)[^\s,"'}]+/gi, '$1[redacted]')
function ordinary(path) {
  const abs = resolve(path), lower = text => process.platform === 'win32' ? text.toLowerCase() : text
  assert.equal(lower(fs.realpathSync(abs)), lower(abs), 'Evidence path follows a junction')
  for (let cursor = abs; cursor !== parse(cursor).root; cursor = dirname(cursor)) {
    const stat = fs.lstatSync(cursor); assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Evidence ancestor is not ordinary')
  }
  return abs
}
function json(file, metadata = true) {
  const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024)
  if (metadata) { ordinary(dirname(file)); assert.equal(stat.nlink, 1) }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
ordinary(join(root, 'Data/Development'))
const evidenceRoot = join(root, 'Data/Development/ui-global-audit'); fs.mkdirSync(evidenceRoot, { recursive: true }); ordinary(evidenceRoot)
const out = join(evidenceRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID()); fs.mkdirSync(out)
const scratch = join(out, 'isolated'); fs.mkdirSync(scratch); ordinary(scratch)
const portable = join(scratch, 'portable'), home = join(portable, 'Data/DSH-home'), profile = join(home, 'profiles/web'), nm = join(profile, 'node_modules')
fs.mkdirSync(nm, { recursive: true })
app.setName('DSH isolated full UI audit'); app.setPath('userData', join(scratch, 'electron')); app.setPath('sessionData', join(scratch, 'electron'))
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {})
let win, shellWin, host, upstream, origin, fixtureOrigin, finished = false, stage = 'preflight', paintCount = 0, runtimeVersion, uiVersion, before, runtimeBinding, catalog, currentTheme = 'light', bootstrapSnapshot
const sources = {}, sourcePaths = {}, sourceCopies = [], sourceExclusions = [], bundles = [], sourceLedger = [], surfaces = [], findings = [], clicks = [], errors = [], blockedRequests = [], ipcCalls = [], startup = [], screenshots = []
let copiedBytes = 0
const protectedFiles = ['Data/Updates/Desktop/pointer.json', 'Data/Updates/Desktop/state.json', 'Data/Runtime/Harness/current.json',
  'Data/Electron/UserData/desktop-settings.json', 'Data/Electron/UserData/desktop-update-settings.json', 'Data/Electron/UserData/shell/theme.json',
  'Data/Updates/Harness/policy.json', 'Data/Plugins/dsh-earthquake-alert/preferences.json']
function production() {
  return protectedFiles.map(path => { const file = join(root, path); if (!fs.existsSync(file)) return { path, present: false }
    const stat = fs.lstatSync(file); ordinary(dirname(file)); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1)
    return { path, present: true, sha256: sha(file), size: stat.size, mtimeMs: stat.mtimeMs } })
}
function track(file, alias) { const id = alias || key(file); sourcePaths[id] = file; sources[id] = sha(file); return sources[id] }
function save(name, value) { fs.writeFileSync(join(out, name), JSON.stringify(value, null, 2)) }
function checkpoint(next) { stage = next; save('checkpoint.json', { stage, preflight, out, scratch, hostPid: startup.at(-1)?.pid, surfaces: surfaces.length, screenshots: screenshots.length }) }
async function finite(promise, milliseconds, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ISOLATED_STEP_TIMEOUT: ' + label)), milliseconds) })]) } finally { clearTimeout(timer) } }
const js = code => finite(win.webContents.executeJavaScript(code), 12000, 'renderer at ' + stage)
async function until(fn, reason, milliseconds = 30000) { const end = Date.now() + milliseconds; while (Date.now() < end) { if (await fn()) return; await sleep(100) } throw new Error(reason) }
function own(name) { const path = resolve(scratch, name), suffix = relative(scratch, path); assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix)); return path }
function link(target, destination) { fs.mkdirSync(dirname(destination), { recursive: true }); fs.symlinkSync(target, destination, 'junction') }
function copyTree(source, destination, options = {}) {
  ordinary(source)
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    const from = join(source, item.name), to = join(destination, item.name)
    const top = options.rootLevel !== false
    if (['node_modules', '.git', 'evidence', 'test', 'tests'].includes(item.name) || item.name === 'ui-probe.json' ||
      top && !(item.isDirectory() ? ['lib', 'portable', 'assets', 'src'].includes(item.name) : ['package.json', 'cordis.patch.yml', 'dsh-capabilities.json'].includes(item.name))) {
      sourceExclusions.push({ source: key(from), reason: 'Outside explicit runtime-code/assets/maintenance-source metadata whitelist; evidence, tests, backups, installer state and production configuration are not copied' }); continue
    }
    assert.ok(!item.isSymbolicLink(), 'Local source subtree contains a symlink')
    if (item.isDirectory()) { copyTree(from, to, { ...options, rootLevel: false }); continue }
    assert.ok(item.isFile()); const info = fs.lstatSync(from); copiedBytes += info.size
    assert.ok(sourceCopies.length < 2500 && info.size <= 32 * 1024 * 1024 && copiedBytes <= 128 * 1024 * 1024, 'Bounded source copy budget exceeded')
    const hash = track(from); fs.mkdirSync(dirname(to), { recursive: true })
    if (item.name === 'cordis.patch.yml') {
      // Bundle patch identity is preserved; configuration values and !!js
      // expressions are never copied. Each own override is declared separately.
      const original = yaml.parse(fs.readFileSync(from, 'utf8'), { logLevel: 'silent' })
      assert.ok(Array.isArray(original) && original.length <= 20)
      const identity = entry => { assert.ok(entry && typeof entry.id === 'string' && /^[\w-]+$/.test(entry.id) && typeof entry.name === 'string' && /^[\w@./-]+$/.test(entry.name)); return { id: entry.id, name: entry.name } }
      const rebuilt = original.map(row => row.insert ? { insert: row.insert.map(identity) } : identity(row))
      fs.writeFileSync(to, yaml.stringify(rebuilt))
      sourceCopies.push({ source: key(from), destination: to, sourceSha256: hash, destinationSha256: sha(to), transformation: 'identity-only real plugin rows; all configuration/expressions omitted, not byte-identical', whitelist: ['id', 'name', 'insert'] })
    } else { fs.copyFileSync(from, to); assert.equal(sha(to), hash); sourceCopies.push({ source: key(from), destination: to, sha256: hash, whitelist: top ? 'immutable package/capability metadata' : 'runtime assets/code or retained maintenance source' }) }
    assert.equal(sha(from), hash, 'Source drifted while copied')
  }
}
const canonical = { 'dsh-ui-tweaks': 'customizations/ui-tweaks', 'dsh-agent-mcp': 'customizations/agent-mcp',
  'dsh-custom-spaces': 'customizations/custom-spaces', 'dsh-black-hole': 'customizations/black-hole',
  'dsh-system-awareness': 'plugins/dsh-system-awareness', 'dsh-manual': 'plugins/dsh-manual',
  'dsh-earthquake-alert': 'plugins/dsh-earthquake-alert', 'dsh-p3-tiny-watch': 'plugins/dsh-p3-tiny-watch' }
const settingsSurfaceIds = { '常规': 'settings.general', '模型': 'settings.models', '通知': 'settings.desktop.notifications',
  '更新': 'settings.desktop.updates', '插件市场': 'market.main', '内置插件': 'settings.plugins', '技能': 'skills-manager.settings',
  '连接器': 'workspace.connectors', '专家': 'agency-agents.settings', 'Agent预设': 'settings.agent-presets', 'DSH手册': 'manual.main',
  '自定义空间': 'custom-spaces.settings', '侧边卡片': 'sidebar.settings', 'CodexUI': 'workspace.about', '宠物': 'codex-pet.main',
  '定时任务': 'automation.main', 'IM助理': 'im-connect.main', '多智能体交互管理': 'multi-agent.management', '归档会话': 'archive-manager.main' }
const safeOverrides = []
// Every allowed POST is a reviewed read operation against the OWN profile. HTTP
// POST is the official RPC transport, not by itself evidence of a mutation.
const readOnlyPosts = new Set(['/api/settings/describe', '/api/credentials/describe', '/api/dynamicCordisRunner/inventory',
  '/api/dynamicCordisRunner/syncInspectManifest', '/api/session/list', '/api/session/modelCatalog', '/api/permissionPresets/catalog',
  '/api/agentPresets/list', '/api/agencyAgents/getTeams', '/api/agencyAgents/getCatalog', '/api/llm/listProviders',
  '/api/llm/listConfigurableProviders', '/sidebar/api/shell.get', '/sidebar/api/settings.get', '/dsh-automation/snapshot', '/ui-tweaks/probe'])
function row(id, config, reason) { safeOverrides.push({ id, config, reason }); return '- id: ' + id + '\n  config: ' + JSON.stringify(config) + '\n' }
async function upstreamFixture() {
  upstream = http.createServer((req, res) => { const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    // No live event, no siren. Only clearly dated synthetic history data.
    if (pathname === '/eew') res.end('null')
    else if (pathname === '/list') res.end(JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ time: '2026-09-28 12:00:00', location: '隔离历史演练地点 ' + (i + 1), magnitude: 3 + i / 10, depth: 10, latitude: 30, longitude: 104 }))))
    else { res.end(JSON.stringify({ fixture: 'isolated owned workbench listener; no production site' })) }
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); fixtureOrigin = 'http://127.0.0.1:' + upstream.address().port
}
function childGuard() {
  const file = own('child-safety.cjs'), record = own('child-safety.jsonl'), allowedPort = Number(new URL(fixtureOrigin).port)
  // Only this child is patched. Parent starts exactly one owned DSH process.
  // All descendant execution is refused, and filesystem writes follow realpath.
  fs.writeFileSync(file, `const fs=require('node:fs'),p=require('node:path'),net=require('node:net'),cp=require('node:child_process'),mod=require('node:module');
const base=${JSON.stringify(scratch)},record=${JSON.stringify(record)},port=${allowedPort},ownedPorts=new Set([port]),append=fs.appendFileSync;
function note(kind,detail){append(record,JSON.stringify({kind,detail,at:Date.now(),pid:process.pid})+'\\n')}
function reject(kind,detail){note(kind,detail);const e=Error('ISOLATED_FORBIDDEN_'+kind);e.code='EACCES';throw e}
function inside(target){if(typeof target==='number')return;let path=target instanceof URL?require('node:url').fileURLToPath(target):String(target);path=p.resolve(path);let cursor=path;while(!fs.existsSync(cursor)&&cursor!==p.dirname(cursor))cursor=p.dirname(cursor);const real=fs.realpathSync(cursor),suffix=p.relative(base,real);if(suffix.startsWith('..')||p.isAbsolute(suffix))reject('write',p.basename(path));const lexical=p.relative(base,path);if(lexical.startsWith('..')||p.isAbsolute(lexical))reject('write',p.basename(path))}
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=function(){reject('child',{method:name,stack:Error().stack})};
for(const name of ['writeFile','appendFile','mkdir','mkdtemp','unlink','rm','rmdir','truncate','chmod','chown','utimes','link','symlink'])for(const suffix of ['', 'Sync']){const k=name+suffix,old=fs[k];if(old)fs[k]=function(target,...args){inside(target);if(['link','symlink'].includes(name))inside(args[0]);return old.call(this,target,...args)}};
for(const name of ['rename','copyFile','cp'])for(const suffix of ['', 'Sync']){const k=name+suffix,old=fs[k];if(old)fs[k]=function(a,b,...args){inside(b);if(name==='rename')inside(a);return old.call(this,a,b,...args)}};
for(const name of ['open','openSync']){const old=fs[name];fs[name]=function(path,flags,...args){if(typeof flags==='number'?!!(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT)):!/^r$/.test(String(flags)))inside(path);return old.call(this,path,flags,...args)}}
const oldStream=fs.createWriteStream;fs.createWriteStream=function(path,...a){inside(path);return oldStream.call(this,path,...a)};
const fsp=require('node:fs/promises');for(const name of ['writeFile','appendFile','mkdir','mkdtemp','unlink','rm','rmdir','truncate','chmod','chown','utimes','link','symlink']){const old=fsp[name];if(old)fsp[name]=async function(a,...rest){inside(a);if(['link','symlink'].includes(name))inside(rest[0]);return old.call(this,a,...rest)}}
for(const name of ['rename','copyFile','cp']){const old=fsp[name];if(old)fsp[name]=async function(a,b,...rest){inside(b);if(name==='rename')inside(a);return old.call(this,a,b,...rest)}}
const oldOpen=fsp.open;fsp.open=async function(path,flags,...a){if(typeof flags==='number'?!!(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT)):!/^r$/.test(String(flags)))inside(path);return oldOpen.call(this,path,flags,...a)};
const oldConnect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){let a=args[0];if(Array.isArray(a))a=a[0];if(a&&typeof a==='object'&&a.path)return oldConnect.apply(this,args);const h=typeof a==='object'?a.host:typeof args[1]==='string'?args[1]:'localhost',n=typeof a==='object'?a.port:a;if(n!==undefined&&(!['127.0.0.1','localhost','::1'].includes(h)||!ownedPorts.has(Number(n))))reject('egress',{host:h,port:n});return oldConnect.apply(this,args)};
const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){let a=args[0];if(Array.isArray(a))a=a[0];if(a&&typeof a==='object'&&a.path)reject('listen','pipe');const n=typeof a==='object'?a.port:a;if(Number(n)!==0)reject('listen',n);this.once('listening',()=>{ownedPorts.add(this.address()?.port);note('owned-listener',{port:this.address()?.port})});return listen.apply(this,args)};
const fetch=globalThis.fetch;globalThis.fetch=function(input,init){const u=new URL(typeof input==='string'?input:input.url||String(input));if(u.hostname!=='127.0.0.1'||!ownedPorts.has(Number(u.port)))reject('egress',{host:u.hostname,port:u.port});return fetch(input,init)};
mod.syncBuiltinESMExports();note('installed',{spawnDenied:true,writesConfined:true,onlyOwnedFixturePort:port,listenZeroOnly:true});`)
  return { file, record }
}
async function click(contents, selector) {
  await finite(contents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing target');e.scrollIntoView({block:'center',inline:'nearest'});})()`), 10000, 'scroll real target')
  await sleep(120)
  const point = await contents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);window.__uiTrustedClick=null;document.addEventListener('click',event=>{const e=document.querySelector(${JSON.stringify(selector)});window.__uiTrustedClick={trusted:event.isTrusted,target:e===event.target||!!e?.contains(event.target),label:event.target.textContent.trim().slice(0,100)}},{once:true,capture:true});return{x,y,hit:r.width>0&&r.height>0&&(hit===e||e.contains(hit)),disabled:e.disabled===true}})()`)
  assert.ok(point.hit, 'Obstructed real mouse target: ' + selector); assert.equal(point.disabled, false)
  const zoom = contents.getZoomFactor(), x = Math.round(point.x * zoom), y = Math.round(point.y * zoom); contents.focus()
  for (const e of [{ type: 'mouseMove', x, y }, { type: 'mouseDown', x, y, button: 'left', clickCount: 1 }, { type: 'mouseUp', x, y, button: 'left', clickCount: 1 }]) contents.sendInputEvent(e)
  await until(() => contents.executeJavaScript('window.__uiTrustedClick!==null'), 'No trusted click receipt')
  const receipt = await contents.executeJavaScript('window.__uiTrustedClick'); assert.equal(receipt.trusted, true); assert.equal(receipt.target, true)
  clicks.push({ selector, zoom, x, y, ...receipt }); await sleep(200)
}
async function freshPaint() {
  await finite(win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }), 8000, 'warm actual compositor'); await sleep(900)
  await js(`(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect&&a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})()`)
  const before = paintCount; win.webContents.invalidate(); await until(() => paintCount > before, 'No fresh paint'); await sleep(150)
}
async function fonts(selector) {
  const debug = win.webContents.debugger; await finite(debug.sendCommand('DOM.enable'), 10000, 'DOM.enable'); await finite(debug.sendCommand('CSS.enable'), 10000, 'CSS.enable')
  const { root: document } = await debug.sendCommand('DOM.getDocument'), { nodeId } = await debug.sendCommand('DOM.querySelector', { nodeId: document.nodeId, selector })
  if (!nodeId) return []
  const { fonts } = await debug.sendCommand('CSS.getPlatformFontsForNode', { nodeId }); return fonts.filter(font => font.glyphCount > 0)
}
function sampleComputed() {
  // Prior mounted-but-hidden slot entries can remain in the real renderer.
  // Instrumentation identities are unique to THIS current visible measurement.
  for (const element of document.querySelectorAll('[data-ui-audit-sample]')) element.removeAttribute('data-ui-audit-sample')
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility === 'visible' && s.display !== 'none' }
  const all = [...document.querySelectorAll('h1,h2,h3,h4,p,button,label,input,select,textarea,[role=tab],[role=dialog],.dsh-sg-item,.dcu-settings-link,dt,dd,summary,[class*="_title"],[class*="_hint"],[class*="_description"],[class*="_caption"]')].filter(visible)
  const style = getComputedStyle(document.documentElement), tokens = {}, expected = {}
  const probe = document.createElement('span'); probe.setAttribute('aria-hidden', 'true'); probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none'; document.body.append(probe)
  for (const [token, property] of Object.entries({ '--dsh-font-ui': 'font-family', '--dsh-font-size-control': 'font-size', '--dsh-text-primary': 'color', '--dsh-text-secondary': 'color' })) {
    tokens[token] = style.getPropertyValue(token).trim()
    if (tokens[token]) { probe.style.setProperty(property, 'var(' + token + ')'); expected[token] = getComputedStyle(probe).getPropertyValue(property).trim(); probe.style.removeProperty(property) }
  }
  probe.remove()
  for (const token of ['--dsh-font-code', '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsh-border-subtle', '--dcu-font-body', '--dcu-font-caption', '--dcu-font-small']) tokens[token] = style.getPropertyValue(token).trim()
  return { url: location.pathname, theme: document.body.hasAttribute('data-ds-dark-theme') || document.documentElement.dataset.colorScheme === 'dark' ? 'dark' : 'light', width: innerWidth, height: innerHeight,
    overflow: document.documentElement.scrollWidth > innerWidth + 1, tokens, expected, active: document.activeElement?.tagName,
    settingsNav: [...document.querySelectorAll('.dsh-sg-item.dsh-on')].filter(visible).map(e => e.dataset.dshNavKey),
    headings: all.filter(e => /^H[1-4]$/.test(e.tagName)).map(e => e.textContent.trim()), samples: all.slice(0, 350).map((e, i) => {
      e.dataset.uiAuditSample = String(i); const s = getComputedStyle(e), r = e.getBoundingClientRect()
      return { index: i, tag: e.tagName, role: e.getAttribute('role'), className: typeof e.className === 'string' ? e.className : '', id: e.id,
        label: (e.textContent || e.getAttribute('placeholder') || e.getAttribute('aria-label') || '').trim().slice(0, 150),
        font: s.font, fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, color: s.color, background: s.backgroundColor, border: s.borderColor, radius: s.borderRadius,
        width: r.width, height: r.height, top: r.top, bottom: r.bottom, inViewport: r.bottom > 0 && r.top < innerHeight,
        inNavigation: !!e.closest('.dsh-settings-groups,.dcu-settings-nav,.dcu-sidebar,.dcu-root'),
        value: /password/i.test(e.type || '') ? '[redacted]' : e.value, checked: e.checked, disabled: e.disabled, overflow: e.scrollWidth > e.clientWidth + 2,
        monospace: !!e.closest('pre,code,.monaco-editor,.terminal,.xterm') || /terminal|mono|codeEditor/.test(typeof e.className === 'string' ? e.className : '') || e.tagName === 'TEXTAREA' && /monospace|consolas/i.test(s.fontFamily) }
    }) }
}
const computed = '(' + sampleComputed.toString() + ')()'
async function keyboardFocusReceipt() {
  await js(`(()=>{window.__uiAuditKey=null;document.addEventListener('keydown',event=>{if(event.key==='Tab')window.__uiAuditKey={key:event.key,trusted:event.isTrusted}},{once:true,capture:true})})()`)
  win.webContents.focus()
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' })
  await sleep(120)
  return await js(`(()=>{const e=document.activeElement,r=e?.getBoundingClientRect(),s=e?getComputedStyle(e):null;
    const visible=!!r&&r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&s.visibility==='visible'&&s.display!=='none';
    const outline=!!s&&s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0&&!['transparent','rgba(0, 0, 0, 0)'].includes(s.outlineColor);
    const shadow=!!s&&s.boxShadow!=='none';const focusVisible=!!e&&e.matches(':focus-visible');
    return {event:window.__uiAuditKey,tag:e?.tagName,label:(e?.textContent||e?.getAttribute('aria-label')||'').trim().slice(0,100),
      selector:e?.id?'#'+CSS.escape(e.id):null,visible,focusVisible,outlineStyle:s?.outlineStyle,outlineWidth:s?.outlineWidth,
      outlineColor:s?.outlineColor,outlineOffset:s?.outlineOffset,boxShadow:s?.boxShadow,
      rect:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,
      verified:window.__uiAuditKey?.trusted===true&&visible&&focusVisible&&(outline||shadow)}})()`)
}
async function embeddedSamples() {
  const frame = win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc')
  if (!frame) return null
  const measurement = await finite(frame.executeJavaScript(computed), 12000, 'real srcdoc computed styles')
  const debug = win.webContents.debugger, { root: doc } = await debug.sendCommand('DOM.getDocument'), { nodeId } = await debug.sendCommand('DOM.querySelector', { nodeId: doc.nodeId, selector: 'iframe[data-dsh-desktop-settings]' })
  assert.ok(nodeId, 'Computed embedded document must belong to the current canonical settings iframe')
  const { node } = await debug.sendCommand('DOM.describeNode', { nodeId, depth: 1 }), { targetInfos } = await debug.sendCommand('Target.getTargets')
  const target = targetInfos.find(target => target.type === 'iframe' && target.targetId === node.frameId && target.url === 'about:srcdoc')
  const actualFonts = []; let sessionId
  try {
    if (target) sessionId = (await debug.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
    if (!sessionId) return { measurement, actualFonts, blockedReason: 'No exact OOPIF target; computed iframe styles retained, platform-font proof unavailable' }
    const { result } = await debug.sendCommand('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId); assert.equal(result.value, 'about:srcdoc')
    await debug.sendCommand('DOM.enable', {}, sessionId); await debug.sendCommand('CSS.enable', {}, sessionId)
    const { root: inner } = await debug.sendCommand('DOM.getDocument', {}, sessionId)
    for (const sample of measurement.samples.filter(sample => /[\u4e00-\u9fff]/.test(sample.label) && sample.inViewport && !sample.monospace).slice(0, 4)) {
      const { nodeId } = await debug.sendCommand('DOM.querySelector', { nodeId: inner.nodeId, selector: '[data-ui-audit-sample="' + sample.index + '"]' }, sessionId)
      const { fonts } = await debug.sendCommand('CSS.getPlatformFontsForNode', { nodeId }, sessionId); actualFonts.push({ index: sample.index, fonts: fonts.filter(font => font.glyphCount > 0) })
    }
  } finally { if (sessionId) await debug.sendCommand('Target.detachFromTarget', { sessionId }) }
  return { measurement, actualFonts, domFrameId: node.frameId, exactTarget: true }
}
async function capture(id, label, options = {}) {
  checkpoint('capture:' + id)
  await js(`(()=>{for(const e of document.querySelectorAll('.dcu-settings-main,.dshea-root,[data-dsh-manual-panel]')){e.scrollTop=0;e.scrollLeft=0}})()`)
  const modality = await js(`(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility==='visible'&&s.display!=='none'};
    return {dialogs:[...document.querySelectorAll('[role=dialog],dialog[open],[aria-modal=true]')].filter(visible).map(e=>({heading:e.querySelector('h1,h2,h3,[role=heading]')?.textContent.trim()||null,text:e.innerText.trim().slice(0,250)})),
      onboarding:[...document.querySelectorAll('button')].some(e=>visible(e)&&/^(稍后配置|Set up later)$/i.test(e.textContent.trim()))}})()`)
  assert.ok(!modality.onboarding || options.modal === 'onboarding', 'Credential onboarding overlay is not the requested page: ' + id)
  if (options.expectedNav) assert.ok((await js(computed)).settingsNav.includes(options.expectedNav), 'Capture selected navigation differs from requested page')
  const keyboardReceipt = await keyboardFocusReceipt()
  await freshPaint(); const measurement = await js(computed)
  assert.ok(options.modal === 'onboarding' || !await js(`(()=>{return [...document.querySelectorAll('button')].some(e=>e.getBoundingClientRect().width>0&&/^(稍后配置|Set up later)$/i.test(e.textContent.trim()))})()`), 'Onboarding appeared during paint; page coverage must not be counted')
  assert.equal(measurement.theme, options.theme || 'light', 'Actual theme path did not take effect')
  if (!measurement.samples.length) throw new Error('Empty page is not a captured UI: ' + id)
  const text = await js('document.body.innerText')
  const loadingOnly = /^(?:\s|Loading|正在加载|加载中|[.。…])+$/.test(text)
  assert.equal(loadingOnly, false, 'Loading-only page cannot pass')
  const actualFonts = []
  const mainSamples = measurement.samples.filter(sample => /[\u4e00-\u9fff]/.test(sample.label) && !sample.monospace && !sample.inNavigation && sample.inViewport)
  const navSample = measurement.samples.find(sample => sample.inNavigation && /[\u4e00-\u9fff]/.test(sample.label) && sample.inViewport)
  const fontSamples = [...mainSamples.filter(sample => /^H/.test(sample.tag)).slice(0, 1), ...mainSamples.filter(sample => !/^H/.test(sample.tag)).slice(0, 3), ...(navSample ? [navSample] : [])]
  for (const sample of fontSamples) {
    actualFonts.push({ index: sample.index, fonts: await fonts('[data-ui-audit-sample="' + sample.index + '"]') })
  }
  const name = id.replace(/[^\w.-]/g, '-') + '-' + createHash('sha256').update(id).digest('hex').slice(0, 12) + '.png', path = join(out, name)
  assert.equal(fs.existsSync(path), false, 'Screenshot ID collision must never overwrite evidence')
  fs.writeFileSync(path, (await finite(win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }), 10000, 'actual screenshot')).toPNG())
  screenshots.push(path)
  const sample = fontSamples.find(sample => !sample.inNavigation), primary = mainSamples.find(sample => /^H/.test(sample.tag)) || mainSamples.find(sample => sample.tag === 'LABEL'),
    secondary = mainSamples.find(sample => !['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(sample.tag) && (/caption|hint|description|muted|dim|note/.test(sample.className) || sample.tag === 'DT')),
    control = mainSamples.find(sample => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(sample.tag))
  const roles = []
  if (sample) roles.push({ id: 'ui-family', property: 'font-family', selector: '[data-ui-audit-sample="' + sample.index + '"]', computedValue: sample.fontFamily, expectedValue: measurement.expected['--dsh-font-ui'] || null, fontFamily: sample.fontFamily, platformFonts: actualFonts.find(item => item.index === sample.index)?.fonts || [] })
  for (const [id, property, target, token] of [['primary-text', 'color', primary, '--dsh-text-primary'], ['secondary-text', 'color', secondary, '--dsh-text-secondary'], ['control-size', 'font-size', control, '--dsh-font-size-control']]) {
    const mappedRole = catalog?.surfaces.find(surface => surface.id === options.catalogSurfaceId)?.roles?.find(role => role.id === id)
    if (target) roles.push({ id, property, selector: '[data-ui-audit-sample="' + target.index + '"]', computedValue: property === 'color' ? target.color : target.fontSize, expectedValue: mappedRole?.token ? measurement.expected[mappedRole.token] || null : null, sample: target, semanticMapping: mappedRole?.token ? 'provisional-live-role-review-required' : 'unmapped-retain-raw-value-no-uniformity-claim' })
  }
  const embedded = await embeddedSamples()
  if (embedded) assert.equal(embedded.measurement.theme, options.theme || 'light', 'Canonical embedded document did not receive the real bootstrap theme path')
  const surface = { id, catalogSurfaceId: options.catalogSurfaceId || null, label, state: 'captured', real: true,
    isTrusted: keyboardReceipt.event?.trusted === true || options.passive !== true && clicks.at(-1)?.trusted === true,
    sourceHashes: { ...sources }, screenshot: { path, sha256: sha(path) },
    roles, checks: { paint: true, focus: keyboardReceipt.verified === true, responsive: !measurement.overflow }, keyboardReceipt, modality, measurement, actualFonts, embedded,
    limitation: options.limitation || null, capturedAt: new Date().toISOString(), paintCount }
  surfaces.push(surface)
  if (measurement.overflow) findings.push({ id, issue: 'document-horizontal-overflow', width: measurement.width })
  save('partial-results.json', report()); return surface
}
function blocked(id, reason) { if (!surfaces.some(surface => surface.id === id)) surfaces.push({ id, state: 'blocked', real: false, isTrusted: false, blockedReason: reason, sourceHashes: { ...sources }, checks: {} }) }
function report() { return { schema: 1, kind: 'real-profile-ui', capturedAt: new Date().toISOString(), status: 'coverage-audit-not-global-acceptance', stage,
  profile: { runtimeVersion, uiVersion, bundles, safeOverrides, fixtureOnly: true, runtimeBinding, metadataHashes: runtimeBinding?.metadataHashes }, sourceHashes: sources, sourceCopies, sourceExclusions, copiedBytes, sourceLedger, surfaces, findings, screenshots, clicks, errors, blockedRequests, ipcCalls, startup, scratch, out } }
function evidence() {
  // Exact catalog IDs are mapped only when this round actually captured that
  // registered surface. No missing/modal/credential-dependent page is promoted.
  const catalogSurfaces = catalog.surfaces.map(item => {
    const captured = surfaces.find(surface => surface.state === 'captured' && surface.catalogSurfaceId === item.id)
    return captured ? { ...captured, id: item.id, captureId: captured.id } : { id: item.id, state: 'blocked', real: false, isTrusted: false,
      blockedReason: 'Not captured in this offline bounded round; registered conditional/credential/task/native-host states are not inferred from parent pages', checks: {}, sourceHashes: { ...sources } }
  })
  return { schema: 1, kind: 'real-profile-ui', capturedAt: new Date().toISOString(), profile: report().profile,
    surfaces: catalogSurfaces, sourceHashes: sources, captures: surfaces, matrix: preflight ? 'Five settings representatives, light only; diagnostic preflight' : 'Settings light/dark plus explicitly named responsive/modal representatives; not full Cartesian' }
}
async function bootstrapAndIpc() {
  const load = name => import(pathToFileURL(join(root, 'dist/src', name + '.js')))
  const { SHELL_IPC } = await load('shell-contract'), embedded = await load('embedded-desktop-settings')
  const document = embedded.embeddedDesktopSettingsDocument(fs.readFileSync(join(root, 'assets/settings.html'), 'utf8'), fs.readFileSync(join(root, 'assets/theme.css'), 'utf8'), fs.readFileSync(join(root, 'assets/theme.js'), 'utf8'), fs.readFileSync(join(root, 'assets/shell-icons/chevron-down.svg'), 'utf8'))
  // Read-only transport values are finite fixture state, never a claim that
  // notification delivery, updater execution or production persistence passed.
  const fixture = { notifications: { turnMode: 'unfocused', approvalsEnabled: true, questionsEnabled: true },
    desktop: { policy: 'manual', channel: 'stable', checkIntervalHours: 3 },
    harness: { channel: 'alpha', mode: 'manual', checkIntervalHours: 3, idleQuietSeconds: 30, shadowStartupTimeoutSeconds: 120, liveStartupTimeoutSeconds: 120, observationMinutes: 5, rollbackTimeoutSeconds: 60, maxDownloadRetries: 3, keepGoodSlots: 2, skipVersions: [], maxAutomaticDeployAttempts: 2, deployRetryCooldownHours: 12 } }
  bootstrapSnapshot = () => ({ locale: 'zh-CN', platform: 'win32', version: 'isolated-ui-audit', colorScheme: currentTheme, themePreset: 'deep-sea', menus: [], state: { zoomPercent: 100, browser: { visible: false }, update: { kind: 'idle' } } })
  const handlers = { getBootstrap: bootstrapSnapshot,
    getNotificationPreferences: () => fixture.notifications, getUpdatePreferences: () => fixture.desktop,
    getDesktopUpdateState: () => ({ packaged: true, currentVersion: 'isolated-ui-audit', status: { kind: 'idle' } }),
    getHarnessUpdateState: () => ({ available: true, running: false, policy: fixture.harness, state: { phase: 'idle', currentVersion: runtimeVersion } }) }
  function authorize(event) { assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame); assert.ok(embedded.mayUseEmbeddedDesktopSettings('dsh', true, event.senderFrame.url, origin)) }
  ipcMain.handle(SHELL_IPC.embeddedSettingsDocument, event => { authorize(event); return document })
  ipcMain.handle(SHELL_IPC.embeddedSettingsRequest, (event, value) => { authorize(event); const request = embedded.parseDesktopSettingsRequest(value); ipcCalls.push({ method: request.method }); assert.ok(Object.hasOwn(handlers, request.method), 'Read-only audit forbids mutation/action IPC'); return handlers[request.method]() })
  ipcMain.handle(SHELL_IPC.getBootstrap, event => { assert.equal(event.sender, shellWin.webContents); return handlers.getBootstrap() })
  ipcMain.handle(SHELL_IPC.getDesktopUpdateState, event => { assert.equal(event.sender, shellWin.webContents); return handlers.getDesktopUpdateState() })
  ipcMain.handle(SHELL_IPC.browserPanelTabs, event => { assert.equal(event.sender, win.webContents); return { tabs: [], activeId: null } })
  ipcMain.handle(SHELL_IPC.action, (event, value) => { assert.equal(event.sender, shellWin.webContents); assert.equal(value, 'settings', 'Only real shell settings entry is allowed'); win.webContents.send(SHELL_IPC.dshAction, value); return null })
}
async function theme(value) {
  currentTheme = value
  win.webContents.send('dsh-shell:desktop-theme', { colorScheme: value, preset: 'deep-sea' })
  // This is the production bootstrap event transport forwarded by the genuine
  // preload + desktop bridge into srcdoc, not a hand-written iframe attribute.
  win.webContents.send('dsh-shell:bootstrap', bootstrapSnapshot())
  await sleep(250); await until(() => js(`document.body.hasAttribute('data-ds-dark-theme')===${value === 'dark'}`), 'Theme path failed')
}
async function closeModal() { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' }); await sleep(250) }
async function fitActualPanelWidth(selector, target) {
  win.webContents.setZoomFactor(1); win.setContentSize(1360, 1000); await sleep(200)
  for (let attempt = 0; attempt < 5; attempt++) {
    const actual = await js(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().width`)
    assert.ok(Number.isFinite(actual) && actual > 0, 'Actual responsive panel is missing')
    if (Math.abs(actual - target) <= 2) return { selector, target, actual, windowWidth: win.getContentSize()[0] }
    const width = Math.round(win.getContentSize()[0] + target - actual); assert.ok(width >= 400 && width <= 2000, 'Panel width cannot be safely reached through actual window resize')
    win.setContentSize(width, 1000); await sleep(250)
  }
  throw new Error('Actual panel width not reached: ' + selector + ' -> ' + target)
}
async function settings(label) {
  await dismissOnboarding()
  const selector = '.dsh-settings-groups .dsh-sg-item[data-dsh-nav-key=' + JSON.stringify(label) + ']'
  await click(win.webContents, selector); await sleep(500)
  await until(() => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e=>e.classList.contains('dsh-on')&&e.getBoundingClientRect().width>0)`), 'Settings nav not selected: ' + label)
}
async function dismissOnboarding() {
  const marker = randomUUID()
  const selector = await js(`(()=>{for(const e of document.querySelectorAll('[data-ui-audit-dismiss]'))e.removeAttribute('data-ui-audit-dismiss');const b=[...document.querySelectorAll('button')].find(e=>/^(稍后配置|Set up later)$/i.test(e.textContent.trim())&&e.getBoundingClientRect().width>0&&getComputedStyle(e).visibility==='visible');if(b)b.dataset.uiAuditDismiss=${JSON.stringify(marker)};return b?'[data-ui-audit-dismiss="${marker}"]':null})()`)
  if (!selector) return
  if (!surfaces.some(surface => surface.id === 'onboarding-api-key-light')) await capture('onboarding-api-key-light', 'Real empty API-key onboarding dialog', { passive: true, modal: 'onboarding', catalogSurfaceId: 'settings.onboarding', limitation: 'No credential entry/save; trusted Later cancellation only' })
  await click(win.webContents, selector)
  await until(() => js(`![...document.querySelectorAll('button')].some(e=>/^(稍后配置|Set up later)$/i.test(e.textContent.trim())&&e.getBoundingClientRect().width>0)`), 'Empty credential onboarding was not cancelled')
}
async function inspectSecondary(label) {
  // Opening a dialog is explicitly allowlisted; never match arbitrary destructive
  // toolbar labels, connect/OAuth/QR/start/install/run/update/send/save buttons.
  const allowed = { '专家': /^(?:新建专家|添加专家|New expert)$/, 'Agent预设': /^(?:新建预设|添加预设|New preset)$/,
    '定时任务': /^(?:新建任务|新建定时任务|New task|New schedule)$/, 'IM助理': /^(?:添加渠道|Add channel)$/ }
  if (!allowed[label]) return
  const pattern = String(allowed[label])
  const marker = randomUUID()
  const selector = await js(`(()=>{for(const e of document.querySelectorAll('[data-ui-audit-secondary]'))e.removeAttribute('data-ui-audit-secondary');const pattern=${pattern},e=[...document.querySelectorAll('button')].find(e=>pattern.test(e.textContent.trim())&&e.getBoundingClientRect().width>0&&getComputedStyle(e).visibility==='visible'&&!e.disabled);if(!e)return null;e.dataset.uiAuditSecondary=${JSON.stringify(marker)};return'[data-ui-audit-secondary="${marker}"]'})()`)
  if (!selector) { blocked('secondary-' + label, 'No exact allowlisted readonly dialog entry in real page'); return }
  await click(win.webContents, selector); await freshPaint()
  const hasDialog = await js(`!![...document.querySelectorAll('[role=dialog],dialog,[aria-modal=true]')].find(e=>e.getBoundingClientRect().width>0)`)
  if (!hasDialog) { blocked('secondary-' + label, 'Entry did not create a real modal; no substitute mounted'); return }
  await capture('dialog-' + label, label + ' readonly dialog', { limitation: 'Opened/cancelled only; no saved configuration, execution, credentials or connection' })
  await closeModal()
}
async function run() {
  await app.whenReady(); checkpoint('source-identities'); before = production()
  const { activeUiProfile } = await import(pathToFileURL(join(root, 'scripts/lib/active-ui-profile.mjs'))), active = activeUiProfile(root)
  track(join(root, 'scripts/lib/ui-consistency-contract.mjs'))
  const { resolveUiRuntimeAnchor } = await import(pathToFileURL(join(root, 'scripts/lib/ui-consistency-contract.mjs')))
  runtimeBinding = await resolveUiRuntimeAnchor(root)
  catalog = json(join(root, 'customizations/ui/interface-catalog.json')); track(join(root, 'customizations/ui/interface-catalog.json'))
  const runtime = runtimeBinding.runtimeRoot; ordinary(runtime)
  assert.equal(resolve(root, runtimeBinding.profileRelativePath), active.profile)
  runtimeVersion = json(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), false).version
  assert.equal(runtimeVersion, runtimeBinding.runtimeVersion)
  assert.equal(json(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), false).name, '@deepseek-ai/dsh')
  const manifest = json(join(active.profile, 'package.json')); bundles.push(...manifest.dsh.profile.bundles); assert.equal(bundles.length, 38, 'Installed bundle inventory drift requires re-audit')
  uiVersion = json(join(active.profile, 'node_modules/@michengai/dsh-codex-ui/package.json'), false).version
  const compatibility = json(join(active.profile, 'compatibility.json')), approval = '@michengai/dsh-codex-ui@' + uiVersion
  assert.ok(compatibility[approval]?.includes(runtimeVersion), 'No invented compatibility override')
  for (const file of ['scripts/verify-all-ui-profile.cjs', 'assets/theme.css', 'assets/theme.js', 'assets/settings.html', 'assets/shell.html', 'dist/src/desktop-host.js', 'dist/src/desktop-bridge-client-source.js', 'dist/src/dsh-view-preload.cjs', 'dist/src/shell-preload.cjs', 'dist/src/dsh-process.js', 'dist/src/dsh-bootstrap.mjs', 'dist/src/embedded-desktop-settings.js']) track(join(root, file))
  link(join(runtime, 'node_modules/@deepseek-ai'), join(nm, '@deepseek-ai'))
  const dependencies = {}
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    const installed = join(active.profile, 'node_modules', name)
    if (String(spec).startsWith('link:')) {
      const oldSource = join(active.profile, 'local', name); assert.ok(fs.existsSync(join(oldSource, 'package.json')), 'Missing active link package: ' + name)
      const source = canonical[name] ? join(root, canonical[name]) : oldSource, destination = join(profile, 'local', name)
      copyTree(source, destination)
      dependencies[name] = 'link:local/' + name; link(destination, join(nm, name))
      sourceLedger.push({ name, kind: canonical[name] ? 'canonical-candidate-not-production-activated' : 'actual-active-code-only-no-config', source: key(source), activeSource: key(oldSource), canonicalIndexEqualsActive: sha(join(source, 'lib/index.js')) === sha(join(oldSource, 'lib/index.js')) })
      // Local plugin dependencies must resolve to the accepted installed versions.
      link(join(runtime, 'node_modules/@deepseek-ai'), join(destination, 'node_modules/@deepseek-ai'))
      link(join(active.profile, 'node_modules/schemastery'), join(destination, 'node_modules/schemastery'))
      if (fs.existsSync(join(active.profile, 'node_modules/zod'))) link(join(active.profile, 'node_modules/zod'), join(destination, 'node_modules/zod'))
    } else {
      assert.ok(fs.existsSync(join(installed, 'package.json')), 'Installed dependency missing; no install allowed: ' + name)
      dependencies[name] = json(join(installed, 'package.json'), false).version; link(installed, join(nm, name))
      sourceLedger.push({ name, kind: 'actual-installed-package-readonly', version: dependencies[name] })
      // Only explicit catalog source closure is read below; avoid an unbounded
      // recursive scan of unrelated installed-package implementation/data.
      track(join(installed, 'package.json'), '@active/node_modules/' + name + '/package.json')
    }
  }
  fs.writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-all-ui-audit', private: true, dependencies, dsh: { profile: { bundles } } }, null, 2))
  const catalogFiles = [...new Set([...catalog.sourceGroups.flatMap(group => group.sourceFiles), ...(catalog.sharedSourceFiles || [])])]
  assert.ok(catalogFiles.length <= 2500); let catalogBytes = 0
  const sourceBinding = []
  for (const id of catalogFiles) {
    const source = id.startsWith('@runtime/') ? join(runtime, id.slice(9)) : id.startsWith('@active/') ? join(active.profile, id.slice(8)) : join(root, id)
    const info = fs.lstatSync(source); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024)
    catalogBytes += info.size; assert.ok(catalogBytes <= 64 * 1024 * 1024); const sourceSha256 = track(source, id)
    const fixture = id.startsWith('@runtime/') ? source : id.startsWith('@active/local/') ? join(profile, id.slice(8)) : id.startsWith('@active/node_modules/') ? join(profile, id.slice(8)) : sourceCopies.find(copy => copy.source === id)?.destination
    const fixtureSha256 = fixture && fs.existsSync(fixture) ? sha(fixture) : null
    sourceBinding.push({ id, sourceSha256, fixtureSha256, binding: fixtureSha256 === sourceSha256 ? 'exact-actual-source-bytes' : fixtureSha256 ? 'transformed-or-different-fixture-explicitly-unsupported' : 'source-snapshot-only-not-a-loaded-byte-claim' })
  }
  save('catalog-source-binding.json', { catalogBytes, files: sourceBinding })
  const fixtureCompatibility = {}
  for (const [name, version] of Object.entries(dependencies)) {
    const installedVersion = String(version).startsWith('link:') ? json(join(nm, name, 'package.json'), false).version : version
    const exact = name + '@' + installedVersion
    if (compatibility[exact]?.includes(runtimeVersion)) fixtureCompatibility[exact] = [runtimeVersion]
  }
  assert.ok(fixtureCompatibility[approval]?.includes(runtimeVersion))
  fs.writeFileSync(join(profile, 'compatibility.json'), JSON.stringify(fixtureCompatibility))
  fs.mkdirSync(own('documents'), { recursive: true }); fs.writeFileSync(own('documents/隔离UI审查.txt'), '仅供隔离 UI 文件预览。没有生产文件、会话或凭据。\n')
  fs.mkdirSync(own('manual-source/docs'), { recursive: true }); fs.writeFileSync(own('manual-source/README.md'), '# 隔离手册源\n这是本轮 UI 审查的独立文档，不是生产手册内容。\n')
  const { transactStore } = await import(pathToFileURL(join(root, 'customizations/black-hole/lib/portable-store.js')))
  // Real canonical ownstore initialization, not a fabricated API reply.
  transactStore(join(home, 'workbench/black-hole'), { action: 'migrate' })
  await upstreamFixture()
  const fixturePort = Number(new URL(fixtureOrigin).port)
  let patch = row('workspace-controller', { documentsDirectory: own('documents') }, 'Own empty documents only')
  patch += row('session-query-sqlite', { path: join(home, 'session-query.sqlite'), openAt: 'never' }, 'Own path; full-text native database opening explicitly disabled, not a search capability claim')
  patch += row('hj-workbench', { port: fixturePort, dir: '', probeBrokerPort: 0, probeBrokerScript: '', fileRoots: [own('documents')] }, 'No Python/broker spawn, no fixed production ports/site')
  patch += row('agent-bridge', { port: 0 }, 'Own random listener, own DSH_HOME token, never deliver tasks')
  patch += row('agent-mcp', { port: 0, bridgeDir: '', bridgePort: fixturePort }, 'Own random listener and empty external Bridge directory')
  patch += row('restart-button', { agentToken: '' }, 'No copied production credential; restart route never invoked')
  patch += row('dsh-p3-tiny-watch', { enabled: false, scheduleEnabled: false, desktopNotifications: false }, 'No monitoring/network/schedule/notification')
  patch += row('agentos-trigger', { enabled: false, portableRoot: portable, workspaceRoot: own('documents') }, 'No autonomous execution; own missing AgentOS is explicitly degraded')
  patch += row('dsh-manual', { sourceRoot: own('manual-source'), manualDirectory: 'manual', allowModelEdits: false, syncIntervalSeconds: 3600 }, 'Own generated manual, no production source sync/model edit')
  patch += row('black-hole', { dataDirectory: join(home, 'workbench/black-hole') }, 'Own initially empty content store')
  patch += row('sidebar-spaces', { inventorExecutable: '', dataDirectory: join(home, 'workbench/sidebar-spaces') }, 'Own empty store; application launch never invoked')
  patch += row('im-connect', { stateDir: join(home, 'dsh-im-connect'), cwd: own('documents') }, 'No enabled accounts/channels/mappings or model submission')
  patch += row('mcp-connector', { catalogUrl: '', connectors: [], persistSecrets: false, openBrowser: false, showSidebarEntry: true }, 'Only real built-in offline catalog; no external MCP/OAuth/child')
  patch += row('dsh-market', { allowRestart: false, profile: 'web' }, 'No installs/update/restart; remote catalog blocked explicitly')
  patch += row('ui-usage-billing', { statsPath: join(home, '.dsh-usage-stats.json'), snapshotPath: join(home, '.dsh-usage-stats.json'), ledgerPath: join(home, '.dsh-usage-ledger.json'), reconcilePath: join(home, '.dsh-usage-reconcile.json'), subscriptionProviders: [] }, 'Own empty usage; startup remote pricing refused before egress, builtin fallback only')
  patch += row('dsh-earthquake-alert', { eewUrl: fixtureOrigin + '/eew', listUrl: fixtureOrigin + '/list', pollSeconds: 30, listSeconds: 60, timeoutSeconds: 3 }, 'Own null-current fixture, historical rows, no live warning/sound')
  fs.writeFileSync(join(profile, 'cordis.patch.yml'), patch)
  const { installDesktopBridge } = await import(pathToFileURL(join(root, 'dist/src/desktop-host.js'))); installDesktopBridge(profile, join(root, 'dist/src'))
  assert.deepEqual(json(join(profile, 'package.json')).dsh.profile.bundles, bundles, 'Do not silently drop registered UI bundles')
  // Persist real sidebar defaults in the isolated home before loading any client.
  fs.mkdirSync(join(home, 'better-sidebar'), { recursive: true })
  const guard = childGuard(); save('safety-assembly.json', { bundles, safeOverrides, sourceLedger, productionConfigCopied: false,
    productionConfigPolicy: 'Only package/code/assets/maintenance sources and immutable capability metadata; bundle patches reconstructed with identity-only whitelist and all own overrides declared', guard: guard.file, sourceCopies, sourceExclusions })
  checkpoint('start-owned-host')
  const { GATE_NODE } = await import(pathToFileURL(join(root, 'scripts/lib/gate-node.mjs'))), { startDsh } = await import(pathToFileURL(join(root, 'dist/src/dsh-process.js')))
  const oldSpawn = cp.spawn
  cp.spawn = function (command, args, options) {
    assert.equal(command, GATE_NODE); assert.equal(args[0], join(root, 'dist/src/dsh-bootstrap.mjs')); assert.equal(options.cwd, scratch)
    const child = oldSpawn(command, args, options); const entry = { pid: child.pid, commandIdentity: 'gate-node', startedAt: new Date().toISOString() }; startup.push(entry)
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', chunk => { const text = redact(chunk); fs.appendFileSync(join(out, 'host-' + name + '.log'), text); if (/dsh web:/.test(text)) entry.readyLineSeen = true })
    return child }
  syncBuiltinESMExports()
  const environment = { DSH_PORTABLE_ROOT: portable, DSH_HOME: home, DSH_PROFILE_DIR: profile, DSH_PROFILE_NAME: 'web', DSH_RUNTIME_DIR: runtime,
    DSH_DESKTOP_WEB_PORT: '0', NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require ' + JSON.stringify(guard.file.replace(/\\/g, '/')),
    USERPROFILE: own('os-user'), APPDATA: own('os-user/AppData/Roaming'), LOCALAPPDATA: own('os-user/AppData/Local'), TEMP: scratch, TMP: scratch, TMPDIR: scratch,
    npm_config_cache: own('npm-cache'), npm_config_offline: 'true' }
  // Do not inherit provider, OAuth, IM, proxy or routing secrets. Values are never logged.
  for (const name of Object.keys(process.env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|PROXY|DSHM_|DSH_USAGE_STATS/i.test(name)) environment[name] = ''
  try { host = await startDsh({ nodeExecutable: GATE_NODE, bootstrapPath: join(root, 'dist/src/dsh-bootstrap.mjs'), runtime: { root: runtime, entry: join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js') }, workingDirectory: scratch, environment, startupTimeoutMs: 120000 }) }
  finally { cp.spawn = oldSpawn; syncBuiltinESMExports() }
  origin = new URL(host.url).origin
  checkpoint('create-owned-electron')
  app.on('web-contents-created', (_event, contents) => { contents.setAudioMuted(true); contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => { if (/^https?:/.test(url) && ![origin, fixtureOrigin].includes(new URL(url).origin)) event.preventDefault() })
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    contents.session.webRequest.onBeforeRequest((request, callback) => { let blocked = false
      if (/^(https?|wss?):/.test(request.url)) { const target = new URL(request.url), normalized = target.origin.replace(/^ws/, 'http')
        const ownedListeners = fs.readFileSync(guard.record, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.kind === 'owned-listener').map(item => Number(item.detail.port))
        blocked = ![origin, fixtureOrigin].includes(normalized) && !(target.hostname === '127.0.0.1' && ownedListeners.includes(Number(target.port)))
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          let readOnly = target.origin === origin && request.method === 'POST' && readOnlyPosts.has(target.pathname)
          if (target.origin === origin && request.method === 'POST' && ['/dsh-manual/api', '/dsh-agent-mcp/settings'].includes(target.pathname)) {
            try {
              const value = JSON.parse(Buffer.concat((request.uploadData || []).filter(item => item.bytes).map(item => item.bytes)).toString('utf8'))
              const operation = value.operation
              readOnly = target.pathname === '/dsh-manual/api'
                ? ['list', 'search', 'read', 'history', 'status'].includes(operation) && Object.keys(value).every(name => ['operation', 'query', 'offset', 'limit', 'id'].includes(name))
                : ['status', 'check', 'bridge.status'].includes(operation) && Object.keys(value).every(name => name === 'operation')
            } catch {}
          }
          if (target.origin === origin && request.method === 'POST' && target.pathname === '/black-hole/api/store') {
            try { const value = JSON.parse(Buffer.concat((request.uploadData || []).filter(item => item.bytes).map(item => item.bytes)).toString('utf8')); readOnly = value.action === 'load' && Object.keys(value).every(name => name === 'action') } catch {}
          }
          if (!readOnly) blocked = true
        }
        if (blocked) blockedRequests.push({ host: target.hostname, path: target.pathname, method: request.method }) }
      callback({ cancel: blocked }) }) })
  win = new BrowserWindow({ width: 1360, height: 1000, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: join(root, 'dist/src/dsh-view-preload.cjs') } })
  shellWin = new BrowserWindow({ width: 1360, height: 52, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: join(root, 'dist/src/shell-preload.cjs') } })
  win.webContents.on('paint', () => paintCount++); win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(redact(event.message)) })
  await bootstrapAndIpc(); await finite(win.loadURL('about:blank'), 15000, 'initial renderer')
  const debug = win.webContents.debugger; debug.attach('1.3'); await finite(debug.sendCommand('Page.enable'), 10000, 'Page.enable')
  await debug.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `window.__uiAudioAttempts=0;for(const k of ['AudioContext','webkitAudioContext','Notification'])if(window[k])window[k]=class{constructor(){window.__uiAudioAttempts++;throw Error('ISOLATED_AUDIO_NOTIFICATION_FORBIDDEN')}};` })
  await finite(win.loadURL(host.url), 45000, 'real authenticated DSH URL'); await win.webContents.insertCSS(fs.readFileSync(join(root, 'assets/theme.css'), 'utf8'))
  await theme('light'); await finite(shellWin.loadFile(join(root, 'assets/shell.html')), 15000, 'real shell document')
  await until(() => js(`!!document.querySelector('[data-dcu-settings-trigger]')&&!!window.dshDesktopShell`), 'True Codex UI/bridge did not become ready')
  await sleep(1500); await dismissOnboarding()
  await capture('welcome-light', 'Welcome/new unsent draft', { passive: true, catalogSurfaceId: 'conversation.welcome', limitation: 'No model/task submission or production sessions' })
  await click(shellWin.webContents, '#settings-btn')
  await until(() => js(`!!document.querySelector('.dsh-settings-groups')`), 'Real settings navigation not registered')
  await freshPaint(); await dismissOnboarding()
  const nav = await js(`[...document.querySelectorAll('.dsh-settings-groups .dsh-sg-item')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({label:e.dataset.dshNavKey,text:e.textContent.trim()}))`)
  assert.ok(nav.length >= 15, 'Full installed settings inventory unexpectedly incomplete'); save('actual-nav.json', nav)
  const selection = preflight ? nav.filter(item => ['常规', '模型', '多智能体交互管理', '插件配置', 'DSH手册'].includes(item.label.replace(/\s/g, ''))) : nav
  for (const item of selection) {
    await theme('light'); const previousErrorCount = errors.length
    try { await settings(item.label) }
    catch (error) {
      const newErrors = errors.slice(previousErrorCount)
      if (item.label !== '插件配置' || !String(error.message).startsWith('Settings nav not selected:') || !newErrors.some(message => message.includes('props.useStore is not a function')) || !newErrors.some(message => message.includes("slot entry crashed in 'settings.section'"))) throw error
      findings.push({ id: 'plugin-config-render-crash', page: item.label, issue: 'Real Codex mirrored main/plugins loses official entry.store; props.useStore unavailable in settings.section', errors: newErrors })
      blocked('plugin-config-parent-and-children', 'Actual plugin configuration parent crashes before cards; no configuration/detail children are inferred as validated')
      await capture('business-error-plugin-config-fallback-light', 'Observed actual plugin configuration crash fallback, not plugin configuration coverage', { limitation: 'Diagnostic only. Requested plugin configuration never mounted; fallback remains rejected.' })
      await settings('常规')
      assert.equal(await js(`document.querySelector('.dcu-settings-inner')?.dataset.settingsSection`), 'general', 'Trusted recovery did not restore actual general main')
      continue
    }
    await capture('settings-' + item.label + '-light', item.label, { catalogSurfaceId: settingsSurfaceIds[item.label.replace(/\s/g, '')], expectedNav: item.label, limitation: /通知|更新|常规/.test(item.label) ? 'Canonical desktop document + readonly fixture IPC values; actual actions/persistence not tested' : null })
    if (!preflight) { await inspectSecondary(item.label); await theme('dark'); await capture('settings-' + item.label + '-dark', item.label, { theme: 'dark', expectedNav: item.label }) }
  }
  if (!preflight) {
    // Representative combinations, intentionally not a false all-page Cartesian claim.
    for (const [label, width, zoom, mode] of [['常规', 900, 1.25, 'light'], ['模型', 900, 1.5, 'dark'], ['DSH手册', 900, .8, 'light'], ['多智能体交互管理', 900, 1, 'dark'], ['DSH手册', 900, 1.25, 'light']]) {
      if (!nav.some(item => item.label === label)) { blocked('responsive-' + label, 'Expected representative nav absent'); continue }
      win.setContentSize(width, 1000); win.webContents.setZoomFactor(zoom); await theme(mode); await settings(label); await capture('responsive-' + label + '-' + zoom + '-' + mode, label, { theme: mode })
    }
    win.webContents.setZoomFactor(1); win.setContentSize(1360, 1000)
    await click(win.webContents, '.dcu-settings-back')
    await until(() => js(`!document.querySelector('.dcu-settings-page')`), 'Actual settings did not close')
    await theme('dark'); await capture('welcome-dark', 'Welcome/new unsent draft dark', { theme: 'dark', passive: true, limitation: 'No model/task or production data; same real welcome main, not a message-state claim' })
    const quakeSelector = '.dcu-global-panel[aria-label="地震预警"]'
    if (await js(`!!document.querySelector(${JSON.stringify(quakeSelector)})`)) {
      await theme('light'); await click(win.webContents, quakeSelector)
      await until(() => js(`!!document.querySelector('.dshea-root')`), 'Actual registered earthquake page did not mount')
      await capture('earthquake-main-light', 'Actual earthquake main, null current own fixture', { catalogSurfaceId: 'earthquake.main', limitation: 'Owned null-current/history sources only; no live warning, test banner, sound or notification' })
      await theme('dark'); await capture('earthquake-main-dark', 'Actual earthquake main dark', { theme: 'dark' })
      for (const width of [320, 480, 900]) {
        const viewport = await fitActualPanelWidth('.dshea-root', width)
        for (const mode of ['light', 'dark']) { await theme(mode); const surface = await capture('earthquake-width-' + width + '-' + mode, 'Actual available earthquake column ' + width, { theme: mode }); surface.viewport = viewport }
      }
    } else blocked('earthquake-main-not-registered', 'Actual sidebar.panellist earthquake button absent; no component manually mounted')
    // Right-side tabs require a real selected workspace/session in this runtime.
    // The own empty draft intentionally does not fabricate a task or open a
    // child terminal just to obtain Files/black-hole/native browser screenshots.
    blocked('right-tabs-no-own-session', 'Actual empty unsent draft has no selected workspace/session; right Files/black-hole/other tab states remain conditional, no fabricated store/session mounted')
  }
  win.webContents.setZoomFactor(1); win.setContentSize(1360, 1000)
  for (const [id, reason] of Object.entries({ 'conversation-live-messages': 'Real model task/LLM response and production sessions are forbidden', 'conversation-trajectory-context': 'No real task run; public synthetic canonical session fixture not yet approved',
    'agent-approval-question-modal': 'Do not provoke approvals/tasks to obtain UI', 'terminal-execution': 'All child process execution refused; no fake terminal substituted', 'external-browser-sites': 'Third-party site typography explicitly outside DSH UI scope and all egress denied',
    'workbench-external-site': 'Real external macro-cloud site/data outside isolated profile; only DSH service manager covered', 'marketplace-remote-catalog-install': 'External catalog/download/install/restart forbidden; registered offline/error page only',
    'im-auth-qr-connected-channels': 'No real account, credentials, messages or channel connect', 'mcp-oauth-connected-server': 'No credential/token view, OAuth, external server or child launch', 'updates-live-operation': 'No network update/download/install/restart; readonly document fixture only',
    'notification-audio-delivery': 'Permission/API constructors refused, window muted; no real notification/siren', 'billing-real-account-provider': 'No accounts, real usage or provider prices; own empty stats only', 'agentos-background-execution': 'Disabled in isolated profile; no product healthy-execution claim',
    'schedule-run-history': 'Own empty automation store; save/run/enable forbidden' })) blocked(id, reason)
  assert.equal(await js('window.__uiAudioAttempts'), 0, 'Page attempted notification/audio during readonly audit')
  assert.deepEqual(production(), before, 'Production metadata changed during isolated audit')
  for (const [source, expected] of Object.entries(sources)) assert.equal(sha(sourcePaths[source]), expected, 'Source drift invalidates evidence: ' + source)
  assert.deepEqual(await resolveUiRuntimeAnchor(root), runtimeBinding, 'Runtime/home/profile binding drift invalidates evidence')
  const safetyRecords = fs.existsSync(guard.record) ? fs.readFileSync(guard.record, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  assert.ok(safetyRecords.some(record => record.kind === 'installed'), 'Child safety guard did not actually install')
  const childDenied = safetyRecords.filter(record => record.kind === 'child')
  for (const record of childDenied) {
    const stack = record.detail?.stack || ''
    if (record.detail?.method === 'spawn' && /ForegroundExplorer\.(?:warmup|ensureStarted)/.test(stack) && stack.includes('@michengai/dsh-codex-ui/lib/index.mjs')) blocked('native-explorer-warmup', 'Immutable Codex UI unconditionally attempts Explorer foreground helper warmup; child guard refused before execution. UI retained, native opening not validated.')
    else if (record.detail?.method === 'execFile' && stack.includes('@deepseek-ai/dsh-host-open-in-app/lib/index.js') && /readWindowsRegistryView/.test(stack)) blocked('native-open-app-discovery', 'Native installed-app registry probe refused before child execution. Real catalog availability degraded and not validated.')
    else throw new Error('Unknown forbidden child attempt; re-audit source before continuing: ' + redact(stack))
  }
  assert.equal(safetyRecords.some(record => ['write', 'listen'].includes(record.kind)), false, 'Host attempted outside write/fixed listen; retain failure')
  save('safety-final.json', { records: safetyRecords, productionBefore: before, productionAfter: production(), sourceHashesUnchanged: true, audioAttempts: 0, noSilentBundleOmission: true })
  save('results.json', report()); save('evidence.json', evidence())
  console.log(JSON.stringify({ status: 'captured-with-explicit-blocked-coverage', out, surfaces: surfaces.length, screenshots: screenshots.length, findings: findings.length }))
}
async function finish(code) {
  if (finished) return; finished = true
  try { win?.destroy(); shellWin?.destroy(); if (host) await finite(host.stop(), 12000, 'normal owned host stop'); if (upstream) await finite(new Promise(resolve => upstream.close(resolve)), 5000, 'owned fixture stop') }
  catch (error) { console.error(redact(error)); code = 1 }
  // No recursive cleanup: isolated fixtures contain immutable source junctions.
  app.exit(code)
}
function failure(error) { save('failure.json', { ...report(), status: 'fail', error: redact(error), stack: redact(error.stack || ''), productionBefore: before, productionAfter: before ? production() : null }) }
const totalTimer = setTimeout(() => { const error = new Error('ISOLATED_TOTAL_TIMEOUT'); failure(error); void finish(1) }, 900000)
run().then(() => { clearTimeout(totalTimer); return finish(0) }).catch(async error => {
  console.error(redact(error.stack || error)); failure(error)
  if (win && !win.isDestroyed() && win.webContents.getURL() && !win.webContents.isLoadingMainFrame()) try { await finite((async () => { await freshPaint(); fs.writeFileSync(join(out, 'failure.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()) })(), 4000, 'bounded failure screenshot') } catch {}
  failure(error); clearTimeout(totalTimer); return finish(1)
})
