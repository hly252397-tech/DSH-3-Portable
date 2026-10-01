$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskRoot = 'G:\DSH-3-Portable'
$taskVersion = 'v26.10.0'
$taskBase = 'https://nodejs.org/dist/' + $taskVersion
$taskSums = (Invoke-WebRequest ($taskBase + '/SHASUMS256.txt')).Content
if ($taskSums -is [byte[]]) { $taskSums = [Text.Encoding]::UTF8.GetString($taskSums) }
$taskTargets = @(
    @{ Target='win32-x64'; File='win-x64/node.exe'; Directory='Tools/node-v26.10.0'; Member=$null },
    @{ Target='darwin-arm64'; File='node-v26.10.0-darwin-arm64.tar.gz'; Directory='Tools/audit-upgrade-20260927/node-darwin-arm64'; Member='node-v26.10.0-darwin-arm64/bin/node' },
    @{ Target='darwin-x64'; File='node-v26.10.0-darwin-x64.tar.gz'; Directory='Tools/audit-upgrade-20260927/node-darwin-x64'; Member='node-v26.10.0-darwin-x64/bin/node' },
    @{ Target='linux-arm64'; File='node-v26.10.0-linux-arm64.tar.xz'; Directory='Tools/audit-upgrade-20260927/node-linux-arm64'; Member='node-v26.10.0-linux-arm64/bin/node' },
    @{ Target='linux-x64'; File='node-v26.10.0-linux-x64.tar.xz'; Directory='Tools/audit-upgrade-20260927/node-linux-x64'; Member='node-v26.10.0-linux-x64/bin/node' }
)
$taskResults = $taskTargets | ForEach-Object -Parallel {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $spec = $_
    $directory = Join-Path $using:taskRoot $spec.Directory
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $archive = Join-Path $directory ([IO.Path]::GetFileName($spec.File))
    $escaped = [regex]::Escape($spec.File)
    $match = [regex]::Match($using:taskSums, '(?m)^([a-fA-F0-9]{64})\s+' + $escaped + '\s*$')
    if (!$match.Success) { throw ('No official checksum: ' + $spec.File) }
    Invoke-WebRequest -Uri ($using:taskBase + '/' + $spec.File) -OutFile $archive
    $archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($archiveHash -ne $match.Groups[1].Value) { throw ('Official checksum mismatch: ' + $spec.File) }
    if ($null -ne $spec.Member) {
        & tar -xf $archive -C $directory --strip-components=2 $spec.Member
        if ($LASTEXITCODE -ne 0) { throw ('Extraction failed: ' + $spec.File) }
        $binary = Join-Path $directory 'node'
    } else { $binary = $archive }
    [pscustomobject]@{ Target=$spec.Target; Binary=$binary; Sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash; ArchiveSha256=$archiveHash; Source=($using:taskBase+'/'+$spec.File) }
} -ThrottleLimit 3
if (@($taskResults).Count -ne 5) { throw 'Incomplete Node artifact set' }
$taskResults | ConvertTo-Json -Depth 4
