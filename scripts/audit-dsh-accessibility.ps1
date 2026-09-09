param(
  [ValidateSet('capture','invoke')][string]$Action='capture',
  [string]$Label='',
  [string]$Shot='01-dsh.png'
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DshAccessibleAudit {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$target=Get-Process -Id 41396
$hwnd=[IntPtr]38866396
$owner=[uint32]0
[void][DshAccessibleAudit]::GetWindowThreadProcessId($hwnd,[ref]$owner)
if($owner -ne $target.Id -or $target.Path -ne 'G:\DSH-3-Portable\Data\Updates\Desktop\slots\1.0.46-local-9ce60671cf7bd302\DSH Codex Desktop.exe') { throw 'DSH target changed' }
[void][DshAccessibleAudit]::SetThreadDpiAwarenessContext([IntPtr](-4))
if($Action -eq 'invoke') {
  # Navigation only: no install, update, delete, toggle, or restart controls.
  $allowed=@('扩展','设置','关闭','已安装管理','返回工作区','返回扩展列表','技能包','连接与集成','插件','加载更多','清除筛选','刷新目录','插件市场','OpenAI Codex','常规','界面','打开安装管理器')
  if($Label -notin $allowed -and $Label -notmatch '^查看详情：dsh[-a-zA-Z0-9._]+$') { throw 'Control outside read-only audit scope' }
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$Label)
  $matches=@($root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition) | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
  if($matches.Count -ne 1) { throw "Expected one visible enabled button: $Label; found $($matches.Count)" }
  $invoke=$matches[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
  Write-Output "INVOKED=$Label PID=$owner"
  exit
}
if($Shot -notmatch '^[a-zA-Z0-9_-]+\.png$') { throw 'Invalid screenshot name' }
$rect=New-Object DshAccessibleAudit+RECT
[void][DshAccessibleAudit]::GetWindowRect($hwnd,[ref]$rect)
$bitmap=[System.Drawing.Bitmap]::new($rect.Right-$rect.Left,$rect.Bottom-$rect.Top)
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
$dc=$graphics.GetHdc()
try { $captured=[DshAccessibleAudit]::PrintWindow($hwnd,$dc,2) } finally { $graphics.ReleaseHdc($dc) }
$directory='G:\DSH-3-Portable\artifacts\extension-split-20260905'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$destination=Join-Path $directory $Shot
try { if(-not $captured){throw 'Window capture failed'}; $bitmap.Save($destination,[System.Drawing.Imaging.ImageFormat]::Png) } finally { $graphics.Dispose(); $bitmap.Dispose() }
Write-Output "SCREENSHOT=$destination PID=$owner"
