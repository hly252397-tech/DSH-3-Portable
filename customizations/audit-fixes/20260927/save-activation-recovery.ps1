param([string]$BackupName='pre-08792d6114f916b8-20260927')
$ErrorActionPreference='Stop'
if ($BackupName -notmatch '^pre-[a-z0-9-]+$') { throw 'Invalid recovery directory name' }
$repo='G:\DSH-3-Portable'
$dshHome="$repo\Data\DSH-generations\v4-rc2b\home"
$out="$repo\Data\Updates\Backups\$BackupName"
if (Test-Path -LiteralPath $out) { throw 'Recovery point already exists; refusing overwrite' }
$running=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$repo\Data\Updates\Desktop\slots\*" }
if ($running) { throw 'Desktop or owned backend still running; snapshot cancelled' }
New-Item -ItemType Directory -Path $out | Out-Null
$roots=@('profiles/web','sessions','storages','plugin-data','workbench','mcp-bridges')
$roots+=@(Get-ChildItem -LiteralPath $dshHome -File -Force | Select-Object -ExpandProperty Name)
$tarArgs=@('-czf',"$out\profile-state.tgz",'--exclude=profiles/web/node_modules.broken-*','-C',$dshHome)+$roots
& tar.exe @tarArgs
if ($LASTEXITCODE -ne 0) { throw 'Recovery archive failed' }
& tar.exe -tf "$out\profile-state.tgz" > "$out\archive-index.txt"
if ($LASTEXITCODE -ne 0) { throw 'Recovery archive readback failed' }
$index=Get-Content -LiteralPath "$out\archive-index.txt"
foreach ($required in @('profiles/web/package.json','profiles/web/pnpm-lock.yaml','profiles/web/cordis.yml')) {
 if ($index -notcontains $required) { throw "Archive missing $required" }
}
Copy-Item -LiteralPath "$repo\Data\Updates\Desktop\pointer.json" -Destination "$out\desktop-pointer.json"
Copy-Item -LiteralPath "$repo\Data\Updates\Desktop\state.json" -Destination "$out\desktop-state.json"
$electron="$repo\Data\Electron\UserData"
New-Item -ItemType Directory -Path "$out\electron-config" | Out-Null
Get-ChildItem -LiteralPath $electron -File -Filter '*.json' | Copy-Item -Destination "$out\electron-config"
$links=@(Get-ChildItem -LiteralPath "$dshHome\profiles\web\node_modules" -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object Name,LinkTarget)
$manifest=[ordered]@{savedAt=(Get-Date).ToString('o');activeHome=$dshHome;archiveSha256=(Get-FileHash -LiteralPath "$out\profile-state.tgz").Hash;archiveBytes=(Get-Item -LiteralPath "$out\profile-state.tgz").Length;entries=$index.Count;roots=$roots;moduleLinks=$links;excluded=@('historical broken node_modules','attachments','cache','indexes');note='Offline recovery point, contains private configuration: keep local. Restore Profile links to original home, not backup path. Desktop pointer is evidence, use normal rollback workflow.'}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$out\manifest.json" -Encoding UTF8
Write-Output "Recovery point verified: $out; entries=$($index.Count); bytes=$($manifest.archiveBytes); SHA256=$($manifest.archiveSha256)"
