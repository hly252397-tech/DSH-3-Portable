# verify-panel-drag.ps1 -- assert "the right panel can be dragged" (2026-09-17, v6, full rewrite).
# ASCII only: PowerShell 5.1 reads non-BOM UTF-8 as ANSI, so non-ASCII would break parsing.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-panel-drag.ps1 -Delta 120
#
# v6 vs v5:
#   * calibration baseline = the RESIZE HANDLE's own reported rect (probe nArs4W_panelResize),
#     not a guessed panel-left mapping (v5 was ~12px off and could never hit the 8px handle);
#   * window restored first (a minimized window rect is 160x28 and every size filter skips it);
#   * offsets widened to +-20px; restore step re-calibrates too.
param(
  [int]$Delta = 120,
  [int]$Tolerance = 24,
  [int]$SettleMs = 3500,
  [string]$Repo = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System;using System.Text;using System.Runtime.InteropServices;
public class PDV{
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RR r);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int cx,int cy,uint f);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [StructLayout(LayoutKind.Sequential)] public struct RR{public int L,T,Rt,B;}
}
"@ -ErrorAction SilentlyContinue

$probePath = Join-Path $Repo 'Data\DSH\profiles\web\local\dsh-ui-tweaks\lib\ui-probe.json'
function Probe {
  if (-not (Test-Path $probePath)) { return $null }
  $j = Get-Content $probePath -Raw | ConvertFrom-Json
  $band = ($j.bands | Where-Object { $_ -match 'nArs4W_panelBody' } | Select-Object -First 1)
  $m = [regex]::Match([string]$band, '\[(\d+)\.\.')
  $panel = if ($m.Success) { [int]$m.Groups[1].Value } else { -1 }
  $hb = ($j.bands | Where-Object { $_ -match 'nArs4W_panelResize' } | Select-Object -First 1)
  $hm = [regex]::Match([string]$hb, '\[(\d+)\.\.(\d+)\]')
  $handleMid = if ($hm.Success) { [int](([int]$hm.Groups[1].Value + [int]$hm.Groups[2].Value) / 2) } else { -1 }
  $target = ''
  if ($j.pointer) { $target = [string]$j.pointer.target }
  return [pscustomobject]@{ panel = $panel; vw = [int]$j.vw; handleMid = $handleMid; target = $target }
}

foreach ($pw in (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DSH*' -and $_.MainWindowHandle -ne 0 })) {
  [void][PDV]::ShowWindow($pw.MainWindowHandle, 9)
}
Start-Sleep -Milliseconds 1500

$cands = @()
foreach ($p in (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) {
  if ($p.ProcessName -notlike '*DSH*') { continue }
  if (-not [PDV]::IsWindowVisible($p.MainWindowHandle)) { continue }
  $sb = New-Object System.Text.StringBuilder 512
  [void][PDV]::GetWindowTextW($p.MainWindowHandle, $sb, 512)
  if ($sb.ToString().Trim() -eq '') { continue }
  $rr0 = New-Object PDV+RR
  [void][PDV]::GetWindowRect($p.MainWindowHandle, [ref]$rr0)
  $w0 = $rr0.Rt - $rr0.L; $h0 = $rr0.B - $rr0.T
  if ($w0 -le 400 -or $h0 -le 300) { continue }
  $cands += [pscustomobject]@{ Handle = $p.MainWindowHandle; Area = ($w0 * $h0); W = $w0; H = $h0 }
}
$pick = $cands | Sort-Object Area -Descending | Select-Object -First 1
if (-not $pick) { Write-Output 'DSH app window not found'; exit 2 }
$h = $pick.Handle
Write-Output ('window: {0}x{1} hwnd={2}' -f $pick.W, $pick.H, $h)

$TOP = [IntPtr](-1); $NOTOP = [IntPtr](-2); $SWP = 0x0053
[void][PDV]::SetWindowPos($h, $TOP, 0, 0, 0, 0, $SWP)
Start-Sleep -Milliseconds 900
$r = New-Object PDV+RR
[void][PDV]::GetWindowRect($h, [ref]$r)
$winW = $r.Rt - $r.L
$screenY = $r.T + [int](($r.B - $r.T) / 2)

$p1 = Probe; Start-Sleep -Milliseconds 3000; $p2 = Probe
if ($p1 -eq $null -or $p2 -eq $null -or [Math]::Abs($p2.panel - $p1.panel) -gt 2) {
  [void][PDV]::SetWindowPos($h, $NOTOP, 0, 0, 0, 0, $SWP)
  Write-Output ('seam not settled: {0} -> {1}' -f $p1.panel, $p2.panel); exit 2
}
$before = $p2.panel
$scale = $winW / [double]$p1.vw
$baseX = if ($p2.handleMid -gt 0) { $p2.handleMid } else { $before }
Write-Output ('before: panelLeft={0} handleMid={1} viewport={2}css window={3}px scale={4:N3}' -f $before, $p2.handleMid, $p1.vw, $winW, $scale)

function Press ([int]$x, [int]$y) {
  [void][PDV]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 220
  [PDV]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
}
function Release { [PDV]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero) }
$script:lastX = 0
function MoveTo ([int]$x, [int]$y) {
  # 必须用**相对输入移动**：SetCursorPos 产生的 pointermove 其 movementX 恒为 0，
  # 而插件是按 movementX 累加面板宽度（2026-09-17 实测：62 次带键 move 却零位移的根因）。
  $dx = $x - $script:lastX
  if ($dx -ne 0) { [PDV]::mouse_event(0x0001, [uint32]([int]$dx), 0, 0, [IntPtr]::Zero) }
  $script:lastX = $x
  Start-Sleep -Milliseconds 35
}

function Calibrate ([int]$base, [int]$yy) {
  $offs = @(0, -4, 4, -8, 8, -12, 12, -16, 16, -20, 20)
  foreach ($off in $offs) {
    $tryX = $r.L + [int]($base * $scale) + $off
    Press $tryX $yy
    Start-Sleep -Milliseconds 2800
    $seen = Probe
    if ($seen -ne $null -and $seen.target -match 'panelResize') {
      Write-Host ('calibrated: offset {0}px target={1}' -f $off, $seen.target)
      return $tryX
    }
    Release; Start-Sleep -Milliseconds 250
  }
  return -1
}

$pressX = Calibrate $baseX $screenY
if ($pressX -lt 0) {
  [void][PDV]::SetWindowPos($h, $NOTOP, 0, 0, 0, 0, $SWP)
  Write-Output 'calibration failed: press never landed on .nArs4W_panelResize'
  exit 3
}
$shift = [int]($Delta * $scale)
$script:lastX = $pressX
for ($i = 1; $i -le 24; $i++) { MoveTo ($pressX - [int]($shift * $i / 24)) $screenY }
Start-Sleep -Milliseconds 250
Release
Start-Sleep -Milliseconds $SettleMs
$after = Probe
$moved = $before - $after.panel
$ok = [Math]::Abs($moved - $Delta) -le $Tolerance

$r2 = New-Object PDV+RR
[void][PDV]::GetWindowRect($h, [ref]$r2)
$base2 = if ($after.handleMid -gt 0) { $after.handleMid } else { $after.panel }
$backX = Calibrate $base2 $screenY
if ($backX -ge 0) {
  for ($i = 1; $i -le 24; $i++) { MoveTo ($backX + [int]($shift * $i / 24)) $screenY }
  Start-Sleep -Milliseconds 250
  Release
}
Start-Sleep -Milliseconds 1500
$restored = Probe
[void][PDV]::SetWindowPos($h, $NOTOP, 0, 0, 0, 0, $SWP)

$dir = Join-Path $Repo ('Data\artifacts\panel-drag-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$res = [pscustomobject]@{
  status = $(if ($ok) { 'pass' } else { 'fail' })
  method = 'probe + restore-window + TOPMOST + handle-rect calibration + calibrated restore'
  panelBefore = $before
  panelAfter = $after.panel
  moved = $moved
  expected = $Delta
  tolerance = $Tolerance
  restoredPanelLeft = $restored.panel
}
$res | ConvertTo-Json | Set-Content -Path (Join-Path $dir 'results.json') -Encoding utf8
Write-Output ''
Write-Output ('panel drag  ' + $(if ($ok) { 'PASS' } else { 'FAIL' }))
$res | Format-List
Write-Output ('evidence: ' + $dir.Replace($Repo + '\', ''))
exit $(if ($ok) { 0 } else { 1 })
