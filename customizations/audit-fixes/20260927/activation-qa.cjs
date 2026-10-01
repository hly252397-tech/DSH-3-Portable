// Real candidate regression, reusing navigation-qa's existing-session workflow.
// No message sending, session deletion, setting saves, or model changes.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = 'G:/DSH-3-Portable';
const puppeteer = createRequire(root + '/宏建云系统/tools/package.json')('puppeteer-core');
const out = process.env.DSH_QA_OUT;
const width = process.argv[2];
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
(async () => {
 const browser = await puppeteer.connect({browserURL:`http://127.0.0.1:${process.env.DSH_QA_PORT || 9463}`,defaultViewport:null});
 try {
  const pages = await browser.pages();
  const shell = pages.find(p => p.url().includes('/shell.html'));
  const expectedSlot = process.env.DSH_QA_SLOT;
  assert.ok(expectedSlot && shell?.url().includes(expectedSlot), 'Expected explicitly selected candidate shell');
  const page = pages.find(p => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url()));
  assert.ok(page, 'Real DSH page required');
  const cleanDraft = async () => assert.equal(await page.evaluate(() => [...document.querySelectorAll('textarea,[contenteditable=true]')].some(e => (e.value || e.textContent || '').length)), false, 'Do not discard drafts');
  const ready = async () => { await page.waitForSelector('.dbh-dock',{visible:true,timeout:60000}); await wait(2000); assert.equal(await page.evaluate(()=>document.visibilityState),'visible'); };
  await ready(); await cleanDraft();
  await page.reload({waitUntil:'domcontentloaded',timeout:60000}); await ready();
  results.push({check:'independent-reload',pass:true,url:page.url()});
  if (!await page.evaluate(() => [...document.querySelectorAll('[data-dcu-session]')].some(e => e.offsetParent))) {
   await shell.evaluate(() => window.dshShell.action('toggle-sidebar')); await wait(700);
  }
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-dcu-session]')].filter(e=>e.offsetParent).slice(0,4).map(e=>e.dataset.dcuSession));
  assert.ok(rows.length >= 4, 'Need four existing sessions');
  const titles = {};
  const visit = async id => {
   await cleanDraft(); await page.click(`[data-dcu-session="${id}"]`);
   await page.waitForFunction(id=>document.querySelector('[data-dcu-session][aria-selected=true]')?.dataset.dcuSession===id,{},id);
   await ready();
  };
  for (const id of rows.slice(0,3)) { await visit(id); titles[id]=await page.title(); results.push({check:'visit',id,pass:true}); }
  assert.equal(await shell.$eval('#back',e=>e.disabled),false);
  for (const [action,id] of [['back',rows[1]],['back',rows[0]],['forward',rows[1]]]) {
   await cleanDraft(); await shell.click('#'+action);
   await page.waitForFunction(id=>document.querySelector('[data-dcu-session][aria-selected=true]')?.dataset.dcuSession===id,{},id);
   await page.waitForFunction(title=>document.title===title,{},titles[id]);
   results.push({check:action,id,pass:true});
  }
  await visit(rows[3]); assert.equal(await shell.$eval('#forward',e=>e.disabled),true);
  results.push({check:'new-branch-clears-forward',pass:true});
  // Close expanded left navigation to recover the user's compact mode.
  await shell.evaluate(()=>window.dshShell.action('toggle-sidebar')); await wait(1200);
  for (const action of ['zoom-reset','zoom-out','zoom-out','zoom-reset','zoom-in','zoom-in','zoom-in','zoom-in','zoom-in','zoom-reset']) {
   await shell.evaluate(id=>window.dshShell.action(id),action); await wait(1600);
   const geometry=await page.evaluate(()=>{
    const seat=document.querySelector('.dsh-tweaks-seat'),dock=document.querySelector('.dbh-dock');
    const s=seat?.getBoundingClientRect(),d=dock?.getBoundingClientRect();
    return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,zoom:getComputedStyle(document.documentElement).getPropertyValue('--dsh-app-zoom'),seat:s?.toJSON(),dock:d?.toJSON(),modelInSeat:!!seat?.querySelector('._7KE1Ra_root'),costInSeat:!!seat?.querySelector('[data-testid="billing-live-cost-chip"]'),visible:document.visibilityState};
   });
   assert.ok(geometry.seat?.width>10 && geometry.modelInSeat,'Model seat must remain in dock');
   assert.ok(geometry.seat.right<=geometry.dock.right+2 && geometry.seat.top>=geometry.dock.top-2 && geometry.seat.bottom<=geometry.dock.bottom+2,'Seat stays inside upper-right dock');
   assert.ok(geometry.seat.right<=geometry.width+1 && geometry.seat.bottom<=geometry.height+1,'Controls stay on screen');
   results.push({check:action,pass:true,...geometry});
  }
  const modelButton = await page.$('.dsh-tweaks-seat ._7KE1Ra_root button');
  assert.ok(modelButton,'Model trigger must exist');
  await modelButton.click(); await wait(600);
  const menuOpen=await page.evaluate(()=>!!document.querySelector('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'));
  assert.ok(menuOpen,'Model menu opens after real input');
  results.push({check:'model-menu-click',pass:true}); await page.keyboard.press('Escape'); await wait(1500);
  if (width === 'maximized') {
   await shell.evaluate(()=>window.dshShell.action('toggle-fullscreen'));
   try {
    await wait(2000); await ready();
    const full = await page.evaluate(()=>{
     const seat=document.querySelector('.dsh-tweaks-seat')?.getBoundingClientRect();
     const dock=document.querySelector('.dbh-dock')?.getBoundingClientRect();
     return {width:innerWidth,height:innerHeight,seat:seat?.toJSON(),dock:dock?.toJSON()};
    });
    assert.ok(full.seat?.width>10 && full.seat.right<=full.width+1 && full.seat.right<=full.dock.right+2,'Fullscreen controls stay in composer column');
    await page.click('.dsh-tweaks-seat ._7KE1Ra_root button'); await wait(500);
    assert.ok(await page.$('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'),'Fullscreen model menu opens');
    await page.keyboard.press('Escape');
    await page.screenshot({path:`${out}/ui-fullscreen.png`});
    results.push({check:'true-fullscreen',pass:true,...full});
   } finally { await shell.evaluate(()=>window.dshShell.action('toggle-fullscreen')); await wait(1800); }
  }
  await page.screenshot({path:`${out}/ui-${width}.png`});
  fs.writeFileSync(`${out}/results-${width}.json`,JSON.stringify({status:'pass',at:new Date().toISOString(),shell:shell.url(),results},null,2));
  console.log(JSON.stringify({width,status:'pass',checks:results.length}));
 } catch (e) {
  fs.writeFileSync(`${out}/failure-${width}-${Date.now()}.json`,JSON.stringify({at:new Date().toISOString(),error:e.stack,results},null,2));
  throw e;
 } finally { browser.disconnect(); }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
