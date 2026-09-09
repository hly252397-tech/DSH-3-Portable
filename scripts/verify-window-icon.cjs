// Native Electron regression probe. Does not start DSH or touch its profile.
const { app, nativeImage, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const output = path.resolve('artifacts/taskbar-icon-20260905');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'electron-user-data'));
app.whenReady().then(async () => {
  const { resolveCompactIconCrop } = await import('../dist/src/app-icon.js');
  const source = nativeImage.createFromPath(path.resolve('assets/icons/taskbar.png'));
  const compact = source.crop(resolveCompactIconCrop(source.getSize()));
  // Execute the actual compiled function with real NativeImage, not a duplicate fix.
  const main = fs.readFileSync(path.resolve('dist/src/main.js'), 'utf8');
  const implementation = main.slice(main.indexOf('function resolveWindowIconImage()'), main.indexOf('function installDesktopFaviconReplacement()'));
  const context = vm.createContext({ nativeImage, resolveCompactIconCrop,
    resolveWindowIconFilePath: () => path.resolve('assets/icons/taskbar.png') });
  const corrected = vm.runInContext('let cachedWindowIcon;\n' + implementation + '\nresolveWindowIconImage()', context);
  assert.deepEqual(corrected.toPNG(), compact.toPNG());
  assert.equal(vm.runInContext('resolveWindowIconImage()', context), corrected, 'reuse immutable icon cache');
  const legacy = nativeImage.createEmpty();
  for (const size of [16, 20, 24, 32, 40, 48, 64, 256]) {
    legacy.addRepresentation({ width: size, height: size,
      buffer: compact.resize({ width: size, height: size, quality: 'best' }).toPNG(), scaleFactor: 1 });
  }
  const report = { electron: process.versions.electron, source: source.getSize(),
    legacy: { size: legacy.getSize(), scales: legacy.getScaleFactors() },
    corrected: { size: corrected.getSize(), scales: corrected.getScaleFactors() } };
  fs.writeFileSync(path.join(output, 'native-report.json'), JSON.stringify(report, null, 2));
  assert.equal(legacy.getSize().width, 16, 'reproduce first 1x representation retaining only 16 px');
  assert.equal(compact.getSize().width, 456);
  const window = new BrowserWindow({ width: 680, height: 340, show: false, icon: corrected,
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: true } });
  const images = [legacy, corrected].map(icon => [24, 32, 48].map(size =>
    `<img width="${size}" height="${size}" src="${icon.resize({width:size,height:size,quality:'best'}).toDataURL()}">`).join(' '));
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<body style="background:#f1f5f9;font:16px Segoe UI;padding:24px"><h3>Same original whale · native Electron rendering</h3><p>Before — 16px reused</p><div>${images[0]}</div><p>After — full-resolution source</p><div>${images[1]}</div></body>`));
  await new Promise(resolve => setTimeout(resolve, 500));
  fs.writeFileSync(path.join(output, 'native-comparison.png'), (await window.webContents.capturePage()).toPNG());
  window.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
