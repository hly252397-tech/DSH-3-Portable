param([Parameter(Mandatory=$true)][int]$TargetProcessId,[ValidateSet('Capture','Quit','Test','Click')][string]$Action='Capture',[string]$OutDir,[int]$Port=9463,[int]$X=850,[int]$Y=22)
$ErrorActionPreference='Stop'
$repo='G:\DSH-3-Portable'
$process=Get-Process -Id $TargetProcessId
if (-not $process.Path.StartsWith("$repo\Data\Updates\Desktop\slots\",[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected process path' }
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class ActivationWindow {
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 public delegate bool Callback(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c,IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int z,uint f);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref Point p);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
 public static IntPtr Find(uint p) { IntPtr found=IntPtr.Zero; EnumWindows((h,l)=>{uint id;GetWindowThreadProcessId(h,out id);var s=new StringBuilder(512);GetWindowText(h,s,512);if(id==p&&s.ToString()=="DSH Codex Desktop")found=h;return true;},IntPtr.Zero);return found; }
}
'@
$handle=[ActivationWindow]::Find($TargetProcessId)
if ($handle -eq [IntPtr]::Zero) { throw 'DSH window absent' }
$wasTopmost=([ActivationWindow]::GetWindowLong($handle,-20) -band 8) -ne 0
$priorDpiContext=[ActivationWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
try {
 [void][ActivationWindow]::ShowWindow($handle,9)
 [void][ActivationWindow]::SetWindowPos($handle,[IntPtr](-1),0,0,0,0,0x13)
 [void][ActivationWindow]::SetForegroundWindow($handle)
 Start-Sleep -Milliseconds 1800
 & "$repo\scripts\capture-app-window.ps1" -Hwnd $handle.ToInt64() -Out "$OutDir\before.png"
 if ($Action -eq 'Quit' -or $Action -eq 'Click') {
  # Foreground restrictions can reject SetForegroundWindow. Click only the
  # inspected empty shell toolbar region, and verify its owning PID first.
  if ($Action -eq 'Click' -or [ActivationWindow]::GetForegroundWindow() -ne $handle) {
   $point=New-Object ActivationWindow+Point; $point.X=$X; $point.Y=$Y
   [void][ActivationWindow]::ClientToScreen($handle,[ref]$point)
   [uint32]$pointOwner=0
   [void][ActivationWindow]::GetWindowThreadProcessId([ActivationWindow]::WindowFromPoint($point),[ref]$pointOwner)
   if ($pointOwner -ne $TargetProcessId) { throw 'Click point is occluded; no input sent' }
   $cursor=New-Object ActivationWindow+Point
   [void][ActivationWindow]::GetCursorPos([ref]$cursor)
   try {
    [void][ActivationWindow]::SetCursorPos($point.X,$point.Y)
    [ActivationWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    [ActivationWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
   } finally { [void][ActivationWindow]::SetCursorPos($cursor.X,$cursor.Y) }
   Start-Sleep -Milliseconds 250
  }
  if ([ActivationWindow]::GetForegroundWindow() -ne $handle) { throw 'Not foreground; no key sent' }
 }
 if ($Action -eq 'Click') {
  Start-Sleep -Milliseconds 1800
  & "$repo\scripts\capture-app-window.ps1" -Hwnd $handle.ToInt64() -Out "$OutDir\after.png"
 }
 if ($Action -eq 'Quit') {
  $ws=New-Object -ComObject WScript.Shell
  $ws.SendKeys('^q')
  $deadline=(Get-Date).AddSeconds(20)
  while ((Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue) { throw 'Normal quit did not finish; not force-stopped' }
  Write-Output 'Normal Ctrl+Q quit confirmed'
 }
 if ($Action -eq 'Test') {
  $env:DSH_QA_PORT=[string]$Port
  $env:DSH_QA_OUT=$OutDir
  foreach ($width in @('1376','1100','maximized')) {
   if ($width -eq 'maximized') { [void][ActivationWindow]::ShowWindow($handle,3) }
   else {
    [void][ActivationWindow]::ShowWindow($handle,9)
    [void][ActivationWindow]::SetWindowPos($handle,[IntPtr]::Zero,0,0,[int]$width,908,0x16)
   }
   Start-Sleep -Milliseconds 1800
   & "$repo\Tools\node-v26.10.0\node.exe" "$PSScriptRoot\activation-qa.cjs" $width
   if ($LASTEXITCODE -ne 0) { throw "UI test failed width=$width" }
   & "$repo\scripts\capture-app-window.ps1" -Hwnd $handle.ToInt64() -Out "$OutDir\physical-$width.png"
   & "$repo\Tools\node-v26.10.0\node.exe" "$repo\scripts\gates.mjs"
   if ($LASTEXITCODE -ne 0) { throw "Gate failed width=$width" }
  }
 }
} finally {
 if ([ActivationWindow]::IsWindow($handle) -and -not $wasTopmost) { [void][ActivationWindow]::SetWindowPos($handle,[IntPtr](-2),0,0,0,0,0x13) }
 if ($priorDpiContext -ne [IntPtr]::Zero) { [void][ActivationWindow]::SetThreadDpiAwarenessContext($priorDpiContext) }
}
