# verify-adaptive-matrix.ps1 -- L4 automation (2026-09-17).
# Runs scripts/verify-adaptive-layout.mjs across a window-size x zoom matrix and prints PASS/FAIL per cell.
# ASCII only on purpose: PowerShell 5.1 parses non-BOM UTF-8 as ANSI, so Chinese/comments would break.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-adaptive-matrix.ps1
#   ... -Widths 960,1200,1360,1920 -Zooms 100,130,150 -Height 900
#
# Requires: the read-only layout probe inside the local plugin dsh-ui-tweaks (reports every ~2.5s).
param(
  [int[]]$Widths = @(960, 1360, 1920),
  [int[]]$Zooms = @(100, 130),
  [int]$Height = 900,
  [string]$Repo = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public class MX{
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RR r);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
 [StructLayout(LayoutKind.Sequential)] public struct RR{public int L,T,Rt,B;}
}
"@ -ErrorAction SilentlyContinue

$node = Join-Path $Repo 'App\resources\node\node.exe'
$verify = Join-Path $Repo 'scripts\verify-adaptive-layout.mjs'
$app = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DSH Codex Desktop' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $app) { Write-Output 'DSH app window not found'; exit 2 }
$h = $app.MainWindowHandle
$orig = New-Object MX+RR
[void][MX]::GetWindowRect($h, [ref]$orig)

function Key-Ctrl([int]$vk) {
  [MX]::keybd_event(0x11, 0, 0, [IntPtr]::Zero)
  [MX]::keybd_event([byte]$vk, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [MX]::keybd_event([byte]$vk, 0, 2, [IntPtr]::Zero)
  [MX]::keybd_event(0x11, 0, 2, [IntPtr]::Zero)
}
function Set-Zoom([int]$pct) {
  [void][MX]::SetForegroundWindow($h)
  Key-Ctrl 0x30                      # Ctrl+0 reset to 100%
  Start-Sleep -Milliseconds 400
  $steps = [Math]::Round(($pct - 100) / 10)
  for ($i = 0; $i -lt [Math]::Abs($steps); $i++) { if ($steps -gt 0) { Key-Ctrl 0xBB } else { Key-Ctrl 0xBD } }
  Start-Sleep -Milliseconds 900
}
function Probe-Zoom {
  $p = Join-Path $Repo 'Data\DSH\profiles\web\local\dsh-ui-tweaks\lib\ui-probe.json'
  if (Test-Path $p) { $j = Get-Content $p -Raw | ConvertFrom-Json; return $j.appWidthVar }
  return ''
}

$rows = @()
foreach ($z in $Zooms) {
  Set-Zoom $z
  foreach ($w in $Widths) {
    [void][MX]::SetWindowPos($h, [IntPtr]::Zero, 120, 120, $w, $Height, 0x0004)
    Start-Sleep -Milliseconds 2600
    $out = & $node $verify 2>&1 | Out-String
    $code = $LASTEXITCODE
    $m = [regex]::Match($out, '\((\d+)/(\d+)\)')
    $ratio = if ($m.Success) { $m.Value } else { '?/?' }
    $rows += [pscustomobject]@{ Zoom = $z; Width = $w; Result = $(if ($code -eq 0) { 'PASS' } else { 'FAIL' }); Checks = $ratio }
  }
}
Set-Zoom 100
[void][MX]::SetWindowPos($h, [IntPtr]::Zero, $orig.L, $orig.T, ($orig.Rt - $orig.L), ($orig.B - $orig.T), 0x0004)

Write-Output ''
Write-Output 'Adaptive matrix (window size x zoom)'
$rows | Format-Table -AutoSize
$fail = ($rows | Where-Object { $_.Result -ne 'PASS' }).Count
$dir = Join-Path $Repo ('Data\artifacts\adaptive-matrix-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$rows | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $dir 'results.json') -Encoding utf8
Write-Output ("cells={0} fail={1}  evidence={2}" -f $rows.Count, $fail, $dir.Replace($Repo + '\', ''))
exit $(if ($fail -eq 0) { 0 } else { 1 })
