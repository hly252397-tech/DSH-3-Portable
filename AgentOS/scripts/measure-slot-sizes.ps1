# measure-slot-sizes.ps1 -- ASCII-only.
# Measure every runtime/desktop slot size with `cmd /c dir /s /-c` (native, fastest reliable path on this drive).
# Writes JSON to the given -Out path. Read-only w.r.t. the slots (dir /s does not modify).
param(
  [string]$Out = 'G:\DSH-3-Portable\Data\Temp\slot-sizes.json'
)
$ErrorActionPreference = 'Continue'
$portable = 'G:\DSH-3-Portable'
$targets = @(
  @{ kind = 'harness'; dir = Join-Path $portable 'Data\Runtime\Harness\slots' },
  @{ kind = 'desktop'; dir = Join-Path $portable 'Data\Updates\Desktop\slots' }
)

function Measure-Slot([string]$path) {
  $res = [ordered]@{ path = $path; bytes = $null; files = $null; dirs = $null; ok = $false; error = $null; elapsed_ms = $null }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $raw = & cmd.exe /c ('dir /s /-c "' + $path + '"') 2>$null
    foreach ($line in $raw) {
      if ($line -match '^\s*(\d+)\s+File\(s\)\s+(\d+)\s+bytes') {
        $res.files = [int64]$matches[1]
        $res.bytes = [int64]$matches[2]
      } elseif ($line -match '^\s*(\d+)\s+Dir\(s\)') {
        $res.dirs = [int64]$matches[1]
      }
    }
    $res.ok = ($null -ne $res.bytes)
    if (-not $res.ok) { $res.error = 'could not parse dir output' }
  } catch {
    $res.error = $_.Exception.Message
  }
  $sw.Stop()
  $res.elapsed_ms = $sw.ElapsedMilliseconds
  return [pscustomobject]$res
}

$rows = @()
foreach ($t in $targets) {
  if (-not (Test-Path $t.dir)) { continue }
  foreach ($d in (Get-ChildItem $t.dir -Directory | Sort-Object Name)) {
    $m = Measure-Slot $d.FullName
    $m | Add-Member -NotePropertyName kind -NotePropertyValue $t.kind -Force
    $m | Add-Member -NotePropertyName name -NotePropertyValue $d.Name -Force
    $rows += $m
    Write-Output ("measured {0}/{1} bytes={2} files={3} ms={4}" -f $t.kind, $d.Name, $m.bytes, $m.files, $m.elapsed_ms)
  }
}

$obj = [ordered]@{ measured_at = (Get-Date).ToString('o'); portable_root = $portable; slots = $rows }
$json = $obj | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("WROTE " + $Out)
