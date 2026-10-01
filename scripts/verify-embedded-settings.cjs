// Real shared settings HTML/shim in isolated Electron; all backend methods are mocks.
// No DSH process, production preferences, download, deployment or restart is used.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), assert = require('node:assert/strict')
const { resolve, join, dirname, parse } = require('node:path')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const root = resolve(__dirname, '..')
function ordinaryDirectory(path) {
  const absolute = resolve(path), normalize = value => process.platform === 'win32' ? value.toLowerCase() : value
  assert.equal(normalize(fs.realpathSync(absolute)), normalize(absolute), 'Fixture/evidence path follows a junction')
  for (let cursor = absolute; cursor !== parse(cursor).root; cursor = dirname(cursor)) {
    const item = fs.lstatSync(cursor)
    assert.ok(item.isDirectory() && !item.isSymbolicLink(), 'Fixture/evidence ancestor is not an ordinary directory')
  }
  return absolute
}
ordinaryDirectory(join(root, 'Data/Development'))
const evidenceRoot = join(root, 'Data/Development/settings-split-renderer')
fs.mkdirSync(evidenceRoot, { recursive: true }); ordinaryDirectory(evidenceRoot)
const out = join(evidenceRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID())
fs.mkdirSync(out); ordinaryDirectory(out)
const scratch = fs.mkdtempSync(join(ordinaryDirectory(join(root, 'Data/Temp')), 'embedded-settings-render-'))
app.setPath('userData', scratch); app.setPath('sessionData', scratch); app.disableHardwareAcceleration()
let win
const results = [], errors = [], screenshots = [], blockedRequests = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const timeout = setTimeout(() => { console.error('Isolated embedded settings verification timed out'); app.exit(1) }, 180000)
const js = code => win.webContents.executeJavaScript(code)
const child = () => win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc')
const frameJs = code => child().executeJavaScript(code)
async function until(fn, reason, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(70) }
  throw new Error(reason)
}
async function section(value) {
  // Only the real parent transport selects a split page; internal navigation is hidden.
  await js(`window.selectSection(${JSON.stringify(value)})`)
  await until(() => frameJs(`document.documentElement.dataset.dshSection===${JSON.stringify(value)}&&!document.getElementById(${JSON.stringify(value + 'Page')}).hidden`), 'Parent section routing failed: ' + value)
}
async function mount(value) {
  await js(`window.mount(${JSON.stringify(value)})`)
  await until(async () => !!child() && await frameJs(`document.querySelector('#currentVersion')?.textContent==='fixture-desktop'&&!!document.querySelector('[data-theme-id="gold"]')&&!!window.__initialSectionSnapshot`), 'Shared settings remount failed')
  assert.deepEqual(await frameJs('window.__initialSectionSnapshot'), { section: value, visible: [value], internalNavVisible: false }, 'First completed inline-script frame must already select its own section')
}
async function click(selector) { await frameJs(`document.querySelector(${JSON.stringify(selector)}).click()`); await sleep(70) }
async function choose(button, list, value) {
  await click('#' + button)
  await click(`#${list} [data-value="${value}"]`)
}
async function saved(method, previous) {
  await until(async () => await js(`calls.filter(c=>c.method===${JSON.stringify(method)}).length>${previous}`)
    && await frameJs(`!document.querySelector('#approvalsEnabled').disabled&&!document.querySelector('#policyButton').disabled&&!document.querySelector('#harnessPolicyButton').disabled&&document.querySelector('#themeGrid').getAttribute('aria-busy')!=='true'`), method + ' did not settle')
}
const count = method => js(`calls.filter(c=>c.method===${JSON.stringify(method)}).length`)
async function rejectSave(method, page, action, restoreAssertion) {
  await mount(page)
  const before = await js('structuredClone(fixture)'), previous = await count(method)
  await js(`window.failNext=${JSON.stringify(method)}`)
  await action(); await saved(method, previous)
  assert.deepEqual(await js('structuredClone(fixture)'), before, 'Rejected save changed committed preferences: ' + method)
  assert.equal(await frameJs(`document.querySelector('#settingsError').hidden`), false)
  assert.match(await frameJs(`document.querySelector('#settingsError').textContent`), /Fixture save denied/)
  assert.equal(await frameJs(restoreAssertion), true, 'Rejected save did not restore its visible committed value: ' + method)
  results.push({ name: method + ' rejection reports failure, restores value and re-enables controls', pass: true })
}
async function run() {
  const { embeddedDesktopSettingsDocument } = await import(pathToFileURL(join(root, 'dist/src/embedded-desktop-settings.js')))
  const html = embeddedDesktopSettingsDocument(...['settings.html', 'theme.css', 'theme.js', 'shell-icons/chevron-down.svg'].map(name => fs.readFileSync(join(root, 'assets', name), 'utf8')))
  // The real bridge factory adds the section to trusted HTML before srcDoc, not after load.
  const documents = Object.fromEntries(['notifications', 'updates', 'appearance'].map(section => [section,
    html.replace(/<html\b/i, `<html data-dsh-section="${section}"`).replace('</body>', `<script>window.__initialSectionSnapshot={section:document.documentElement.dataset.dshSection,visible:['notifications','updates','appearance'].filter(s=>!document.getElementById(s+'Page').hidden),internalNavVisible:getComputedStyle(document.querySelector('aside')).display!=='none'};<\/script></body>`)]))
  const parent = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white}iframe{display:block;width:100%;height:100vh;border:0}</style><iframe sandbox="allow-scripts" title="Isolated settings"></iframe><script>
    const frame=document.querySelector('iframe'),channel='dsh-desktop-settings-v1',docs=${JSON.stringify(documents).replaceAll('<', '\\u003c')};
    window.calls=[];window.failNext=null;
    window.fixture={notifications:{turnMode:'unfocused',approvalsEnabled:true,questionsEnabled:true},themePreset:'lake',
      desktop:{policy:'manual',channel:'stable',checkIntervalHours:3},
      harness:{channel:'alpha',mode:'manual',checkIntervalHours:11,idleQuietSeconds:29,shadowStartupTimeoutSeconds:73,liveStartupTimeoutSeconds:97,observationMinutes:7,rollbackTimeoutSeconds:61,maxDownloadRetries:4,keepGoodSlots:3,skipVersions:['fixture-skipped'],maxAutomaticDeployAttempts:2,deployRetryCooldownHours:13}};
    let desktopStatus={kind:'idle'},harnessStatus={phase:'idle',currentVersion:'fixture-runtime'};
    const clone=v=>structuredClone(v),desktopState=()=>({packaged:true,currentVersion:'fixture-desktop',status:clone(desktopStatus)}),harnessState=()=>({available:true,policy:clone(fixture.harness),running:false,state:clone(harnessStatus)});
    const handlers={getBootstrap:()=>({locale:'zh-CN',colorScheme:'light',themePreset:fixture.themePreset,version:'fixture-desktop',platform:'win32'}),
      getNotificationPreferences:()=>clone(fixture.notifications),getUpdatePreferences:()=>clone(fixture.desktop),getDesktopUpdateState:desktopState,getHarnessUpdateState:harnessState,
      updateNotificationPreferences:v=>(fixture.notifications=clone(v)),updateThemePreferences:v=>(fixture.themePreset=v.preset,{schema:1,preset:v.preset}),
      updateUpdatePreferences:v=>(fixture.desktop={...fixture.desktop,...clone(v)},clone(fixture.desktop)),updateHarnessUpdatePolicy:v=>(fixture.harness=clone(v),harnessState()),
      desktopUpdateAction:v=>{if(!['check','download','install'].includes(v))throw Error('Forbidden mock action');desktopStatus=v==='check'?{kind:'available',version:'fixture-candidate'}:v==='download'?{kind:'ready',version:'fixture-candidate',detail:'Mock candidate only; no artifact was downloaded'}:{kind:'completed',detail:'Mock route only; no installation or restart occurred'};return desktopState()},
      harnessUpdateAction:v=>{if(v!=='check')throw Error('Forbidden mock runtime action');harnessStatus={phase:'blocked',currentVersion:'fixture-runtime',detail:'Fixture safety gate: activation is disabled'};return harnessState()},close:()=>null};
    addEventListener('message',e=>{const d=e.data;if(e.source!==frame.contentWindow||e.origin!=='null'||d?.channel!==channel||!Number.isSafeInteger(d.id))return;
      calls.push({method:d.method,value:d.value});setTimeout(()=>{let result;try{if(failNext===d.method){failNext=null;throw Error('Fixture save denied')}if(!Object.hasOwn(handlers,d.method))throw Error('Forbidden');result={value:handlers[d.method](d.value)}}catch(error){result={error:String(error)}}frame.contentWindow.postMessage({channel,id:d.id,...result},'*')},25)});
    window.selectSection=value=>frame.contentWindow.postMessage({channel,event:'settingsSection',value},'*');window.mount=value=>new Promise(resolve=>{frame.addEventListener('load',()=>resolve(null),{once:true});frame.srcdoc=docs[value]});mount('notifications');
  </script>`
  await app.whenReady()
  win = new BrowserWindow({ width: 720, height: 740, show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const blocked = /^(https?|wss?):/i.test(details.url)
    if (blocked) blockedRequests.push(details.url.replace(/[?#].*/, ''))
    callback({ cancel: blocked })
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(parent))
  for (const page of ['notifications', 'updates', 'appearance']) await mount(page)
  results.push({ name: 'All three initial split documents select their own page before parent retries', pass: true })
  for (const width of [360, 560, 900]) for (const zoom of [0.8, 1, 1.25]) {
    win.setContentSize(width, 740); win.webContents.setZoomFactor(zoom)
    for (const page of ['notifications', 'updates', 'appearance']) {
      await section(page)
      const sample = await frameJs(`(()=>{const m=document.querySelector('main');return{section:document.documentElement.dataset.dshSection,visible:['notifications','updates','appearance'].filter(s=>!document.getElementById(s+'Page').hidden),internalNavVisible:getComputedStyle(document.querySelector('aside')).display!=='none',overflow:document.documentElement.scrollWidth>innerWidth+1,mainOverflow:m.scrollWidth>m.clientWidth+1,images:[...document.images].every(i=>i.complete&&i.naturalWidth>0)}})()`)
      assert.equal(sample.section, page); assert.deepEqual(sample.visible, [page]); assert.equal(sample.internalNavVisible, false)
      assert.equal(sample.overflow, false); assert.equal(sample.mainOverflow, false); assert.equal(sample.images, true)
      results.push({ width, zoom, page, ...sample })
    }
  }
  assert.equal((await js('calls')).filter(c => /Action$/.test(c.method)).length, 0, 'Load and section navigation must not initiate either updater')
  win.webContents.setZoomFactor(1); win.setContentSize(560, 740)
  const initial = await js('structuredClone(fixture)')
  await section('notifications')
  let previous = await count('updateNotificationPreferences')
  await choose('turnModeButton', 'turnModeList', 'always'); await saved('updateNotificationPreferences', previous)
  previous = await count('updateNotificationPreferences'); await click('#approvalsEnabled'); await saved('updateNotificationPreferences', previous)
  previous = await count('updateNotificationPreferences'); await click('#questionsEnabled'); await saved('updateNotificationPreferences', previous)
  assert.deepEqual(await js('fixture.notifications'), { turnMode: 'always', approvalsEnabled: false, questionsEnabled: false })
  await section('updates')
  previous = await count('updateUpdatePreferences'); await choose('policyButton', 'policyList', 'auto-on-exit'); await saved('updateUpdatePreferences', previous)
  previous = await count('updateUpdatePreferences'); await click('#previewUpdates'); await saved('updateUpdatePreferences', previous)
  assert.deepEqual(await js('fixture.desktop'), { policy: 'auto-on-exit', channel: 'preview', checkIntervalHours: 3 })
  previous = await count('updateHarnessUpdatePolicy'); await choose('harnessPolicyButton', 'harnessPolicyList', 'notify'); await saved('updateHarnessUpdatePolicy', previous)
  assert.deepEqual(await js('fixture.harness'), { ...initial.harness, mode: 'notify' }, 'Runtime policy save must roundtrip all original fields')
  await section('appearance')
  previous = await count('updateThemePreferences'); await click('[data-theme-id="gold"]'); await saved('updateThemePreferences', previous)
  assert.equal(await js('fixture.themePreset'), 'gold'); assert.equal(await frameJs('DshThemes.current()'), 'gold')
  const committed = await js('structuredClone(fixture)')
  await mount('notifications')
  assert.equal(await frameJs(`document.querySelector('#turnModeList [data-value="always"]').getAttribute('aria-selected')`), 'true')
  assert.equal(await frameJs(`document.querySelector('#approvalsEnabled').checked||document.querySelector('#questionsEnabled').checked`), false)
  await section('updates')
  assert.equal(await frameJs(`document.querySelector('#policyList [data-value="auto-on-exit"]').getAttribute('aria-selected')`), 'true')
  assert.equal(await frameJs(`document.querySelector('#previewUpdates').checked`), true)
  assert.equal(await frameJs(`document.querySelector('#harnessPolicyList [data-value="notify"]').getAttribute('aria-selected')`), 'true')
  await section('appearance'); assert.equal(await frameJs('DshThemes.current()'), 'gold')
  assert.deepEqual(await js('structuredClone(fixture)'), committed)
  results.push({ name: 'Notification/theme/desktop policy/runtime full policy save and remount roundtrip independently', pass: true })
  await rejectSave('updateNotificationPreferences', 'notifications', () => click('#approvalsEnabled'), `!document.querySelector('#approvalsEnabled').checked&&!document.querySelector('#notificationSaved').classList.contains('visible')`)
  await rejectSave('updateUpdatePreferences', 'updates', () => choose('policyButton', 'policyList', 'manual'), `document.querySelector('#policyList [data-value="auto-on-exit"]').getAttribute('aria-selected')==='true'`)
  await rejectSave('updateHarnessUpdatePolicy', 'updates', () => choose('harnessPolicyButton', 'harnessPolicyList', 'safe-auto'), `document.querySelector('#harnessPolicyList [data-value="notify"]').getAttribute('aria-selected')==='true'`)
  await rejectSave('updateThemePreferences', 'appearance', () => click('[data-theme-id="lake"]'), `DshThemes.current()==='gold'&&document.querySelector('[data-theme-id="gold"]').getAttribute('aria-checked')==='true'`)
  await mount('updates')
  assert.match(await frameJs(`document.querySelector('#harnessPolicyDescription').textContent`), /正式激活仍受安全门禁保护/)
  for (const expected of ['check', 'download', 'install']) {
    assert.equal(await frameJs(`document.querySelector('#updateAction').dataset.action`), expected)
    previous = await count('desktopUpdateAction'); await click('#updateAction'); await saved('desktopUpdateAction', previous)
    assert.equal((await js('calls.filter(c=>c.method==="desktopUpdateAction").at(-1)')).value, expected)
  }
  previous = await count('harnessUpdateAction'); await click('#harnessAction'); await saved('harnessUpdateAction', previous)
  assert.equal((await js('calls.filter(c=>c.method==="harnessUpdateAction").at(-1)')).value, 'check')
  assert.equal(await frameJs(`document.querySelector('#harnessBadge').textContent`), '安全门禁阻止')
  assert.match(await frameJs(`document.querySelector('#harnessFeedback').textContent`), /Fixture safety gate/)
  assert.deepEqual(await js('structuredClone(fixture)'), committed, 'Action route mocks must not mutate preferences')
  results.push({ name: 'Distinct desktop check/download/install and runtime check routes are mock-only; blocked runtime is not success', pass: true })
  await frameJs(`applyBootstrap({locale:'en',colorScheme:'light',themePreset:'gold'})`)
  assert.match(await frameJs(`document.querySelector('#harnessPolicyDescription').textContent`), /Activation remains safety-gated/)
  assert.equal(await frameJs(`document.querySelector('#harnessAction').textContent`), 'Check and validate candidate')
  await frameJs(`applyBootstrap({locale:'zh-CN',colorScheme:'light',themePreset:'gold'})`)
  for (const width of [360, 900]) for (const page of ['notifications', 'updates', 'appearance']) {
    win.setContentSize(width, 740); win.webContents.setZoomFactor(1); await section(page)
    await frameJs(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    const name = `embedded-${page}-${width}.png`
    fs.writeFileSync(join(out, name), (await win.webContents.capturePage()).toPNG()); screenshots.push(name)
  }
  assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [], 'Settings assets must make no network requests')
  const calls = await js('calls')
  fs.writeFileSync(join(out, 'embedded-results.json'), JSON.stringify({ status: 'pass', scope: 'isolated-real-shared-settings-renderer-mock-backend', actualBackendVerified: false, actualDownloadInstallRestart: false, scratch, electron: process.versions.electron, results, calls, screenshots, errors, blockedRequests }, null, 2))
  console.log(`PASS ${results.length} isolated split/layout/save/route cases; no production backend; evidence ${out}`)
}
run().catch(error => { console.error(error); fs.writeFileSync(join(out, 'embedded-failure.json'), JSON.stringify({ error: String(error), results, errors, blockedRequests }, null, 2)); process.exitCode = 1 })
  .finally(() => { clearTimeout(timeout); win?.destroy(); app.exit(process.exitCode || 0) })
