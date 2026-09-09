[CmdletBinding()]
param(
    [string]$PortableRoot,
    [switch]$AsJson,
    [switch]$NoHttp,
    [ValidateRange(1, 10)][int]$TimeoutSeconds = 2,
    [ValidateRange(0, 1024)][double]$MinimumFreeGB = 2
)
$ErrorActionPreference = 'Stop'
if (-not $PortableRoot) { $PortableRoot = Join-Path $PSScriptRoot '..\..' }
. (Join-Path $PSScriptRoot 'Health.Core.ps1')
$checks = New-Object 'System.Collections.Generic.List[object]'
function Add-Check([string]$Id, [string]$Status, [string]$Message, $Evidence = $null) {
    $checks.Add([pscustomobject]@{ id = $Id; status = $Status; message = $Message; evidence = $Evidence })
}
try {
    $root = [IO.Path]::GetFullPath($PortableRoot).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Missing root' }
    $userData = Resolve-HealthPath $root 'Data\Electron\UserData'
    $pointerPath = Resolve-HealthPath $root 'Data\Updates\Desktop\pointer.json'
    $runtimePath = Resolve-HealthPath $root 'Data\Runtime\Harness\current.json'
    $snapshots = @{}
    foreach ($path in @($pointerPath, $runtimePath)) {
        $snapshots[$path] = Get-HealthSnapshot $path
    }
} catch {
    $result = [pscustomobject]@{ schemaVersion = 1; readOnly = $true; overall = 'incomplete'; message = '便携目录或版本元数据无法安全读取。'; failureCode = $_.Exception.GetType().Name; checkLine = $_.InvocationInfo.ScriptLineNumber }
    if ($AsJson) { $result | ConvertTo-Json } else { Write-Output $result.message }
    exit 2
}
$pointer = $null
$main = $null
$dsh = @()
try {
    $pointer = Read-HealthJson $pointerPath
    $state = Read-HealthJson (Resolve-HealthPath $root 'Data\Updates\Desktop\state.json')
    if (-not $pointer) { Add-Check 'update' 'unknown' '未发现桌面版本指针；不能据此认定安装损坏。' }
    else {
        $updateStatus = Get-HealthUpdateStatus $pointer $state
        $level = 'info'
        $description = '已读取桌面更新状态。'
        if ($updateStatus -eq 'waiting_activation') { $description = '候选已暂存，等待正常退出后启动验证；尚未更新完成。本工具不会重启。' }
        if ($updateStatus -eq 'failed') { $level = 'warning'; $description = '更新状态记录了失败；不代表当前桌面不可用。' }
        if (-not $state) { $level = 'unknown'; $description = '更新状态文件缺失，仅能读取版本指针。' }
        Add-Check 'update' $level $description @{ state = $updateStatus; progress = (Get-HealthField $state 'overallProgress') }
        foreach ($name in @('current', 'pending')) {
            $slot = Get-HealthField $pointer $name
            if (-not $slot) { continue }
            $relative = [string](Get-HealthField $slot 'relativePath')
            $slotPath = Resolve-HealthPath $root $relative
            $manifest = Resolve-HealthPath $root ($relative + '\slot-manifest.json')
            $exePath = Resolve-HealthPath $root ($relative + '\DSH Codex Desktop.exe')
            $asarPath = Resolve-HealthPath $root ($relative + '\resources\app.asar')
            $missing = @(@($exePath, $asarPath, $manifest) | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
            $valid = $missing.Count -eq 0
            if ($valid) { $valid = (Get-HealthSnapshot $manifest) -ieq (Get-HealthField $slot 'sha256') }
            $level = 'ok'
            $description = '关键文件存在且槽清单哈希匹配；未对整个安装包做完整校验。'
            if (-not $valid) { $level = 'error'; $description = '关键文件缺失或槽清单哈希不匹配；请勿手工覆盖当前程序。' }
            Add-Check "desktop_$name" $level $description @{ version = (Get-HealthVersion (Get-HealthField $slot 'version')); path = $slotPath }
        }
    }
} catch { Add-Check 'update_metadata' 'unknown' '桌面更新元数据不可读取、格式异常或路径不安全；未作修改。' }
try {
    $runtime = Read-HealthJson $runtimePath
    $configured = Get-HealthField $runtime 'current'
    $level = 'info'
    if (-not $configured) { $level = 'unknown' }
    Add-Check 'runtime_configured' $level '运行时指针版本（不等同于进程实际版本）。' @{ version = (Get-HealthVersion (Get-HealthField $configured 'version')) }
} catch { Add-Check 'runtime_configured' 'unknown' '运行时指针无法读取。' }
try {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $matchesFound = @(Select-HealthDesktop $processes $root $userData)
    $portableMains = @($processes | Where-Object {
        $_.Name -ieq 'DSH Codex Desktop.exe' -and $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -and
        $_.CommandLine -notmatch '(?:^|\s)--type(?:=|\s)'
    })
    Add-Check 'other_instances' 'info' '其他用户数据目录或无法确认身份的实例被排除，不参与正式版健康判断。' @{ count = [Math]::Max(0, $portableMains.Count - $matchesFound.Count) }
    if ($matchesFound.Count -eq 0) {
        $level = 'info'
        $description = '未发现使用正式用户数据目录的桌面实例；服务检查不适用。'
        $unidentified = @($portableMains | Where-Object { -not (Get-HealthArgument $_.CommandLine '--user-data-dir') })
        $inaccessible = @($processes | Where-Object { $_.Name -ieq 'DSH Codex Desktop.exe' -and (-not $_.ExecutablePath -or -not $_.CommandLine) })
        if ($unidentified.Count -gt 0 -or $inaccessible.Count -gt 0) { $level = 'unknown'; $description = '有桌面进程身份不可读取，无法确认正式实例是否运行。' }
        Add-Check 'desktop_process' $level $description
    } elseif ($matchesFound.Count -gt 1) { Add-Check 'desktop_process' 'warning' '发现多个正式桌面主进程，跳过服务探测以避免误判。' }
    else {
        $main = $matchesFound[0]
        $exe = Resolve-HealthPath $root ($main.ExecutablePath.Substring($root.Length + 1))
        $version = Get-HealthVersion ([Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion)
        $level = 'ok'
        if ($version -eq 'unknown') { $level = 'unknown' }
        Add-Check 'desktop_process' $level '已按可执行文件和正式用户数据目录识别正在运行的桌面；版本 unknown 表示无法读取文件版本。' @{ pid = $main.ProcessId; version = $version; executable = $exe }
        $current = Get-HealthField $pointer 'current'
        if ($current) {
            $expected = Resolve-HealthPath $root ((Get-HealthField $current 'relativePath') + '\DSH Codex Desktop.exe')
            if ($exe -ine $expected) { Add-Check 'desktop_pointer_match' 'warning' '正在运行的 EXE 与当前槽指针不同；可能处于切换中，不应混用两者版本。' }
        }
        $resources = Join-Path ([IO.Path]::GetDirectoryName($exe)) 'resources'
        $dsh = @($processes | Where-Object {
            $_.ParentProcessId -eq $main.ProcessId -and $_.ExecutablePath -ieq (Join-Path $resources 'node\node.exe') -and
            $_.CommandLine -and $_.CommandLine.IndexOf((Join-Path $resources 'bootstrap.mjs'), [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $_.CommandLine -match '\\node_modules\\@deepseek-ai\\dsh\\lib\\bin\.js"?\s+web(?:\s|$)'
        })
        if ($dsh.Count -ne 1) { Add-Check 'runtime_process' 'unknown' '未能唯一识别此正式桌面启动的 Harness；可能尚在启动，未探测其他进程。' }
        else {
            $binMatch = [regex]::Match($dsh[0].CommandLine, '(?:"([^"\r\n]+\\node_modules\\@deepseek-ai\\dsh\\lib\\bin\.js)"|([^\s"]+\\node_modules\\@deepseek-ai\\dsh\\lib\\bin\.js))\s+web(?:\s|$)')
            $bin = $binMatch.Groups[1].Value
            if (-not $bin) { $bin = $binMatch.Groups[2].Value }
            if (-not $bin.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid runtime path' }
            $bin = Resolve-HealthPath $root $bin.Substring($root.Length + 1)
            $packagePath = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($bin))) 'package.json'
            $package = Read-HealthJson (Resolve-HealthPath $root $packagePath.Substring($root.Length + 1))
            $runtimeVersion = Get-HealthVersion (Get-HealthField $package 'version')
            $level = 'ok'
            if ($runtimeVersion -eq 'unknown') { $level = 'unknown' }
            Add-Check 'runtime_process' $level '正式 Harness 进程加载路径对应的包版本。' @{ pid = $dsh[0].ProcessId; version = $runtimeVersion; entry = $bin }
            if ($NoHttp) { Add-Check 'service' 'skipped' '已按参数跳过 HTTP 探测；不能据此判定服务健康。' }
            else {
                $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $dsh[0].ProcessId -and $_.LocalAddress -in @('127.0.0.1', '::1') } | Select-Object -First 3)
                if ($listeners.Count -eq 0) { Add-Check 'service' 'unknown' '正式 Harness 没有可识别的回环监听端口，可能尚未就绪。' }
                foreach ($listener in $listeners) {
                    try {
                        $status = Test-HealthHttp $listener.LocalAddress $listener.LocalPort $TimeoutSeconds
                        $level = 'warning'
                        $description = '回环服务返回非成功状态；未读取响应内容。'
                        if ($status -ge 200 -and $status -lt 300) { $level = 'ok'; $description = '正式 Harness HTTP 可达；不等同于界面、插件或模型调用已通过验收。' }
                        if ($status -in @(401, 403)) { $level = 'info'; $description = '正式 Harness 返回认证拒绝，HTTP 可达；受保护功能未验证。' }
                        if ($status -ge 500) { $level = 'error' }
                        Add-Check 'service' $level $description @{ port = $listener.LocalPort; httpStatus = $status }
                    } catch { Add-Check 'service' 'unknown' '回环服务连接失败或超时；未重试、重启或使用登录凭据。' @{ port = $listener.LocalPort } }
                }
            }
        }
    }
} catch { Add-Check 'process_inspection' 'unknown' '进程、版本或监听端口检查不完整；可能是权限或并发退出，未干预进程。' }
try {
    $logPath = Resolve-HealthPath $root 'Data\Electron\UserData\startup-error.log'
    if (Test-Path -LiteralPath $logPath -PathType Leaf) {
        $log = Get-Item -LiteralPath $logPath
        $age = Get-HealthLogAge $log.LastWriteTimeUtc (Get-HealthField $main 'CreationDate')
        $level = 'info'
        $description = '仅检查错误日志时间和大小，不读取内容；旧日志不代表本次启动失败。'
        if ($age -eq 'since_start' -and $log.Length -gt 0) { $level = 'warning'; $description = '本次桌面启动后错误日志有写入，需要结合服务状态排查；不输出日志内容。' }
        Add-Check 'startup_log' $level $description @{ age = $age; bytes = $log.Length; modifiedUtc = $log.LastWriteTimeUtc.ToString('o') }
    } else { Add-Check 'startup_log' 'info' '未发现启动错误日志；这本身不是启动成功证明。' }
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($root))
    $free = [Math]::Round($drive.AvailableFreeSpace / 1GB, 2)
    $level = 'ok'
    if ($free -lt $MinimumFreeGB) { $level = 'warning' }
    Add-Check 'disk' $level '便携盘可用空间（未进行写入测试或自动清理）。' @{ freeGB = $free; warningBelowGB = $MinimumFreeGB }
} catch { Add-Check 'storage' 'unknown' '日志元数据或磁盘空间无法完整读取。' }
try {
    foreach ($path in $snapshots.Keys) {
        $after = Get-HealthSnapshot $path
        if ($after -ne $snapshots[$path]) { Add-Check 'snapshot' 'unknown' '检查期间版本指针发生变化，本次报告不是一致快照；请稍后重新检查。' }
    }
    if ($main) {
        $stillRunning = Get-CimInstance Win32_Process -Filter "ProcessId = $($main.ProcessId)" -ErrorAction Stop
        if (-not $stillRunning -or $stillRunning.CreationDate -ne $main.CreationDate) { Add-Check 'snapshot' 'unknown' '正式桌面在检查期间已退出或变化；请稍后重新检查。' }
    }
    if ($dsh.Count -eq 1) {
        $stillDsh = Get-CimInstance Win32_Process -Filter "ProcessId = $($dsh[0].ProcessId)" -ErrorAction Stop
        if (-not $stillDsh -or $stillDsh.CreationDate -ne $dsh[0].CreationDate) { Add-Check 'snapshot' 'unknown' 'Harness 在检查期间退出或重启；请重新检查服务状态。' }
    }
} catch { Add-Check 'snapshot' 'unknown' '无法确认检查结束时的进程/版本状态。' }
$overall = 'no_issue_detected'
$exitCode = 0
if (@($checks | Where-Object status -eq 'warning').Count) { $overall = 'attention'; $exitCode = 1 }
if (@($checks | Where-Object { $_.status -in @('unknown', 'skipped') }).Count) { $overall = 'incomplete'; $exitCode = 2 }
if (@($checks | Where-Object status -eq 'error').Count) { $overall = 'error'; $exitCode = 1 }
$report = [pscustomobject]@{ schemaVersion = 1; capturedAt = [DateTime]::UtcNow.ToString('o'); readOnly = $true; portableRoot = $root; overall = $overall; checks = $checks.ToArray() }
if ($AsJson) { $report | ConvertTo-Json -Depth 8 }
else {
    $summaryNames = @{ no_issue_detected = '已完成，未发现明确异常'; attention = '有项目需要关注'; incomplete = '部分检查无法完成'; error = '发现异常' }
    $statusNames = @{ ok = '通过'; info = '说明'; warning = '注意'; error = '异常'; unknown = '未确认'; skipped = '已跳过' }
    $checkNames = @{ update = '更新状态'; desktop_current = '当前桌面槽'; desktop_pending = '待更新桌面槽'; runtime_configured = '配置的运行时'; other_instances = '其他实例'; desktop_process = '正式桌面进程'; desktop_pointer_match = '运行版本一致性'; runtime_process = '实际运行时'; service = '服务响应'; startup_log = '启动错误记录'; disk = '磁盘空间'; snapshot = '快照一致性' }
    $fieldNames = @{ version = '版本'; path = '目录'; pid = '进程号'; executable = '程序'; entry = '入口'; count = '数量'; freeGB = '可用空间 GB'; warningBelowGB = '警告阈值 GB'; port = '端口'; httpStatus = 'HTTP 状态'; modifiedUtc = '记录时间 UTC'; bytes = '字节数'; age = '记录归属'; state = '状态'; progress = '记录进度 %' }
    $valueNames = @{ waiting_activation = '等待正常退出后启动验证'; historical = '早于本次启动'; since_start = '本次启动后'; unknown_age = '无正式进程，无法判断新旧' }
    Write-Output "DSH 便携版只读健康检查 — $($summaryNames[$overall])"
    Write-Output '不会构建、更新、重启、清理或修改配置。结果只代表本次检查时刻。'
    foreach ($check in $checks) {
        $label = $checkNames[$check.id]
        if (-not $label) { $label = $check.id }
        Write-Output "`n[$($statusNames[$check.status])] ${label}：$($check.message)"
        if ($check.evidence) {
            foreach ($key in @($check.evidence.Keys | Sort-Object)) {
                $field = $fieldNames[$key]
                if (-not $field) { $field = $key }
                $value = $check.evidence[$key]
                if ($null -ne $value -and $valueNames.ContainsKey([string]$value)) { $value = $valueNames[[string]$value] }
                Write-Output "  ${field}：$value"
            }
        }
    }
    Write-Output "`n退出码：$exitCode（0=未发现问题；1=需关注；2=检查不完整）"
}
exit $exitCode
