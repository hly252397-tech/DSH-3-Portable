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

function Resolve-SlotApplication {
  param($Reference)
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
        $candidateFile = [System.IO.Path]::GetFullPath((Join-Path $directory $relative.Replace('/', '\')))
        if (-not $candidateFile.StartsWith($directory.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
        if ((Get-Sha256Hex -Path $candidateFile) -ne ([string]$property.Value).ToLowerInvariant()) { return $null }
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

function Set-UpdateState {
  param([string]$Phase, [int]$Overall, [int]$Stage, [string]$Detail, $Pointer)
  $currentReference = Get-OptionalProperty -Value $Pointer -Name 'current'
  $pendingReference = Get-OptionalProperty -Value $Pointer -Name 'pending'
  $currentVersion = if ($currentReference) { [string]$currentReference.version } else { '0.0.0' }
  $targetVersion = if ($pendingReference) { [string]$pendingReference.version } else { $null }
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
  param($Pointer, [string]$Detail)
  $rolledBackPointer = [ordered]@{
    schema = 1
    current = $Pointer.current
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $previousReference = Get-OptionalProperty -Value $Pointer -Name 'previous'
  if ($previousReference) { $rolledBackPointer.previous = $previousReference }
  Save-JsonAtomic -Value $rolledBackPointer -Path $pointerPath
  Set-UpdateState -Phase 'rolled-back' -Overall 100 -Stage 100 -Detail $Detail -Pointer $rolledBackPointer
  return $rolledBackPointer
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

$pointer = Get-DesktopPointer
$pendingReference = Get-OptionalProperty -Value $pointer -Name 'pending'
$legacyApplication = Join-Path $portablePaths.App 'DSH Codex Desktop.exe'
$currentApplication = if ($pointer) { Resolve-SlotApplication $pointer.current } else { $null }
if (-not $currentApplication -and (Test-Path -LiteralPath $legacyApplication -PathType Leaf)) {
  $currentApplication = $legacyApplication
}

if ($RecoverPending) {
  if ($pendingReference) {
    Restore-CurrentDesktopPointer -Pointer $pointer -Detail '已撤销待部署桌面候选，当前已知可用槽保持不变。' | Out-Null
    Write-LauncherLog "已按恢复请求撤销候选事务：$($pendingReference.transactionId)"
  }
  exit 0
}

if ($pendingReference) {
  $candidateApplication = Resolve-SlotApplication $pendingReference
  if ($candidateApplication) {
    $transactionId = [string]$pendingReference.transactionId
    $healthRoot = Join-Path $desktopUpdateRoot ('transactions\' + $transactionId)
    $healthFile = Join-Path $healthRoot 'health.json'
    $progressFile = Join-Path $healthRoot 'startup-progress.json'
    $attemptFile = Join-Path $healthRoot 'activation-attempt.json'
    New-Item -ItemType Directory -Path $healthRoot -Force | Out-Null
    Remove-Item -LiteralPath $healthFile,$progressFile -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $attemptFile -PathType Leaf) {
      Write-LauncherLog "候选事务已经尝试过且未提交，拒绝重复启动并回退：$transactionId"
      Restore-CurrentDesktopPointer -Pointer $pointer -Detail '候选桌面上次未完成启动验证，已阻止重复尝试并恢复当前槽。' | Out-Null
      if ($currentApplication) {
        Clear-DesktopActivationEnvironment
        Start-DesktopApplicationReliable -Executable $currentApplication | Out-Null
      }
      exit 0
    }
    Save-JsonAtomic -Value ([ordered]@{
      schema = 1
      transactionId = $transactionId
      startedAt = (Get-Date).ToUniversalTime().ToString('o')
    }) -Path $attemptFile
    [Environment]::SetEnvironmentVariable('DSH_DESKTOP_UPDATE_TRANSACTION', $transactionId, 'Process')
    [Environment]::SetEnvironmentVariable('DSH_DESKTOP_UPDATE_HEALTH_FILE', $healthFile, 'Process')
    Set-UpdateState -Phase 'validating' -Overall 97 -Stage 20 -Detail '候选桌面正在启动并验证 DSH readiness。' -Pointer $pointer
    Write-LauncherLog "启动候选槽：$($pendingReference.relativePath)"
    $candidate = Start-DesktopApplication -Executable $candidateApplication -PassThru
    $leaseDeadline = (Get-Date).AddMinutes(3)
    $hardDeadline = (Get-Date).AddMinutes(15)
    $lastProgressWriteUtc = [datetime]::MinValue
    while ((Get-Date) -lt $hardDeadline) {
      if (Test-Path -LiteralPath $healthFile -PathType Leaf) {
        Write-LauncherLog "候选槽验证通过：$($pendingReference.version)"
        exit 0
      }
      if ($candidate.HasExited) { break }
      if (Test-Path -LiteralPath $progressFile -PathType Leaf) {
        $progressWriteUtc = (Get-Item -LiteralPath $progressFile).LastWriteTimeUtc
        if ($progressWriteUtc -gt $lastProgressWriteUtc) {
          $lastProgressWriteUtc = $progressWriteUtc
          $leaseDeadline = (Get-Date).AddMinutes(3)
        }
      }
      if ((Get-Date) -ge $leaseDeadline) { break }
      Start-Sleep -Milliseconds 500
      try { $candidate.Refresh() } catch { }
    }

    Write-LauncherLog "候选槽未通过启动验证，执行自动回退：$($pendingReference.version)"
    # 先撤销 pending，确保即便候选清理意外中断启动器也不会重复启动坏槽。
    Restore-CurrentDesktopPointer -Pointer $pointer -Detail '候选桌面启动验证失败，已自动恢复上一已知可用槽。' | Out-Null
    if (-not $candidate.HasExited) {
      try { $candidate.CloseMainWindow() | Out-Null } catch { }
      try { if (-not $candidate.WaitForExit(8000)) { & taskkill.exe /PID $candidate.Id /T /F | Out-Null } } catch { }
    }
    Clear-DesktopActivationEnvironment
    if ($currentApplication) {
      Start-DesktopApplicationReliable -Executable $currentApplication | Out-Null
      exit 0
    }
    throw '候选验证失败，且没有可启动的上一桌面槽。'
  }
  Write-LauncherLog '待部署桌面槽未通过完整性验证，已撤销候选并保留当前版本。'
  Restore-CurrentDesktopPointer -Pointer $pointer -Detail '候选桌面完整性验证失败，已自动恢复上一已知可用槽。' | Out-Null
}

if (-not $currentApplication) {
  throw '未找到完整桌面程序槽。请从发布包恢复 App，用户数据仍完整保留在 Data。'
}

Clear-DesktopActivationEnvironment
Start-DesktopApplicationReliable -Executable $currentApplication | Out-Null
