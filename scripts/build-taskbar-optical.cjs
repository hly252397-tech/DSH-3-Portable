// Compile the repository-native vector at each Windows icon size; no raster tracing.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = path.resolve('artifacts/taskbar-optical-20260905');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'electron-data'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 780, height: 390,
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: true } });
  const svg = fs.readFileSync(path.resolve('assets/icons/taskbar-optical.svg'), 'utf8');
  const url = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  await window.loadURL('data:text/html,<body></body>');
  const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
  const entries = [];
  for (const size of sizes) {
    const data = await window.webContents.executeJavaScript(`(async()=>{
      const img=new Image(); img.src=${JSON.stringify(url)}; await img.decode();
      const c=document.createElement('canvas'); c.width=c.height=${size};
      c.getContext('2d').drawImage(img,0,0,${size},${size}); return c.toDataURL('image/png');
    })()`);
    const png = Buffer.from(data.split(',')[1], 'base64');
    const pixels = nativeImage.createFromBuffer(png).toBitmap();
    assert.equal(pixels[3], 0, 'real transparent background');
    assert(pixels.some((v,i)=>i%4===3 && v===255), 'nonempty opaque mark');
    fs.writeFileSync(path.join(out, `optical-${size}.png`), png);
    entries.push({ size, png, url: data });
  }
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({size,png}, i) => {
    const p = 6 + i * 16;
    header[p] = header[p+1] = size===256 ? 0 : size;
    header.writeUInt16LE(1,p+4); header.writeUInt16LE(32,p+6);
    header.writeUInt32LE(png.length,p+8); header.writeUInt32LE(offset,p+12); offset+=png.length;
  });
  fs.writeFileSync(path.resolve('assets/icons/taskbar-optical.ico'), Buffer.concat([header,...entries.map(e=>e.png)]));
  const old = nativeImage.createFromPath(path.resolve('assets/icons/taskbar.png'));
  const oldCropped = old.crop({x:28,y:28,width:456,height:456});
  const row = (newIcon) => entries.slice(0,6).map(e=>`<div style="width:82px;text-align:center"><div style="height:54px;display:flex;align-items:center;justify-content:center"><img width="${e.size}" height="${e.size}" src="${newIcon?e.url:oldCropped.resize({width:e.size,height:e.size,quality:'best'}).toDataURL()}"></div><small>${e.size}px</small></div>`).join('');
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<body style="font:14px Segoe UI;margin:24px;background:#eef4f8;color:#222"><h3>First-edition whale — actual pixel sizes</h3><p>Before: original details with corrected scaling</p><div style="display:flex">${row(false)}</div><p>After: simplified eye / belly, optical padding, native size frames</p><div style="display:flex">${row(true)}</div><p>Real alpha · no tile · no painted checkerboard</p></body>`));
  await new Promise(r=>setTimeout(r,500));
  fs.writeFileSync(path.join(out,'actual-size-comparison.png'),(await window.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({sizes,alpha:'verified',asset:'assets/icons/taskbar-optical.ico'},null,2));
  window.destroy(); app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
