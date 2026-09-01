# After-Update 钩子：官方更新完成后调用（更新脚本传入 -PortableRoot / -AppDirectory / -Version）。
# 作用：
#   1) 记录本次更新与 App-Overlay 恢复情况；
#   2) 提醒择机执行 Sync-Upstream-Source.ps1 + Build-DSH-Portable.cmd 重建完整定制版
#      （overlay 只恢复了 UI 层定制：theme.js 与外壳页面；源码级定制需重建生效）。
# 注意：本钩子绝不抛错、恒退出 0，避免中断更新流程。
param(
  [string]$PortableRoot,
  [string]$AppDirectory,
  [string]$Version
)

$noteDir = Join-Path $PortableRoot 'Data\Updates'
New-Item -ItemType Directory -Path $noteDir -Force | Out-Null

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$overlayDir = Join-Path $PortableRoot 'Customize\App-Overlay\resources'
$restored = @()
if (Test-Path -LiteralPath $overlayDir) {
  $restored = (Get-ChildItem -LiteralPath $overlayDir -File | Select-Object -ExpandProperty Name) -join ', '
}

$lines = @(
  "[$stamp] 官方更新 $Version 已应用，App-Overlay 已覆盖恢复 UI 定制。",
  "  已恢复文件: $restored",
  '  提醒: 源码级定制（内置浏览器等）尚未随官方新版回归；请择机运行:',
  '    1) .\Sync-Upstream-Source.ps1        # 检查并合并上游源码',
  '    2) .\Build-DSH-Portable.cmd         # 重建并部署完整定制版',
  '  重建后请从 App\resources 拷回最新定制页面到 App-Overlay，保持兜底同步。'
)
$log = Join-Path $noteDir 'overlay-note.log'
try { Add-Content -LiteralPath $log -Value $lines -Encoding UTF8 } catch { }
Write-Host ($lines -join "`n")
exit 0
