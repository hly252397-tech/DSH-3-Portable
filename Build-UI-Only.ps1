[CmdletBinding()]
param(
  [switch]$DryRun,       # 只做门禁检查与差异报告，不复制、不暂存
  [switch]$SkipStage,    # 复制素材后不暂存候选槽（只刷新 release\win-unpacked）
  [switch]$Force         # 兼容旧调用参数；不得绕过质量或定制保护门禁
)

# ============================================================================
#  界面快通道 · Build-UI-Only
#
#  适用：只改了 assets\ 下的界面素材（shell.html / theme.css / browser-* / 图标 …）。
#  原理：assets\* 在 package.json 的 build.extraResources 里是「原样复制」，
#        不参与 asar / tsc / 运行时装配。所以把差异文件直接铺进
#        release\win-unpacked\resources\ 再走候选槽暂存即可，
#        整条 prepare-runtime + electron-builder 全量管线（约 20-40 分钟）可跳过。
#
#  不适用（会被门禁拦下）：改了 src\*.ts / scripts\*.ts / package.json / 依赖。
#        这些必须跑 Build-DSH-Portable.cmd 重新出 app.asar 与 desktop-bridge。
# ============================================================================

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$portableRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)

$script:blockers = @()
$script:notices  = @()

function Write-Head([string]$text) {
  Write-Host ''
  Write-Host "=== $text ===" -ForegroundColor Cyan
}
function Write-Ok([string]$text)    { Write-Host "  [ OK ] $text" -ForegroundColor Green }
function Write-Warn2([string]$text) { Write-Host "  [ .. ] $text" -ForegroundColor Yellow }
function Write-Bad([string]$text)   { Write-Host "  [FAIL] $text" -ForegroundColor Red }
function Write-Dim([string]$text)   { Write-Host "         $text" -ForegroundColor DarkGray }

function Get-ContentSHA256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Test-NeedsCopy {
  param(
    [System.IO.FileInfo]$SourceFile,
    [string]$TargetPath
  )
  if (-not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) { return $true }
  $target = Get-Item -LiteralPath $TargetPath
  if ($target.Length -ne $SourceFile.Length) { return $true }
  # size/mtime 不是内容证据；等长且同时间戳也可能已被替换。
  return (Get-ContentSHA256 $SourceFile.FullName) -ne (Get-ContentSHA256 $TargetPath)
}

function Open-UIBuildLock([string]$Root, [bool]$Preview) {
  # 与全量构建共用同一把独占锁。预览不得创建锁文件或目录。
  if ($Preview) { return $null }
  $cacheRoot = Join-Path $Root 'Data\Development\build-cache'
  if (-not (Test-Path -LiteralPath $cacheRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
  }
  $lockPath = Join-Path $cacheRoot 'build.lock'
  try {
    return [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    throw "构建锁不可获取（可能有另一构建正在运行）：$lockPath。未复制或暂存，请待其完成后重试。"
  }
}

function Assert-UIBuildVerdict([object[]]$Blockers, [bool]$LegacyForce) {
  if ($Blockers.Count -gt 0) {
    throw "界面快通道门禁未通过：$($Blockers -join '; ')。请先完成全量构建；-Force 不允许绕过门禁。"
  }
}

function Invoke-UIProtectionGates([string]$Root, [string]$Node, [string]$Resources) {
  $checker = Join-Path $Root 'dist\scripts\check-customization-preservation.js'
  $candidateManifest = Join-Path $Resources 'preservation.json'
  foreach ($required in @($checker, $candidateManifest)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "定制保护门禁输入缺失：$required" }
    if (((Get-Item -LiteralPath $required).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "定制保护门禁输入不得为重解析链接：$required"
    }
  }
  $previousLocation = Get-Location
  Set-Location -LiteralPath $Root
  try {
    # 仅读，不编译、不更新基线。旧 dist 不允许充当本次源码的门禁。
    & $Node --input-type=module -e "import { assertFreshTestBuild } from './scripts/lib/test-build-freshness.mjs'; assertFreshTestBuild(process.cwd())"
    if ($LASTEXITCODE -ne 0) { throw "编译新鲜度门禁失败（退出码 $LASTEXITCODE），请先统一编译。" }
    & $Node (Join-Path $Root 'scripts\ui-baseline.mjs') --source-only
    if ($LASTEXITCODE -ne 0) { throw "UI 源码基线门禁失败（退出码 $LASTEXITCODE）。" }
    & $Node $checker --root $Root
    if ($LASTEXITCODE -ne 0) { throw "定制源码/活动 Profile 保护门禁失败（退出码 $LASTEXITCODE）。" }
    & $Node $checker --root $Root --candidate-manifest $candidateManifest
    if ($LASTEXITCODE -ne 0) { throw "既有打包资源 preservation.json 不符合当前登记（退出码 $LASTEXITCODE）；必须重新全量构建。" }
  } finally {
    Set-Location -LiteralPath $previousLocation
  }
}

function Assert-UIReceiptGate([string]$Node, [string]$Script, [string]$Root, [string]$App) {
  & $Node $Script verify-ui $Root $App
  if ($LASTEXITCODE -ne 0) { throw '现有源码与 app.asar 成功收据不一致；请先完成全量构建。-Force 不允许绕过。' }
}

# 判定一处工作区改动对「能否只走界面快通道」的影响：
#   block  —— 会进入 app.asar / resources\desktop-bridge，必须全量构建
#   notice —— 不影响打包产物，仅提示
#   skip   —— 与交付无关（文档、记忆、产物、本脚本自身）
function Get-DirtyVerdict([string]$path) {
  if ($path -like 'assets/*') { return 'skip' }
  # 进入 asar / desktop-bridge 的源码与编译输入
  if ($path -like 'src/*') { return 'block' }
  if ($path -like 'scripts/*' -and $path -match '\.(?:ts|tsx|mts|cts|js|mjs|cjs)$') { return 'block' }
  if ($path -like 'plugins/*' -or $path -like 'customizations/*') { return 'block' }
  if ($path -eq 'package.json' -or $path -eq 'tsconfig.json' -or
      $path -eq 'pnpm-lock.yaml' -or $path -eq 'pnpm-workspace.yaml') { return 'block' }
  if ($path -like 'node_modules/*') { return 'block' }
  # 无交付价值
  if ($path -like 'Build-UI-Only.*') { return 'skip' }
  if ($path -like 'docs/*' -or $path -like '.workbuddy/*' -or $path -like 'artifacts/*' -or
      $path -like '.tmp/*' -or $path -like '*.md' -or $path -like '_p3tw_*') { return 'skip' }
  return 'notice'
}

function Resolve-GitExe {
  $cmd = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    'C:\Program Files\Git\cmd\git.exe',
    'C:\Program Files (x86)\Git\cmd\git.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe'),
    'C:\Program Files\Git\bin\git.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

# 所有可能写入的路径都受此锁及 finally 约束；不静默等待其他构建。
$buildLockStream = $null
try {
$buildLockStream = Open-UIBuildLock $portableRoot ([bool]$DryRun)
if ($Force) { Write-Warn2 '-Force 仅兼容旧参数，不绕过任何门禁。' }

# --- 0. 基础前置 -------------------------------------------------------------
Write-Head '0/5 前置检查'

$manifestPath = Join-Path $portableRoot 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "找不到 package.json：$manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
Write-Ok "版本 $version"

$assetsRoot = Join-Path $portableRoot 'assets'
if (-not (Test-Path -LiteralPath $assetsRoot -PathType Container)) { throw "找不到 assets 目录：$assetsRoot" }
Write-Ok 'assets 目录存在'

$builtApp = Join-Path $portableRoot 'release\win-unpacked'
$resourcesRoot = Join-Path $builtApp 'resources'
$builtExe = Join-Path $builtApp 'DSH Codex Desktop.exe'
$asarPath = Join-Path $resourcesRoot 'app.asar'
foreach ($required in @($builtApp, $resourcesRoot, $builtExe, $asarPath)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "缺少既有全量构建产物：$required`n界面快通道是在已有打包结果上做增量替换，请先跑一次 Build-DSH-Portable.cmd。"
  }
}
Write-Ok "既有打包产物就绪：release\win-unpacked"

# 门禁解释器必须与清单一致。原先这里写死 Tools\node\node.exe，而该目录在 2026-09-29
# 实测停在 v24.21.0、哈希 BA4E6D11… 已不命中 package.json 的
# config.bundledNodeSha256['win32-x64']（CEA6AC36… = v26.10.0）——于是 UI 快通道与
# scripts/gates.mjs / run-tests.mjs 会在两个不同 Node 版本上跑同一批门禁
# （Codex 2026-09-26 独立复核已指出该分裂）。这里改为向唯一事实源
# scripts/lib/gate-node.mjs 问 GATE_NODE，不再本地另实现一套候选顺序。
$gateNodeResolver = Join-Path $portableRoot 'scripts\lib\gate-node.mjs'
$bootstrapNode = Join-Path $portableRoot 'Tools\node\node.exe'
if (-not (Test-Path -LiteralPath $gateNodeResolver -PathType Leaf)) {
  throw "找不到门禁 Node 解析器：$gateNodeResolver（仓库不完整，先跑一次 Build-DSH-Portable.cmd）"
}
if (-not (Test-Path -LiteralPath $bootstrapNode -PathType Leaf)) {
  throw "找不到引导 Node：$bootstrapNode（先跑一次 Build-DSH-Portable.cmd 生成）"
}
# 用引导 Node 只做一次「问路」：import GATE_NODE 并打印路径。它对不匹配清单的候选会直接
# 抛错（不降级为未校验门禁），所以这里失败就是真失败，不会静默换版本。相对 specifier 按
# 工作目录解析，因此先切到便携根。
$previousLocation = Get-Location
Set-Location -LiteralPath $portableRoot
try {
  $gateNode = (& $bootstrapNode -e "import('./scripts/lib/gate-node.mjs').then(m => process.stdout.write(m.GATE_NODE))" 2>&1 | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0) { throw "门禁 Node 解析失败（退出码 $LASTEXITCODE）。" }
} finally {
  Set-Location -LiteralPath $previousLocation
}
if (-not $gateNode -or -not (Test-Path -LiteralPath $gateNode -PathType Leaf)) {
  throw "无法解析与清单一致的门禁 Node（gate-node.mjs 拒绝了全部候选）。原始输出：$gateNode"
}
$nodeExecutable = $gateNode
Write-Ok "门禁 Node：$nodeExecutable（与 package.json 清单哈希一致）"
$stageScript = Join-Path $portableRoot 'dist\scripts\stage-local-desktop-candidate.js'
if (-not (Test-Path -LiteralPath $stageScript -PathType Leaf)) {
  throw "找不到候选槽暂存脚本：$stageScript（先跑一次 Build-DSH-Portable.cmd 生成）"
}
Write-Ok '便携 Node 与暂存脚本就绪'

# --- 1. 门禁 A：工作区是否有「非界面」的未打包改动 ---------------------------
Write-Head '1/5 门禁A · 未打包的源码改动'

$git = Resolve-GitExe
$dirty = @()
if ($null -eq $git) {
  throw '未找到 git，无法执行源码改动门禁；拒绝界面快通道。'
} else {
  Write-Ok "git：$git"
  $previousEncoding = [Console]::OutputEncoding
  try {
    # git 以 UTF-8 输出路径；PS 5.1 默认按 ANSI 解码会把中文路径变成八进制串
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $raw = & $git -c core.quotepath=false -C $portableRoot status --porcelain 2>$null
    if ($LASTEXITCODE -ne 0) { throw "git 状态检查失败（退出码 $LASTEXITCODE）；拒绝跳过门禁。" }
  } finally {
    [Console]::OutputEncoding = $previousEncoding
  }
  foreach ($line in $raw) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.Length -lt 4) { continue }
    $status = $line.Substring(0, 2).Trim()
    $path = $line.Substring(3).Trim().Trim('"')
    $path = $path -replace '\\', '/'
    # rename 的旧、新路径都必须检查，不能以 assets -> src 的旧路径绕过。
    foreach ($changedPath in ($path -split ' -> ')) {
      $dirty += [pscustomobject]@{ Status = $status; Path = $changedPath.Trim('"') }
    }
  }

  foreach ($item in $dirty) {
    $verdict = Get-DirtyVerdict $item.Path
    if ($verdict -eq 'block') {
      # Git dirty 并不等于未构建：内容收据将严格证明它是否已进入当前 asar。
      $script:notices += "源码改动（须与成功收据一致）：$($item.Status) $($item.Path)"
    } elseif ($verdict -eq 'notice') {
      $script:notices += "$($item.Status) $($item.Path)"
    }
  }
}

if ($script:blockers.Count -gt 0) {
  Write-Bad "发现 $($script:blockers.Count) 项必须重新打包 app.asar / desktop-bridge 的改动："
  foreach ($item in $script:blockers) { Write-Dim $item }
  Write-Host ''
  Write-Dim '这些改动不会随界面快通道生效。'
} elseif ($null -ne $git) {
  Write-Ok '除 assets\ 外没有需要重新打包的改动'
}

# --- 2. 门禁 B：dist 是否比 app.asar 新（tsc 跑了但没重新打包） -------------
Write-Head '2/5 门禁B · 编译产物是否领先于打包产物'

$distDirs = @(
  (Join-Path $portableRoot 'dist\src'),
  (Join-Path $portableRoot 'dist\scripts')
)
foreach ($dir in $distDirs) {
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "编译产物目录缺失：$dir；拒绝跳过门禁。" }
}

$newestDist = $null
foreach ($dir in $distDirs) {
  $file = Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -ne $file -and ($null -eq $newestDist -or $file.LastWriteTime -gt $newestDist.LastWriteTime)) {
    $newestDist = $file
  }
}

if ($null -eq $newestDist) {
  throw '未找到 dist 编译文件；拒绝跳过门禁B。'
} else {
  $asarTime = (Get-Item -LiteralPath $asarPath).LastWriteTime
  Write-Dim ("dist 最新：{0}  ({1})" -f $newestDist.LastWriteTime.ToString('MM-dd HH:mm:ss'), $newestDist.Name)
  Write-Dim ("app.asar ：{0}" -f $asarTime.ToString('MM-dd HH:mm:ss'))
  if ($newestDist.LastWriteTime -gt $asarTime.AddSeconds(2)) {
    $lead = [math]::Round(($newestDist.LastWriteTime - $asarTime).TotalMinutes, 1)
    $script:notices += "dist 时间戳领先 app.asar $lead 分钟（由输入/ASAR 内容收据裁决，不能以 mtime 放行或误阻）"
    Write-Warn2 "dist 领先 app.asar $lead 分钟；继续以内容收据核实"
  } else {
    Write-Ok 'app.asar 不落后于 dist'
  }
}

# --- 门禁裁决 ---------------------------------------------------------------
if ($script:blockers.Count -gt 0) {
  Write-Head '门禁未通过'
  Write-Host ''
  Write-Host '  界面快通道只能携带 assets\ 下的素材。上面的改动需要走全量构建：' -ForegroundColor Yellow
  Write-Host '      Build-DSH-Portable.cmd' -ForegroundColor White
  Write-Host ''
  Write-Dim '-Force 不能跳过门禁，也不能携带未打包源码。'
}
Assert-UIBuildVerdict $script:blockers ([bool]$Force)
Invoke-UIProtectionGates $portableRoot $nodeExecutable $resourcesRoot
$buildInputReceiptScript = Join-Path $portableRoot 'scripts\build-input-receipt.mjs'
if (-not (Test-Path -LiteralPath $buildInputReceiptScript -PathType Leaf)) { throw '缺少构建输入收据模块。' }
Assert-UIReceiptGate $nodeExecutable $buildInputReceiptScript $portableRoot $builtApp
Write-Ok '编译新鲜度、UI 源码、活动 Profile 与候选资源定制保护均通过'

# --- 3. 计算素材差异 --------------------------------------------------------
Write-Head '3/5 assets → release\win-unpacked\resources 差异'

$mappings = @()
foreach ($entry in $manifest.build.extraResources) {
  $from = [string]$entry.from
  if (-not $from.StartsWith('assets/')) { continue }
  $sourcePath = Join-Path $portableRoot ($from -replace '/', '\')
  if (-not (Test-Path -LiteralPath $sourcePath)) { throw "已登记的界面资源缺失：$sourcePath" }
  $mappings += [pscustomobject]@{
    From = $sourcePath
    FromLabel = $from
    To = Join-Path $resourcesRoot ([string]$entry.to -replace '/', '\')
  }
}

$pending = @()
$unchanged = 0
$coveredSources = @()

foreach ($map in $mappings) {
  $sourceIsDir = Test-Path -LiteralPath $map.From -PathType Container
  $files = @()
  if ($sourceIsDir) {
    $coveredSources += [pscustomobject]@{ Path = $map.FromLabel.TrimEnd('/'); IsDir = $true }
    $files = Get-ChildItem -LiteralPath $map.From -Recurse -File
    foreach ($file in $files) {
      $rel = $file.FullName.Substring($map.From.Length).TrimStart('\')
      $target = Join-Path $map.To $rel
      if (Test-NeedsCopy $file $target) {
        $pending += [pscustomobject]@{ Src = $file.FullName; Dst = $target; Label = "$($map.FromLabel)/$($rel -replace '\\','/')" }
      } else { $unchanged++ }
    }
  } else {
    $coveredSources += [pscustomobject]@{ Path = $map.FromLabel; IsDir = $false }
    $file = Get-Item -LiteralPath $map.From
    if (Test-NeedsCopy $file $map.To) {
      $pending += [pscustomobject]@{ Src = $file.FullName; Dst = $map.To; Label = $map.FromLabel }
    } else { $unchanged++ }
  }
}

if ($pending.Count -eq 0) {
  Write-Ok "没有差异（$unchanged 个素材与运行目录一致）"
} else {
  Write-Warn2 "待同步 $($pending.Count) 个（另有 $unchanged 个一致）："
  foreach ($item in $pending) { Write-Dim $item.Label }
}

# assets 下未纳入打包的素材：改了也不会生效
$orphans = @()
foreach ($file in Get-ChildItem -LiteralPath $assetsRoot -Recurse -File) {
  $rel = '/' + ($file.FullName.Substring($assetsRoot.Length).TrimStart('\') -replace '\\', '/')
  $matched = $false
  foreach ($covered in $coveredSources) {
    $sub = $covered.Path.Substring('assets/'.Length)
    if ($covered.IsDir) {
      if ($rel.StartsWith('/' + $sub + '/')) { $matched = $true; break }
    } elseif ($rel -eq ('/' + $sub)) { $matched = $true; break }
  }
  if (-not $matched) { $orphans += ('assets' + $rel) }
}
if ($orphans.Count -gt 0) {
  Write-Warn2 "assets 下未纳入 extraResources 的素材（$($orphans.Count) 个，改了不会生效）："
  foreach ($item in $orphans) { Write-Dim $item }
  $script:notices += "assets 下有 $($orphans.Count) 个素材未纳入打包映射"
}

# --- 4. 复制 ----------------------------------------------------------------
Write-Head '4/5 同步到 release\win-unpacked\resources'

if ($DryRun) {
  Write-Warn2 '-DryRun：跳过复制与暂存'
  Write-Host ''
  Write-Host "  预览结果：待复制 $($pending.Count) 个素材" -ForegroundColor White
  exit 0
}

$buildInputSnapshot = Join-Path $portableRoot ('Data\Development\build-cache\input-' + [guid]::NewGuid().ToString() + '.json')
& $nodeExecutable $buildInputReceiptScript capture $portableRoot $buildInputSnapshot
if ($LASTEXITCODE -ne 0) { throw 'UI 构建输入捕获失败，未复制素材。' }

if ($pending.Count -eq 0) {
  Write-Ok '无需复制'
} else {
  $copied = 0
  foreach ($item in $pending) {
    $parent = Split-Path -Parent $item.Dst
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $item.Src -Destination $item.Dst -Force
    $copied++
  }
  Write-Ok "已复制 $copied 个素材"
}

# --- 5. 暂存候选槽 ----------------------------------------------------------
if ($SkipStage) {
  & $nodeExecutable $buildInputReceiptScript commit-ui $portableRoot $builtApp $buildInputSnapshot
  if ($LASTEXITCODE -ne 0) { throw '素材复制后输入或输出已漂移，不写成功收据。' }
  Write-Head '5/5 暂存候选槽'
  Write-Warn2 '-SkipStage：已跳过。release\win-unpacked 已刷新，但当前 App 不会切换。'
  exit 0
}

Write-Head '5/5 暂存候选槽'

Write-Host '  正在把 release\win-unpacked 送入 A/B 候选槽（当前桌面不受影响）…' -ForegroundColor Gray
$stageArgs = @($buildInputReceiptScript, 'stage', $portableRoot, $builtApp, $buildInputSnapshot, $version, 'ui')
& $nodeExecutable @stageArgs
if ($LASTEXITCODE -ne 0) { throw "候选槽暂存失败（退出码 $LASTEXITCODE）。" }

Write-Host ''
Write-Host '  界面改版已进入候选槽。' -ForegroundColor Green
Write-Host '  在托盘正常退出，或点顶栏「重启」；启动器会部署、验证，失败时自动回滚。' -ForegroundColor Yellow
if ($script:notices.Count -gt 0) {
  Write-Host ''
  Write-Host '  提示：' -ForegroundColor DarkGray
  foreach ($item in $script:notices) { Write-Dim $item }
}
} finally {
  if ($null -ne $buildLockStream) { $buildLockStream.Dispose() }
}
