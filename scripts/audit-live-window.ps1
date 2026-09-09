param(
  [int]$TargetProcessId = 41396,
  [long]$WindowHandle = 38866396,
  [ValidateSet('capture','click','type','reload-plugins')][string]$Action = 'capture',
  [string]$Text = '',
  [int]$X = -1,
  [int]$Y = -1,
  [string]$Shot = '01-start.png'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LiveAuditNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$target = Get-Process -Id $TargetProcessId
if ($target.ProcessName -ne 'DSH Codex Desktop' -or $target.MainWindowHandle -eq 0) { throw 'Expected visible DSH window' }
$hwnd = [IntPtr]$WindowHandle
$windowPid = [uint32]0
[void][LiveAuditNative]::GetWindowThreadProcessId($hwnd,[ref]$windowPid)
if($windowPid -ne $TargetProcessId){
  $dialogOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$windowPid"
  $dialogElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if($dialogOwner.ParentProcessId -ne $TargetProcessId -or
     $dialogOwner.ExecutablePath -ne $target.Path -or
     $dialogElement.Current.ClassName -ne '#32770'){
    throw 'Window owner mismatch: expected a verified DSH child-process dialog'
  }
}
[void][LiveAuditNative]::SetThreadDpiAwarenessContext([IntPtr](-4))
[void][LiveAuditNative]::SetForegroundWindow($hwnd)
if ([LiveAuditNative]::GetForegroundWindow() -ne $hwnd) { throw 'DSH is not foreground; refusing click/capture' }
if($Action -eq 'reload-plugins') {
  if($windowPid -ne $TargetProcessId){throw 'Reload is only allowed on the main DSH window'}
  $pendingPath='G:\DSH-3-Portable\Data\DSH\profiles\web\.dsh-pending-updates.json'
  if(Test-Path -LiteralPath $pendingPath){throw 'Pending profile updates require separate review before reload'}
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait('^r')
  Write-Output "REQUESTED_PLUGIN_RELOAD PID=$TargetProcessId"
  exit
}
if($Action -eq 'type') {
  if($Text -notmatch '^[a-zA-Z0-9 -]{1,80}$'){throw 'Only plain audit search text allowed'}
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait($Text)
  Write-Output "TYPED_SEARCH PID=$TargetProcessId"
  exit
}
$rect = New-Object LiveAuditNative+RECT
[void][LiveAuditNative]::GetWindowRect($hwnd,[ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if($Action -eq 'click') {
  if($X -lt 0 -or $Y -lt 0 -or $X -ge $width -or $Y -ge $height){throw 'Click outside verified window'}
  [void][LiveAuditNative]::SetCursorPos($rect.Left + $X,$rect.Top + $Y)
  [LiveAuditNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [LiveAuditNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  Write-Output "CLICK=$X,$Y PID=$TargetProcessId"
  exit
}
if($Shot -notmatch '^[a-zA-Z0-9_-]+\.png$'){throw 'Invalid screenshot name'}
$auditDir = 'G:\DSH-3-Portable\artifacts\live-entry-audit-20260905'
New-Item -ItemType Directory -Path $auditDir -Force | Out-Null
$destination = Join-Path $auditDir $Shot
$bitmap = [System.Drawing.Bitmap]::new($width,$height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,[System.Drawing.Size]::new($width,$height))
  $bitmap.Save($destination,[System.Drawing.Imaging.ImageFormat]::Png)
} finally { $graphics.Dispose(); $bitmap.Dispose() }
Write-Output "SCREENSHOT=$destination WIDTH=$width HEIGHT=$height PID=$TargetProcessId"
