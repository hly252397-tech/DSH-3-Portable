<#
.SYNOPSIS
  DSH 便携版 3 —— 文件替换式更新器（对照 GitHub 上游 main 分支，逐文件替换，全程不重启）

.DESCRIPTION
  同步范围 = 上游仓库 MichengAI/dsh-codex-desktop 的 git 跟踪文件树（tree/main）。
  因此 App/ Data/ Tools/ Workspace/ Customize/ 工作空间/ node_modules/ runtime* dist/ release/
  等本地目录天然不在同步范围内（脚本另有保护名单硬校验，双保险）。

  四种模式：
    Check       只检查更新（读 state.json 基线 vs 远端 main 最新提交），附带提示 App 桌面程序新版本
    DryRun      下载远端文件树并逐文件对比，只打印“将要 新增/替换/删除/还原”的清单，不改任何文件
    Apply       检查 + 下载 + 备份 + 替换 + 恢复定制 + 记录基线
    Interactive 检查 → 询问 → （可选先演练）→ 应用。供双击 Update-Portable-Files.cmd 使用

  免重启原理：
    - 不结束、不等待、不重启任何进程（应用运行中也可以更新）；
    - 目标文件被占用而无法覆盖时，把被占用的旧文件“改名”挪进备份目录（同卷改名对运行中文件有效），
      再写入新文件；正在运行的程序继续用旧内容，下次启动自动用新文件 —— 重启即代表更新完毕。

  用户配置/定制恢复原理：
    - 工作区未提交改动（dirty 文件，如 assets/*.html 主题定制）：替换前先备份；若上游没有改这个
      文件 → 自动把用户的版本还原回去（零丢失）；若上游也改了 → 保留上游新版，用户版本留在备份里
      并在报告中列为“需手动合并”。
    - 本地提交定制过的上游文件（便携版脚手架对 src/main.ts 等的修改）：永不覆盖；若上游也改了同名
      文件，把上游新版存到 Data\Updates\FileSync\Pending\ 供手动合并。
    - 未跟踪文件（assets/theme.js、工作空间/ 等）根本不在上游树中，永不动。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Update-Portable-Files.ps1 -Mode Check
  powershell -ExecutionPolicy Bypass -File .\Update-Portable-Files.ps1 -Mode DryRun
  powershell -ExecutionPolicy Bypass -File .\Update-Portable-Files.ps1 -Mode Apply
#>
[CmdletBinding()]
param(
  [ValidateSet('Check', 'DryRun', 'Apply', 'Interactive')]
  [string]$Mode = 'Check',
  [string]$Ref = 'main',
  [string]$Repo = 'MichengAI/dsh-codex-desktop',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

# ---------- 路径常量 ----------
$portableRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$syncRoot     = Join-Path $portableRoot 'Data\Updates\FileSync'
$downloadDir  = Join-Path $syncRoot 'Downloads'
$stagingDir   = Join-Path $syncRoot 'Staging'
$backupDir    = Join-Path $syncRoot 'Backup'
$pendingDir   = Join-Path $syncRoot 'Pending'
$statePath    = Join-Path $syncRoot 'state.json'
$manifestPath = Join-Path $syncRoot 'manifest.json'
$checkPath    = Join-Path $syncRoot 'last-check.json'
$appInstalledPath = Join-Path $portableRoot 'Data\Updates\installed.json'
$apiHeaders = @{ 'User-Agent' = 'DSH-3-Portable-FileSync'; 'Accept' = 'application/vnd.github+json' }

# ---------- 小工具 ----------
function Write-Info { param([string]$Text) Write-Host $Text }
function Write-Ok   { param([string]$Text) Write-Host $Text -ForegroundColor Green }
function Write-Warn2{ param([string]$Text) Write-Host $Text -ForegroundColor Yellow }
function Write-Err2 { param([string]$Text) Write-Host $Text -ForegroundColor Red }

function Ensure-Dir {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}

function Save-JsonUtf8 {
  param($Object, [string]$Path)
  Ensure-Dir ([System.IO.Path]::GetDirectoryName($Path))
  $json = $Object | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-Sha7 { param([string]$Sha) if ($Sha -and $Sha.Length -ge 7) { return $Sha.Substring(0, 7) } return $Sha }

# ---------- 内容比较（行尾不敏感的文本比较 / 二进制精确比较） ----------
function Test-BinaryBytes {
  param([byte[]]$Bytes)
  $limit = [Math]::Min(8000, $Bytes.Length)
  for ($i = 0; $i -lt $limit; $i++) { if ($Bytes[$i] -eq 0) { return $true } }
  return $false
}

function Get-NormalizedText {
  param([byte[]]$Bytes)
  # ISO-8859-1 逐字节解码：保真、与编码无关，只用于比较
  $text = [System.Text.Encoding]::GetEncoding(28591).GetString($Bytes)
  return $text.Replace("`r`n", "`n").Replace("`r", "`n")
}

function Test-SameContent {
  param([byte[]]$A, [byte[]]$B)
  if ($A.Length -ne $B.Length) {
    if ((-not (Test-BinaryBytes $A)) -and (-not (Test-BinaryBytes $B))) {
      return ((Get-NormalizedText $A) -eq (Get-NormalizedText $B))
    }
    return $false
  }
  for ($i = 0; $i -lt $A.Length; $i++) { if ($A[$i] -ne $B[$i]) {
    if ((-not (Test-BinaryBytes $A)) -and (-not (Test-BinaryBytes $B))) {
      return ((Get-NormalizedText $A) -eq (Get-NormalizedText $B))
    }
    return $false
  } }
  return $true
}

# ---------- 保护名单（双保险：上游树本身也不含这些目录，这里再硬拦一次） ----------
function Test-ProtectedRel {
  param([string]$Rel)
  $r = $Rel.Replace('\', '/').TrimStart('/')
  if ($r -like '_tmp*' -or $r -like '*.log') { return $true }
  if ($r -ieq 'Workspace/README.md') { return $false }
  if ($r -ieq 'Customize/App-Overlay/.gitkeep') { return $false }
  $top = $r.Split('/')[0]
  $blocked = @(
    '.git', 'App', 'Data', 'Tools', 'Workspace', 'Customize', '工作空间',
    'node_modules', 'dist', 'release', 'runtime', 'runtime-dsh', 'runtime-node',
    'runtime-plugins', 'coverage', '.codegraph'
  )
  foreach ($b in $blocked) { if ($top -ieq $b) { return $true } }
  return $false
}

function Assert-SafeRel {
  param([string]$Rel)
  if ([System.String]::IsNullOrWhiteSpace($Rel)) { throw '空路径' }
  if ($Rel -match '(\.\.|^/|^[A-Za-z]:)') { throw "可疑路径：$Rel" }
}

# ---------- git 事实收集（尽力而为：git 不可用时降级为“只备份不还原”） ----------
function Get-GitFacts {
  param([string]$Root)

  $facts = @{ Available = $false; BaseSha = $null; CommittedCustom = @{}; Dirty = @{}; AheadCount = $null }
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) { Write-Warn2 '未找到 git，跳过定制识别（仍会备份所有被替换文件）。'; return $facts }

  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & git -C $Root fetch upstream --quiet 2>$null | Out-Null

    $base = (& git -C $Root merge-base HEAD upstream/main 2>$null)
    if (-not $base) { $base = (& git -C $Root rev-parse upstream/main 2>$null) }
    if (-not $base) { $base = (& git -C $Root rev-parse HEAD 2>$null) }
    if (-not $base) { Write-Warn2 'git 基线不可用，跳过定制识别。'; return $facts }
    $facts.BaseSha = ([string]$base).Trim()
    $facts.Available = $true

    # 本地提交相对基线改过的文件 = 版本化定制，永不覆盖
    $customLines = @(& git -C $Root -c core.quotepath=false diff --name-only $facts.BaseSha HEAD 2>$null)
    foreach ($line in $customLines) {
      $p = ([string]$line).Trim()
      if ($p) { $facts.CommittedCustom[$p.Replace('\', '/')] = $true }
    }

    # 工作区未提交改动 = 用户配置级定制，替换后按需还原
    $statusLines = @(& git -C $Root -c core.quotepath=false status --porcelain -uno 2>$null)
    foreach ($line in $statusLines) {
      $s = ([string]$line)
      if ($s.Length -lt 4) { continue }
      $code = $s.Substring(0, 2)
      if ($code.Trim() -eq '') { continue }
      $pathPart = $s.Substring(3)
      if ($pathPart -like '* -> *') {
        $parts = $pathPart -split ' -> '
        foreach ($pp in $parts) { $facts.Dirty[$pp.Replace('\', '/')] = $true }
      } else {
        $facts.Dirty[$pathPart.Replace('\', '/')] = $true
      }
    }

    $ahead = (& git -C $Root rev-list --count ('HEAD..upstream/main') 2>$null)
    if ($ahead) { $facts.AheadCount = [int]([string]$ahead).Trim() }
  } finally {
    $ErrorActionPreference = $oldEap
  }
  return $facts
}

function Get-GitBaseBlob {
  param([string]$Root, [string]$BaseSha, [string]$Rel)
  $oldEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $out = & git -C $Root rev-parse "$($BaseSha):$Rel" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
    return ([string]($out | Select-Object -First 1)).Trim()
  } finally { $ErrorActionPreference = $oldEap }
}

function Get-GitFileBlob {
  param([string]$Root, [string]$Path)
  $oldEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $out = & git -C $Root hash-object -- $Path 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
    return ([string]($out | Select-Object -First 1)).Trim()
  } finally { $ErrorActionPreference = $oldEap }
}

# ---------- 远端信息 ----------
function Get-RemoteCommitInfo {
  param([string]$RepoSlug, [string]$RefName)
  $uri = "https://api.github.com/repos/$RepoSlug/commits/$RefName"
  $c = Invoke-RestMethod -Uri $uri -Headers $apiHeaders -TimeoutSec 30
  $msg = [string]$c.commit.message
  $nl = $msg.IndexOf("`n")
  if ($nl -ge 0) { $msg = $msg.Substring(0, $nl) }
  return [pscustomobject]@{
    Sha     = [string]$c.sha
    Message = $msg
    Date    = [string]$c.commit.committer.date
    Url     = [string]$c.html_url
  }
}

function Get-LatestReleaseTag {
  param([string]$RepoSlug)
  try {
    $r = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoSlug/releases/latest" -Headers $apiHeaders -TimeoutSec 30
    return [string]$r.tag_name
  } catch { return $null }
}

function Save-LastCheck {
  param([string]$Status, $Remote, [string]$LocalSha, [string]$Detail)
  $remoteSha = $null; $remoteDate = $null; $remoteMessage = $null
  if ($Remote) { $remoteSha = $Remote.Sha; $remoteDate = $Remote.Date; $remoteMessage = $Remote.Message }
  $payload = [ordered]@{
    checkedAt   = (Get-Date).ToString('o')
    repo        = $Repo
    ref         = $Ref
    status      = $Status
    remoteSha     = $remoteSha
    remoteDate    = $remoteDate
    remoteMessage = $remoteMessage
    localBaseline = $LocalSha
    detail      = $Detail
  }
  Save-JsonUtf8 $payload $checkPath
}

# ---------- 状态读写 ----------
function Get-State {
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try { return (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json) } catch { return $null }
  }
  return $null
}

function Get-PrevManifestSet {
  $set = @{}
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    try {
      $m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
      if ($m.files) { foreach ($f in @($m.files)) { $set[$f.path] = $true } }
    } catch { }
  }
  return $set
}

# ---------- 免重启的文件替换 ----------
function Copy-FileOver {
  # 返回 'written' 或 'written-via-rename'；失败抛异常
  param([string]$From, [string]$To)
  Ensure-Dir ([System.IO.Path]::GetDirectoryName($To))
  try {
    if (Test-Path -LiteralPath $To -PathType Leaf) {
      try { Set-ItemProperty -LiteralPath $To -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue } catch { }
    }
    [System.IO.File]::Copy($From, $To, $true)
    return 'written'
  } catch [System.IO.IOException] {
    # 文件被运行中的进程占用：把旧文件改名挪走（同卷改名对运行中文件有效），再写新文件
    $busyPath = "$To.busy-pending"
    if (Test-Path -LiteralPath $busyPath) { Remove-Item -LiteralPath $busyPath -Force -ErrorAction SilentlyContinue }
    Move-Item -LiteralPath $To -Destination $busyPath -Force
    try {
      [System.IO.File]::Copy($From, $To, $true)
      Move-Item -LiteralPath $busyPath -Destination "$To.old-in-backup" -ErrorAction SilentlyContinue
      return 'written-via-rename'
    } catch {
      Move-Item -LiteralPath $busyPath -Destination $To -Force -ErrorAction SilentlyContinue
      throw
    }
  }
}

function Move-FileToBackup {
  param([string]$From, [string]$BackupPath)
  Ensure-Dir ([System.IO.Path]::GetDirectoryName($BackupPath))
  try {
    Move-Item -LiteralPath $From -Destination $BackupPath -Force
    return $true
  } catch {
    # 被占用删不掉：先复制备份，原文件保留到下次启动后再清
    try {
      [System.IO.File]::Copy($From, $BackupPath, $true)
      return $false
    } catch { return $false }
  }
}

# ---------- 生成更新计划 ----------
function Get-UpdatePlan {
  param(
    [string]$Root,
    [string]$StageRoot,
    $GitFacts,
    $PrevManifestSet
  )

  $plan = @{
    Items            = New-Object System.Collections.Generic.List[object]
    RemoteRels       = @()
    SkippedProtected = @()
    Unchanged        = 0
    ShaTag           = $script:CurrentShaTag
    GitAvailable     = $GitFacts.Available
  }

  $allFiles = @(Get-ChildItem -LiteralPath $StageRoot -Recurse -File)
  $remoteSet = @{}
  foreach ($f in $allFiles) {
    $rel = $f.FullName.Substring($StageRoot.Length).TrimStart('\').Replace('\', '/')
    Assert-SafeRel $rel
    $remoteSet[$rel] = $true
  }
  $plan.RemoteRels = @($remoteSet.Keys)

  foreach ($rel in $plan.RemoteRels) {
    if (Test-ProtectedRel $rel) { $plan.SkippedProtected += $rel; continue }

    $stagedPath = Join-Path $StageRoot ($rel.Replace('/', '\'))
    $localPath  = Join-Path $Root ($rel.Replace('/', '\'))
    $isCustom   = $GitFacts.CommittedCustom.ContainsKey($rel)
    $isDirty    = $GitFacts.Dirty.ContainsKey($rel)
    $localExists = Test-Path -LiteralPath $localPath -PathType Leaf

    if ($isCustom -and -not $isDirty) {
      # 版本化定制（本地提交改过的上游文件）：永不覆盖；上游也改了 → 存 Pending 供手动合并
      if ($localExists -and $GitFacts.Available) {
        $baseBlob = Get-GitBaseBlob -Root $Root -BaseSha $GitFacts.BaseSha -Rel $rel
        $newBlob  = Get-GitFileBlob -Root $Root -Path $stagedPath
        if ($null -eq $baseBlob -or ($newBlob -and $baseBlob -ne $newBlob)) {
          $pendingTarget = Join-Path $pendingDir ((Get-Sha7 $script:CurrentSha) + '\' + ($rel.Replace('/', '\')))
          Ensure-Dir ([System.IO.Path]::GetDirectoryName($pendingTarget))
          Copy-Item -LiteralPath $stagedPath -Destination $pendingTarget -Force
          $plan.Items.Add([pscustomobject]@{
            Action = 'Pending'; Rel = $rel; Staged = $stagedPath; Local = $localPath
            BackupPath = $null; RestoreEval = $false; UpstreamChanged = $true
            Note = '本地提交定制过此文件，上游新版已存入 Pending，请手动合并'
          })
        }
      }
      continue
    }

    if (-not $localExists) {
      $plan.Items.Add([pscustomobject]@{
        Action = 'Add'; Rel = $rel; Staged = $stagedPath; Local = $localPath
        BackupPath = $null; RestoreEval = $false; UpstreamChanged = $null; Note = ''
      })
      continue
    }

    $localBytes = [System.IO.File]::ReadAllBytes($localPath)
    $stagedBytes = [System.IO.File]::ReadAllBytes($stagedPath)
    if (Test-SameContent $localBytes $stagedBytes) { $plan.Unchanged++; continue }

    $upstreamChanged = $null
    if ($isDirty -and $GitFacts.Available) {
      $baseBlob = Get-GitBaseBlob -Root $Root -BaseSha $GitFacts.BaseSha -Rel $rel
      $newBlob  = Get-GitFileBlob -Root $Root -Path $stagedPath
      if ($null -eq $baseBlob) { $upstreamChanged = $true }
      elseif ($null -eq $newBlob) { $upstreamChanged = $true }
      else { $upstreamChanged = ($baseBlob -ne $newBlob) }
    }

    $plan.Items.Add([pscustomobject]@{
      Action = 'Replace'; Rel = $rel; Staged = $stagedPath; Local = $localPath
      BackupPath = (Join-Path $backupDir ($script:CurrentShaTag + '\' + ($rel.Replace('/', '\'))))
      RestoreEval = $isDirty; UpstreamChanged = $upstreamChanged
      Note = $(if ($isDirty) { '本地有未提交定制' } else { '' })
    })
  }

  # 上游已删除、且上一轮由本脚本同步过的文件 → 删除（移入备份）
  foreach ($prevRel in $PrevManifestSet.Keys) {
    if ($remoteSet.ContainsKey($prevRel)) { continue }
    if (Test-ProtectedRel $prevRel) { continue }
    if ($GitFacts.CommittedCustom.ContainsKey($prevRel) -or $GitFacts.Dirty.ContainsKey($prevRel)) { continue }
    $localPath = Join-Path $Root ($prevRel.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) { continue }
    $plan.Items.Add([pscustomobject]@{
      Action = 'Delete'; Rel = $prevRel; Staged = $null; Local = $localPath
      BackupPath = (Join-Path $backupDir ($script:CurrentShaTag + '\' + ($prevRel.Replace('/', '\'))))
      RestoreEval = $false; UpstreamChanged = $null; Note = '上游已删除此文件'
    })
  }

  return $plan
}

function Show-Plan {
  param($Plan)
  $groups = $Plan.Items | Group-Object -Property Action
  Write-Info ''
  Write-Info '—— 更新计划 ——'
  if ($groups) {
    foreach ($g in $groups) { Write-Info ("  {0,-10} {1} 个文件" -f $g.Name, $g.Count) }
  } else {
    Write-Info '  （无文件级变化）'
  }
  Write-Info ("  相同跳过    {0} 个文件" -f $Plan.Unchanged)
  if ($Plan.SkippedProtected.Count -gt 0) {
    Write-Info ("  保护拦截    {0} 个路径（App/Data/Workspace 等，不会触碰）" -f $Plan.SkippedProtected.Count)
  }

  $maxList = 40
  foreach ($action in @('Add', 'Replace', 'Delete', 'Pending')) {
    $items = @($Plan.Items | Where-Object { $_.Action -eq $action })
    if (-not $items.Count) { continue }
    Write-Info ''
    $title = @{ Add = '新增'; Replace = '替换'; Delete = '删除'; Pending = '待手动合并' }[$action]
    Write-Info ("[{0}] {1}" -f $title, $action)
    $i = 0
    foreach ($it in $items) {
      if ($i -ge $maxList) { Write-Info ("  … 还有 {0} 个" -f ($items.Count - $maxList)); break }
      $suffix = ''
      if ($it.RestoreEval -and -not $it.UpstreamChanged) { $suffix = '  （替换后自动还原你的定制）' }
      elseif ($it.RestoreEval -and $it.UpstreamChanged) { $suffix = '  （上游也改了：保留新版，你的版本进备份，需手动合并）' }
      elseif ($it.Note) { $suffix = "  （$($it.Note)）" }
      Write-Info ("  {0}{1}" -f $it.Rel, $suffix)
      $i++
    }
  }
  Write-Info ''
}

# ---------- 执行计划 ----------
function Invoke-PlanApply {
  param($Plan, $Root)

  $backupRoot = Join-Path $backupDir $script:CurrentShaTag
  Ensure-Dir $backupRoot

  $result = @{ Written = 0; Renamed = 0; Restored = 0; Conflicts = @(); Deleted = 0; Pending = 0; Failures = @() }

  # 先做全部备份（此时还没动任何文件）
  foreach ($it in $Plan.Items) {
    if ($it.Action -eq 'Replace' -or $it.Action -eq 'Delete') {
      Ensure-Dir ([System.IO.Path]::GetDirectoryName($it.BackupPath))
      try { [System.IO.File]::Copy($it.Local, $it.BackupPath, $true) } catch {
        $result.Failures += ("备份失败：{0}（{1}）" -f $it.Rel, $_.Exception.Message)
      }
    }
  }

  foreach ($it in $Plan.Items) {
    try {
      switch ($it.Action) {
        'Add' {
          Copy-FileOver -From $it.Staged -To $it.Local | Out-Null
          $result.Written++
        }
        'Replace' {
          $mode = Copy-FileOver -From $it.Staged -To $it.Local
          if ($mode -eq 'written-via-rename') { $result.Renamed++ }
          $result.Written++

          if ($it.RestoreEval) {
            if ($it.UpstreamChanged -eq $false) {
              # 上游没改这个文件 → 把用户定制还原回去
              [System.IO.File]::Copy($it.BackupPath, $it.Local, $true)
              $result.Restored++
            } else {
              $result.Conflicts += $it.Rel
            }
          }
        }
        'Delete' {
          $moved = Move-FileToBackup -From $it.Local -BackupPath $it.BackupPath
          if ($moved) { $result.Deleted++ } else {
            $result.Deleted++
            $result.Failures += ("文件被占用，已备份但暂留原位（下次更新再清）：{0}" -f $it.Rel)
          }
        }
        'Pending' {
          $result.Pending++
        }
      }
    } catch {
      $result.Failures += ("{0} 失败：{1}（{2}）" -f $it.Action, $it.Rel, $_.Exception.Message)
    }
  }
  return $result
}

# ---------- 高层流程 ----------
function Resolve-RemoteCommit {
  try {
    $script:RemoteCommit = Get-RemoteCommitInfo -RepoSlug $Repo -RefName $Ref
    return $true
  } catch {
    if ($Force -and $Ref -eq 'main') {
      Write-Warn2 'GitHub API 不可用，按 -Force 直接使用 main 分支最新 zipball（本次不记录基线）。'
      $script:RemoteCommit = [pscustomobject]@{ Sha = 'unknown'; Message = 'main@HEAD'; Date = $null; Url = $null }
      return $true
    }
    Write-Err2 ("无法获取远端 {0} 信息：{1}" -f $Ref, $_.Exception.Message)
    Save-LastCheck -Status 'error' -Remote $null -LocalSha $null -Detail $_.Exception.Message
    return $false
  }
}

function Get-StageFromZipball {
  param([string]$Sha)

  Ensure-Dir $downloadDir; Ensure-Dir $stagingDir
  # 清理旧 staging
  Get-ChildItem -LiteralPath $stagingDir -Directory -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  $zipPath = Join-Path $downloadDir ("{0}-{1}.zip" -f $Ref, (Get-Sha7 $Sha))
  if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
    $uri = if ($Sha -eq 'unknown') { "https://codeload.github.com/$Repo/zip/refs/heads/$Ref" }
           else { "https://codeload.github.com/$Repo/zip/$Sha" }
    Write-Info ("正在下载远端文件树（{0}）…" -f $Ref)
    Invoke-WebRequest -Uri $uri -OutFile $zipPath -Headers @{ 'User-Agent' = 'DSH-3-Portable-FileSync' } -TimeoutSec 600
  } else {
    Write-Info '复用已下载的远端文件树压缩包。'
  }

  $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  $extractRoot = Join-Path $stagingDir $stamp
  Ensure-Dir $extractRoot
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

  $inner = @(Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1)
  if (-not $inner -or -not (Test-Path -LiteralPath (Join-Path $inner[0].FullName 'package.json') -PathType Leaf)) {
    throw '解压结果异常：未找到 package.json，远端文件树无效。'
  }
  return $inner[0].FullName
}

function Invoke-CheckMode {
  $state = Get-State
  if (-not (Resolve-RemoteCommit)) { exit 1 }

  $localSha = $null
  if ($state -and $state.lastCommit) { $localSha = [string]$state.lastCommit }

  Write-Info ''
  Write-Info '======== DSH 便携版 · 检查更新 ========'
  if ($localSha -and $localSha -ne 'unknown') {
    Write-Info ("本地基线： {0}  （{1}）" -f (Get-Sha7 $localSha), $state.lastAppliedAt)
  } else {
    Write-Info '本地基线： 尚未建立（首次使用，建议先 DryRun 再 Apply）'
  }
  Write-Info ("远端 {0}： {1}  {2}" -f $Ref, (Get-Sha7 $script:RemoteCommit.Sha), $script:RemoteCommit.Date)
  Write-Info ("最新提交： {0}" -f $script:RemoteCommit.Message)

  $status = 'up-to-date'
  if (-not $localSha -or $localSha -eq 'unknown') {
    $status = 'unknown'
    Write-Warn2 '结论：暂无基线，无法判断是否需要更新；执行 Apply 后会建立基线。'
  } elseif ($localSha -eq $script:RemoteCommit.Sha) {
    Write-Ok '结论：已是最新，无需更新。'
  } else {
    $status = 'available'
    Write-Warn2 '结论：有可用更新。运行 Update-Portable-Files.cmd 或 -Mode Apply 应用。'
  }

  $gitFacts = Get-GitFacts -Root $portableRoot
  if ($null -ne $gitFacts.AheadCount -and $gitFacts.AheadCount -gt 0) {
    Write-Info ("（本地 git 分支领先 upstream/main {0} 个提交 —— 便携版定制提交，文件更新不会动它们）" -f $gitFacts.AheadCount)
  }

  $releaseTag = Get-LatestReleaseTag -RepoSlug $Repo
  if ($releaseTag) {
    $appVer = $null
    if (Test-Path -LiteralPath $appInstalledPath -PathType Leaf) {
      try { $appVer = ([string]((Get-Content -LiteralPath $appInstalledPath -Raw | ConvertFrom-Json).version)) } catch { }
    }
    if ($appVer) {
      if ($appVer -ne $releaseTag) {
        Write-Warn2 ("App 桌面程序：已装 {0}，官网最新 {1}。更新 App 需退出应用后运行 Update-DSH-Portable.cmd。" -f $appVer, $releaseTag)
      } else {
        Write-Ok ("App 桌面程序：已是最新（{0}）。" -f $appVer)
      }
    } else {
      Write-Info ("App 桌面程序：未记录版本；官网最新发布为 {0}（如需更新请运行 Update-DSH-Portable.cmd，注意该流程要求先退出应用）。" -f $releaseTag)
    }
  }

  Save-LastCheck -Status $status -Remote $script:RemoteCommit -LocalSha $localSha -Detail ''
  Write-Info "检查结果已写入：$checkPath"
  Write-Info ''
}

function Invoke-UpdateRun {
  param([switch]$DryRunOnly)

  $state = Get-State
  if (-not (Resolve-RemoteCommit)) { exit 1 }
  $script:CurrentSha = $script:RemoteCommit.Sha
  $script:CurrentShaTag = if ($script:CurrentSha -eq 'unknown') { 'unknown' } else { Get-Sha7 $script:CurrentSha }

  if (-not $DryRunOnly -and -not $Force -and $state -and $state.lastCommit -eq $script:CurrentSha) {
    Write-Ok ("已是最新（基线 {0}），无需更新。加 -Force 可强制重新同步。" -f (Get-Sha7 $script:CurrentSha))
    return
  }

  $stageRoot = Get-StageFromZipball -Sha $script:CurrentSha

  # 双保险：staging 中不允许出现受保护顶层目录
  foreach ($f in (Get-ChildItem -LiteralPath $stageRoot -Recurse -File)) {
    $rel = $f.FullName.Substring($stageRoot.Length).TrimStart('\').Replace('\', '/')
    if (Test-ProtectedRel $rel) {
      throw "远端文件树包含受保护路径 $rel，为安全起见中止（请检查上游仓库）。"
    }
  }

  $gitFacts = Get-GitFacts -Root $portableRoot
  $prevSet = Get-PrevManifestSet
  $plan = Get-UpdatePlan -Root $portableRoot -StageRoot $stageRoot -GitFacts $gitFacts -PrevManifestSet $prevSet

  Show-Plan -Plan $plan

  if ($DryRunOnly) {
    Save-LastCheck -Status 'dry-run' -Remote $script:RemoteCommit -LocalSha ($(if ($state -and $state.lastCommit) { [string]$state.lastCommit } else { $null })) -Detail 'DryRun 完成计划预览，未修改任何文件'
    Write-Ok 'DryRun 完成：以上为预览，未修改任何文件。确认后运行 -Mode Apply 应用。'
    return
  }

  Write-Info '开始应用更新（全程不结束、不重启任何进程）…'
  $result = Invoke-PlanApply -Plan $plan -Root $portableRoot

  # 写清单与基线
  $manifestFiles = New-Object System.Collections.Generic.List[object]
  foreach ($rel in $plan.RemoteRels) {
    if (Test-ProtectedRel $rel) { continue }
    if ($gitFacts.CommittedCustom.ContainsKey($rel)) { continue }
    $localPath = Join-Path $portableRoot ($rel.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) { continue }
    $hash = (Get-FileHash -LiteralPath $localPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestFiles.Add([pscustomobject]@{ path = $rel; sha256 = $hash })
  }
  Save-JsonUtf8 ([ordered]@{
    generatedAt = (Get-Date).ToString('o')
    commit      = $script:CurrentSha
    fileCount   = $manifestFiles.Count
    files       = $manifestFiles
  }) $manifestPath

  Save-JsonUtf8 ([ordered]@{
    lastCommit        = $script:CurrentSha
    lastCommitMessage = $script:RemoteCommit.Message
    lastCommitDate    = $script:RemoteCommit.Date
    lastAppliedAt     = (Get-Date).ToString('o')
    ref               = $Ref
    repo              = $Repo
    counts = [ordered]@{
      written = $result.Written; viaRename = $result.Renamed
      restored = $result.Restored; deleted = $result.Deleted
      pendingMerge = $result.Pending; unchanged = $plan.Unchanged
    }
    conflicts = $result.Conflicts
    failures  = $result.Failures
  }) $statePath

  Save-LastCheck -Status 'applied' -Remote $script:RemoteCommit -LocalSha $script:CurrentSha -Detail 'Apply 完成'

  # 收尾：备份只留最近 5 轮
  $oldBackups = @(Get-ChildItem -LiteralPath $backupDir -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -Skip 5)
  foreach ($d in $oldBackups) { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue }

  # 用户配置完整性核验
  Write-Info ''
  Write-Info '—— 用户配置核验 ——'
  foreach ($dir in @('Data', 'Workspace', 'Customize', 'App', 'Tools', '工作空间')) {
    $p = Join-Path $portableRoot $dir
    if (Test-Path -LiteralPath $p) { Write-Ok ("  保留完好：{0}\" -f $dir) }
  }
  if ($result.Restored -gt 0) { Write-Ok ("已自动还原你的未提交定制：{0} 个文件。" -f $result.Restored) }
  if ($result.Conflicts.Count -gt 0) {
    Write-Warn2 ("{0} 个文件你与上游都改过：已采用上游新版，你的版本在 {1}，请手动合并：" -f $result.Conflicts.Count, (Join-Path $backupDir $script:CurrentShaTag))
    foreach ($c in $result.Conflicts) { Write-Info ("  - {0}" -f $c) }
  }
  if ($result.Pending -gt 0) {
    Write-Warn2 ("{0} 个文件本地提交定制过、上游也改了：你的版本保持不变，上游新版在 {1} 供手动合并。" -f $result.Pending, $pendingDir)
  }
  if ($result.Failures.Count -gt 0) {
    Write-Warn2 ("{0} 个操作未完成：" -f $result.Failures.Count)
    foreach ($m in $result.Failures) { Write-Info ("  - {0}" -f $m) }
    exit 2
  }

  Write-Ok ''
  Write-Ok ("更新完成：基线 {0}（{1}）。" -f (Get-Sha7 $script:CurrentSha), $script:RemoteCommit.Message)
  Write-Ok '本次过程未重启、未结束任何进程。下次启动 DSH Codex Desktop 即自动使用新文件 —— 重启即代表更新完毕。'
}

function Invoke-Interactive {
  $state = Get-State
  if (-not (Resolve-RemoteCommit)) { exit 1 }
  $script:CurrentSha = $script:RemoteCommit.Sha
  $script:CurrentShaTag = if ($script:CurrentSha -eq 'unknown') { 'unknown' } else { Get-Sha7 $script:CurrentSha }

  $localSha = $null
  if ($state -and $state.lastCommit) { $localSha = [string]$state.lastCommit }
  $upToDate = ($localSha -eq $script:CurrentSha)

  Write-Info ''
  Write-Info '======== DSH 便携版 · 文件替换式更新 ========'
  if ($null -eq $localSha) {
    Write-Warn2 '当前尚无更新基线（首次运行）。'
  } elseif ($upToDate) {
    Write-Ok ("当前已是最新（基线 {0}）。" -f (Get-Sha7 $localSha))
  } else {
    Write-Warn2 ("发现更新：{0} → {1}" -f $(if ($localSha) { Get-Sha7 $localSha } else { '无基线' }), (Get-Sha7 $script:CurrentSha))
    Write-Info ("最新提交：{0}" -f $script:RemoteCommit.Message)
  }
  Save-LastCheck -Status $(if ($upToDate) { 'up-to-date' } else { 'available' }) -Remote $script:RemoteCommit -LocalSha $localSha -Detail 'interactive'

  if ($upToDate -and -not $Force) { Write-Info '无需更新，直接关闭即可。'; return }

  $answer = Read-Host '是否现在更新文件？[Y] 直接更新  [D] 先演练预览  [N] 取消'
  if ($answer -match '^[Dd]') {
    Invoke-UpdateRun -DryRunOnly
    $answer2 = Read-Host '确认按上述计划应用更新？[Y/N]'
    if ($answer2 -match '^[Yy]') { Invoke-UpdateRun } else { Write-Info '已取消，未修改任何文件。' }
  } elseif ($answer -match '^[Yy]') {
    Invoke-UpdateRun
  } else {
    Write-Info '已取消，未修改任何文件。'
  }
}

# ---------- 入口 ----------
Ensure-Dir $syncRoot
try {
  switch ($Mode) {
    'Check'       { Invoke-CheckMode }
    'Interactive' { Invoke-Interactive }
    'DryRun'      { Invoke-UpdateRun -DryRunOnly }
    'Apply'       { Invoke-UpdateRun }
  }
} catch {
  Write-Err2 ("更新失败：{0}" -f $_.Exception.Message)
  Write-Info '已完成的步骤有完整备份（Data\Updates\FileSync\Backup），应用数据不受影响。'
  exit 1
}
