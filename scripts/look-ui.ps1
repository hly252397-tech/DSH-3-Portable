# look-ui.ps1 — 自己看界面：抓「应用自己的窗口」，宽/窄各一张，然后恢复窗口原样
#
# 为什么要它：改完界面（样式/图标/排版）后，不要问用户"好不好看"——自己抓图看。
# 关键纪律：
#   1) 只抓**应用窗口的矩形**（绝不抓整屏）——避免抓到别的应用（曾抓到用户其它应用的登录框，隐私事故）
#   2) 先把窗口提到最前，再抓；其它窗口可能仍然遮挡，所以抓完自己核对内容对不对
#   3) 测窄档时自己改窗口宽度（SetWindowPos），**测完必须恢复原尺寸**
#   4) 抓完用 read_image 自己看图；像素量不出来就裁剪放大再量
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\look-ui.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\look-ui.ps1 -NarrowWidth 1100
# 产出：Data\Temp\ui-wide.png（原宽）与 Data\Temp\ui-narrow.png（窄档，若指定）
param(
  [int]$NarrowWidth = 0,
  [string]$OutDir = '',
  [string]$ProcessMatch = '*DSH*',
  [switch]$AllowFullScreen = $false
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public class LookUiWin{
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out R r);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int cx,int cy,uint flags);
 [StructLayout(LayoutKind.Sequential)] public struct R{public int L,T,Rt,B;}
}
"@ -ErrorAction SilentlyContinue

$repo = Split-Path -Parent $PSScriptRoot
if ($OutDir -eq '') { $OutDir = Join-Path $repo 'Data\Temp' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Get-WindowRect($handle) {
  $r = New-Object LookUiWin+R
  [void][LookUiWin]::GetWindowRect($handle, [ref]$r)
  return $r
}
function Save-WindowShot($handle, $r, $path) {
  $w = $r.Rt - $r.L
  $h = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ("$path ($w x $h)")
}

# 找窗口：只认「可见 + 有标题 + 不是占满全屏」的窗口，再按面积取最大。
# 为什么这么严：2026-09-16 实测 `Get-Process.MainWindowHandle` 会指向进程的**隐藏全屏窗口**，
# 抓它的矩形 = 抓整屏（会连用户其它应用一起抓进来，隐私事故）。所以必须过滤。
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;using System.Text;
public class LookUiEnum{
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
}
"@ -ErrorAction SilentlyContinue

function Get-WindowTitle($handle) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][LookUiEnum]::GetWindowTextW($handle, $sb, 512)
  return $sb.ToString()
}

$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$screenW = $screen.Bounds.Width
$screenH = $screen.Bounds.Height
$cands = @()
foreach ($p in (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) {
  if ($p.ProcessName -notlike $ProcessMatch) { continue }
  if (-not [LookUiEnum]::IsWindowVisible($p.MainWindowHandle)) { continue }
  $title = Get-WindowTitle $p.MainWindowHandle
  if ($title -eq '') { continue }
  $r = Get-WindowRect $p.MainWindowHandle
  $w = ($r.Rt - $r.L); $h = ($r.B - $r.T)
  if ($w -le 200 -or $h -le 200) { continue }
  # 占满整屏的窗口一律当成隐藏/覆盖层排除（真要抓最大化窗口时用 -AllowFullScreen 显式放行）
  if (-not $AllowFullScreen -and $w -ge ($screenW - 4) -and $h -ge ($screenH - 60)) { continue }
  $cands += [pscustomobject]@{
    P = $p; Handle = $p.MainWindowHandle; Rect = $r; Title = $title
    W = $w; H = $h; Area = ($w * $h)
  }
}
if ($cands.Count -gt 1) {
  Write-Output "候选窗口："
  $cands | Sort-Object Area -Descending | ForEach-Object { Write-Output ("  {0} [{1}] {2}x{3} @({4},{5}) «{6}»" -f $_.P.ProcessName, $_.P.Id, $_.W, $_.H, $_.Rect.L, $_.Rect.T, $_.Title) }
}
$target = $cands | Sort-Object Area -Descending | Select-Object -First 1
if (-not $target) { Write-Output "未找到匹配 '$ProcessMatch' 的可见应用窗口"; exit 2 }

[void][LookUiWin]::ShowWindow($target.Handle, 9)
[void][LookUiWin]::SetForegroundWindow($target.Handle)
# 临时置顶：SetForegroundWindow 挡不住别的窗口压在上面（2026-09-16 实测抓到自己的浏览器窗口），
# 所以抓图期间把目标窗口抬到 TOPMOST，抓完立刻 NOTOPMOST 还原（不改变用户窗口层级习惯）。
$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOMOVE_NOSIZE_SHOW = 0x0053
[void][LookUiWin]::SetWindowPos($target.Handle, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVE_NOSIZE_SHOW)
Start-Sleep -Milliseconds 900

$orig = $target.Rect
Write-Output ("目标窗口: {0} [{1}] {2}x{3} @({4},{5}) «{6}»" -f $target.P.ProcessName, $target.P.Id, $target.W, $target.H, $orig.L, $orig.T, $target.Title)
Write-Output ("已保存: " + (Save-WindowShot $target.Handle $orig (Join-Path $OutDir 'ui-wide.png')))

if ($NarrowWidth -gt 0) {
  # 只改宽度、不动位置；SWP_NOZORDER=0x0004
  [void][LookUiWin]::SetWindowPos($target.Handle, [IntPtr]::Zero, $orig.L, $orig.T, $NarrowWidth, $target.H, 0x0004)
  Start-Sleep -Milliseconds 1200
  $r2 = Get-WindowRect $target.Handle
  Write-Output ("已保存: " + (Save-WindowShot $target.Handle $r2 (Join-Path $OutDir 'ui-narrow.png')))
  # 恢复原样（尺寸）
  [void][LookUiWin]::SetWindowPos($target.Handle, [IntPtr]::Zero, $orig.L, $orig.T, $target.W, $target.H, 0x0004)
  Start-Sleep -Milliseconds 600
  $r3 = Get-WindowRect $target.Handle
  Write-Output ("窗口已恢复: {0}x{1}" -f ($r3.Rt - $r3.L), ($r3.B - $r3.T))
}
# 取消置顶（无论上面是否失败都要走到）
[void][LookUiWin]::SetWindowPos($target.Handle, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOMOVE_NOSIZE_SHOW)
exit 0
