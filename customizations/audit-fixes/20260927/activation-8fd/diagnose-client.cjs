const fs = require('node:fs');
const {createRequire} = require('node:module');
const p = createRequire('G:/DSH-3-Portable/宏建云系统/tools/package.json')('puppeteer-core');
(async()=>{
 const browser=await p.connect({browserURL:'http://127.0.0.1:9463',defaultViewport:null});
 const report={errors:[],console:[],failed:[],responses:[]};
 try {
  const page=(await browser.pages()).find(p=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url()));
  page.on('pageerror', e=>report.errors.push(e.stack||e.message));
  page.on('console', e=>{if(['error','warn'].includes(e.type()))report.console.push(e.text().slice(0,1500));});
  page.on('requestfailed', r=>report.failed.push({url:r.url().replace(/\?.*/,''),failure:r.failure()}));
  page.on('response', r=>{if(r.status()>=400)report.responses.push({url:r.url().replace(/\?.*/,''),status:r.status()});});
  await page.reload({waitUntil:'domcontentloaded',timeout:60000});
  await new Promise(r=>setTimeout(r,10000));
  report.dom=await page.evaluate(()=>({title:document.title,rows:document.querySelectorAll('[data-dcu-session]').length,dialogs:[...document.querySelectorAll('[role="dialog"]')].map(e=>e.innerText.slice(0,800)),modules:performance.getEntriesByType('resource').filter(e=>e.name.includes('codex-ui')).map(e=>e.name.replace(/\?.*/,'')),buttons:[...document.querySelectorAll('button')].filter(e=>e.textContent.trim()==='继续').map(e=>({text:e.textContent,html:e.outerHTML.slice(0,300)}))}));
  fs.writeFileSync(__dirname+'/client-diagnostics.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
 } finally {browser.disconnect();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
