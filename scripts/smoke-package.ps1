[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$ApplicationPath,
  [string]$PortableRoot
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$resolvedApplication = (Resolve-Path -LiteralPath $ApplicationPath).Path
$tempBase = if ([string]::IsNullOrWhiteSpace($PortableRoot)) {
  [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
} else {
  $resolvedPortableRoot = (Resolve-Path -LiteralPath $PortableRoot).Path
  $diagnosticsRoot = Join-Path $resolvedPortableRoot 'Data\Updates\Desktop\diagnostics'
  New-Item -ItemType Directory -Path $diagnosticsRoot -Force | Out-Null
  [System.IO.Path]::GetFullPath($diagnosticsRoot)
}
$tempRoot = Join-Path $tempBase ("dsh-desktop-smoke-$([guid]::NewGuid().ToString('N'))")
$userDataDir = Join-Path $tempRoot 'Data\Electron\UserData'
$dshHome = Join-Path $tempRoot 'Data\DSH'
New-Item -ItemType Directory -Path $userDataDir, $dshHome -Force | Out-Null
$previousDshHome = $env:DSH_HOME
$previousPortableRoot = $env:DSH_PORTABLE_ROOT
$previousSmokeReadyFile = $env:DSH_DESKTOP_SMOKE_READY_FILE
$previousNpmOffline = $env:npm_config_offline
$previousDesktopWebPort = $env:DSH_DESKTOP_WEB_PORT
$env:DSH_HOME = $dshHome
$env:DSH_PORTABLE_ROOT = $tempRoot
$env:npm_config_offline = 'true'
$smokeReadyFile = Join-Path $userDataDir 'startup-ready'
$startupError = Join-Path $userDataDir 'startup-error.log'
$env:DSH_DESKTOP_SMOKE_READY_FILE = $smokeReadyFile
$application = $null
$bootstrapProcessId = $null
$startupTimeoutSeconds = 900
$unresponsiveSince = $null
$expectedNodeExecutable = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $resolvedApplication) 'resources\node\node.exe'))

function Find-SmokeBootstrapProcess {
  param(
    [Parameter(Mandatory)]
    [int]$RootProcessId,
    [Parameter(Mandatory)]
    [string]$ExpectedNodeExecutable
  )
  $processes = @(Get-CimInstance Win32_Process)
  $descendantIds = @($RootProcessId)
  do {
    $previousCount = $descendantIds.Count
    foreach ($process in $processes) {
      if ($descendantIds -contains [int]$process.ParentProcessId -and $descendantIds -notcontains [int]$process.ProcessId) {
        $descendantIds += [int]$process.ProcessId
      }
    }
  } while ($descendantIds.Count -gt $previousCount)

  $bootstrap = $processes | Where-Object {
    $descendantIds -contains [int]$_.ProcessId -and $_.CommandLine -like '*bootstrap.mjs*'
  } | Select-Object -First 1
  if ($null -ne $bootstrap) { return $bootstrap }

  # Electron may hand off to a replacement main process on Windows. Limit the
  # fallback to the exact Node executable bundled in this candidate so an
  # independently running portable desktop cannot be mistaken for the smoke run.
  return $processes | Where-Object {
    $_.CommandLine -like '*bootstrap.mjs*' -and
    -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath) -and
    [System.IO.Path]::GetFullPath([string]$_.ExecutablePath).Equals($ExpectedNodeExecutable, [System.StringComparison]::OrdinalIgnoreCase)
  } | Select-Object -First 1
}

function Invoke-SmokeWebRequest {
  param(
    [Parameter(Mandatory)]
    [string]$Uri,
    [int]$TimeoutSec = 10
  )
  $handler = New-Object System.Net.Http.HttpClientHandler
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
  try {
    # HttpClient does not throw for HTTP 401 and applies its timeout while the
    # complete response body is buffered. This avoids Invoke-WebRequest's
    # version-dependent error objects and its hanging progress reader.
    $response = $client.GetAsync($Uri).GetAwaiter().GetResult()
    try {
      return [pscustomobject]@{
        StatusCode = [int]$response.StatusCode
        Content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      }
    } finally {
      $response.Dispose()
    }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Get-AvailableLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return [int]$listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Remove-SmokeDirectory {
  param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [string]$AllowedBase
  )
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  $resolvedBase = [System.IO.Path]::GetFullPath($AllowedBase).TrimEnd('\') + '\'
  if (-not $resolvedPath.StartsWith($resolvedBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理诊断根目录以外的路径：$resolvedPath"
  }
  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    if (-not [System.IO.Directory]::Exists($resolvedPath)) { return }
    $root = [System.IO.DirectoryInfo]::new($resolvedPath)
    foreach ($entry in $root.EnumerateFileSystemInfos('*', [System.IO.SearchOption]::AllDirectories)) {
      try { $entry.Attributes = [System.IO.FileAttributes]::Normal } catch { }
    }
    $root.Attributes = [System.IO.FileAttributes]::Directory
    try {
      [System.IO.Directory]::Delete($resolvedPath, $true)
      return
    } catch {
      if ($attempt -eq 3) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
}

try {
  $smokePort = Get-AvailableLoopbackPort
  $env:DSH_DESKTOP_WEB_PORT = [string]$smokePort
  $application = Start-Process -FilePath $resolvedApplication -ArgumentList "--user-data-dir=$userDataDir" -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds($startupTimeoutSeconds)
  $serviceReady = $false
  while ((Get-Date) -lt $deadline -and -not $serviceReady) {
    if (Test-Path -LiteralPath $startupError) {
      throw "桌面应用启动失败：$((Get-Content -LiteralPath $startupError -Raw).Trim())"
    }
    $application.Refresh()
    if ($application.HasExited) { throw '打包应用在初始化期间意外退出。' }
    if ($application.MainWindowHandle -ne 0 -and -not $application.Responding) {
      if ($null -eq $unresponsiveSince) { $unresponsiveSince = Get-Date }
      if (((Get-Date) - $unresponsiveSince).TotalSeconds -ge 10) {
        throw '便携版首启窗口连续 10 秒未响应。'
      }
    } else {
      $unresponsiveSince = $null
    }
    $bootstrap = Find-SmokeBootstrapProcess -RootProcessId $application.Id -ExpectedNodeExecutable $expectedNodeExecutable
    if ($null -ne $bootstrap) { $bootstrapProcessId = $bootstrap.ProcessId }
    try {
      $candidate = Invoke-SmokeWebRequest -Uri "http://127.0.0.1:$smokePort/" -TimeoutSec 2
      $serviceReady = $candidate.StatusCode -eq 200 -or ($candidate.StatusCode -eq 401 -and $candidate.Content -match 'dsh web authentication required')
    } catch {
      # DSH 仍在启动；下一轮继续检查固定的隔离端口。
    }
    if (-not $serviceReady) { Start-Sleep -Milliseconds 500 }
  }
  if (-not $serviceReady) { throw "打包应用在 $startupTimeoutSeconds 秒内未启动本机 HTTP 服务。" }

  $baseUrl = "http://127.0.0.1:$smokePort"
  $page = Invoke-SmokeWebRequest -Uri "$baseUrl/"
  if ($page.StatusCode -eq 401) {
    if ($page.Content -notmatch 'dsh web authentication required') {
      throw '根页面返回了未知的 HTTP 401 响应。'
    }
    # DSH 0.1.2-alpha.2+ 会把随机启动 token 只交给桌面 WebContents；
    # 外部冒烟请求没有它时必须被拒绝，同时应用必须仍保持运行。
    $application.Refresh()
    if ($application.HasExited) { throw '根页面通过鉴权拒绝后桌面应用意外退出。' }
  } else {
    if ($page.StatusCode -ne 200) { throw "根页面返回 HTTP $($page.StatusCode)。" }
    $asset = [regex]::Match($page.Content, '(?:src|href)=["''](?<path>/[^"'']+\.(?:js|css))')
    if (-not $asset.Success) { throw '根页面未找到可验证的前端资源。' }
    $assetResponse = Invoke-SmokeWebRequest -Uri "$baseUrl$($asset.Groups['path'].Value)"
    if ($assetResponse.StatusCode -ne 200) { throw "前端资源返回 HTTP $($assetResponse.StatusCode)。" }
  }

  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $smokeReadyFile)) {
    if (Test-Path -LiteralPath $startupError) {
      throw "桌面应用启动失败：$((Get-Content -LiteralPath $startupError -Raw).Trim())"
    }
    $application.Refresh()
    if ($application.HasExited) { throw '桌面应用在报告启动完成前意外退出。' }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath $smokeReadyFile)) { throw "桌面应用未在 $startupTimeoutSeconds 秒内报告启动完成。" }

  $verifierPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\scripts\smoke-packaged-plugins.mjs'
  if (-not (Test-Path -LiteralPath $verifierPath -PathType Leaf)) { throw "未找到内置插件校验脚本：$verifierPath" }
  & node $verifierPath $dshHome
  if ($LASTEXITCODE -ne 0) { throw "内置插件校验失败，退出码：$LASTEXITCODE" }
} finally {
  if ($null -ne $application) {
    $application.Refresh()
    if (-not $application.HasExited) {
      Stop-Process -Id $application.Id -Force -ErrorAction SilentlyContinue
      $application.WaitForExit(10000) | Out-Null
    }
  }
  $bootstrapStillRunning = $false
  if ($null -ne $bootstrapProcessId) {
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $bootstrapProcessId -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $bootstrapProcessId -ErrorAction SilentlyContinue) {
      $bootstrapStillRunning = $true
    }
  }
  $env:DSH_HOME = $previousDshHome
  $env:DSH_PORTABLE_ROOT = $previousPortableRoot
  $env:DSH_DESKTOP_SMOKE_READY_FILE = $previousSmokeReadyFile
  $env:npm_config_offline = $previousNpmOffline
  $env:DSH_DESKTOP_WEB_PORT = $previousDesktopWebPort
  Remove-SmokeDirectory -Path $tempRoot -AllowedBase $tempBase
  if ($bootstrapStillRunning) { throw "DSH 引导进程 $bootstrapProcessId 未在应用退出后结束。" }
}

Write-Output 'SMOKE_PACKAGE_PASS: 离线冷启动、HTTP 鉴权、插件闭包和隔离目录清理均通过。'
