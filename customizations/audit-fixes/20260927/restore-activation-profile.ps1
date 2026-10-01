param([string]$BackupName='pre-08792d6114f916b8-20260927')
$ErrorActionPreference='Stop'
if ($BackupName -notmatch '^pre-[a-z0-9-]+$') { throw 'Invalid backup name' }
$repo='G:\DSH-3-Portable'
$profile="$repo\Data\DSH-generations\v4-rc2b\home\profiles\web"
$backup="$repo\Data\Updates\Backups\$BackupName"
$failed="$backup\failed-profile"
function Assert-Contained([string]$path) {
 $absolute=[IO.Path]::GetFullPath($path)
 if (-not $absolute.StartsWith($repo+'\',[StringComparison]::OrdinalIgnoreCase)) { throw "Out of workspace: $absolute" }
 return $absolute
}
foreach($path in @($profile,$backup,$failed)) { [void](Assert-Contained $path) }
if (Test-Path -LiteralPath $failed) { throw 'Existing failure snapshot; refusing overwrite' }
if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$repo\Data\Updates\Desktop\slots\*" }) { throw 'Desktop must be stopped' }
$manifest=Get-Content -LiteralPath "$backup\manifest.json" -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath "$backup\profile-state.tgz").Hash -ne $manifest.archiveSha256) { throw 'Archive checksum mismatch' }
$links=@($manifest.moduleLinks | ForEach-Object { [pscustomobject]@{Relative=('node_modules\'+$_.Name);Target=$_.LinkTarget} })
# The local source tree was not modified by failed seeding; preserve its nested links.
$links+=@(Get-ChildItem -LiteralPath "$profile\local" -Recurse -Force -Attributes ReparsePoint | ForEach-Object { [pscustomobject]@{Relative=$_.FullName.Substring($profile.Length+1);Target=$_.LinkTarget} })
$links | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$backup\restore-links.json" -Encoding UTF8
Move-Item -LiteralPath $profile -Destination $failed
& tar.exe -xf "$backup\profile-state.tgz" -C "$repo\Data\DSH-generations\v4-rc2b\home" profiles/web
if ($LASTEXITCODE -ne 0) { throw 'Profile extraction failed; original retained in failed-profile' }
New-Item -ItemType Directory -Path "$backup\materialized-links" | Out-Null
$number=0
foreach($link in $links) {
 $path=Assert-Contained (Join-Path $profile $link.Relative)
 $target=Assert-Contained ([string]$link.Target)
 $saved=Assert-Contained "$backup\materialized-links\$number"
 if (Test-Path -LiteralPath $path) { Move-Item -LiteralPath $path -Destination $saved }
 New-Item -ItemType Junction -Path $path -Target $target | Out-Null
 $number++
}
foreach($name in @('package.json','pnpm-lock.yaml','cordis.yml')) {
 if ((Get-FileHash -LiteralPath "$profile\$name").Hash -ne (Get-FileHash -LiteralPath "$backup\readback\profiles\web\$name").Hash) { throw "Restored file differs: $name" }
}
Write-Output "Original Profile restored; $number junctions restored; failed Profile retained at $failed. Conversations untouched."
