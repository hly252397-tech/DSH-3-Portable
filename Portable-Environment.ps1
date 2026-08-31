Set-StrictMode -Version Latest

function Set-DshPortableEnvironment {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$PortableRoot
  )

  $resolvedRoot = [System.IO.Path]::GetFullPath($PortableRoot)
  $dataRoot = Join-Path $resolvedRoot 'Data'
  $developmentRoot = Join-Path $dataRoot 'Development'
  $paths = [ordered]@{
    Root = $resolvedRoot
    App = Join-Path $resolvedRoot 'App'
    Data = $dataRoot
    Home = Join-Path $dataRoot 'Home'
    DshHome = Join-Path $dataRoot 'DSH'
    UserData = Join-Path $dataRoot 'Electron\UserData'
    Cache = Join-Path $dataRoot 'Electron\Cache'
    SessionData = Join-Path $dataRoot 'Electron\SessionData'
    CrashDumps = Join-Path $dataRoot 'Electron\CrashDumps'
    Logs = Join-Path $dataRoot 'Logs'
    Temp = Join-Path $dataRoot 'Temp'
    AppData = Join-Path $dataRoot 'Windows\Roaming'
    LocalAppData = Join-Path $dataRoot 'Windows\Local'
    Workspace = Join-Path $resolvedRoot 'Workspace'
    Development = $developmentRoot
  }

  foreach ($path in @($paths.Data, $paths.Home, $paths.DshHome, $paths.UserData, $paths.Cache, $paths.SessionData, $paths.CrashDumps, $paths.Logs, $paths.Temp, $paths.AppData, $paths.LocalAppData, $paths.Workspace, $paths.Development)) {
    if (-not (Test-Path -LiteralPath $path)) {
      New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
  }

  $environmentVariables = [ordered]@{
    DSH_PORTABLE_ROOT = $resolvedRoot
    DSH_HOME = $paths.DshHome
    DSH_DESKTOP_RUNTIME_DIR = Join-Path $dataRoot 'Runtime\dsh-runtime'
    DSH_WORKSPACE_ROOT = $paths.Workspace
    HOME = $paths.Home
    USERPROFILE = $paths.Home
    APPDATA = $paths.AppData
    LOCALAPPDATA = $paths.LocalAppData
    TEMP = $paths.Temp
    TMP = $paths.Temp
    XDG_CONFIG_HOME = Join-Path $dataRoot 'XDG\Config'
    XDG_CACHE_HOME = Join-Path $dataRoot 'XDG\Cache'
    XDG_DATA_HOME = Join-Path $dataRoot 'XDG\Data'
    npm_config_cache = Join-Path $developmentRoot 'npm-cache'
    npm_config_prefix = Join-Path $developmentRoot 'npm-global'
    npm_config_userconfig = Join-Path $developmentRoot 'npmrc'
    PNPM_HOME = Join-Path $developmentRoot 'pnpm-home'
    PNPM_STORE_DIR = Join-Path $developmentRoot 'pnpm-store'
    ELECTRON_CACHE = Join-Path $developmentRoot 'electron-cache'
    ELECTRON_BUILDER_CACHE = Join-Path $developmentRoot 'electron-builder-cache'
    PLAYWRIGHT_BROWSERS_PATH = Join-Path $developmentRoot 'playwright'
    PIP_CACHE_DIR = Join-Path $developmentRoot 'pip-cache'
    PYTHONUSERBASE = Join-Path $developmentRoot 'python-user'
    CARGO_HOME = Join-Path $developmentRoot 'cargo'
    RUSTUP_HOME = Join-Path $developmentRoot 'rustup'
    GOPATH = Join-Path $developmentRoot 'go'
    GOCACHE = Join-Path $developmentRoot 'go-cache'
    DOTNET_CLI_HOME = Join-Path $developmentRoot 'dotnet'
    NUGET_PACKAGES = Join-Path $developmentRoot 'nuget'
    GIT_CONFIG_GLOBAL = Join-Path $developmentRoot 'gitconfig'
  }

  foreach ($entry in $environmentVariables.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, 'Process')
    if (-not (Test-Path -LiteralPath $entry.Value) -and $entry.Key -notin @('DSH_PORTABLE_ROOT', 'DSH_DESKTOP_RUNTIME_DIR', 'DSH_WORKSPACE_ROOT', 'npm_config_userconfig', 'GIT_CONFIG_GLOBAL')) {
      New-Item -ItemType Directory -Path $entry.Value -Force | Out-Null
    }
  }

  # pnpm records absolute store and virtual-store paths. Rebase the two known
  # portable profiles before either the official build or this fork starts.
  $stateFiles = @(
    (Join-Path $paths.DshHome 'profiles\web\node_modules\.modules.yaml'),
    (Join-Path $dataRoot 'Runtime\dsh-runtime\node_modules\.modules.yaml'),
    (Join-Path $paths.App 'dsh-runtime\node_modules\.modules.yaml')
  )
  $currentRootSlash = $resolvedRoot.Replace('\', '/').TrimEnd('/')
  foreach ($stateFile in $stateFiles) {
    if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) { continue }
    $state = Get-Content -LiteralPath $stateFile -Raw
    $stateObject = $null
    try { $stateObject = $state | ConvertFrom-Json } catch { }
    if ($stateObject -and $stateObject.storeDir) {
      $recordedStore = ([string]$stateObject.storeDir).Replace('\', '/')
    } else {
      $storeMatch = [regex]::Match($state, '(?im)^storeDir:\s*["'']?(?<path>.+?)["'']?\s*$')
      if (-not $storeMatch.Success) { continue }
      $recordedStore = $storeMatch.Groups['path'].Value.Replace('\', '/')
    }
    $layoutIndex = $recordedStore.IndexOf('/Data/', [System.StringComparison]::OrdinalIgnoreCase)
    if ($layoutIndex -lt 0) { $layoutIndex = $recordedStore.IndexOf('/App/', [System.StringComparison]::OrdinalIgnoreCase) }
    if ($layoutIndex -lt 0) { continue }
    $oldRootSlash = $recordedStore.Substring(0, $layoutIndex).TrimEnd('/')
    if ($oldRootSlash.Equals($currentRootSlash, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    if ($stateObject -and $stateObject.storeDir) {
      foreach ($property in @('storeDir', 'virtualStoreDir')) {
        if (-not $stateObject.PSObject.Properties[$property]) { continue }
        $value = ([string]$stateObject.$property).Replace('\', '/')
        if ($value.StartsWith($oldRootSlash + '/', [System.StringComparison]::OrdinalIgnoreCase)) {
          $stateObject.$property = ($currentRootSlash + $value.Substring($oldRootSlash.Length)).Replace('/', '\')
        }
      }
      $nextState = $stateObject | ConvertTo-Json -Depth 100
      $nextState += "`n"
    } else {
      $nextState = [regex]::Replace($state, [regex]::Escape($oldRootSlash), $currentRootSlash, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }
    [System.IO.File]::WriteAllText($stateFile, $nextState, [System.Text.UTF8Encoding]::new($false))
  }

  return [pscustomobject]$paths
}
