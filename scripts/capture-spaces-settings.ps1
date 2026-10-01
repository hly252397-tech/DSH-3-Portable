param([int]$TargetProcessId, [int]$VerifiedPort, [switch]$ProbeOnce, [switch]$OpenSettings)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$out=Join-Path $repo 'customizations/audit-fixes/20260927/spaces-service-merge'
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class SpacesCapture {
 [StructLayout(LayoutKind.Sequential)] public struct P { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Right,B; }
 [StructLayout(LayoutKind.Sequential)] public struct Placement { public int Length,Flags,Show; public P Min,Max; public R Normal; }
 [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h,ref Placement p);
 [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h,ref Placement p);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out R r);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int z,uint f);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int index);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
$process=Get-Process -Id $TargetProcessId
if (-not $process.Path.StartsWith((Join-Path $repo 'Data\Updates\Desktop\slots\'))) { throw 'Unexpected target process' }
$handle=$process.MainWindowHandle
$placement=New-Object SpacesCapture+Placement
$placement.Length=[System.Runtime.InteropServices.Marshal]::SizeOf($placement)
if (-not [SpacesCapture]::GetWindowPlacement($handle,[ref]$placement)) { throw 'Cannot save window placement' }
$wasTopmost=([SpacesCapture]::GetWindowLong($handle,-20) -band 8) -ne 0
$foreground=[SpacesCapture]::GetForegroundWindow()
try {
 [void][SpacesCapture]::ShowWindow($handle,9)
 [void][SpacesCapture]::SetWindowPos($handle,[IntPtr](-1),0,0,0,0,0x13)
 Start-Sleep -Milliseconds 1500
 if ($OpenSettings) {
  & (Join-Path $repo 'Tools/node-v26.10.0/node.exe') (Join-Path $repo 'scripts/verify-spaces-service-live.mjs') settings $VerifiedPort
  if ($LASTEXITCODE -ne 0) { throw 'Cannot open settings' }
  Start-Sleep -Milliseconds 500
  & (Join-Path $repo 'Tools/node-v26.10.0/node.exe') (Join-Path $repo 'scripts/verify-spaces-service-live.mjs') spaces $VerifiedPort
  if ($LASTEXITCODE -ne 0) { throw 'Cannot open custom spaces' }
 }
 $rect=New-Object SpacesCapture+R
 [void][SpacesCapture]::GetWindowRect($handle,[ref]$rect)
 foreach ($width in @(1360,1000)) {
  [void][SpacesCapture]::SetWindowPos($handle,[IntPtr](-1),0,0,$width,($rect.B-$rect.T),0x16)
  Start-Sleep -Milliseconds 1500
  if ($ProbeOnce -and $width -eq 1360) {
   & (Join-Path $repo 'Tools/node-v26.10.0/node.exe') (Join-Path $repo 'scripts/verify-spaces-service-live.mjs') probe $VerifiedPort
   if ($LASTEXITCODE -ne 0) { throw 'Probe button verification failed' }
  }
  & (Join-Path $repo 'Tools/node-v26.10.0/node.exe') (Join-Path $repo 'scripts/verify-spaces-service-live.mjs') inspect $VerifiedPort
  if ($LASTEXITCODE -ne 0) { throw 'Live inspection failed' }
  Copy-Item -LiteralPath (Join-Path $out 'live-inspect.json') -Destination (Join-Path $out "settings-$width.json")
  $check=Get-Content -LiteralPath (Join-Path $out "settings-$width.json") -Raw | ConvertFrom-Json
  if (-not $check.form -or $check.headings.Count -ne 1 -or $check.settingsStyle.position -ne 'fixed' -or $check.card.scrollWidth -gt $check.card.clientWidth+1 -or $check.card.right -gt $check.viewport.width) { throw 'Settings layout assertion failed' }
  & (Join-Path $repo 'scripts/capture-app-window.ps1') -Hwnd $handle.ToInt64() -Out (Join-Path $out "settings-$width.png")
 }
} finally {
 if ($OpenSettings) {
  & (Join-Path $repo 'Tools/node-v26.10.0/node.exe') (Join-Path $repo 'scripts/verify-spaces-service-live.mjs') close $VerifiedPort
 }
 if (-not $wasTopmost) { [void][SpacesCapture]::SetWindowPos($handle,[IntPtr](-2),0,0,0,0,0x13) }
 [void][SpacesCapture]::SetWindowPlacement($handle,[ref]$placement)
 if ($foreground -ne [IntPtr]::Zero) { [void][SpacesCapture]::SetForegroundWindow($foreground) }
}
Write-Output 'Settings checks passed; original window placement restored'
