const {app, BrowserWindow, nativeImage}=require('electron');
const fs=require('node:fs'); const path=require('node:path');
const out=path.resolve('artifacts/taskbar-optical-20260905');
app.setPath('userData',path.join(out,'preview-data'));
app.setAppUserModelId('dsh.icon.optical.preview');
app.whenReady().then(async()=>{
  const icon=path.resolve('assets/icons/taskbar-optical.ico');
  const w=new BrowserWindow({width:540,height:240,title:'DSH Icon Optical Preview',icon,
    webPreferences:{sandbox:true,contextIsolation:true}});
  w.setMenu(null);
  await w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="font:16px Segoe UI;background:#eef4f8;padding:24px"><h3>任务栏图标验收</h3><p>独立测试窗口，不连接 DSH，不操作任务或更新队列。</p><p>请看任务栏中的鲸鱼图标。此窗口将在 60 秒后自动关闭。</p></body>'));
  const handle=w.getNativeWindowHandle();
  fs.writeFileSync(path.join(out,'preview-window.json'),JSON.stringify({pid:process.pid,hwnd:Number(handle.readBigUInt64LE()),icon}));
  w.show();
  setTimeout(()=>{if(!w.isDestroyed())w.destroy();app.quit()},60000);
});
app.on('window-all-closed',()=>app.quit());
