param(
  [int]$TargetProcessId = 35028,
  [ValidateSet('capture','click')][string]$Action = 'capture',
  [int]$X = -1,
  [int]$Y = -1,
  [string]$Shot = '01-start.png'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class QoderAuditNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int mode);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$target = Get-Process -Id $TargetProcessId
if ($target.ProcessName -ne 'Qoder' -or $target.MainWindowHandle -eq 0 -or
    $target.Path -ne 'C:\Users\96551\AppData\Local\Programs\Qoder\Qoder.exe') {
  throw 'Expected the verified local Qoder main window'
}
$hwnd = $target.MainWindowHandle
$owner = [uint32]0
[void][QoderAuditNative]::GetWindowThreadProcessId($hwnd,[ref]$owner)
if ($owner -ne $TargetProcessId) { throw 'Qoder window owner mismatch' }
[void][QoderAuditNative]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ([QoderAuditNative]::IsIconic($hwnd)) { [void][QoderAuditNative]::ShowWindow($hwnd,9) }
[void][QoderAuditNative]::SetForegroundWindow($hwnd)
if ([QoderAuditNative]::GetForegroundWindow() -ne $hwnd) { throw 'Qoder not foreground; refusing action' }
$rect = New-Object QoderAuditNative+RECT
[void][QoderAuditNative]::GetWindowRect($hwnd,[ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($Action -eq 'click') {
  if ($X -lt 0 -or $Y -lt 0 -or $X -ge $width -or $Y -ge $height) { throw 'Click outside Qoder window' }
  [void][QoderAuditNative]::SetCursorPos($rect.Left+$X,$rect.Top+$Y)
  [QoderAuditNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [QoderAuditNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  Write-Output "CLICK=$X,$Y PID=$TargetProcessId"
  exit
}
if ($Shot -notmatch '^[a-zA-Z0-9_-]+\.png$') { throw 'Invalid screenshot name' }
$auditDir = 'G:\DSH-3-Portable\artifacts\qoder-reference-20260905'
New-Item -ItemType Directory -Path $auditDir -Force | Out-Null
$destination = Join-Path $auditDir $Shot
$bitmap = [System.Drawing.Bitmap]::new($width,$height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,[System.Drawing.Size]::new($width,$height))
  $bitmap.Save($destination,[System.Drawing.Imaging.ImageFormat]::Png)
} finally { $graphics.Dispose(); $bitmap.Dispose() }
Write-Output "SCREENSHOT=$destination WIDTH=$width HEIGHT=$height PID=$TargetProcessId"
