// Isolated renderer only; does not load a real profile or modify user preferences.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'Data/Temp/settings-icons-electron'));
app.disableHardwareAcceleration();
const dir = path.join(root, 'customizations/ui-tweaks/evidence/settings-icons-20260928');
const source = readFileSync(path.join(root, 'customizations/ui-tweaks/lib/client.js'), 'utf8');
const block = source.split('// BEGIN SETTINGS_NAV_DISTINCT_ICONS')[1].split('// END SETTINGS_NAV_DISTINCT_ICONS')[0];
app.whenReady().then(async () => {
 const win = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
 try {
  const rows = JSON.parse(readFileSync(path.join(dir, 'before.json'), 'utf8')).result.rows;
  const buttons = rows.map(r => `<button class="dcu-settings-link"><svg viewBox="0 0 24 24" width="16" height="16">${r.svg}</svg><span>${r.label}</span></button>`).join('');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<style>body{margin:0;background:white;color:#333}.dcu-settings-nav{width:260px}.dcu-settings-link{display:flex;align-items:center;gap:8px;width:100%;min-height:31px;color:inherit;background:transparent;border:0}</style><nav class="dcu-settings-nav">'+buttons+'</nav>'));
  await win.webContents.executeJavaScript(block + ';window.cleanupIcons=null; installSettingsNavIcons({effect(fn){window.cleanupIcons=fn()}}); document.querySelectorAll("button").forEach(b=>b.onclick=()=>window.clicked=b.textContent);');
  const results=[];
  for(const width of [480,1360]) for(const zoom of [0.8,1,1.25]) for(const dark of [false,true]) {
   win.setSize(width,900); win.webContents.setZoomFactor(zoom);
   results.push(await win.webContents.executeJavaScript(`(async()=>{
    document.body.style.color=${JSON.stringify(dark?'#ddd':'#333')};document.body.style.background=${JSON.stringify(dark?'#222':'white')};
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const items=[...document.querySelectorAll('[data-dsh-settings-icon]')];
    if(items.length!==5)throw Error('Missing icons');
    for(const b of items){const s=getComputedStyle(b,'::before');if(Math.abs(parseFloat(s.width)-16)>0.1||Math.abs(parseFloat(s.height)-16)>0.1||s.backgroundColor!==getComputedStyle(b).color||s.maskImage==='none')throw Error('Invalid icon style '+JSON.stringify({label:b.textContent,width:s.width,height:s.height,bg:s.backgroundColor,color:getComputedStyle(b).color,mask:s.maskImage}));b.click();if(window.clicked!==b.textContent)throw Error('Click intercepted')}
    return {width:${width},zoom:${zoom},dark:${dark},icons:items.length,ok:true};})()`));
  }
  const lifecycle=await win.webContents.executeJavaScript(`(async()=>{
   const nav=document.querySelector('nav'),b=nav.querySelector('[data-dsh-settings-icon]'),copy=b.cloneNode(true);copy.removeAttribute('data-dsh-settings-icon');b.remove();nav.appendChild(copy);
   const deadline=Date.now()+5000;while(!copy.hasAttribute('data-dsh-settings-icon')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
   if(!copy.hasAttribute('data-dsh-settings-icon'))throw Error('Remount missing icon');
   window.cleanupIcons();if(document.querySelector('[data-dsh-settings-icon],[data-dsh-settings-icons-style]'))throw Error('Cleanup incomplete');
   return {remount:true,cleanup:true};})()`);
  mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,'layout.json'),JSON.stringify({results,lifecycle},null,2));
  console.log(JSON.stringify({cases:results.length,lifecycle}));app.exit(0);
 }catch(e){console.error(e);app.exit(1)}
});
