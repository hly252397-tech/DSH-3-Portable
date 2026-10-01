# Capture the DSH window's OWN content, regardless of which window is on top.
# CopyFromScreen grabs whatever is physically on screen (could be another app -> privacy risk),
# so we use PrintWindow with PW_RENDERFULLCONTENT (2), which Chromium/Electron supports.
# ASCII-only on purpose (PowerShell 5.1 ANSI pitfall).
param(
  [string]$Out = 'G:\DSH-3-Portable\Data\Temp\ui-print.png',
  [long]$Hwnd = 0,
  [int]$CropX = -1,
  [int]$CropY = -1,
  [int]$CropW = 1400,
  [int]$CropH = 70,
  [int]$Scale = 1
)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinPrintDSH {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$p = if ($Hwnd -ne 0) { $null } else { Get-Process | Where-Object { $_.ProcessName -like '*DSH*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }
if ($Hwnd -eq 0 -and -not $p) { Write-Output 'no DSH window'; exit 1 }
$target = if ($Hwnd -ne 0) { [IntPtr]$Hwnd } else { $p.MainWindowHandle }
$r = New-Object WinPrintDSH+RECT
[void][WinPrintDSH]::GetWindowRect($target, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [WinPrintDSH]::PrintWindow($target, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if ($Scale -gt 1) {
  $big = New-Object System.Drawing.Bitmap(($w * $Scale), ($h * $Scale))
  $gb = [System.Drawing.Graphics]::FromImage($big)
  $gb.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $gb.DrawImage($bmp, 0, 0, ($w * $Scale), ($h * $Scale))
  $gb.Dispose()
  $bmp.Dispose()
  $bmp = $big
  $w = $w * $Scale
  $h = $h * $Scale
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
if ($CropX -ge 0 -and $CropY -ge 0) {
  $cw = [Math]::Min($CropW * $Scale, $w)
  $ch = [Math]::Min($CropH * $Scale, $h)
  $crop = New-Object System.Drawing.Bitmap($cw, $ch)
  $gc = [System.Drawing.Graphics]::FromImage($crop)
  $gc.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), (New-Object System.Drawing.Rectangle(($CropX * $Scale), ($CropY * $Scale), $cw, $ch)), [System.Drawing.GraphicsUnit]::Pixel)
  $gc.Dispose()
  $cropPath = [System.IO.Path]::ChangeExtension($Out, $null) + '-crop.png'
  $crop.Save($cropPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $crop.Dispose()
  Write-Output "saved $cropPath $($cw)x$($ch)"
}
$bmp.Dispose()
Write-Output "printwindow=$ok saved=$Out ${w}x${h}"
