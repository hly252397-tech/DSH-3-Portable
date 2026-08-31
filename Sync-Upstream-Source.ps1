[CmdletBinding()]
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$portableRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
. (Join-Path $portableRoot 'Portable-Environment.ps1')
$null = Set-DshPortableEnvironment -PortableRoot $portableRoot
if (-not (Test-Path -LiteralPath (Join-Path $portableRoot '.git'))) { throw '当前目录不是源码仓库。' }

git -C $portableRoot fetch upstream --tags
if ($LASTEXITCODE -ne 0) { throw '获取上游源码失败。' }

$local = (git -C $portableRoot rev-parse HEAD).Trim()
$remote = (git -C $portableRoot rev-parse upstream/main).Trim()
Write-Host "本地：$local"
Write-Host "上游：$remote"
git -C $portableRoot log --oneline --decorate HEAD..upstream/main

if (-not $Apply) {
  Write-Host '只完成检查。确认改动后可运行：.\Sync-Upstream-Source.ps1 -Apply'
  exit 0
}

$changes = git -C $portableRoot status --porcelain
if ($changes) { throw '源码有未提交的定制改动；为避免覆盖，本脚本不会自动合并。请先提交或另建分支。' }
git -C $portableRoot merge --ff-only upstream/main
if ($LASTEXITCODE -ne 0) { throw '无法快进到上游；请手动合并定制分支。' }
Write-Host '源码已快进到 upstream/main。' -ForegroundColor Green
