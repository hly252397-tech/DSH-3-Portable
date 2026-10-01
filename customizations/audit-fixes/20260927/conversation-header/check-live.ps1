param([int]$TargetProcessId=34428)
$ErrorActionPreference='Stop'
$repo='G:\DSH-3-Portable'
$probe=Join-Path $repo 'Data\DSH-generations\v4-rc2b\home\profiles\web\local\dsh-ui-tweaks\lib\ui-probe.json'
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class HeaderCheck {
 [StructLayout(LayoutKind.Sequential)] public struct P { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Right,B; }
 [StructLayout(LayoutKind.Sequential)] public struct Placement { public int Length,Flags,Show; public P Min,Max; public R Normal; }
 [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h,ref Placement p);
 [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h,ref Placement p);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int z,uint f);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int index);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out R r);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref P p);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
 [DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);
}
'@
$p=Get-Process -Id $TargetProcessId
if (-not $p.Path.StartsWith((Join-Path $repo 'Data\Updates\Desktop\slots\'))) { throw 'Not DSH' }
$h=$p.MainWindowHandle
$previous=[HeaderCheck]::GetForegroundWindow()
$wasTopmost=([HeaderCheck]::GetWindowLong($h,-20) -band 8) -ne 0
$placement=New-Object HeaderCheck+Placement
$placement.Length=[System.Runtime.InteropServices.Marshal]::SizeOf($placement)
if (-not [HeaderCheck]::GetWindowPlacement($h,[ref]$placement)) { throw 'Cannot save placement' }
$cursor=New-Object HeaderCheck+P
[void][HeaderCheck]::GetCursorPos([ref]$cursor)
function Key([byte]$k,[uint32]$flags=0) { [HeaderCheck]::keybd_event($k,0,$flags,[UIntPtr]::Zero) }
function AssertFocus { if ([HeaderCheck]::GetForegroundWindow() -ne $h) { throw 'Target lost focus; stop UI interaction' } }
function ToggleSidebar { AssertFocus; Key 17; Key 66; Key 66 2; Key 17 2 }
function FreshProbe {
 $started=[DateTime]::UtcNow
 for($i=0;$i -lt 24;$i++) {
  Start-Sleep -Milliseconds 500
  $d=Get-Content -LiteralPath $probe -Raw | ConvertFrom-Json
  if ([DateTime]::Parse($d.sampledAt).ToUniversalTime() -gt $started -and $d.headerDiag.visible -eq 'visible') { return $d }
 }
 throw 'No new visible probe'
}
$toggled=$false
try {
 [void][HeaderCheck]::ShowWindow($h,9)
 [void][HeaderCheck]::SetWindowPos($h,[IntPtr](-1),0,0,0,0,0x13)
 [void][HeaderCheck]::SetForegroundWindow($h)
 Start-Sleep -Milliseconds 400
 AssertFocus
 $d=FreshProbe
 if (-not ($d.narrowText -match 'dcu-compact')) { throw 'Expected collapsed sidebar; no preference changed' }
 ToggleSidebar
 $toggled=$true
 $d=FreshProbe
 $d | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'live-three-row.json')
 & (Join-Path $repo 'scripts/capture-app-window.ps1') -Hwnd $h.ToInt64() -Out (Join-Path $PSScriptRoot 'live-three-row.png')
 if ($d.headerDiag.header.width -gt 520) { throw 'Actual column not narrow enough' }
 if ($d.headerDiag.subagent.height -gt 28.5 -or $d.headerDiag.scroll.top -lt $d.headerDiag.header.bottom-1) { throw 'Header geometry failed' }
 $rect=New-Object HeaderCheck+R
 [void][HeaderCheck]::GetClientRect($h,[ref]$rect)
 if ([Math]::Abs($rect.Right-$d.vw) -gt 4) { throw 'Coordinate scale mismatch; no click' }
 $point=New-Object HeaderCheck+P
 $point.X=[int](($d.headerDiag.subagent.left+$d.headerDiag.subagent.right)/2)
 $point.Y=[int](42+($d.headerDiag.subagent.top+$d.headerDiag.subagent.bottom)/2)
 [void][HeaderCheck]::ClientToScreen($h,[ref]$point)
 AssertFocus
 [void][HeaderCheck]::SetCursorPos($point.X,$point.Y)
 [HeaderCheck]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
 [HeaderCheck]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 800
 & (Join-Path $repo 'scripts/capture-app-window.ps1') -Hwnd $h.ToInt64() -Out (Join-Path $PSScriptRoot 'live-subagent-menu.png')
 AssertFocus
 Key 27; Key 27 2
 & (Join-Path $repo 'Tools/node-v26.10.0/node.exe') (Join-Path $repo 'scripts/gates.mjs')
 if ($LASTEXITCODE -ne 0) { throw 'Live gates failed' }
} finally {
 if ($toggled -and [HeaderCheck]::GetForegroundWindow() -eq $h) { ToggleSidebar }
 [void][HeaderCheck]::SetCursorPos($cursor.X,$cursor.Y)
 if (-not $wasTopmost) { [void][HeaderCheck]::SetWindowPos($h,[IntPtr](-2),0,0,0,0,0x13) }
 [void][HeaderCheck]::SetWindowPlacement($h,[ref]$placement)
 if ($previous -ne [IntPtr]::Zero) { [void][HeaderCheck]::SetForegroundWindow($previous) }
}
