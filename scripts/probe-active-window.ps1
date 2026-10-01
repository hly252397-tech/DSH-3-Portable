param([Parameter(Mandatory=$true)][int]$TargetProcessId, [int]$Width=1100, [string]$OutDir, [switch]$ReturnToConversation, [switch]$Verify)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir=Join-Path $repo 'Data\artifacts\active-window-probe' }
$process=Get-Process -Id $TargetProcessId
if (-not $process.Path.StartsWith((Join-Path $repo 'Data\Updates\Desktop\slots\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Target is not a portable DSH desktop slot' }
Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class ProbeDshWindow {
 public delegate bool EnumProc(IntPtr h, IntPtr l);
 [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Rt,B; }
 [StructLayout(LayoutKind.Sequential)] public struct P { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct Placement { public int Length,Flags,Show; public P Min,Max; public R Normal; }
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb,IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out R r);
 [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h,ref Placement p);
 [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h,ref Placement p);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int z,uint f);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int index);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref P p);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
 public static IntPtr Find(uint pid) {
  IntPtr found=IntPtr.Zero; long area=0;
  EnumWindows((h,l)=> { uint p; GetWindowThreadProcessId(h,out p); R r;
   if(p==pid && IsWindowVisible(h) && GetWindowRect(h,out r)) {
    var title=new StringBuilder(512); var kind=new StringBuilder(128);
    GetWindowText(h,title,512); GetClassName(h,kind,128);
    long a=(long)(r.Rt-r.L)*(r.B-r.T); if(title.ToString()=="DSH Codex Desktop" && kind.ToString()=="Chrome_WidgetWin_1" && a>area) { area=a; found=h; }
   } return true;
  },IntPtr.Zero); return found;
 }
}
'@
$handle=[ProbeDshWindow]::Find($TargetProcessId)
if ($handle -eq [IntPtr]::Zero) { throw 'No visible DSH window; no state changed' }
$placement=New-Object ProbeDshWindow+Placement
$placement.Length=[System.Runtime.InteropServices.Marshal]::SizeOf($placement)
if (-not [ProbeDshWindow]::GetWindowPlacement($handle,[ref]$placement)) { throw 'Cannot save placement' }
$wasTopmost=([ProbeDshWindow]::GetWindowLong($handle,-20) -band 8) -ne 0
$previousForeground=[ProbeDshWindow]::GetForegroundWindow()
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
try {
 [void][ProbeDshWindow]::ShowWindow($handle,9)
 if ($Verify) {
  # Real viewport probes require unoccluded painting, not merely native visibility.
  [void][ProbeDshWindow]::SetWindowPos($handle,[IntPtr](-1),0,0,0,0,0x13)
  [void][ProbeDshWindow]::SetForegroundWindow($handle)
 }
 Start-Sleep -Milliseconds 300
 if ($ReturnToConversation) {
  # Coordinates from the captured DSH settings page, never guessed on another app.
  $cursor=New-Object ProbeDshWindow+P
  [void][ProbeDshWindow]::GetCursorPos([ref]$cursor)
  [void][ProbeDshWindow]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 250
  if ([ProbeDshWindow]::GetForegroundWindow() -ne $handle) { throw 'Could not focus target; no click sent' }
  $point=New-Object ProbeDshWindow+P
  $point.X=70; $point.Y=70
  [void][ProbeDshWindow]::ClientToScreen($handle,[ref]$point)
  try {
   [void][ProbeDshWindow]::SetCursorPos($point.X,$point.Y)
   [ProbeDshWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
   [ProbeDshWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  } finally { [void][ProbeDshWindow]::SetCursorPos($cursor.X,$cursor.Y) }
  Start-Sleep -Milliseconds 900
 }
 $rect=New-Object ProbeDshWindow+R
 [void][ProbeDshWindow]::GetWindowRect($handle,[ref]$rect)
 [void][ProbeDshWindow]::SetWindowPos($handle,[IntPtr]::Zero,0,0,$Width,($rect.B-$rect.T),0x16)
 Start-Sleep -Milliseconds 1600
 & (Join-Path $PSScriptRoot 'capture-app-window.ps1') -Hwnd $handle.ToInt64() -Out (Join-Path $OutDir 'narrow.png')
 if ($Verify) {
  & (Join-Path $repo 'Tools/node-v26.10.0/node.exe') (Join-Path $repo 'scripts/gates.mjs')
  $narrowExit=$LASTEXITCODE
  [void][ProbeDshWindow]::SetWindowPos($handle,[IntPtr]::Zero,0,0,($rect.Rt-$rect.L),($rect.B-$rect.T),0x16)
  Start-Sleep -Milliseconds 1600
  & (Join-Path $PSScriptRoot 'capture-app-window.ps1') -Hwnd $handle.ToInt64() -Out (Join-Path $OutDir 'wide.png')
  & (Join-Path $repo 'Tools/node-v26.10.0/node.exe') (Join-Path $repo 'scripts/gates.mjs')
  $wideExit=$LASTEXITCODE
  if ($narrowExit -ne 0 -or $wideExit -ne 0) { throw "Window gates failed: narrow=$narrowExit wide=$wideExit" }
 }
} finally {
 if ($Verify -and -not $wasTopmost) { [void][ProbeDshWindow]::SetWindowPos($handle,[IntPtr](-2),0,0,0,0,0x13) }
 [void][ProbeDshWindow]::SetWindowPlacement($handle,[ref]$placement)
 if ($Verify -and $previousForeground -ne [IntPtr]::Zero -and $previousForeground -ne $handle) { [void][ProbeDshWindow]::SetForegroundWindow($previousForeground) }
 Start-Sleep -Milliseconds 1600
}
& (Join-Path $PSScriptRoot 'capture-app-window.ps1') -Hwnd $handle.ToInt64() -Out (Join-Path $OutDir 'restored.png')
Write-Output "Target PID $TargetProcessId HWND $handle; original placement restored"
