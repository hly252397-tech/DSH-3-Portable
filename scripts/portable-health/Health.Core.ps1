Set-StrictMode -Version 2.0

function Get-HealthField($Object, [string]$Name, $Default = $null) {
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $Default
}

function Resolve-HealthPath([string]$Root, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or
        $Relative.Contains(':') -or ($Relative -split '[/\\]' -contains '..')) { throw 'Unsafe relative path' }
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $full = [IO.Path]::GetFullPath((Join-Path $base $Relative))
    if (-not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Outside portable root' }
    # Reject junctions/symlinks, including the root and its ancestors. Never inspect their targets.
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Reparse point is not inspected'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}

function Read-HealthJson([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try {
        if ($stream.Length -gt 1MB) { throw 'Metadata exceeds size limit' }
        $reader = New-Object IO.StreamReader($stream)
        try { return ($reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop) } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Get-HealthSnapshot([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'missing' }
    if ((Get-Item -LiteralPath $Path).Length -gt 1MB) { throw 'Metadata exceeds size limit' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-HealthArgument([string]$Command, [string]$Name) {
    $pattern = '(?:^|\s)' + [regex]::Escape($Name) + '(?:=|\s+)(?:"([^"]*)"|([^\s"]+))(?=\s|$)'
    $matchesFound = [regex]::Matches($Command, $pattern)
    if ($matchesFound.Count -ne 1) { return $null }
    if ($matchesFound[0].Groups[1].Success) { return $matchesFound[0].Groups[1].Value }
    return $matchesFound[0].Groups[2].Value
}

function Select-HealthDesktop($Processes, [string]$Root, [string]$UserData) {
    foreach ($process in $Processes) {
        $exe = [string](Get-HealthField $process 'ExecutablePath' '')
        $cmd = [string](Get-HealthField $process 'CommandLine' '')
        if (-not $exe.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
        if ([IO.Path]::GetFileName($exe) -ine 'DSH Codex Desktop.exe' -or $cmd -match '(?:^|\s)--type(?:=|\s)') { continue }
        $profile = Get-HealthArgument $cmd '--user-data-dir'
        if ($profile -and [IO.Path]::GetFullPath($profile).TrimEnd('\') -ieq $UserData.TrimEnd('\')) { $process }
    }
}

function Get-HealthUpdateStatus($Pointer, $State) {
    $pending = Get-HealthField $Pointer 'pending'
    $phase = Get-HealthField $State 'phase' 'unknown'
    if ($phase -in @('failed', 'error', 'rolled-back')) { return 'failed' }
    if ($pending -and $phase -eq 'deploying' -and
        (Get-HealthField $pending 'transactionId') -eq (Get-HealthField $State 'transactionId') -and
        (Get-HealthField $pending 'transactionId')) { return 'waiting_activation' }
    if ($pending) { return 'candidate_present' }
    return $phase
}

function Get-HealthLogAge([datetime]$ModifiedUtc, $StartedUtc) {
    if ($null -eq $StartedUtc) { return 'unknown_age' }
    if ($ModifiedUtc -lt ([datetime]$StartedUtc).ToUniversalTime()) { return 'historical' }
    return 'since_start'
}

function Test-HealthHttp([string]$Address, [int]$Port, [int]$TimeoutSeconds) {
    if ($Address -notin @('127.0.0.1', '::1') -or $Port -lt 1 -or $Port -gt 65535) { throw 'Only loopback endpoints are allowed' }
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $handler.UseCookies = $false
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    $response = $null
    try {
        $hostAddress = $Address
        if ($Address -eq '::1') { $hostAddress = '[::1]' }
        # Headers only: no credentials, cookies, redirect, or response body is read/exported.
        $response = $client.GetAsync("http://${hostAddress}:$Port/", [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        return [int]$response.StatusCode
    } finally {
        if ($response) { $response.Dispose() }
        $client.Dispose()
        $handler.Dispose()
    }
}

function Get-HealthVersion($Value) {
    $text = [string]$Value
    if ($text -match '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$') { return $text }
    return 'unknown'
}
