// Isolated Chromium/React editor acceptance. Does not navigate/reload the user's DSH window.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const run = path.join(root, 'Data/Temp', 'I035-ui-' + Date.now());
app.setPath('userData', path.join(run, 'electron'));
app.setPath('sessionData', path.join(run, 'electron'));
app.setPath('crashDumps', path.join(run, 'crashes'));
let win, server;
const checks = [];
const assertCheck = (name, condition) => { assert.ok(condition, name); checks.push(name); };
(async () => {
  await fs.mkdir(run, { recursive: true });
  const output = path.join(root, 'Data/artifacts/I035-manual-ui');
  await fs.mkdir(output, { recursive: true });
  const { createManualStore } = await import(pathToFileURL(path.join(root, 'plugins/dsh-manual/lib/store.js')));
  const { dispatchManual, readBody, safeError, trustedManualRequest } = await import(pathToFileURL(path.join(root, 'plugins/dsh-manual/lib/api.js')));
  const store = createManualStore({ root: path.join(run, 'manual'), sourceRoot: root, sources: [] });
  await store.initialize();
  const profile = path.join(root, 'Data/DSH/profiles/web/package.json');
  const client = await fs.readFile(path.join(root, 'plugins/dsh-manual/lib/client.js'), 'utf8');
  const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>DSH 手册 · 隔离验收</title><style>body{margin:28px;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;color:#242424;background:#fafafa}h1{font-size:23px}</style><h1>DSH 手册</h1><div id="root"></div><script>
    const fixtureRequire=require('node:module').createRequire(${JSON.stringify(profile)});
    const nodePath=require('node:path');
    const reactDomPath=fixtureRequire.resolve('react-dom/client');
    const reactPackagePath=nodePath.join(nodePath.dirname(reactDomPath),'..','react');
    const React=require(reactPackagePath),ReactDOM=require(reactDomPath);
    const disposers=[];let dictionary,component,props;const reactRoot=ReactDOM.createRoot(document.getElementById('root'));
    const pluginRequire=request=>request==='react'?React:fixtureRequire(request);
    window.__ModuleLoader__={load({factory}){const plugin=factory(pluginRequire);plugin.apply({
      effect(fn){const dispose=fn();if(dispose)disposers.push(dispose)},
      locale:{register(ns,d){dictionary=d.zh;return()=>{}},bind(){return key=>dictionary[key]||key}},
      slots:{inject(name,fn){fn()},register(config,Component){component=Component;props=config.inject();reactRoot.render(React.createElement(Component,props));return()=>reactRoot.unmount()}},
    });window.fixtureDispose=()=>{reactRoot.unmount();for(const dispose of disposers.reverse())dispose()}}};
    window.fixtureSet=(selector,value)=>{const element=document.querySelector(selector);const proto=element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}))};
    window.fixtureClick=text=>{const element=[...document.querySelectorAll('button')].find(b=>b.textContent===text);if(!element)throw Error('Missing button '+text);element.click()};
    ${client}
  </script></html>`;
  server = createServer(async (req, res) => {
    if (req.url !== '/dsh-manual/api') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
    try {
      if (!trustedManualRequest(req)) { res.writeHead(403); res.end('{}'); return; }
      const args = await readBody(req);
      const value = args.operation === 'status' ? { lastSync: { status: 'ready' } } : await dispatchManual(store, args, { author: 'user' });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, value }));
    } catch (error) { res.writeHead(error.code === 'REVISION_CONFLICT' ? 409 : 400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: safeError(error) })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1180, height: 980, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  const evaluate = expression => win.webContents.executeJavaScript(expression);
  const until = async expression => { const end = Date.now() + 8000; while(Date.now() < end) { if(await evaluate(expression))return; await new Promise(resolve=>setTimeout(resolve,40)); } throw Error('UI wait timed out: '+expression); };
  await win.loadURL('http://127.0.0.1:' + server.address().port);
  await until('document.querySelectorAll(".dshm-list li").length > 0 && !document.querySelector(".dshm-actions button").disabled');
  await evaluate('fixtureClick("DSH 手册操作总览")');
  await until('!!document.querySelector("textarea") && document.querySelector("textarea").value.length > 0');
  assertCheck('generated source is read-only', await evaluate('document.querySelector("textarea").readOnly'));
  await evaluate('fixtureClick("新建笔记")');
  await evaluate('fixtureSet(".dshm-editor input", "UI 验收笔记");fixtureSet("textarea", "# UI 验收\\n初始正文")');
  await until('![...document.querySelectorAll("button")].find(b=>b.textContent==="保存草稿").disabled');
  await evaluate('fixtureClick("保存草稿")');
  await until('document.querySelector(".dshm-notice").textContent.includes("草稿已保存")');
  let note = (await store.list({ kind: 'note' })).items[0];
  assertCheck('save persists actual Markdown', (await store.read({ id: note.id })).content.includes('初始正文'));
  assertCheck('saved note remains editable', await evaluate('!document.querySelector("textarea").readOnly'));
  const original = note.revision;
  await evaluate('fixtureSet("textarea", "# UI 验收\\n本地未保存草稿")');
  await store.edit({ id: note.id, expectedRevision: note.revision, content: '# 并发编辑\n来自另一窗口', title: note.title, author: 'fixture' });
  await evaluate('fixtureClick("保存草稿")');
  await until('document.querySelector(".dshm-notice").textContent.includes("版本冲突")');
  assertCheck('conflict keeps unsaved draft', await evaluate('document.querySelector("textarea").value.includes("本地未保存草稿")'));
  assertCheck('conflict preserves newer disk value', (await store.read({ id: note.id })).content.includes('来自另一窗口'));
  await fs.writeFile(path.join(output, 'wide.png'), (await win.webContents.capturePage()).toPNG());
  await evaluate('fixtureClick("放弃未保存修改")');
  await evaluate('fixtureClick("UI 验收笔记")');
  await until('document.querySelector("textarea").value.includes("来自另一窗口")');
  await evaluate('fixtureClick("修订历史")');
  await until('!!document.querySelector("select")');
  await evaluate(`(()=>{const e=document.querySelector('select');e.value=${JSON.stringify(original)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await evaluate('fixtureClick("恢复所选修订")');
  await until('document.querySelector("textarea").value.includes("初始正文")');
  assertCheck('history restore creates usable draft', (await store.read({ id: note.id })).status === 'draft');
  win.setContentSize(540, 840);
  await new Promise(resolve => setTimeout(resolve, 160));
  assertCheck('narrow editor does not overflow viewport', await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  await fs.writeFile(path.join(output, 'narrow.png'), (await win.webContents.capturePage()).toPNG());
  await evaluate('fixtureDispose()');
  assertCheck('client disposal removes owned stylesheet', await evaluate('!document.querySelector("style[data-plugin=dsh-manual]")'));
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ status: 'pass', checks, actualDesktopVerified: false, fixture: 'real Chromium + installed React + source client + real manual store; isolated slot carrier', run }, null, 2));
  console.log(JSON.stringify({ status: 'pass', checks: checks.length, output }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  win?.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  app.exit(process.exitCode || 0);
});
