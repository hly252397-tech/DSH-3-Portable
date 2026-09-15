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
  [string]$ProcessMatch = '*DSH*'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
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

# 找窗口：按面积取最大的匹配进程窗口（避免抓到托盘/提示小窗）
$cands = @()
foreach ($p in (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) {
  if ($p.ProcessName -notlike $ProcessMatch) { continue }
  $r = Get-WindowRect $p.MainWindowHandle
  $cands += [pscustomobject]@{
    P = $p; Handle = $p.MainWindowHandle; Rect = $r
    W = ($r.Rt - $r.L); H = ($r.B - $r.T); Area = (($r.Rt - $r.L) * ($r.B - $r.T))
  }
}
$target = $cands | Sort-Object Area -Descending | Select-Object -First 1
if (-not $target) { Write-Output "未找到匹配 '$ProcessMatch' 的应用窗口"; exit 2 }

[void][LookUiWin]::ShowWindow($target.Handle, 9)
[void][LookUiWin]::SetForegroundWindow($target.Handle)
Start-Sleep -Milliseconds 900

$orig = $target.Rect
Write-Output ("目标窗口: {0} [{1}] {2}x{3} @({4},{5})" -f $target.P.ProcessName, $target.P.Id, $target.W, $target.H, $orig.L, $orig.T)
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
exit 0
