[CmdletBinding()]
param([switch]$SkipTests)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$portableRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
if ($SkipTests) { throw '-SkipTests 不允许发布或生成成功构建收据；请移除此参数后重新运行完整构建。' }
. (Join-Path $portableRoot 'Portable-Environment.ps1')
$portablePaths = Set-DshPortableEnvironment -PortableRoot $portableRoot
$buildCacheRoot = Join-Path $portablePaths.Development 'build-cache'
New-Item -ItemType Directory -Path $buildCacheRoot -Force | Out-Null
$buildLockPath = Join-Path $buildCacheRoot 'build.lock'
$buildLockStream = $null
$lockStarted = [System.Diagnostics.Stopwatch]::StartNew()
$waitReported = $false
while ($null -eq $buildLockStream) {
  try {
    # FileShare.None is released by Windows even when a build is interrupted.
    $buildLockStream = [System.IO.File]::Open($buildLockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    if ($lockStarted.Elapsed.TotalMinutes -ge 30) { throw '等待另一个便携构建结束超时。' }
    if (-not $waitReported) {
      Write-Host '另一个便携构建正在使用共享产物，本次等待它完成。' -ForegroundColor Yellow
      $waitReported = $true
    }
    Start-Sleep -Milliseconds 1000
  }
}
$buildStartedAt = [DateTime]::UtcNow.ToString('o')
$buildPhases = New-Object 'System.Collections.Generic.List[object]'
function Get-DshBuildFileSha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)
  # No module autoload: Node/CMD callers may inherit PowerShell 7 module paths.
  $stream = $null
  $sha = $null
  try {
    $stream = [System.IO.File]::OpenRead($LiteralPath)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
  } finally {
    if ($null -ne $sha) { $sha.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}
function Invoke-DshBuildPhase {
  param([string]$Name, [scriptblock]$Action)
  $phaseWatch = [System.Diagnostics.Stopwatch]::StartNew()
  $phaseSucceeded = $false
  Write-Host "开始：$Name"
  try {
    & $Action
    $phaseSucceeded = $true
  } finally {
    $phaseWatch.Stop()
    $buildPhases.Add([pscustomobject]@{ name = $Name; durationMs = [Math]::Round($phaseWatch.Elapsed.TotalMilliseconds); succeeded = $phaseSucceeded })
    Write-Host ("{0}：{1:N1} 秒" -f $Name, $phaseWatch.Elapsed.TotalSeconds)
  }
}
$buildSucceeded = $false
try {
$buildInputReceiptScript = Join-Path $portableRoot 'scripts\build-input-receipt.mjs'
$buildInputSnapshot = Join-Path $buildCacheRoot ('input-' + [guid]::NewGuid().ToString() + '.json')
if (-not (Test-Path -LiteralPath $buildInputReceiptScript -PathType Leaf)) { throw '缺少构建输入收据模块，拒绝暂存。' }
$initialManifestSha256 = Get-DshBuildFileSha256 -LiteralPath (Join-Path $portableRoot 'package.json')
$manifest = Get-Content -LiteralPath (Join-Path $portableRoot 'package.json') -Raw | ConvertFrom-Json
$nodeVersion = [string]$manifest.engines.node
$pnpmVersion = ([string]$manifest.packageManager).Split('@')[-1]
$toolsRoot = Join-Path $portableRoot 'Tools'
$nodeRoot = Join-Path $toolsRoot ('node-v' + $nodeVersion)
$nodeExecutable = Join-Path $nodeRoot 'node.exe'
$downloads = Join-Path $portablePaths.Development 'downloads'
New-Item -ItemType Directory -Path $downloads, $toolsRoot -Force | Out-Null

$expectedNodeHash = ([string]$manifest.config.bundledNodeSha256.'win32-x64').ToUpperInvariant()
$nodeNeedsInstall = -not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)
if (-not $nodeNeedsInstall) {
  $nodeNeedsInstall = (Get-DshBuildFileSha256 -LiteralPath $nodeExecutable) -ne $expectedNodeHash
  if ($nodeNeedsInstall) { Write-Host "便携构建 Node 与清单不一致，将更新到 $nodeVersion。" -ForegroundColor Yellow }
}
if ($nodeNeedsInstall) {
  $archiveName = "node-v$nodeVersion-win-x64.zip"
  $archive = Join-Path $downloads $archiveName
  $downloadUri = "https://nodejs.org/dist/v$nodeVersion/$archiveName"
  Write-Host "正在把 Node.js $nodeVersion 下载到便携盘…"
  Invoke-WebRequest -Uri $downloadUri -OutFile $archive
  $stage = Join-Path $portablePaths.Development ('node-stage-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $stage
  $extracted = Join-Path $stage "node-v$nodeVersion-win-x64"
  $extractedNode = Join-Path $extracted 'node.exe'
  if (-not (Test-Path -LiteralPath $extractedNode)) { throw 'Node.js 解压结构无效。' }
  $actualHash = Get-DshBuildFileSha256 -LiteralPath $extractedNode
  if ($actualHash -ne $expectedNodeHash) { throw 'Node.js 可执行文件 SHA256 校验失败。' }
  if (Test-Path -LiteralPath $nodeRoot) {
    Move-Item -LiteralPath $nodeRoot -Destination (Join-Path $portablePaths.Development ('node-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')))
  }
  Move-Item -LiteralPath $extracted -Destination $nodeRoot
}

$pnpmRoot = Join-Path $toolsRoot ('pnpm-v' + $pnpmVersion)
$pnpmCommand = Join-Path $pnpmRoot 'pnpm.cmd'
if (-not (Test-Path -LiteralPath $pnpmCommand -PathType Leaf)) {
  Write-Host "正在把 pnpm $pnpmVersion 安装到便携盘…"
  & (Join-Path $nodeRoot 'npm.cmd') install --global "pnpm@$pnpmVersion" --prefix $pnpmRoot
  if ($LASTEXITCODE -ne 0) { throw '安装便携 pnpm 失败。' }
}

$env:PATH = "$nodeRoot;$pnpmRoot;$env:PATH"
# pnpm 11.24 不读 .npmrc 里的 fetch-timeout，也不接受 --config.X=number（传 string 会 TypeError）。
# 唯一稳定路径是 npm_config_* 环境变量；显式拉长避免 react-icons / node-pty / mermaid 等大 tarball 抖动失败。
$env:npm_config_fetch_timeout = '600000'
$env:npm_config_fetch_retries = '5'
# electron 二进制直连 GitHub Release 在便携环境常见超时（2026-09-09 实测 install.js fetch failed）。
# 未显式配置时回退 npmmirror 镜像，与 prepare-runtime 的 npmmirror 预取代理策略一致；显式设置优先。
if (-not $env:ELECTRON_MIRROR) {
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
}
$previousCi = $env:CI
$previousNpmExecPath = $env:npm_execpath
# 在第一次依赖/编译事务前捕获；工具下载不计作源码构建。
& $nodeExecutable $buildInputReceiptScript capture $portableRoot $buildInputSnapshot
if ($LASTEXITCODE -ne 0) { throw '构建输入捕获失败，禁止编译/暂存。' }
if ((Get-DshBuildFileSha256 -LiteralPath (Join-Path $portableRoot 'package.json')) -ne $initialManifestSha256) {
  throw '工具准备期间 package.json 已变更，请重新开始完整构建。'
}
Push-Location $portableRoot
try {
  # 构建器必须可从设置页、CI 或隐藏启动器无人值守运行。整个 pnpm
  # 事务保持 CI 模式，覆盖 run/test 内部触发的依赖状态检查和子 pnpm。
  $env:CI = 'true'
  Invoke-DshBuildPhase -Name '开发依赖检查与安装' -Action {
    $reuseDependencies = $false
    if ($env:DSH_BUILD_NO_CACHE -ne '1') {
      & $nodeExecutable (Join-Path $portableRoot 'src\build-cache.ts') dependencies-check $portableRoot
      if ($LASTEXITCODE -eq 0) { $reuseDependencies = $true }
      elseif ($LASTEXITCODE -ne 2) { throw '开发依赖缓存检查失败。' }
    }
    if ($reuseDependencies) { Write-Host '开发依赖输入和工具制品校验一致，复用已安装依赖。' }
    else {
      & $pnpmCommand install --frozen-lockfile
      if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败。' }
    }
  }
  $electronExecutable = Join-Path $portableRoot 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
    & $nodeExecutable (Join-Path $portableRoot 'node_modules\electron\install.js')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
      throw 'Electron 安装脚本未生成开发态可执行文件。'
    }
  }
  & $nodeExecutable (Join-Path $portableRoot 'src\build-cache.ts') dependencies-commit $portableRoot
  if ($LASTEXITCODE -ne 0) { throw '开发依赖安装结果校验失败。' }
  Invoke-DshBuildPhase -Name 'TypeScript 编译' -Action {
    & $nodeExecutable (Join-Path $portableRoot 'node_modules\typescript\bin\tsc')
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript 编译失败。' }
  }
  & $nodeExecutable $buildInputReceiptScript pin-compiled $portableRoot $buildInputSnapshot
  if ($LASTEXITCODE -ne 0) { throw '编译产物封存失败，禁止测试/打包/暂存。' }
  Invoke-DshBuildPhase -Name '定制源码保护门禁' -Action {
    & $nodeExecutable (Join-Path $portableRoot 'dist\scripts\check-customization-preservation.js') --source-only
    if ($LASTEXITCODE -ne 0) { throw '定制源码保护检查失败，禁止发布回退的界面或功能。' }
    # 社区包就地补丁的实机校验：--verify 只读不改。缺失或上游变形即阻断发布，
    # 避免「补丁在某家园丢了却照样打包出候选」——这正是 2026-09-28 修过、09-30 复发的那一类。
    & $nodeExecutable (Join-Path $portableRoot 'customizations\codex-ui-patches\apply.mjs') --verify --root $portableRoot
    if ($LASTEXITCODE -ne 0) { throw '社区包补丁（codex-ui 插件配置分区）校验失败，禁止发布；修复：node customizations/codex-ui-patches/apply.mjs' }
  }
  if (-not $SkipTests) {
    Invoke-DshBuildPhase -Name '全量测试门禁' -Action {
      & $nodeExecutable (Join-Path $portableRoot 'scripts\run-tests.mjs')
      if ($LASTEXITCODE -ne 0) { throw '测试失败，未部署新构建。' }
    }
  }
  # Direct assembly still receives the pnpm entry required to materialize its offline toolchain.
  $env:npm_execpath = Join-Path $pnpmRoot 'node_modules\pnpm\bin\pnpm.mjs'
  if (-not (Test-Path -LiteralPath $env:npm_execpath -PathType Leaf)) {
    $env:npm_execpath = Join-Path $pnpmRoot 'node_modules\pnpm\bin\pnpm.cjs'
  }
  if (-not (Test-Path -LiteralPath $env:npm_execpath -PathType Leaf)) { throw '未找到清单 pnpm 的 Node 入口。' }
  Invoke-DshBuildPhase -Name '运行时装配或缓存复用' -Action {
    & $nodeExecutable (Join-Path $portableRoot 'dist\scripts\prepare-runtime.js')
    if ($LASTEXITCODE -ne 0) { throw '运行时装配失败。' }
  }
  Invoke-DshBuildPhase -Name '桌面打包' -Action {
    & $pnpmCommand exec electron-builder --dir --publish never
    if ($LASTEXITCODE -ne 0) { throw '桌面端打包失败。' }
  }
} finally {
  $env:CI = $previousCi
  $env:npm_execpath = $previousNpmExecPath
  Pop-Location
}

$builtApp = Join-Path $portableRoot 'release\win-unpacked'
if (-not (Test-Path -LiteralPath (Join-Path $builtApp 'DSH Codex Desktop.exe') -PathType Leaf)) {
  throw '未找到 release\win-unpacked 构建结果。'
}
Invoke-DshBuildPhase -Name '设置拆分制品一致性' -Action {
  & $nodeExecutable (Join-Path $portableRoot 'scripts\verify-settings-split-payload.mjs') --app $builtApp --root $portableRoot
  if ($LASTEXITCODE -ne 0) { throw '设置拆分配套不一致，禁止暂存会回退的候选。' }
}
Write-Host "源码构建及门禁已完成：$builtApp" -ForegroundColor Green
Write-Host '正在把本地构建送入统一 A/B 候选槽（不会覆盖或结束当前 App）…'
Invoke-DshBuildPhase -Name '候选预热与暂存' -Action {
  & $nodeExecutable (Join-Path $portableRoot 'dist\scripts\check-customization-preservation.js') --source-only
  if ($LASTEXITCODE -ne 0) { throw '候选暂存前定制保护检查失败。' }
  & $nodeExecutable $buildInputReceiptScript stage $portableRoot $builtApp $buildInputSnapshot ([string]$manifest.version) full
  if ($LASTEXITCODE -ne 0) { throw '本地构建未能进入 A/B 候选槽。' }
}
$buildSucceeded = $true
Write-Host '候选已暂存。请从托盘正常退出或使用“重启应用”；启动器会部署、验证，失败时自动回滚。' -ForegroundColor Yellow
} finally {
  try {
    $buildReport = [pscustomobject]@{ schema = 1; startedAt = $buildStartedAt; finishedAt = [DateTime]::UtcNow.ToString('o'); succeeded = $buildSucceeded; phases = $buildPhases.ToArray() }
    [System.IO.File]::WriteAllText((Join-Path $buildCacheRoot 'build-metrics.json'), ($buildReport | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
  } finally {
    $buildLockStream.Dispose()
  }
}
