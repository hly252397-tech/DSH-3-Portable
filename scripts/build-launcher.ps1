[CmdletBinding()]
param([switch]$SkipCompile)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$iconPath = Join-Path $root 'DSH便携版3.ico'
$previewPath = Join-Path $PSScriptRoot 'icon-preview.png'
$exePath = Join-Path $root 'DSH便携版3.exe'
$launcherSource = Join-Path $root 'launcher\Launcher.cs'
$sizes = 16, 24, 32, 48, 64, 128, 256

function New-RoundedRectPath {
  param([float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $Radius * 2
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $Width - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $Width - $d, $Y + $Height - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $Height - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconBitmap {
  param([int]$Size)
  $bmp = [System.Drawing.Bitmap]::new($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = $Size / 256.0

  # 背景：深蓝渐变圆角方块
  $bgPath = New-RoundedRectPath (8 * $s) (8 * $s) (240 * $s) (240 * $s) (52 * $s)
  $top = [System.Drawing.Color]::FromArgb(255, 11, 29, 60)
  $bottom = [System.Drawing.Color]::FromArgb(255, 26, 85, 140)
  $bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.PointF]::new(0, 0),
    [System.Drawing.PointF]::new(0, $Size),
    $top, $bottom)
  $g.FillPath($bgBrush, $bgPath)

  # 鲸鱼剪影（深蓝底上的亮青轮廓）：椭圆身体 + 圆头 + 叉形尾叶
  if ($Size -ge 32) {
    $whaleBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 127, 216, 255))
    $whalePath = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $whalePath.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding
    $whalePath.AddEllipse(66 * $s, 100 * $s, 128 * $s, 62 * $s)
    $whalePath.AddEllipse(172 * $s, 94 * $s, 52 * $s, 52 * $s)
    $whalePath.AddPolygon([System.Drawing.PointF[]]@(
      [System.Drawing.PointF]::new(62 * $s, 112 * $s),
      [System.Drawing.PointF]::new(12 * $s, 84 * $s),
      [System.Drawing.PointF]::new(30 * $s, 124 * $s)
    ))
    $whalePath.AddPolygon([System.Drawing.PointF[]]@(
      [System.Drawing.PointF]::new(62 * $s, 150 * $s),
      [System.Drawing.PointF]::new(12 * $s, 178 * $s),
      [System.Drawing.PointF]::new(30 * $s, 138 * $s)
    ))
    $g.FillPath($whaleBrush, $whalePath)
    if ($Size -ge 48) {
      $eyeBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 11, 29, 60))
      $g.FillEllipse($eyeBrush, 198 * $s, 106 * $s, 10 * $s, 10 * $s)
    }
  }

  # 粒子：半透明白/青圆点
  $particles = @(
    @(232, 52, 8, 200, 255, 255, 255),
    @(180, 210, 7, 180, 127, 216, 255),
    @(52, 60, 5, 150, 255, 255, 255),
    @(120, 218, 4, 160, 127, 216, 255),
    @(24, 214, 6, 140, 127, 216, 255),
    @(238, 190, 5, 150, 255, 255, 255)
  )
  foreach ($p in $particles) {
    $pb = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb([int]$p[3], [int]$p[4], [int]$p[5], [int]$p[6]))
    $r = [float]$p[2] * $s
    $g.FillEllipse($pb, [float]$p[0] * $s - $r, [float]$p[1] * $s - $r, $r * 2, $r * 2)
  }

  $g.Dispose()
  return $bmp
}

function New-IconFile {
  param([string]$Path)
  $pngs = @()
  foreach ($size in $sizes) {
    $bmp = New-IconBitmap $size
    $stream = New-Object System.IO.MemoryStream
    $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += , $stream.ToArray()
    $stream.Dispose()
    $bmp.Dispose()
  }
  $fs = [System.IO.File]::Create($Path)
  $writer = New-Object System.IO.BinaryWriter($fs)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$pngs.Count)
    $offset = 6 + 16 * $pngs.Count
    for ($i = 0; $i -lt $pngs.Count; $i++) {
      $size = $sizes[$i]
      $writer.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))
      $writer.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$pngs[$i].Length)
      $writer.Write([uint32]$offset)
      $offset += $pngs[$i].Length
    }
    foreach ($png in $pngs) { $writer.Write($png) }
  } finally {
    $writer.Close()
  }
  Write-Host "已生成图标：$Path"
}

if (Test-Path -LiteralPath $iconPath) {
  Write-Host "图标已存在，复用：$iconPath（如需重新绘制，删除该文件后重跑本脚本）"
} else {
  Write-Host '正在绘制鲸鱼粒子图标…'
  $preview = New-IconBitmap 256
  $preview.Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $preview.Dispose()
  Write-Host "预览：$previewPath"
  New-IconFile -Path $iconPath
}

if ($SkipCompile) { exit 0 }

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $launcherSource)) { throw "缺少启动器源码：$launcherSource" }

Write-Host '正在编译启动器…'
& $csc /nologo /target:winexe /optimize+ /win32icon:"$iconPath" /out:"$exePath" "$launcherSource" /r:System.Windows.Forms.dll /r:System.Drawing.dll
if ($LASTEXITCODE -ne 0) { throw '启动器编译失败。' }
Write-Host "已生成启动器：$exePath" -ForegroundColor Green
