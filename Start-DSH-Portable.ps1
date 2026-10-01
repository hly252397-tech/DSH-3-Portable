[CmdletBinding()]
param(
  [int]$WaitForProcessId = 0,
  [string]$HandoffReadyFile = '',
  [switch]$RecoverPending,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ApplicationArguments
)

$ErrorActionPreference = 'Stop'
$portableRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
. (Join-Path $portableRoot 'Portable-Environment.ps1')
$portablePaths = Set-DshPortableEnvironment -PortableRoot $portableRoot
$desktopUpdateRoot = Join-Path $portablePaths.Data 'Updates\Desktop'
$pointerPath = Join-Path $desktopUpdateRoot 'pointer.json'
$statePath = Join-Path $desktopUpdateRoot 'state.json'
$logPath = Join-Path $desktopUpdateRoot 'launcher.log'

function Write-LauncherLog {
  param([string]$Message)
  New-Item -ItemType Directory -Path $desktopUpdateRoot -Force | Out-Null
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Message
  try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch { }
}

function Test-ExclusivePathAvailable {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  $probe = $null
  try {
    $probe = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $probe) { $probe.Dispose() }
  }
}

function Open-PendingDesktopActivationLease {
  param([string]$BuildCacheRoot)
  # Unified order: build (L) -> assembly (A) -> short pointer CAS (D).
  # The assembly lease uses Node's existing wx + owner-token protocol, not a
  # permanently retained empty file or a handle which denies owner-JSON reads.
  $buildStream = $null
  $assemblyCreated = $false
  $assemblyPath = Join-Path $BuildCacheRoot 'assembly.lock'
  $assemblyToken = [guid]::NewGuid().ToString()
  try {
    New-Item -ItemType Directory -Path $BuildCacheRoot -Force | Out-Null
    $buildStream = [System.IO.File]::Open((Join-Path $BuildCacheRoot 'build.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $assemblyStream = $null
    try {
      $assemblyStream = [System.IO.File]::Open($assemblyPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
      $assemblyCreated = $true
      $owner = [ordered]@{ pid = $PID; token = $assemblyToken; startedAt = [DateTime]::UtcNow.ToString('o') }
      $bytes = [System.Text.Encoding]::UTF8.GetBytes(($owner | ConvertTo-Json -Compress))
      $assemblyStream.Write($bytes, 0, $bytes.Length)
      $assemblyStream.Flush()
    } finally {
      if ($null -ne $assemblyStream) { $assemblyStream.Dispose() }
    }
    return [pscustomobject]@{ BuildStream = $buildStream; AssemblyPath = $assemblyPath; AssemblyToken = $assemblyToken }
  } catch {
    if ($assemblyCreated) {
      # A normal owner-write failure must not strand an unreadable lease. The
      # exclusive build lease still excludes all cooperative replacement writers.
      try { Remove-Item -LiteralPath $assemblyPath -Force -ErrorAction Stop } catch { }
    }
    if ($null -ne $buildStream) { $buildStream.Dispose() }
    # Live, stale or unknown assembly owners are not stolen by the launcher.
    # Node can recover a valid dead-PID owner; malformed crash remnants fail closed.
    return $null
  }
}

function Close-PendingDesktopActivationLease {
  param($Lease)
  if ($null -eq $Lease) { return }
  try {
    try {
      $owner = Get-Content -LiteralPath $Lease.AssemblyPath -Raw -ErrorAction Stop | ConvertFrom-Json
      if ([string]$owner.token -eq [string]$Lease.AssemblyToken -and [int]$owner.pid -eq $PID) {
        Remove-Item -LiteralPath $Lease.AssemblyPath -Force -ErrorAction Stop
      }
    } catch { Write-LauncherLog '装配租约未能清理或所有者已变更；未删除未知所有者文件。' }
  } finally {
    $Lease.BuildStream.Dispose()
  }
}

function Open-DesktopPointerLease {
  param([int]$WaitMs = 30000)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMs)
  New-Item -ItemType Directory -Path $desktopUpdateRoot -Force | Out-Null
  while ($true) {
    try {
      return [System.IO.File]::Open((Join-Path $desktopUpdateRoot 'operation.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch [System.IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) { return $null }
      Start-Sleep -Milliseconds 25
    }
  }
}

function Test-PrepareRecycleBusy {
  param([string]$Root)
  if (-not (Test-Path -LiteralPath $Root)) { return $false }
  try {
    # Failed buckets are retained diagnostics, not work still being deleted.
    # Never treat a linked/unknown entry as safely quarantined.
    $ancestor = Get-Item -LiteralPath $Root -Force
    if (-not $ancestor.PSIsContainer) { return $true }
    while ($null -ne $ancestor) {
      if (($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
      $ancestor = $ancestor.Parent
    }
    foreach ($entry in @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction Stop)) {
      if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
      if ($entry.PSIsContainer -and $entry.Name -match '\.failed(?:\.failed)*$') { continue }
      if (-not $entry.PSIsContainer -and $entry.Name -match '\.failed\.json$') { continue }
      # Includes .sweeping: even an empty queue is busy while its worker owns it.
      return $true
    }
    return $false
  } catch {
    return $true
  }
}

function Save-JsonAtomic {
  param($Value, [string]$Path)
  $directory = [System.IO.Path]::GetDirectoryName($Path)
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $temporary = $Path + '.tmp-' + [guid]::NewGuid().ToString('N')
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $Path) {
    try { [System.IO.File]::Replace($temporary, $Path, $null, $true) } catch {
      Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
  } else {
    Move-Item -LiteralPath $temporary -Destination $Path
  }
}

function Publish-HandoffReady {
  if ([string]::IsNullOrWhiteSpace($HandoffReadyFile)) { return }
  $handoffRoot = [System.IO.Path]::GetFullPath((Join-Path $desktopUpdateRoot 'handoffs'))
  $readyPath = [System.IO.Path]::GetFullPath($HandoffReadyFile)
  $handoffPrefix = $handoffRoot.TrimEnd('\') + '\'
  if (-not $readyPath.StartsWith($handoffPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '重启接管握手文件必须位于便携更新目录。'
  }
  Save-JsonAtomic -Value ([ordered]@{
    schema = 1
    launcherPid = $PID
    waitingForProcessId = $WaitForProcessId
    readyAt = (Get-Date).ToUniversalTime().ToString('o')
  }) -Path $readyPath
  Write-LauncherLog "启动器接管握手已就绪：等待旧桌面主进程 $WaitForProcessId。"
}

function Get-Sha256Hex {
  param([string]$Path)
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      return -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Test-OrdinaryPortablePath {
  param([string]$Path, [switch]$Directory)
  try {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPath = [System.IO.Path]::GetFullPath($portableRoot).TrimEnd('\')
    if ($fullPath -ne $rootPath -and -not $fullPath.StartsWith($rootPath + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    $entry = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if ($Directory -and -not $entry.PSIsContainer) { return $false }
    if (-not $Directory -and $entry.PSIsContainer) { return $false }
    while ($null -ne $entry) {
      if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
      # Parent/Directory return native IO objects, not provider-extended items.
      # PSIsContainer is absent there under the launcher's StrictMode Latest.
      if ($entry -is [System.IO.DirectoryInfo]) { $entry = $entry.Parent }
      elseif ($entry -is [System.IO.FileInfo]) { $entry = $entry.Directory }
      else { return $false }
    }
    return $true
  } catch { return $false }
}

function Test-CompleteDesktopSlotFiles {
  param($Manifest, [string]$SlotDirectory, [string]$AsarSha256)
  try {
    if ((Get-OptionalProperty -Value $Manifest -Name 'completeFileList') -isnot [bool] -or $Manifest.completeFileList -ne $true) { return $false }
    if (-not (Test-OrdinaryPortablePath -Path $SlotDirectory -Directory)) { return $false }
    $files = Get-OptionalProperty -Value $Manifest -Name 'files'
    if ($null -eq $files -or $files -isnot [pscustomobject]) { return $false }
    $expected = @{}
    foreach ($property in $files.PSObject.Properties) {
      $relative = [string]$property.Name
      if ($relative.Length -gt 1024 -or $relative -eq 'slot-manifest.json' -or $relative -match '[\\<>:"|?*\x00-\x1f]' -or [System.IO.Path]::IsPathRooted($relative)) { return $false }
      foreach ($segment in $relative.Split('/')) {
        if ([string]::IsNullOrEmpty($segment) -or $segment -in @('.', '..') -or $segment -match '[. ]$' -or $segment -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { return $false }
      }
      if ($relative.Split('/').Length -gt 64 -or $expected.ContainsKey($relative) -or [string]$property.Value -notmatch '^[a-fA-F0-9]{64}$') { return $false }
      $expected[$relative] = ([string]$property.Value).ToLowerInvariant()
      if ($expected.Count -gt 100000) { return $false }
    }
    $visited = @{}
    $directories = New-Object 'System.Collections.Generic.Stack[string]'
    $directories.Push($SlotDirectory)
    $slotPrefix = $SlotDirectory.TrimEnd('\') + '\'
    while ($directories.Count -gt 0) {
      $directory = $directories.Pop()
      foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
        # Enumerate one directory at a time, never recurse through a junction.
        if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        if ($entry.PSIsContainer) { $directories.Push($entry.FullName); continue }
        if ($entry -isnot [System.IO.FileInfo] -or -not $entry.FullName.StartsWith($slotPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
        $relative = $entry.FullName.Substring($slotPrefix.Length).Replace('\', '/')
        if ($relative -eq 'slot-manifest.json') { continue }
        if (-not $expected.ContainsKey($relative) -or $visited.ContainsKey($relative)) { return $false }
        $actualHash = if ($relative -eq 'resources/app.asar' -and $AsarSha256) { $AsarSha256 } else { Get-Sha256Hex -Path $entry.FullName }
        if ($actualHash -ne $expected[$relative]) { return $false }
        $visited[$relative] = $true
      }
    }
    return $visited.Count -eq $expected.Count
  } catch { return $false }
}

function Test-LocalDesktopBuildFinalized {
  param($Reference, [string]$SlotDirectory, [string]$AsarSha256)
  $producer = [string](Get-OptionalProperty -Value $Reference -Name 'producer')
  if ([string]::IsNullOrEmpty($producer)) { return $true }
  if ($producer -ne 'local-build-receipt-v1') { return $false }
  $transactionId = [string](Get-OptionalProperty -Value $Reference -Name 'transactionId')
  if ($transactionId -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') { return $false }
  try {
    $transactionRoot = Join-Path $desktopUpdateRoot ('transactions\' + $transactionId)
    if (-not (Test-OrdinaryPortablePath -Path $SlotDirectory -Directory) -or -not (Test-OrdinaryPortablePath -Path $transactionRoot -Directory)) { return $false }
    $intentPath = Join-Path $transactionRoot 'build-intent.json'
    $finalizedPath = Join-Path $transactionRoot 'build-finalized.json'
    $receiptPath = Join-Path $transactionRoot 'build-receipt.json'
    foreach ($proofPath in @($intentPath, $finalizedPath, $receiptPath)) {
      $proofFile = Get-Item -LiteralPath $proofPath -Force -ErrorAction Stop
      if ($proofFile.PSIsContainer -or $proofFile.Length -gt 16777216 -or -not (Test-OrdinaryPortablePath -Path $proofPath)) { return $false }
    }
    $intent = Get-Content -LiteralPath $intentPath -Raw | ConvertFrom-Json
    $finalized = Get-Content -LiteralPath $finalizedPath -Raw | ConvertFrom-Json
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    foreach ($proof in @($intent, $finalized)) {
      if ($proof.schema -ne 1 -or [string]$proof.producer -ne $producer -or [string]$proof.transactionId -ne $transactionId -or
          [string]$proof.slotRelativePath -ne [string]$Reference.relativePath -or [string]$proof.version -ne [string]$Reference.version -or
          [string]$proof.slotManifestSha256 -ne [string]$Reference.sha256) { return $false }
      foreach ($field in @('slotManifestSha256', 'inputFingerprint', 'coreFingerprint', 'asarSha256')) {
        if ([string](Get-OptionalProperty -Value $proof -Name $field) -notmatch '^[a-fA-F0-9]{64}$') { return $false }
      }
    }
    foreach ($field in @('inputFingerprint', 'coreFingerprint', 'asarSha256')) {
      if ([string](Get-OptionalProperty -Value $intent -Name $field) -ne [string](Get-OptionalProperty -Value $finalized -Name $field)) { return $false }
    }
    if ([string]$finalized.receiptSha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-Sha256Hex -Path $receiptPath) -ne [string]$finalized.receiptSha256) { return $false }
    if ($receipt.schema -ne 1 -or [string]$receipt.kind -ne 'dsh-desktop-build' -or [string]$receipt.status -ne 'validated' -or
        [string]$receipt.mode -notin @('full', 'ui') -or $receipt.inputs.schema -ne 1 -or $receipt.inputs.policy -ne 1 -or
        [string]$receipt.inputs.fingerprint -ne [string]$intent.inputFingerprint -or
        [string]$receipt.inputs.coreFingerprint -ne [string]$intent.coreFingerprint -or
        [string]$receipt.asar.sha256 -ne [string]$intent.asarSha256) { return $false }
    if ((Get-Sha256Hex -Path (Join-Path $SlotDirectory 'slot-manifest.json')) -ne [string]$Reference.sha256) { return $false }
    if ([string]::IsNullOrEmpty($AsarSha256)) { $AsarSha256 = Get-Sha256Hex -Path (Join-Path $SlotDirectory 'resources\app.asar') }
    return $AsarSha256 -eq [string]$intent.asarSha256
  } catch {
    Write-LauncherLog '本地构建最终确认凭据缺失或不匹配，未激活/恢复该候选槽。'
    return $false
  }
}

function Test-LocalDesktopSlotHealthy {
  param($Reference)
  $producer = [string](Get-OptionalProperty -Value $Reference -Name 'producer')
  if ([string]::IsNullOrEmpty($producer)) { return $true }
  if ($producer -ne 'local-build-receipt-v1') { return $false }
  $transactionId = [string](Get-OptionalProperty -Value $Reference -Name 'transactionId')
  if ($transactionId -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') { return $false }
  try {
    $healthPath = Join-Path $desktopUpdateRoot ('transactions\' + $transactionId + '\health.json')
    if (-not (Test-OrdinaryPortablePath -Path $healthPath)) { return $false }
    if ((Get-Item -LiteralPath $healthPath -Force).Length -gt 65536) { return $false }
    $health = Get-Content -LiteralPath $healthPath -Raw | ConvertFrom-Json
    if (-not [string]::Equals([string]$health.transactionId, $transactionId, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$health.version, [string]$Reference.version, [System.StringComparison]::Ordinal)) { return $false }
    $completedAt = [DateTimeOffset]::MinValue
    $dateStyle = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
    return [DateTimeOffset]::TryParseExact([string]$health.completedAt, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture, $dateStyle, [ref]$completedAt)
  } catch { return $false }
}

function Resolve-SlotApplication {
  param($Reference, [ref]$ValidatedAsarHash)
  if ($null -eq $Reference -or [string]::IsNullOrWhiteSpace([string]$Reference.relativePath)) { return $null }
  $relativePath = ([string]$Reference.relativePath).Replace('/', '\')
  if ([System.IO.Path]::IsPathRooted($relativePath) -or $relativePath.Split('\') -contains '..') { return $null }
  $directory = [System.IO.Path]::GetFullPath((Join-Path $portableRoot $relativePath))
  $rootPrefix = $portableRoot.TrimEnd('\') + '\'
  if (-not $directory.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
  $executable = Join-Path $directory 'DSH Codex Desktop.exe'
  foreach ($required in @(
    $executable,
    (Join-Path $directory 'resources\app.asar'),
    (Join-Path $directory 'resources\node\node.exe'),
    (Join-Path $directory 'resources\dsh-runtime.tgz'),
    (Join-Path $directory 'resources\plugins-store.tgz')
  )) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { return $null }
  }
  if ($relativePath -ne 'App') {
    $manifestPath = Join-Path $directory 'slot-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
    try {
      $manifestHash = Get-Sha256Hex -Path $manifestPath
      if ($manifestHash -ne ([string]$Reference.sha256).ToLowerInvariant()) { return $null }
      $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
      if ($manifest.schema -ne 1 -or [string]$manifest.version -ne [string]$Reference.version) { return $null }
      $manifestProducer = [string](Get-OptionalProperty -Value $manifest -Name 'producer')
      $referenceProducer = [string](Get-OptionalProperty -Value $Reference -Name 'producer')
      $proofAsarSha256 = $null
      if ($manifestProducer -or $referenceProducer) {
        if ($manifestProducer -ne 'local-build-receipt-v1' -or ($referenceProducer -and $referenceProducer -ne $manifestProducer)) { return $null }
        $manifestTransaction = [string](Get-OptionalProperty -Value $manifest -Name 'transactionId')
        $referenceTransaction = [string](Get-OptionalProperty -Value $Reference -Name 'transactionId')
        if ($referenceTransaction -and $referenceTransaction -ne $manifestTransaction) { return $null }
        $proofReference = [pscustomobject]@{ relativePath = [string]$Reference.relativePath; version = [string]$Reference.version; sha256 = $manifestHash; producer = $manifestProducer; transactionId = $manifestTransaction }
        if (-not (Test-OrdinaryPortablePath -Path $directory -Directory) -or -not (Test-OrdinaryPortablePath -Path $manifestPath) -or -not (Test-OrdinaryPortablePath -Path (Join-Path $directory 'resources\app.asar'))) { return $null }
        $proofAsarSha256 = Get-Sha256Hex -Path (Join-Path $directory 'resources\app.asar')
        if (-not (Test-LocalDesktopBuildFinalized -Reference $proofReference -SlotDirectory $directory -AsarSha256 $proofAsarSha256)) { return $null }
        if (-not (Test-CompleteDesktopSlotFiles -Manifest $manifest -SlotDirectory $directory -AsarSha256 $proofAsarSha256)) { return $null }
        if ($null -ne $ValidatedAsarHash) { $ValidatedAsarHash.Value = $proofAsarSha256 }
      }
      $requiredRelative = @(
        'DSH Codex Desktop.exe',
        'resources/app.asar',
        'resources/node/node.exe',
        'resources/dsh-runtime.tgz',
        'resources/dsh-runtime.tgz.sha256',
        'resources/plugins-store.tgz',
        'resources/plugins-store.tgz.sha256',
        'resources/desktop-bridge/dsh-process.js',
        'resources/desktop-bridge/profile-bundle-health.js',
        'resources/desktop-bridge/profile-quarantine.js',
        'resources/process-control.js'
      )
      foreach ($relative in $requiredRelative) {
        $property = $manifest.files.PSObject.Properties[$relative]
        if ($null -eq $property -or [string]$property.Value -notmatch '^[a-fA-F0-9]{64}$') { return $null }
        # The new producer's exact full tree has already been verified above.
        if ($manifestProducer) { continue }
        $candidateFile = [System.IO.Path]::GetFullPath((Join-Path $directory $relative.Replace('/', '\')))
        if (-not $candidateFile.StartsWith($directory.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
        $actualHash = if ($relative -eq 'resources/app.asar' -and $proofAsarSha256) { $proofAsarSha256 } else { Get-Sha256Hex -Path $candidateFile }
        if ($actualHash -ne ([string]$property.Value).ToLowerInvariant()) { return $null }
      }
    } catch {
      Write-LauncherLog "候选槽完整性验证失败：$($_.Exception.Message)"
      return $null
    }
  }
  return $executable
}

function Get-DesktopPointer {
  if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json } catch {
    Write-LauncherLog "桌面槽指针损坏：$($_.Exception.Message)"
    return $null
  }
}

function Get-OptionalProperty {
  param($Value, [string]$Name)
  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Collections.IDictionary]) {
    if ($Value.Contains($Name)) { return $Value[$Name] }
    return $null
  }
  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Get-DesktopVersionSortKey {
  param([string]$Version)
  $core = ([string]$Version).Trim()
  if ($core.StartsWith('v') -or $core.StartsWith('V')) { $core = $core.Substring(1) }
  $plus = $core.IndexOf('+')
  if ($plus -ge 0) { $core = $core.Substring(0, $plus) }
  if ($core -match '^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?') {
    $portable = if ($Matches[4]) { [int]$Matches[4] } else { 0 }
    return ('{0:D6}.{1:D6}.{2:D6}.{3:D6}' -f [int]$Matches[1], [int]$Matches[2], [int]$Matches[3], $portable)
  }
  return $core
}

function New-SlotReferenceFromManifest {
  param([string]$Directory, [string]$RelativePath)
  $manifestPath = Join-Path $Directory 'slot-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1) { return $null }
    $version = [string]$manifest.version
    if ([string]::IsNullOrWhiteSpace($version)) { return $null }
    $reference = [ordered]@{
      relativePath = $RelativePath
      version = $version
      sha256 = (Get-Sha256Hex -Path $manifestPath)
    }
    foreach ($field in @('producer', 'transactionId')) {
      $value = Get-OptionalProperty -Value $manifest -Name $field
      if ($null -ne $value) { $reference[$field] = $value }
    }
    return [pscustomobject]$reference
  } catch {
    return $null
  }
}

function Resolve-BestAvailableDesktopApplication {
  # 回收顺序：pointer.current → pointer.previous → 扫描 slots/ 取最高版。
  # 仅当全部失败时才由调用方回退 legacy App（App 内 dsh-runtime 可能落后多代）。
  param($Pointer)
  $downgradeReason = ''
  $currentReference = Get-OptionalProperty -Value $Pointer -Name 'current'
  $failedVersion = ''
  if ($currentReference) {
    $verifiedAsarHash = $null
    $executable = Resolve-SlotApplication $currentReference -ValidatedAsarHash ([ref]$verifiedAsarHash)
    if ($executable) {
      return [pscustomobject]@{ Executable = $executable; Reference = $currentReference; Source = 'pointer-current'; AsarSha256 = $verifiedAsarHash; DowngradeReason = '' }
    }
    Write-LauncherLog "pointer.current 未通过完整性校验：$([string]$currentReference.relativePath)"
    $failedVersion = [string](Get-OptionalProperty -Value $currentReference -Name 'version')
    $downgradeReason = "当前槽 $failedVersion 未通过完整性校验（目录内容与 slot-manifest.json 不一致，槽在固化后被改写）"
  }
  $previousReference = Get-OptionalProperty -Value $Pointer -Name 'previous'
  if ($previousReference) {
    $verifiedAsarHash = $null
    $executable = Resolve-SlotApplication $previousReference -ValidatedAsarHash ([ref]$verifiedAsarHash)
    if ($executable) {
      Write-LauncherLog "启用 pointer.previous 作为当前桌面槽：$([string]$previousReference.relativePath)"
      return [pscustomobject]@{ Executable = $executable; Reference = $previousReference; Source = 'pointer-previous'; AsarSha256 = $verifiedAsarHash; DowngradeReason = $downgradeReason }
    }
    Write-LauncherLog "pointer.previous 未通过完整性校验：$([string]$previousReference.relativePath)"
    $failedPrevious = [string](Get-OptionalProperty -Value $previousReference -Name 'version')
    $downgradeReason = "当前槽 $failedVersion 与上一槽 $failedPrevious 均未通过完整性校验，改用槽扫描结果"
  }
  $slotsRoot = Join-Path $desktopUpdateRoot 'slots'
  if (-not (Test-Path -LiteralPath $slotsRoot -PathType Container)) { return $null }
  $rootPrefix = $portableRoot.TrimEnd('\') + '\'
  $best = $null
  foreach ($directory in @(Get-ChildItem -LiteralPath $slotsRoot -Directory -ErrorAction SilentlyContinue)) {
    $fullPath = [System.IO.Path]::GetFullPath($directory.FullName)
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    $relativePath = $fullPath.Substring($rootPrefix.Length).Replace('\', '/')
    $reference = New-SlotReferenceFromManifest -Directory $fullPath -RelativePath $relativePath
    if ($null -eq $reference) { continue }
    $verifiedAsarHash = $null
    $executable = Resolve-SlotApplication $reference -ValidatedAsarHash ([ref]$verifiedAsarHash)
    if ($null -eq $executable) { continue }
    # Finalized proves build integrity, not startup acceptance. Only scan-based
    # recovery of new local slots requires the exact committed health receipt.
    # current/previous/pending and legacy compatibility remain unchanged.
    if (-not (Test-LocalDesktopSlotHealthy -Reference $reference)) { continue }
    $sortKey = Get-DesktopVersionSortKey -Version ([string]$reference.version)
    $isBetter = $false
    if ($null -eq $best) {
      $isBetter = $true
    } elseif ($sortKey -gt $best.SortKey) {
      $isBetter = $true
    } elseif ($sortKey -eq $best.SortKey -and $directory.Name -gt $best.Name) {
      $isBetter = $true
    }
    if ($isBetter) {
      $best = [pscustomobject]@{
        Executable = $executable
        Reference = $reference
        Source = 'slot-scan'
        SortKey = $sortKey
        Name = $directory.Name
        AsarSha256 = $verifiedAsarHash
      }
    }
  }
  if ($best) {
    Write-LauncherLog "从 slots 扫描恢复桌面槽：$($best.Reference.relativePath)（$($best.Reference.version)）"
    return [pscustomobject]@{ Executable = $best.Executable; Reference = $best.Reference; Source = 'slot-scan'; AsarSha256 = $best.AsarSha256; DowngradeReason = $downgradeReason }
  }
  return $null
}

function Save-RecoveredDesktopPointer {
  param($Reference, $Pointer, [string]$Source, [string]$DowngradeReason)
  $recovered = [ordered]@{
    schema = 1
    current = $Reference
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $previousReference = Get-OptionalProperty -Value $Pointer -Name 'previous'
  $currentReference = Get-OptionalProperty -Value $Pointer -Name 'current'
  if ($previousReference -and [string]$previousReference.relativePath -ne [string]$Reference.relativePath) {
    $recovered.previous = $previousReference
  } elseif ($currentReference -and [string]$currentReference.relativePath -ne [string]$Reference.relativePath) {
    $recovered.previous = $currentReference
  }
  $pendingReference = Get-OptionalProperty -Value $Pointer -Name 'pending'
  if ($pendingReference) { $recovered.pending = $pendingReference }
  Save-JsonAtomic -Value $recovered -Path $pointerPath
  if (-not [string]::IsNullOrWhiteSpace($DowngradeReason)) {
    # A downgrade is a rollback, not an up-to-date desktop. Publishing it as
    # 'none' made the shell report "已是最新版本" while an older slot was
    # running, so the user could not see that their update had been withdrawn.
    $revertedVersion = if ($currentReference) { [string]$currentReference.version } else { [string]$Source }
    Set-UpdateState -Phase 'rolled-back' -Overall 100 -Stage 100 `
      -Detail ("已回退到 {0}（{1}）：{2}" -f [string]$Reference.version, $Source, $DowngradeReason) `
      -Pointer $recovered -TargetVersion $revertedVersion
    Write-LauncherLog "已记录回退通知：当前 $($revertedVersion) → 回退到 $([string]$Reference.version)"
  } else {
    Set-UpdateState -Phase 'none' -Overall 100 -Stage 100 -Detail ("已恢复桌面槽指针（{0}）。" -f $Source) -Pointer $recovered
  }
  Write-LauncherLog "已持久化恢复后的桌面槽指针：$([string]$Reference.relativePath)（来源 $Source）"
  return $recovered
}

function Set-UpdateState {
  param([string]$Phase, [int]$Overall, [int]$Stage, [string]$Detail, $Pointer, [string]$TargetVersion)
  $currentReference = Get-OptionalProperty -Value $Pointer -Name 'current'
  $pendingReference = Get-OptionalProperty -Value $Pointer -Name 'pending'
  $currentVersion = if ($currentReference) { [string]$currentReference.version } else { '0.0.0' }
  $targetVersion = if ([string]::IsNullOrWhiteSpace($TargetVersion)) { if ($pendingReference) { [string]$pendingReference.version } else { $null } } else { $TargetVersion }
  $transactionId = if ($pendingReference) { [string]$pendingReference.transactionId } else { $null }
  $state = [ordered]@{
    schema = 1
    phase = $Phase
    currentVersion = $currentVersion
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    overallProgress = $Overall
    stageProgress = $Stage
    detail = $Detail
  }
  if ($targetVersion) { $state.targetVersion = $targetVersion }
  if ($transactionId) { $state.transactionId = $transactionId }
  if ($pendingReference) { $state.slotRelativePath = [string]$pendingReference.relativePath }
  Save-JsonAtomic -Value $state -Path $statePath
}

function Start-DesktopApplication {
  param([string]$Executable, [switch]$PassThru)
  $launchArguments = @(
    '--user-data-dir="' + $portablePaths.UserData + '"'
    '--disk-cache-dir="' + $portablePaths.Cache + '"'
  )
  foreach ($argument in $ApplicationArguments) {
    if (-not [string]::IsNullOrEmpty($argument)) { $launchArguments += $argument }
  }
  $parameters = @{
    FilePath = $Executable
    ArgumentList = $launchArguments
    WorkingDirectory = $portablePaths.Workspace
  }
  if ($PassThru) { $parameters.PassThru = $true }
  return Start-Process @parameters
}

function Get-PortableDesktopProcesses {
  $rootPrefix = $portableRoot.TrimEnd('\') + '\'
  return @(Get-Process -Name 'DSH Codex Desktop' -ErrorAction SilentlyContinue | Where-Object {
    try {
      $_.Path.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
      $false
    }
  })
}

function Start-DesktopApplicationReliable {
  param([string]$Executable)
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $process = Start-DesktopApplication -Executable $Executable -PassThru
    Start-Sleep -Milliseconds 1500
    try { $process.Refresh() } catch { }
    if (-not $process.HasExited) {
      Write-LauncherLog "桌面进程启动并通过存活检查：PID=$($process.Id)，尝试=$attempt。"
      return $process
    }
    Write-LauncherLog "桌面进程过早退出：退出码=$($process.ExitCode)，尝试=$attempt/3。"
    if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
  }
  throw '桌面进程连续三次未通过启动存活检查。'
}

function Clear-DesktopActivationEnvironment {
  Remove-Item Env:DSH_DESKTOP_UPDATE_TRANSACTION -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_DESKTOP_UPDATE_HEALTH_FILE -ErrorAction SilentlyContinue
  Write-LauncherLog '普通桌面启动前已清除候选激活事务环境。'
}

function Restore-CurrentDesktopPointer {
  param($Pointer, [string]$Detail, [string]$RevertedVersion)
  $rolledBackPointer = [ordered]@{
    schema = 1
    current = $Pointer.current
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $previousReference = Get-OptionalProperty -Value $Pointer -Name 'previous'
  if ($previousReference) { $rolledBackPointer.previous = $previousReference }
  Save-JsonAtomic -Value $rolledBackPointer -Path $pointerPath
  # The pointer no longer carries `pending` once the candidate is withdrawn, so
  # the version being withdrawn has to be recorded explicitly for the shell.
  Set-UpdateState -Phase 'rolled-back' -Overall 100 -Stage 100 -Detail $Detail -Pointer $rolledBackPointer -TargetVersion $RevertedVersion
  return $rolledBackPointer
}

function Test-DesktopReferenceMatch {
  param($Left, $Right)
  if ($null -eq $Left -or $null -eq $Right) { return $null -eq $Left -and $null -eq $Right }
  foreach ($field in @('relativePath', 'version', 'sha256', 'producer', 'transactionId')) {
    $leftValue = [string](Get-OptionalProperty -Value $Left -Name $field)
    $rightValue = [string](Get-OptionalProperty -Value $Right -Name $field)
    if ($field -eq 'relativePath') { $leftValue = $leftValue.Replace('\', '/'); $rightValue = $rightValue.Replace('\', '/') }
    if ($leftValue -ne $rightValue) { return $false }
  }
  return $true
}

function Test-DesktopPointerSnapshotMatch {
  param($Left, $Right)
  foreach ($field in @('current', 'previous', 'pending')) {
    if (-not (Test-DesktopReferenceMatch (Get-OptionalProperty $Left $field) (Get-OptionalProperty $Right $field))) { return $false }
  }
  return $true
}

function Test-DesktopSlotIdentity {
  param($Reference, [string]$AsarSha256)
  try {
    $directory = Join-Path $portableRoot ([string]$Reference.relativePath).Replace('/', '\')
    if ([string]$Reference.relativePath -eq 'App') { return Test-Path -LiteralPath (Join-Path $directory 'DSH Codex Desktop.exe') -PathType Leaf }
    $manifestPath = Join-Path $directory 'slot-manifest.json'
    if ((Get-Sha256Hex -Path $manifestPath) -ne ([string]$Reference.sha256).ToLowerInvariant()) { return $false }
    return Test-LocalDesktopBuildFinalized -Reference $Reference -SlotDirectory $directory -AsarSha256 $AsarSha256
  } catch { return $false }
}

function Invoke-DesktopActivationPointerCas {
  param($ExpectedPointer, [scriptblock]$Action)
  $pointerLease = Open-DesktopPointerLease
  if ($null -eq $pointerLease) { return [pscustomobject]@{ Status = 'busy' } }
  try {
    $freshPointer = Get-DesktopPointer
    $expectedPending = Get-OptionalProperty -Value $ExpectedPointer -Name 'pending'
    $freshPending = Get-OptionalProperty -Value $freshPointer -Name 'pending'
    $freshCurrent = Get-OptionalProperty -Value $freshPointer -Name 'current'
    if ($null -ne $expectedPending -and (Test-DesktopReferenceMatch $freshCurrent $expectedPending)) {
      # Pointer publication is irreversible for this launcher, even if the
      # completing process died before writing state/health. Never restore a
      # startup-time snapshot over an already committed candidate.
      $state = $null
      try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { }
      $status = if (-not $freshPending -and [string](Get-OptionalProperty $state 'phase') -eq 'completed' -and
        [string](Get-OptionalProperty $state 'transactionId') -eq [string](Get-OptionalProperty $expectedPending 'transactionId')) { 'committed' } else { 'candidate-current' }
      return [pscustomobject]@{ Status = $status; Pointer = $freshPointer }
    }
    if ($null -eq $expectedPending -or -not (Test-DesktopReferenceMatch $freshPending $expectedPending) -or
        -not (Test-DesktopReferenceMatch $freshCurrent (Get-OptionalProperty $ExpectedPointer 'current')) -or
        -not (Test-DesktopReferenceMatch (Get-OptionalProperty $freshPointer 'previous') (Get-OptionalProperty $ExpectedPointer 'previous'))) {
      return [pscustomobject]@{ Status = 'changed'; Pointer = $freshPointer }
    }
    if ($null -ne $Action) { return & $Action $freshPointer }
    return [pscustomobject]@{ Status = 'pending'; Pointer = $freshPointer }
  } finally {
    # D must be released before starting the candidate; candidate confirmation
    # takes D while the launcher continues to own L/A.
    $pointerLease.Dispose()
  }
}

function Invoke-PendingDesktopActivation {
  param($Pointer, [string]$CurrentApplication)
  $pendingReference = Get-OptionalProperty -Value $Pointer -Name 'pending'
  if ($null -eq $pendingReference) { throw '候选激活必须有明确待部署事务。' }
  $currentApplication = $CurrentApplication
  $activationLease = Open-PendingDesktopActivationLease -BuildCacheRoot (Join-Path $portablePaths.Development 'build-cache')
  if ($null -eq $activationLease) {
    Write-LauncherLog '构建/装配租约不可独占，本次不激活候选；pending 与现役均保留。'
    if (-not $currentApplication) { throw '候选尚在构建或装配，且没有可用现役，请稍后启动。' }
    Clear-DesktopActivationEnvironment
    Start-DesktopApplicationReliable -Executable $currentApplication | Out-Null
    return
  }
  try {
    if (Test-PrepareRecycleBusy -Root (Join-Path $portablePaths.Temp 'prepare-recycle')) {
      Write-LauncherLog '回收清理尚未结束，本次不激活候选；pending 与现役均保留。'
      if (-not $currentApplication) { throw '候选仍在回收清理，且没有可用现役，请稍后启动。' }
      Clear-DesktopActivationEnvironment
      Start-DesktopApplicationReliable -Executable $currentApplication | Out-Null
      return
    }
    # Full immutable payload/receipt verification is done with L/A owned, but
    # outside D. The short D action below rechecks exact identity and pointer.
    $verifiedAsarSha256 = $null
    $candidateApplication = Resolve-SlotApplication -Reference $pendingReference -ValidatedAsarHash ([ref]$verifiedAsarSha256)
    $context = Invoke-DesktopActivationPointerCas -ExpectedPointer $Pointer -Action {
      param($freshPointer)
      $transactionId = [string]$pendingReference.transactionId
      if ($transactionId -notmatch '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') {
        return [pscustomobject]@{ Status = 'deferred'; Detail = '候选事务标识无效；未写入激活标记，现役与 pending 保留。' }
      }
      if (-not $candidateApplication -or -not (Test-DesktopSlotIdentity -Reference $pendingReference -AsarSha256 $verifiedAsarSha256)) {
        if ([string](Get-OptionalProperty $pendingReference 'producer') -eq 'local-build-receipt-v1') {
          return [pscustomobject]@{ Status = 'deferred'; Detail = '本地构建最终确认/完整制品校验尚未通过；pending 与现役保留。' }
        }
        Write-LauncherLog '待部署桌面槽未通过完整性验证，已撤销候选并保留当前版本。'
        Restore-CurrentDesktopPointer -Pointer $freshPointer -Detail '候选桌面完整性验证失败，已自动恢复上一已知可用槽。' -RevertedVersion ([string]$pendingReference.version) | Out-Null
        return [pscustomobject]@{ Status = 'rolled-back' }
      }
      $healthRoot = Join-Path $desktopUpdateRoot ('transactions\' + $transactionId)
      New-Item -ItemType Directory -Path $healthRoot -Force | Out-Null
      if (-not (Test-OrdinaryPortablePath -Path $healthRoot -Directory)) { throw '候选事务目录不是便携盘内普通目录，未激活。' }
      $healthFile = Join-Path $healthRoot 'health.json'
      $progressFile = Join-Path $healthRoot 'startup-progress.json'
      $attemptFile = Join-Path $healthRoot 'activation-attempt.json'
      if (Test-Path -LiteralPath $attemptFile) {
        return [pscustomobject]@{ Status = 'repeated-attempt' }
      }
      foreach ($transientPath in @($healthFile, $progressFile)) {
        if (Test-Path -LiteralPath $transientPath) {
          if (-not (Test-OrdinaryPortablePath -Path $transientPath)) { throw '候选健康状态文件不是普通文件，未激活。' }
          Remove-Item -LiteralPath $transientPath -Force
        }
      }
      Save-JsonAtomic -Value ([ordered]@{ schema = 1; transactionId = $transactionId; startedAt = (Get-Date).ToUniversalTime().ToString('o') }) -Path $attemptFile
      try {
        Set-UpdateState -Phase 'validating' -Overall 97 -Stage 20 -Detail '候选桌面正在启动并验证 DSH readiness。' -Pointer $freshPointer
      } catch {
        Restore-CurrentDesktopPointer -Pointer $freshPointer -Detail '候选准备状态写入失败，未启动该候选。' -RevertedVersion ([string]$pendingReference.version) | Out-Null
        throw
      }
      return [pscustomobject]@{ Status = 'start'; Application = $candidateApplication; TransactionId = $transactionId; HealthFile = $healthFile; ProgressFile = $progressFile }
    }
    if ($context.Status -eq 'committed') { Write-LauncherLog '候选已由当前事务提交，未重复启动或回退。'; return }
    if ($context.Status -eq 'repeated-attempt') {
      $repeatRollback = Invoke-DesktopActivationPointerCas -ExpectedPointer $Pointer -Action {
        param($freshPointer)
        Write-LauncherLog '候选事务已经尝试过且未提交，拒绝重复启动并回退。'
        Restore-CurrentDesktopPointer -Pointer $freshPointer -Detail '候选桌面上次未完成启动验证，已阻止重复尝试并恢复当前槽。' -RevertedVersion ([string]$pendingReference.version) | Out-Null
        return [pscustomobject]@{ Status = 'rolled-back' }
      }
      if ($repeatRollback.Status -eq 'committed') { return }
      if ($repeatRollback.Status -ne 'rolled-back') { throw '过期候选事务指针已变更，未覆盖新事务。' }
      Clear-DesktopActivationEnvironment
      if ($currentApplication) { Start-DesktopApplicationReliable -Executable $currentApplication | Out-Null; return }
      throw '过期候选已撤销，但没有可启动的上一桌面槽。'
    }
    if ($context.Status -in @('deferred', 'rolled-back')) {
      if ($context.Status -eq 'deferred') { Write-LauncherLog $context.Detail }
      if (-not $currentApplication) { throw '候选未激活，且没有可启动的现役桌面槽。' }
      Clear-DesktopActivationEnvironment
      Start-DesktopApplicationReliable -Executable $currentApplication | Out-Null
      return
    }
    if ($context.Status -ne 'start') { throw '桌面指针已变更或正在提交；未覆盖新事务，请稍后正常启动。' }

    [Environment]::SetEnvironmentVariable('DSH_DESKTOP_UPDATE_TRANSACTION', $context.TransactionId, 'Process')
    [Environment]::SetEnvironmentVariable('DSH_DESKTOP_UPDATE_HEALTH_FILE', $context.HealthFile, 'Process')
    $candidate = $null
    try {
      Write-LauncherLog "启动候选槽：$($pendingReference.relativePath)"
      $candidate = Start-DesktopApplication -Executable $context.Application -PassThru
      $leaseDeadline = (Get-Date).AddMinutes(3)
      $hardDeadline = (Get-Date).AddMinutes(15)
      $lastProgressWriteUtc = [datetime]::MinValue
      # A pointer the running candidate already published can only settle into
      # 'committed'; 'candidate-current' means the state file has not caught up.
      # That gap is short by construction, so give it its own short lease and
      # then record what actually disagreed instead of spinning until the 3
      # minute progress lease expires with no evidence in the log.
      $publishDeadline = (Get-Date).AddSeconds(45)
      $publishDiagnosticWritten = $false
      while ((Get-Date) -lt $hardDeadline) {
        if (Test-Path -LiteralPath $context.HealthFile -PathType Leaf) {
          $confirmation = Invoke-DesktopActivationPointerCas -ExpectedPointer $Pointer
          if ($confirmation.Status -eq 'committed') {
            Write-LauncherLog "候选槽验证通过：$($pendingReference.version)"
            return
          }
          if ($confirmation.Status -in @('changed', 'busy')) { break }
          if ($confirmation.Status -eq 'candidate-current' -and -not $publishDiagnosticWritten -and (Get-Date) -ge $publishDeadline) {
            $publishDiagnosticWritten = $true
            $observedState = $null
            try { $observedState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { }
            Write-LauncherLog "候选已写入健康凭据但提交判定未收敛：state.phase=$([string](Get-OptionalProperty $observedState 'phase'))，state.transactionId=$([string](Get-OptionalProperty $observedState 'transactionId'))，期望 transactionId=$($context.TransactionId)。"
            break
          }
        }
        if ($candidate.HasExited) { break }
        if (Test-Path -LiteralPath $context.ProgressFile -PathType Leaf) {
          $progressWriteUtc = (Get-Item -LiteralPath $context.ProgressFile).LastWriteTimeUtc
          if ($progressWriteUtc -gt $lastProgressWriteUtc) {
            $lastProgressWriteUtc = $progressWriteUtc
            $leaseDeadline = (Get-Date).AddMinutes(3)
          }
        }
        if ((Get-Date) -ge $leaseDeadline) { break }
        Start-Sleep -Milliseconds 500
        try { $candidate.Refresh() } catch { }
      }
    } catch {
      Write-LauncherLog "候选启动或健康观察抛错：$($_.Exception.Message)"
    }

    Write-LauncherLog "候选槽未通过启动验证，尝试精确事务自动回退：$($pendingReference.version)"
    $rollback = Invoke-DesktopActivationPointerCas -ExpectedPointer $Pointer -Action {
      param($freshPointer)
      # Only this exact still-pending transaction may be withdrawn. D is short
      # and released before stopping the candidate or starting the old slot.
      # The running candidate publishes its own commit, so a pointer that
      # already names this transaction was committed successfully: withdrawing
      # it here is what turned a healthy 1.0.78 activation into a downgrade.
      if (Test-DesktopReferenceMatch (Get-OptionalProperty $freshPointer -Name 'current') $pendingReference) {
        Write-LauncherLog '候选指针已由运行中的候选进程提交，拒绝按旧快照降级。'
        return [pscustomobject]@{ Status = 'committed' }
      }
      Restore-CurrentDesktopPointer -Pointer $freshPointer -Detail '候选桌面启动验证失败，已自动恢复上一已知可用槽。' -RevertedVersion ([string]$pendingReference.version) | Out-Null
      return [pscustomobject]@{ Status = 'rolled-back' }
    }
    if ($rollback.Status -eq 'committed') { Write-LauncherLog '健康事务已完成提交；未根据旧快照误回退。'; return }
    if ($rollback.Status -ne 'rolled-back') { throw '候选已经提交或指针发生变化；未覆盖新指针，也未强停当前候选，请检查便携更新日志。' }
    if ($null -ne $candidate -and -not $candidate.HasExited) {
      try { $candidate.CloseMainWindow() | Out-Null } catch { }
      try { if (-not $candidate.WaitForExit(8000)) { & taskkill.exe /PID $candidate.Id /T /F | Out-Null } } catch { }
    }
    Clear-DesktopActivationEnvironment
    if (-not $currentApplication) { throw '候选验证失败，且没有可启动的上一桌面槽。' }
    Start-DesktopApplicationReliable -Executable $currentApplication | Out-Null
  } finally {
    # Includes success, failure, thrown launch, cancellation/timeout and all
    # fail-closed pointer dispositions. Normal starts never acquire L/A.
    try { Clear-DesktopActivationEnvironment } finally { Close-PendingDesktopActivationLease -Lease $activationLease }
  }
}

# ── 启动器互斥（2026-09-16 第二次事故修复）──────────────────────────────────
# 事故链：候选部署连败两次，日志显示两个启动器实例在 ~29ms 内**都**放行并各自启动候选，
# 旧槽/新槽抢占 Chromium 单实例锁，候选秒退（退出码=0）→ 自动回退 → 部署被毁。
# 上一版用 activation-attempt.json 当守卫**真机验证失败**：两个实例都在对方写入之前
# 检查了标记（先检查后写入的 TOCTOU 空隙），标记文件天生做不到互斥。
# 正解＝内核级原子锁：Mutex。进程退出（含崩溃）由内核自动释放，不会像锁文件那样留尸。
$launcherMutexHashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
try {
  $launcherMutexHash = -join ($launcherMutexHashAlgorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($portableRoot)) | ForEach-Object { $_.ToString('x2') })
} finally {
  $launcherMutexHashAlgorithm.Dispose()
}
# 名字按便携根路径取哈希：同一台机器上多个便携副本互不干扰
$launcherMutexName = 'Local\DSH-Portable-Launcher-' + $launcherMutexHash.Substring(0, 16)
$launcherMutex = New-Object System.Threading.Mutex($false, $launcherMutexName)
$launcherOwned = $false
try {
  $launcherOwned = $launcherMutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  # 上一个持有者异常退出：内核已把所有权判给本次调用，视为拿到
  $launcherOwned = $true
}
if (-not $launcherOwned) {
  # 已有实例在部署（含交接等待/候选验证窗口）→ 让位退出：不撤指针、不抢启动、不写标记
  Write-LauncherLog "已有另一个启动器实例在运行，本次重复启动让位退出（互斥锁 $launcherMutexName）。"
  if (-not [string]::IsNullOrWhiteSpace($HandoffReadyFile)) { Publish-HandoffReady }
  exit 0
}

Publish-HandoffReady

if ($WaitForProcessId -gt 0) {
  Write-LauncherLog "启动器已接管重启，等待旧桌面主进程 $WaitForProcessId 自然退出。"
  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Process -Id $WaitForProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process -Id $WaitForProcessId -ErrorAction SilentlyContinue) {
    Write-LauncherLog "等待旧桌面进程 $WaitForProcessId 自然退出超时，未部署候选。"
    exit 2
  }
  $drainDeadline = (Get-Date).AddSeconds(20)
  while (@(Get-PortableDesktopProcesses).Count -gt 0 -and (Get-Date) -lt $drainDeadline) {
    Start-Sleep -Milliseconds 250
  }
  $remainingProcesses = @(Get-PortableDesktopProcesses)
  if ($remainingProcesses.Count -gt 0) {
    Write-LauncherLog "旧桌面 Chromium 子进程释放超时，未启动竞争实例：$($remainingProcesses.Id -join ',')。"
    exit 3
  }
  # Chromium 的 SingletonLock 可能比最后一个子进程稍晚释放；留出短暂稳定窗口。
  Start-Sleep -Milliseconds 750
  Write-LauncherLog '旧桌面进程树和单实例锁已释放，继续启动。'
}

$initialPointerLease = Open-DesktopPointerLease -WaitMs 0
if ($null -eq $initialPointerLease) {
  Write-LauncherLog '桌面更新正在提交指针，拒绝与提交并发启动；稍后正常启动即可。'
  exit 4
}
try {
  $pointer = Get-DesktopPointer
} finally {
  $initialPointerLease.Dispose()
}
$pendingReference = Get-OptionalProperty -Value $pointer -Name 'pending'
$legacyApplication = Join-Path $portablePaths.App 'DSH Codex Desktop.exe'
# Full slot verification is read-only and outside the short pointer lock.
$launchSelection = Resolve-BestAvailableDesktopApplication -Pointer $pointer
$currentApplication = if ($launchSelection) { $launchSelection.Executable } else { $null }
if ($launchSelection -and $launchSelection.Source -ne 'pointer-current') {
  $recoveryLease = Open-DesktopPointerLease
  if ($null -eq $recoveryLease) { throw '桌面指针恢复正在等待另一更新事务，请稍后启动。' }
  try {
    $freshPointer = Get-DesktopPointer
    if (-not (Test-DesktopPointerSnapshotMatch $freshPointer $pointer) -or
        -not (Test-DesktopSlotIdentity -Reference $launchSelection.Reference -AsarSha256 $launchSelection.AsarSha256) -or
        ($launchSelection.Source -eq 'slot-scan' -and -not (Test-LocalDesktopSlotHealthy -Reference $launchSelection.Reference))) {
      throw '恢复验证期间桌面指针或槽身份变更，未覆盖新事务，请稍后启动。'
    }
    $pointer = Save-RecoveredDesktopPointer -Reference $launchSelection.Reference -Pointer $pointer -Source $launchSelection.Source -DowngradeReason ([string]$launchSelection.DowngradeReason)
    $pendingReference = Get-OptionalProperty -Value $pointer -Name 'pending'
  } finally { $recoveryLease.Dispose() }
}
if (-not $currentApplication -and (Test-Path -LiteralPath $legacyApplication -PathType Leaf)) {
  Write-LauncherLog '无可用不可变桌面槽，回退 legacy App（其中 dsh-runtime 可能落后于清单版本）。'
  $currentApplication = $legacyApplication
}

if ($RecoverPending) {
  if ($pendingReference) {
    $recoveryResult = Invoke-DesktopActivationPointerCas -ExpectedPointer $pointer -Action {
      param($freshPointer)
      Restore-CurrentDesktopPointer -Pointer $freshPointer -Detail '已撤销待部署桌面候选，当前已知可用槽保持不变。' | Out-Null
      return [pscustomobject]@{ Status = 'rolled-back' }
    }
    if ($recoveryResult.Status -notin @('rolled-back', 'committed')) { throw '恢复请求遇到指针变更，未撤销其他事务。' }
    Write-LauncherLog "已按恢复请求核对候选事务：$($pendingReference.transactionId)"
  }
  exit 0
}

if ($pendingReference) {
  Invoke-PendingDesktopActivation -Pointer $pointer -CurrentApplication $currentApplication
  exit 0
}

if (-not $currentApplication) {
  throw '未找到完整桌面程序槽（pointer/slots/App 均不可用）。请从发布包恢复 App 或有效 slots，用户数据仍完整保留在 Data。'
}

Clear-DesktopActivationEnvironment
Start-DesktopApplicationReliable -Executable $currentApplication | Out-Null
