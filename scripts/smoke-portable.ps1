[CmdletBinding()]
param([int]$StartupTimeoutSeconds = 900)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $projectRoot 'Portable-Environment.ps1')
$portablePaths = Set-DshPortableEnvironment -PortableRoot $projectRoot
$verificationRoot = Join-Path $portablePaths.Data 'Verification'
New-Item -ItemType Directory -Path $verificationRoot -Force | Out-Null
$readyFile = Join-Path $verificationRoot 'startup-ready'
if (Test-Path -LiteralPath $readyFile) { Remove-Item -LiteralPath $readyFile -Force }

$env:DSH_DESKTOP_SMOKE_READY_FILE = $readyFile
$env:npm_config_offline = 'true'
$applicationPath = Join-Path $portablePaths.App 'DSH Codex Desktop.exe'
if (-not (Test-Path -LiteralPath $applicationPath -PathType Leaf)) { throw 'App 尚未部署。' }

$application = $null
$bootstrapProcessId = $null
try {
  $applicationArguments = @(
    '--user-data-dir="' + $portablePaths.UserData + '"'
    '--disk-cache-dir="' + $portablePaths.Cache + '"'
  )
  $application = Start-Process -FilePath $applicationPath -ArgumentList $applicationArguments -WorkingDirectory $portablePaths.Workspace -PassThru
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  $lastReport = Get-Date
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $readyFile)) {
    $application.Refresh()
    if ($application.HasExited) { throw "便携应用提前退出，退出码 $($application.ExitCode)。" }
    if (((Get-Date) - $lastReport).TotalSeconds -ge 10) {
      Write-Host '便携应用仍在初始化…'
      $lastReport = Get-Date
    }
    $bootstrap = Get-CimInstance Win32_Process | Where-Object {
      $_.ParentProcessId -eq $application.Id -and $_.CommandLine -like '*bootstrap.mjs*'
    } | Select-Object -First 1
    if ($bootstrap) { $bootstrapProcessId = $bootstrap.ProcessId }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $readyFile)) { throw "便携应用未在 $StartupTimeoutSeconds 秒内报告启动完成。" }

  $profileDir = Join-Path $portablePaths.DshHome 'profiles\web'
  $runtimeEntry = Join-Path $portablePaths.Data 'Runtime\dsh-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js'
  $modulesState = Join-Path $profileDir 'node_modules\.modules.yaml'
  if (-not (Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) { throw 'Profile 未写入 Data\DSH。' }
  if (-not (Test-Path -LiteralPath $runtimeEntry)) { throw '运行时未写入 Data\Runtime。' }
  if (-not (Test-Path -LiteralPath $modulesState)) { throw '插件状态未写入便携 Profile。' }
  $state = Get-Content -LiteralPath $modulesState -Raw
  $stateObject = $null
  try { $stateObject = $state | ConvertFrom-Json } catch { }
  if ($stateObject -and $stateObject.storeDir) {
    $recordedStore = [System.IO.Path]::GetFullPath([string]$stateObject.storeDir)
  } else {
    $storeMatch = [regex]::Match($state, '(?im)^storeDir:\s*["'']?(?<path>.+?)["'']?\s*$')
    if (-not $storeMatch.Success) { throw '插件状态文件既不是 pnpm JSON 也不是 YAML 格式。' }
    $recordedStore = [System.IO.Path]::GetFullPath($storeMatch.Groups['path'].Value)
  }
  $rootPrefix = $projectRoot.TrimEnd('\') + '\'
  if (-not $recordedStore.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'pnpm 状态没有使用当前便携根目录。' }

  $expectedPackages = @(
    '@michengai/dsh-codex-ui',
    '@michengai/dsh-im-connect',
    '@michengai/dsh-automation',
    '@michengai/dsh-skills-manager',
    '@michengai/dsh-archive-manager',
    '@michengai/dsh-agency-agents',
    'dsh-context',
    'dsh-better-sidebar',
    'dsh-mcp-connector',
    'dshmarket'
  )
  foreach ($package in $expectedPackages) {
    $manifest = Join-Path $profileDir ('node_modules\' + $package.Replace('/', '\') + '\package.json')
    if (-not (Test-Path -LiteralPath $manifest)) { throw "离线首启缺少插件：$package" }
  }
  Write-Host '便携首启验证通过：Profile、运行时、十个插件和 pnpm 路径均位于便携盘。' -ForegroundColor Green
} finally {
  if ($application) {
    $application.Refresh()
    if (-not $application.HasExited) {
      Stop-Process -Id $application.Id -Force -ErrorAction SilentlyContinue
      $application.WaitForExit(10000) | Out-Null
    }
  }
  if ($bootstrapProcessId) {
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $bootstrapProcessId -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $bootstrapProcessId -ErrorAction SilentlyContinue) {
      throw "DSH 子进程 $bootstrapProcessId 未随桌面端退出。"
    }
  }
}
