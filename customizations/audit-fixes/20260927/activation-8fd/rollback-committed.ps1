# One-shot recovery for the UI-rejected 8fd activation. Does not alter slot binaries.
$ErrorActionPreference='Stop'
$portableRoot='G:\DSH-3-Portable'
$desktopUpdateRoot=Join-Path $portableRoot 'Data\Updates\Desktop'
$pointerPath=Join-Path $desktopUpdateRoot 'pointer.json'
$backup=Join-Path $portableRoot 'Data\Updates\Backups\pre-8fd3c40ad480a1fd-20260927'
$evidence=$PSScriptRoot
# Reuse the launcher validation and atomic writer without executing its startup body.
$tokens=$null; $parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $portableRoot 'Start-DSH-Portable.ps1'),[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'Launcher parse errors' }
foreach($name in @('Save-JsonAtomic','Get-Sha256Hex','Resolve-SlotApplication','Write-LauncherLog')) {
 $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
 if (-not $definition) { throw "Missing launcher function $name" }
 . ([scriptblock]::Create($definition.Extent.Text))
}
$hash=[Security.Cryptography.SHA256]::Create()
try { $key=-join($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($portableRoot)) | ForEach-Object {$_.ToString('x2')}) } finally {$hash.Dispose()}
$mutex=New-Object Threading.Mutex($false,('Local\DSH-Portable-Launcher-'+$key.Substring(0,16)))
$owned=$false
try {
 try {$owned=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$owned=$true}
 if (-not $owned) {throw 'Launcher active; recovery refused'}
 $running=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$desktopUpdateRoot\slots\*" -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*DSH-3-Portable*resources/bootstrap.mjs*') })
 if ($running.Count) {throw 'Desktop/backend must be stopped before recovery'}
 $pointer=Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
 $before=Get-Content -LiteralPath "$backup\desktop-pointer.json" -Raw | ConvertFrom-Json
 if ($pointer.pending -or $pointer.current.relativePath -ne 'Data/Updates/Desktop/slots/1.0.76-local-8fd3c40ad480a1fd' -or $pointer.previous.relativePath -ne $before.current.relativePath -or $pointer.previous.sha256 -ne $before.current.sha256) {throw 'Pointer changed; refusing recovery'}
 if (-not (Resolve-SlotApplication -Reference $before.current)) {throw 'Previous slot integrity failed'}
 if (Test-Path -LiteralPath "$evidence\committed-pointer.json") {throw 'Already attempted; preserve existing evidence'}
 Copy-Item -LiteralPath $pointerPath -Destination "$evidence\committed-pointer.json"
 Copy-Item -LiteralPath "$desktopUpdateRoot\state.json" -Destination "$evidence\committed-state.json"
 $readback="$backup\readback"
 if (Test-Path -LiteralPath $readback) {throw 'Readback exists; review before retry'}
 New-Item -ItemType Directory -Path $readback | Out-Null
 & tar.exe -xf "$backup\profile-state.tgz" -C $readback profiles/web/package.json profiles/web/pnpm-lock.yaml profiles/web/cordis.yml
 if ($LASTEXITCODE -ne 0) {throw 'Readback extraction failed'}
 & "$portableRoot\customizations\audit-fixes\20260927\restore-activation-profile.ps1" -BackupName 'pre-8fd3c40ad480a1fd-20260927'
 $latest=Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
 if ($latest.current.sha256 -ne $pointer.current.sha256 -or $latest.pending) {throw 'Concurrent pointer change; refusing overwrite'}
 $now=(Get-Date).ToUniversalTime().ToString('o')
 Save-JsonAtomic -Path $pointerPath -Value ([ordered]@{schema=1;current=$before.current;previous=$pointer.current;updatedAt=$now})
 Save-JsonAtomic -Path "$desktopUpdateRoot\state.json" -Value ([ordered]@{schema=1;phase='rolled-back';currentVersion=$before.current.version;updatedAt=$now;overallProgress=100;stageProgress=100;detail='8fd 实机验收失败：Codex UI 1.1.20 依赖兼容门禁拒绝加载。已恢复重启前 Profile 与上一程序槽。';errorCode='UI_ACCEPTANCE_FAILED'})
 Write-Output 'Rollback complete: current=9ea0; previous=8fd retained; sessions untouched. Restart and real acceptance still required.'
} finally {if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()}
