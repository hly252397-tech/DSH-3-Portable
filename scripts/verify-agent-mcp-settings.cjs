// Real isolated Profile/Loader + real client bundle + trusted mouse input.
// HTTP Bridge fixtures and clipboard stubs cannot execute business tasks.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), assert = require('node:assert/strict')
const { join, resolve, dirname, relative, isAbsolute, parse } = require('node:path')
const { pathToFileURL } = require('node:url')
const { randomUUID, createHash } = require('node:crypto')
const { createFixtureBridge, guardIdentity } = require('./lib/agent-mcp-bridge-fixture.cjs')
const root = resolve(__dirname, '..')
function ordinaryDirectory(path) {
  const absolute = resolve(path), canonical = fs.realpathSync(absolute)
  const same = value => process.platform === 'win32' ? value.toLowerCase() : value
  assert.equal(same(canonical), same(absolute), 'Evidence/fixture path must not follow a junction')
  let parent = absolute
  while (parent !== parse(parent).root) {
    const entry = fs.lstatSync(parent)
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'Evidence/fixture ancestor must be an ordinary directory')
    parent = dirname(parent)
  }
  return absolute
}
const tempRoot = ordinaryDirectory(join(root, 'Data/Temp'))
const evidenceRoot = join(root, 'Data/Development/agent-mcp-takeover')
ordinaryDirectory(join(root, 'Data/Development'))
fs.mkdirSync(evidenceRoot, { recursive: true }); ordinaryDirectory(evidenceRoot)
const evidenceId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID()
const out = join(evidenceRoot, evidenceId)
fs.mkdirSync(out); ordinaryDirectory(out)
const scratch = fs.mkdtempSync(join(tempRoot, 'agent-mcp-profile-'))
ordinaryDirectory(scratch)
const home = join(scratch, 'home'), profile = join(home, 'profiles/web'), nm = join(profile, 'node_modules')
fs.mkdirSync(nm, { recursive: true })
app.setPath('userData', join(scratch, 'electron')); app.setPath('sessionData', join(scratch, 'electron'))
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {})
let server, win, external, squatter, controlled, finished = false, endpoint
const results = [], errors = [], apiCalls = [], phases = [], screenshots = []
const hostGuards = guardIdentity()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const load = name => import(pathToFileURL(join(root, 'dist/src', name + '.js')))
function link(target, path) { fs.mkdirSync(dirname(path), { recursive: true }); fs.symlinkSync(target, path, 'junction') }
const digest = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex')
function isolatedPath(name) {
  const path = resolve(scratch, name), suffix = relative(scratch, path)
  assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'Fixture path escaped scratch')
  return path
}
async function until(fn, reason, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(120) } throw new Error(reason) }
const js = code => win.webContents.executeJavaScript(code)
async function click(selector) {
  await sleep(250)
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await sleep(80)
  assert.equal(await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return e===hit||e.contains(hit)})()`), true, 'Control is obstructed: ' + selector)
  const factor = win.webContents.getZoomFactor(), x = Math.round(point.x * factor), y = Math.round(point.y * factor)
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y })
}
async function action(name, done) {
  const before = apiCalls.length
  await click(`[data-mcp-action="${name}"]`)
  await until(async () => (apiCalls.length > before || name === 'copyUrl') && await js(done || `!document.querySelector('[data-mcp-action="refresh"]').disabled`), name + ' did not finish')
}
async function bridgeAction(name, done) {
  const before = apiCalls.length
  assert.equal(await js(`document.querySelector('[data-mcp-bridge="${name}"]').disabled`), false, 'Bridge control unexpectedly disabled: ' + name)
  await click(`[data-mcp-bridge="${name}"]`)
  await until(async () => {
    const fixtureError = join(scratch, 'controlled-bridge/startup-error.json')
    if (name === 'start' && fs.existsSync(fixtureError)) throw new Error('Controlled fixture startup failed: ' + JSON.parse(fs.readFileSync(fixtureError)).error)
    return apiCalls.length > before && await js(`!document.querySelector('[data-mcp-bridge="status"]').disabled && (${done || 'true'})`)
  }, 'Bridge ' + name + ' did not finish', 50000)
}
async function bridgeRequest(operation) {
  // Negative control requests are confined to our own fake service and Profile.
  return js(`(async()=>{const r=await fetch('/dsh-agent-mcp/settings',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-dsh-agent-mcp':'1'},body:JSON.stringify({operation:${JSON.stringify(operation)}})});return{status:r.status,body:await r.json()}})()`)
}
async function bridgeSnapshot() {
  return js(`(()=>{const e=document.querySelector('.dsh-mcp-settings');return{
    state:e.querySelector('[data-mcp-bridge-state]')?.dataset.mcpBridgeState,
    stopDisabled:e.querySelector('[data-mcp-bridge="stop"]')?.disabled,
    startDisabled:e.querySelector('[data-mcp-bridge="start"]')?.disabled,
    ownership:e.querySelector('[data-mcp-bridge-ownership]')?.dataset.mcpBridgeOwnership||null,
    ownershipText:e.querySelector('[data-mcp-bridge-ownership]')?.textContent||'',
    unreachable:!!e.querySelector('[data-mcp-bridge-unreachable="1"]'),
    unreachableText:e.querySelector('[data-mcp-bridge-unreachable="1"]')?.textContent||'',
    notice:e.querySelector('[data-mcp-bridge-notice]')?.textContent||''}})()`)
}
async function capture(name) {
  assert.equal(await js(`!!document.querySelector('[data-mcp-action="hide"]')||!!document.querySelector('[data-mcp-manual]')`), false, 'Screenshots must not contain credentials')
  fs.writeFileSync(join(out, name), (await win.webContents.capturePage()).toPNG())
  screenshots.push(name)
}
async function installClipboardBoundary() {
  // Never call or restore the OS implementation in this isolated window.
  await js(`navigator.clipboard.writeText=async value=>{window.__mcpCopied=value};void 0`)
}
async function open() {
  await sleep(1000)
  if (await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/稍后配置|Set up later/i.test(e.textContent)&&e.getBoundingClientRect().width>0);if(b)b.dataset.mcpDismiss='1';return !!b})()`)) {
    await click('[data-mcp-dismiss]')
    await until(() => js(`![...document.querySelectorAll('button')].some(e=>/稍后配置|Set up later/i.test(e.textContent)&&e.getBoundingClientRect().width>0)`), 'Onboarding still visible')
  }
  await click('[data-dcu-settings-trigger]')
  await until(() => js(`!!document.querySelector('.dcu-settings-nav')`), 'DSH settings did not open')
  await sleep(400)
  assert.equal(await js(`(()=>{const b=[...document.querySelectorAll('.dcu-settings-nav button')].filter(e=>e.textContent.trim()==='多智能体交互管理');if(b[0])b[0].dataset.mcpNav='1';return b.length})()`), 1)
  await click('[data-mcp-nav]')
  await until(() => js(`document.querySelector('[data-mcp-state]')?.dataset.mcpState==='online'`), 'MCP settings not online')
  await until(() => js(`document.querySelector('[data-mcp-bridge-state]')?.dataset.mcpBridgeState!=='unknown'&&!document.querySelector('[data-mcp-bridge="status"]').disabled`), 'Bridge initial status did not finish')
}
async function run() {
  const pointer = JSON.parse(fs.readFileSync(join(root, 'Data/Runtime/Harness/current.json')))
  const runtime = join(root, 'Data/Runtime', pointer.current.relativePath)
  const { activeUiProfile } = await import(pathToFileURL(join(root, 'scripts/lib/active-ui-profile.mjs')))
  const active = activeUiProfile(root).profile
  const candidate = join(profile, 'local/dsh-agent-mcp')
  fs.cpSync(join(root, 'customizations/agent-mcp'), candidate, { recursive: true, filter: path => !path.includes('evidence') })
  link(join(runtime, 'node_modules/@deepseek-ai'), join(nm, '@deepseek-ai'))
  link(join(active, 'node_modules/schemastery'), join(nm, 'schemastery'))
  link(join(active, 'node_modules/@michengai/dsh-codex-ui'), join(nm, '@michengai/dsh-codex-ui'))
  link(candidate, join(nm, 'dsh-agent-mcp'))
  fs.writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'agent-mcp-settings-verification', private: true,
    dependencies: { '@michengai/dsh-codex-ui': '1.1.18', 'dsh-agent-mcp': 'link:local/dsh-agent-mcp' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@michengai/dsh-codex-ui', 'dsh-agent-mcp'] } } }))
  external = await createFixtureBridge()
  const bridgeDir = isolatedPath('controlled-bridge'), bridgePort = external.port
  fs.mkdirSync(bridgeDir)
  ordinaryDirectory(bridgeDir)
  // The backend's existing executable override runs this Node fixture, not Python
  // or any real Bridge directory. The file lives only in this run's scratch.
  fs.writeFileSync(join(bridgeDir, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }))
  fs.writeFileSync(join(bridgeDir, 'start.py'), `require(${JSON.stringify(join(root, 'scripts/lib/agent-mcp-bridge-fixture.cjs'))}).runControlled(${JSON.stringify({ directory: bridgeDir, port: bridgePort, expectedHome: home })}).catch(error=>{require('node:fs').writeFileSync('startup-error.json',JSON.stringify({status:'fail',error:String(error)}));process.exit(1)});\n`)
  fs.writeFileSync(join(profile, 'cordis.patch.yml'), '- id: agent-mcp\n  config:\n    port: 0\n    bridgeDir: ' + JSON.stringify(bridgeDir) + '\n    bridgePort: ' + bridgePort + '\n- id: workspace-controller\n  config:\n    documentsDirectory: ' + JSON.stringify(join(scratch, 'documents')) + '\n')
  const { startDsh } = await load('dsh-process')
  const startOptions = { nodeExecutable: join(root, 'Tools/node-v26.10.0/node.exe'), bootstrapPath: join(root, 'dist/src/dsh-bootstrap.mjs'),
    runtime: { root: runtime, entry: join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js') }, workingDirectory: scratch,
    environment: { DSH_HOME: home, DSH_PROFILE_DIR: profile, DSH_PROFILE_NAME: 'web', DSH_RUNTIME_DIR: runtime,
      TEMP: scratch, TMP: scratch, DSH_BRIDGE_PYTHON: join(root, 'Tools/node-v26.10.0/node.exe'), npm_config_offline: 'true' }, startupTimeoutMs: 60000 }
  await app.whenReady()
  win = new BrowserWindow({ width: 1360, height: 950, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message.replace(/[a-f0-9]{64}/g, '[redacted]')) })
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (details.url === endpoint && details.uploadData) {
      try { apiCalls.push(JSON.parse(Buffer.concat(details.uploadData.map(v => v.bytes || Buffer.alloc(0))).toString()).operation) } catch {}
    }
    callback({})
  })
  // The counterexample client is a frozen fixture, not a live Profile file. It used
  // to be read from auto-020-rc2, which silently made the control a no-op the moment
  // that Profile was synced with the fix. Its hash is pinned so an edited fixture
  // fails loudly instead of quietly ceasing to reproduce the old defect.
  const beforeClient = join(root, 'scripts/fixtures/agent-mcp-client-before-ownership.js')
  const BEFORE_CLIENT_SHA256 = 'e0434745491e0d66f7594d0a099724fe4ed114bfaec901f20691f4fc56ab2381'
  assert.equal(digest(beforeClient), BEFORE_CLIENT_SHA256, 'counterexample fixture was modified; the control no longer proves anything')
  const candidateClient = join(candidate, 'lib/client.js'), currentClient = fs.readFileSync(candidateClient)
  fs.copyFileSync(beforeClient, candidateClient)
  server = await startDsh(startOptions); endpoint = new URL('/dsh-agent-mcp/settings', server.url).href
  await win.loadURL(server.url)
  await until(() => js(`!!document.querySelector('[data-dcu-settings-trigger]')`), 'Before Profile did not load codex-ui')
  await installClipboardBoundary(); await open()
  const before = await bridgeSnapshot()
  assert.equal(before.state, 'online', 'Before counterexample must use a healthy external fixture')
  assert.equal(before.stopDisabled, false, 'Accepted old client no longer reproduces the enabled external Stop defect')
  phases.push({ scenario: 'before-accepted-client', clientPath: beforeClient, clientSha256: digest(beforeClient), backend: 'candidate backend with accepted client only', expectedDefect: 'external Stop enabled', observed: before })
  await capture('before-external-stop-enabled.png')
  await server.stop(); server = undefined
  fs.writeFileSync(candidateClient, currentClient)
  apiCalls.length = 0
  server = await startDsh(startOptions); endpoint = new URL('/dsh-agent-mcp/settings', server.url).href
  const anonymous = await fetch(endpoint, { method: 'POST', headers: { 'x-dsh-agent-mcp': '1', 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'credentials' }) })
  assert.equal(anonymous.status, 401, 'real official authentication blocks anonymous credential requests')
  results.push('official cookie authentication rejects anonymous callers')
  await win.loadURL(server.url)
  await installClipboardBoundary()
  await until(() => js(`!!document.querySelector('[data-dcu-settings-trigger]')`), 'Real codex-ui missing')
  await sleep(1000)
  if (await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/稍后配置|Set up later/i.test(e.textContent));if(b)b.dataset.mcpDismiss='1';return !!b})()`)) await click('[data-mcp-dismiss]')
  await open()
  assert.ok(apiCalls.includes('status') && !apiCalls.includes('credentials'), 'secrets are not fetched on mount')
  results.push('real Profile Loader discovers one native settings entry; default state contains no credentials')
  // The usage guide is the answer to "how do I actually use this". It must be on
  // the page in exactly the four groups the plan asks for, carrying real commands.
  // Channel 1 and channel 3 each add their own collapsed Connection details /
  // View runs groups, so the total is 7 while the help card holds exactly 4.
  assert.equal(await js(`document.querySelectorAll('.dsh-mcp-settings details').length`), 7, 'collapsed groups missing')
  assert.equal(await js(`document.querySelectorAll('.mcp-help details').length`), 4, 'usage guide must have exactly four groups')
  assert.equal(await js(`document.querySelectorAll('.dsh-mcp-settings details[open]').length`), 0, 'nothing should be expanded by default')
  assert.equal(await js(`[...document.querySelectorAll('.mcp-cmd')].every(e=>e.textContent.trim().length>0)`), true, 'empty command block')
  // Record the rendered headings, not a claim about them: a locale miss would show
  // a raw key like "gB1c" and only the real text proves the dictionary is wired.
  const guideTitles = await js(`[...document.querySelectorAll('.mcp-help details summary')].map(e=>e.textContent)`)
  const rawKeys = await js(`[...document.querySelectorAll('.dsh-mcp-settings details')].some(d=>/\\bg[A-Z]/.test(d.textContent))`)
  assert.equal(rawKeys, false, 'a guide key leaked into the UI instead of its translation')
  results.push('usage guide renders 4 collapsed groups with non-empty command blocks: ' + guideTitles.join(' | '))
  // The channel-two endpoint is only rendered once its discovery file has been
  // read. A blank input would read as "configured but empty", which is a claim
  // this page cannot make, so the two states must be mutually exclusive.
  const httpEndpoint = await js(`(()=>{const i=document.querySelector('[data-mcp-http-endpoint="1"]');const m=document.querySelector('[data-mcp-http-url="missing"]');return{hasInput:!!i,hasMissing:!!m,text:(m?.textContent||'').trim()}})()`)
  assert.notEqual(httpEndpoint.hasInput, httpEndpoint.hasMissing, 'channel 2 must show either a discovered endpoint or the missing-endpoint wording, never both or neither')
  if (httpEndpoint.hasMissing) {
    assert.equal(httpEndpoint.text.length > 0, true, 'missing 9800 endpoint must explain itself instead of showing an empty field')
    results.push('channel 2 without a discovered endpoint shows the "no endpoint yet" wording instead of a blank field')
  } else {
    results.push('channel 2 shows its discovered endpoint read-only: ' + await js(`document.querySelector('[data-mcp-http-endpoint="1"]').value`))
  }
  // The standing risk reminder must survive the simplification: collapsing the run
  // tables is fine, dropping "result is not acceptance" is not.
  assert.equal(await js(`!!document.querySelector('[data-mcp-alert="verify"]')`), true, 'acceptance reminder was removed from the default view')
  results.push('the "produced result is not a passed verification" reminder stays in the default view')
  await action('check', `document.querySelector('.dsh-mcp-settings [role=status]')?.textContent.includes('自检通过')`)
  results.push('mouse click -> authenticated settings API -> real MCP initialize/tools/list/delete -> success')
  // The token lives in channel 3's collapsed Connection details group, so the
  // real mouse has to open it before the reveal button is even hit-testable.
  await js(`(()=>{const d=[...document.querySelectorAll('details')].find(e=>e.querySelector('input[aria-label="Bearer 令牌"]'));if(d)d.open=true;return !!d})()`)
  assert.equal(await js(`document.querySelector('[data-mcp-action="reveal"]').getBoundingClientRect().width>0`), true, 'connection details did not open')
  await action('reveal', `document.querySelector('[data-mcp-action="hide"]')!==null`)
  assert.equal(await js(`/^[a-f0-9]{64}$/.test(document.querySelector('input[aria-label="Bearer 令牌"]').value)`), true)
  await click('[data-mcp-action="hide"]')
  await until(() => js(`!document.querySelector('[data-mcp-action="hide"]')`), 'Hide did not clear credentials')
  assert.equal(await js(`/^[a-f0-9]{64}$/.test(document.querySelector('input[aria-label="Bearer 令牌"]').value)`), false)
  results.push('explicit reveal and hide work without frontend storage')
  // Force clipboard denial to verify failure feedback and selectable fallback.
  await js(`navigator.clipboard.writeText=()=>Promise.reject(Error('test denied'));void 0`)
  await action('copyToken', `!!document.querySelector('[data-mcp-manual]')`)
  assert.equal(await js(`document.querySelector('[role=status]').textContent.includes('复制失败')`), true)
  await click('[data-mcp-action="hide"]')
  await until(() => js(`!document.querySelector('[data-mcp-manual]')`), 'Fallback was not cleared')
  results.push('clipboard rejection produces no false success and can clear manual fallback')
  // Clipboard boundary is simulated so the user's current image/files clipboard
  // is never overwritten. Real mouse, auth API and credential data still apply.
  await js(`navigator.clipboard.writeText=async value=>{window.__mcpCopied=value};void 0`)
  await action('copyConfig')
  const expected = JSON.parse(fs.readFileSync(join(home, 'agent-mcp.json')))
  assert.equal(await js(`(()=>{const d=JSON.parse(window.__mcpCopied);return d.url===${JSON.stringify(expected.url)}&&/^Bearer [a-f0-9]{64}$/.test(d.headers.Authorization)})()`), true)
  await js(`delete window.__mcpCopied;void 0`)
  results.push('copy connection information passes actual fixture data to clipboard API; OS clipboard not changed')
  // Measurement, not assumption: an earlier version of this page read its colours
  // from DSH's --dsh-* tokens, and the probe below proved those tokens never reach
  // this document — every colour silently collapsed to the light literal. The page
  // now carries its own palette keyed off DSH's own data-color-scheme attribute,
  // so the probe flips that attribute and requires the rendered border to follow.
  const theme = await js(`(()=>{const card=document.querySelector('.mcp-card');const scope=document.querySelector('.dsh-mcp-settings');
    const root=document.documentElement;const previous=root.getAttribute('data-color-scheme');
    // The card uses border:1px, the alert only border-left, so each side must be read.
    const read=()=>{const s=getComputedStyle(card);return{border:s.borderTopColor,warn:getComputedStyle(scope.querySelector('[data-mcp-alert="verify"]')).borderLeftColor}};
    const defaultScheme=read();
    root.setAttribute('data-color-scheme','light');const light=read();
    root.setAttribute('data-color-scheme','dark');const dark=read();
    if(previous===null)root.removeAttribute('data-color-scheme');else root.setAttribute('data-color-scheme',previous);
    return{dshToken:getComputedStyle(scope).getPropertyValue('--dsh-border-subtle').trim(),defaultScheme,light,dark}})()`)
  assert.notEqual(theme.light.border, theme.dark.border, 'the page does not follow the DSH colour scheme; it is locked to one palette')
  assert.notEqual(theme.light.warn, theme.dark.warn, 'the standing risk reminder does not follow the colour scheme')
  assert.equal([theme.light.border, theme.dark.border].includes(theme.defaultScheme.border), true,
    'the default (attribute-less) render matches neither scheme branch, matching neither theme.css convention')
  results.push(`theme follows DSH's own scheme attribute, without needing theme.css (--dsh-border-subtle here is "${theme.dshToken || 'empty'}", which is why the page does not use it): card border light ${theme.light.border} / dark ${theme.dark.border}`)
  // Open every guide section first: the worst case for width is the whole guide
  // expanded with its long command lines, not the collapsed default.
  await js(`[...document.querySelectorAll('.dsh-mcp-settings details')].forEach(d=>d.open=true);void 0`)
  for (const width of [1360, 900]) for (const zoom of [0.9, 1, 1.1]) {
    win.setContentSize(width, 950); win.webContents.setZoomFactor(zoom); await sleep(150)
    assert.equal(await js(`(()=>{const e=document.querySelector('.dsh-mcp-settings'),r=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth+1&&r.left>=0&&r.right<=innerWidth+1})()`), true, `layout ${width}/${zoom}`)
    await action('refresh')
    results.push(`layout and refresh mouse click ${width}/${zoom} with the usage guide fully expanded`)
  }
  win.setContentSize(1360, 1100); win.webContents.setZoomFactor(1); await sleep(150)
  // Only a masked isolated settings page is captured.
  await capture('settings.png')
  await win.loadURL(server.url); await until(() => js(`!!document.querySelector('[data-dcu-settings-trigger]')`), 'Reload failed'); await open()
  await installClipboardBoundary()
  assert.equal(await js(`/^[a-f0-9]{64}$/.test(document.querySelector('input[aria-label="Bearer 令牌"]').value)`), false)
  await action('check', `document.querySelector('.dsh-mcp-settings [role=status]')?.textContent.includes('自检通过')`)
  results.push('independent page reload preserves entry and clears displayed credentials')

  await bridgeAction('status', `document.querySelector('[data-mcp-bridge-ownership="external"]')!==null`)
  const externalStatus = await bridgeRequest('bridge.status'), externalSnapshot = await bridgeSnapshot()
  assert.equal(externalStatus.body.value.online, true); assert.equal(externalStatus.body.value.owned, false)
  assert.equal(externalSnapshot.stopDisabled, true); assert.equal(externalSnapshot.startDisabled, true)
  assert.equal(externalSnapshot.unreachable, false); assert.ok(/外部|external/i.test(externalSnapshot.ownershipText))
  const disabledStopBefore = apiCalls.length
  await click('[data-mcp-bridge="stop"]'); await sleep(250)
  assert.equal(apiCalls.length, disabledStopBefore, 'Disabled external Stop must send no control request')
  const externalStop = await bridgeRequest('bridge.stop')
  assert.equal(externalStop.status, 200); assert.equal(externalStop.body.value.error, 'NOT_OWNED')
  assert.ok(external.requests.every(request => request.method === 'GET'), 'External fixture must never receive a control operation')
  phases.push({ scenario: 'healthy-external', port: bridgePort, observed: externalSnapshot, api: externalStatus.body.value })
  await capture('after-external-stop-disabled.png')
  results.push('healthy external Bridge is readable and labelled external; real disabled Stop sends no request; authenticated Stop rejects NOT_OWNED')

  await external.close()
  await bridgeAction('status', `document.querySelector('[data-mcp-bridge-state]')?.dataset.mcpBridgeState==='offline'`)
  const offlineStatus = await bridgeRequest('bridge.status'), offlineSnapshot = await bridgeSnapshot()
  assert.equal(offlineStatus.body.value.online, false); assert.equal(offlineStatus.body.value.owned, false)
  assert.equal(offlineStatus.body.value.reason, 'UNREACHABLE')
  assert.equal(offlineSnapshot.stopDisabled, true); assert.equal(offlineSnapshot.startDisabled, false)
  assert.equal(offlineSnapshot.ownership, null); assert.equal(offlineSnapshot.unreachable, true)
  assert.ok(offlineSnapshot.unreachableText.trim())
  phases.push({ scenario: 'offline', observed: offlineSnapshot, api: offlineStatus.body.value })
  await capture('offline-not-external.png')
  results.push('offline Bridge is unavailable rather than falsely external, with disabled Stop and enabled Start')

  squatter = await createFixtureBridge({ port: bridgePort, service: 'unrelated-fixture-service' })
  await bridgeAction('status', `document.querySelector('[data-mcp-bridge-state]')?.dataset.mcpBridgeState==='port-busy'`)
  const squatterStatus = await bridgeRequest('bridge.status'), squatterSnapshot = await bridgeSnapshot()
  assert.equal(squatterStatus.body.value.reason, 'PORT_NOT_BRIDGE'); assert.equal(squatterStatus.body.value.owned, false)
  assert.equal(squatterSnapshot.startDisabled, true); assert.equal(squatterSnapshot.stopDisabled, true)
  assert.equal(squatterSnapshot.ownership, null); assert.equal(squatterSnapshot.unreachable, false)
  const disabledStartBefore = apiCalls.length
  await click('[data-mcp-bridge="start"]'); await sleep(250)
  assert.equal(apiCalls.length, disabledStartBefore, 'Busy-port disabled Start must send no request')
  const deniedStart = await bridgeRequest('bridge.start')
  assert.equal(deniedStart.status, 200); assert.equal(deniedStart.body.value.error, 'PORT_NOT_BRIDGE')
  assert.equal(fs.existsSync(join(bridgeDir, 'started.json')), false, 'Non-Bridge occupied port must not spawn a child')
  assert.equal(fs.existsSync(join(home, 'agent-bridge-ownership.json')), false, 'Non-Bridge must not be assigned ownership')
  assert.ok(squatter.requests.length > 0 && squatter.requests.every(request => request.method === 'GET' && request.path === '/health'), 'Non-Bridge port must not receive /console/state or control calls')
  phases.push({ scenario: 'non-bridge-port', observed: squatterSnapshot, api: squatterStatus.body.value, requests: [...squatter.requests] })
  await capture('non-bridge-port.png')
  results.push('unrelated port disables Start/Stop, never reads console state, and authenticated Start refuses before spawning')
  await squatter.close()

  await bridgeAction('status', `document.querySelector('[data-mcp-bridge-state]')?.dataset.mcpBridgeState==='offline'`)
  await bridgeAction('start', `document.querySelector('[data-mcp-bridge-ownership="owned"]')!==null`)
  controlled = JSON.parse(fs.readFileSync(join(bridgeDir, 'started.json')))
  assert.ok(Number.isSafeInteger(controlled.pid) && controlled.pid > 0 && controlled.pid !== process.pid)
  assert.equal(controlled.port, bridgePort); assert.deepEqual(controlled.guards, hostGuards, 'Controlled child must inherit safety guard environment unchanged')
  const ownership = JSON.parse(fs.readFileSync(join(home, 'agent-bridge-ownership.json')))
  assert.equal(ownership.pid, controlled.pid); assert.equal(ownership.port, bridgePort)
  assert.equal(ownership.owner, controlled.ownerPid, 'Bridge owner must be the exact isolated DSH that spawned the child')
  assert.ok(Number.isSafeInteger(ownership.owner) && ownership.owner > 0 && ownership.owner !== process.pid && ownership.owner !== controlled.pid)
  const controlledStatus = await bridgeRequest('bridge.status'), controlledSnapshot = await bridgeSnapshot()
  assert.equal(controlledStatus.body.value.online, true); assert.equal(controlledStatus.body.value.owned, true)
  assert.equal(controlledSnapshot.stopDisabled, false); assert.equal(controlledSnapshot.ownership, 'owned')
  phases.push({ scenario: 'controlled-child', fixturePid: controlled.pid, dshOwnerPid: ownership.owner, observed: controlledSnapshot, api: controlledStatus.body.value, inheritedGuards: true })
  await capture('controlled-child-owned.png')
  results.push('trusted mouse Start launches only the isolated Node fake Bridge; matching child/owner/config identity enables Stop and inherits guards')
  for (const width of [1360, 900]) for (const zoom of [0.8, 1.25, 1.5]) {
    win.setContentSize(width, 950); win.webContents.setZoomFactor(zoom); await sleep(150)
    assert.equal(await js(`(()=>{const e=document.querySelector('.dsh-mcp-settings'),r=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth+1&&r.left>=0&&r.right<=innerWidth+1})()`), true, `Bridge layout ${width}/${zoom}`)
    await bridgeAction('status', `document.querySelector('[data-mcp-bridge-ownership="owned"]')!==null`)
    assert.equal((await bridgeSnapshot()).stopDisabled, false)
    results.push(`controlled Bridge responsive layout and trusted refresh ${width}/${zoom}`)
  }
  win.setContentSize(1360, 1100); win.webContents.setZoomFactor(1); await sleep(150)
  await bridgeAction('stop', `document.querySelector('[data-mcp-bridge-state]')?.dataset.mcpBridgeState==='offline'`)
  await until(() => { try { process.kill(controlled.pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }, 'Controlled fake Bridge is still alive after Stop')
  assert.equal(fs.existsSync(join(home, 'agent-bridge-ownership.json')), false, 'Successful Stop must retire only its matching ownership')
  const stoppedSnapshot = await bridgeSnapshot()
  assert.equal(stoppedSnapshot.stopDisabled, true); assert.equal(stoppedSnapshot.ownership, null)
  const controlledRequests = fs.readFileSync(join(bridgeDir, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(controlledRequests.every(request => request.method === 'GET' && ['/health', '/console/state'].includes(request.path)), 'No task dispatch or Bridge cancel is allowed')
  phases.push({ scenario: 'controlled-child-stopped', observed: stoppedSnapshot, requests: controlledRequests, confirmedExited: true })
  await capture('controlled-child-stopped.png')
  results.push('trusted mouse Stop confirms the created fake child exited, retires matching ownership and restores offline/disabled state')
  // Codex UI seeds an empty welcome session. Assert no message/tool/turn events,
  // rather than treating the existence of its directory as a submitted task.
  const sessions = join(home, 'sessions'), allowed = new Set(['session', 'permission/preset', 'sandbox/mode', 'approval/policy'])
  for (const path of fs.readdirSync(sessions, { recursive: true }).filter(name => name.endsWith('.jsonl.zstd'))) {
    const content = require('node:zlib').zstdDecompressSync(fs.readFileSync(join(sessions, path))).toString()
    for (const line of content.trim().split('\n')) {
      const event = JSON.parse(line)
      assert.ok(allowed.has(event.type), 'No submitted task, model turn or tool execution is allowed')
      if (event.type === 'session') assert.ok(event.cwd.startsWith(scratch), 'Even welcome workspace stays on portable disk')
    }
  }
  results.push('only empty welcome-session metadata exists; no tasks, model calls or tools were executed')
  fs.writeFileSync(join(out, 'results.json'), JSON.stringify({ status: 'pass', results, apiCalls, errors, scratch, evidenceId, phases, screenshots,
    boundary: 'isolated real Profile/Loader and Electron input; fake Bridge HTTP, no OS clipboard writes, tasks, real Bridge, production Profile or restart',
    loaded: { runtime, candidate, clientSha256: digest(candidateClient) } }, null, 2))
  console.log(`PASS ${results.length} real isolated Profile checks; evidence: ${out}`)
}
async function finish(code) {
  if (finished) return; finished = true; clearTimeout(deadline)
  // Only a child created in this run may be stopped. On failures the same
  // authenticated ownership check remains in force; no arbitrary PID is killed.
  if (server && win && !win.isDestroyed()) {
    try { await bridgeRequest('bridge.stop') } catch {}
  }
  await external?.close().catch(() => {}); await squatter?.close().catch(() => {})
  win?.destroy(); await server?.stop().catch(() => {}); app.exit(code)
}
const deadline = setTimeout(() => {
  fs.writeFileSync(join(out, 'timeout.json'), JSON.stringify({ status: 'fail', error: 'Verification timeout', results, apiCalls, phases, scratch, evidenceId }, null, 2))
  console.error('Verification timeout; evidence: ' + out); void finish(1)
}, 300000)
run().then(() => finish(0), async error => {
  // Never dump page HTML, credential inputs, request bodies or clipboard.
  let page
  try { page = await js(`({hasSettings:!!document.querySelector('.dcu-settings-nav'),hasMcp:!!document.querySelector('.dsh-mcp-settings'),state:document.querySelector('[data-mcp-state]')?.dataset.mcpState,nav:[...document.querySelectorAll('.dcu-settings-nav button')].map(e=>({text:e.textContent,selected:e.getAttribute('aria-selected')})),notice:document.querySelector('.dsh-mcp-settings [role=status]')?.textContent})`) } catch {}
  fs.writeFileSync(join(out, 'failure.json'), JSON.stringify({ status: 'fail', error: String(error).replace(/[a-f0-9]{64}/g, '[redacted]'), results, errors, apiCalls, scratch, evidenceId, phases, screenshots, page }, null, 2))
  console.error(String(error).replace(/[a-f0-9]{64}/g, '[redacted]') + '; evidence: ' + out); await finish(1)
})
