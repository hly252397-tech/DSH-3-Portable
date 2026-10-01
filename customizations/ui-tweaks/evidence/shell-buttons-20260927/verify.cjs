const {createRequire}=require('node:module');
const {writeFileSync,mkdirSync}=require('node:fs');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const root='G:/DSH-3-Portable';
const puppeteer=createRequire(root+'/宏建云系统/tools/package.json')('puppeteer-core');
const out=root+'/customizations/ui-tweaks/evidence/shell-buttons-20260927';
mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await puppeteer.launch({executablePath:root+'/宏建云系统/browsers/chrome-152.0.7977.64/chrome.exe',headless:true,userDataDir:root+'/Data/Temp/shell-buttons-browser-20260927',args:['--allow-file-access-from-files']});
 const results=[];
 try {
  for(const [label,file] of [['broken',root+'/Data/Updates/Desktop/slots/1.0.76-local-3cfc4743bb8d1fff/resources/shell.html'],['fixed',root+'/assets/shell.html']]){
   const page=await browser.newPage(); const errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.setViewport({width:1360,height:300});
   await page.evaluateOnNewDocument(()=>{
    window.calls=[];
    window.dshShell={platform:'win32',action:id=>{window.calls.push(id);return Promise.resolve()},popupMenu:()=>Promise.resolve(),getBootstrap:()=>Promise.resolve({platform:'win32',locale:'zh-CN',colorScheme:'light',menus:[{id:'file',label:'文件'},{id:'edit',label:'编辑'},{id:'view',label:'视图'},{id:'help',label:'帮助'}],state:{canBack:true,canForward:true,zoomPercent:100}}),onBootstrap:()=>{},onState:()=>{},getDesktopUpdateState:()=>Promise.resolve({status:{kind:'idle'},packaged:true}),onDesktopUpdateState:()=>{}};
   });
   await page.goto(pathToFileURL(file).href); await new Promise(r=>setTimeout(r,250));
   await page.click('#back'); await page.click('#forward');
   const navigation=await page.evaluate(()=>window.calls.slice());
   await page.click('#restart-btn');
   const first=await page.evaluate(()=>({pressed:document.querySelector('#restart-btn').getAttribute('aria-pressed'),calls:window.calls.slice(),status:document.querySelector('#status').textContent}));
   await page.keyboard.press('Escape');
   const cancel=await page.$eval('#restart-btn',e=>e.getAttribute('aria-pressed'));
   await page.click('#restart-btn'); await page.click('#restart-btn');
   const final=await page.evaluate(()=>({calls:window.calls.slice(),menus:document.querySelectorAll('#menus button').length}));
   await page.screenshot({path:out+'/'+label+'.png'});
   results.push({label,errors,navigation,first,cancel,final});await page.close();
  }
  writeFileSync(out+'/results.json',JSON.stringify(results,null,2));
  const [broken,fixed]=results;
  assert.ok(broken.errors.some(e=>e.includes('Unexpected identifier')));assert.deepEqual(broken.navigation,[]);assert.equal(broken.first.pressed,'false');assert.equal(broken.final.menus,0);
  assert.deepEqual(fixed.errors,[]);assert.deepEqual(fixed.navigation,['back','forward']);assert.equal(fixed.first.pressed,'true');assert.deepEqual(fixed.first.calls,['back','forward']);assert.equal(fixed.cancel,'false');assert.deepEqual(fixed.final.calls,['back','forward','app-restart']);assert.equal(fixed.final.menus,4);
  console.log('PASS 11 assertions: broken reproduction + fixed navigation, restart confirmation, Escape cancellation and second-click action');
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
