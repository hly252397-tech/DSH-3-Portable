param([switch]$Apply)
$ErrorActionPreference='Stop'
$base='G:\DSH-3-Portable\Data\Updates\Backups'
$planPath="$PSScriptRoot\old-backup-duplicates.json"
function Get-BufferedSha256([string]$path){
 $stream=[IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read,1048576,[IO.FileOptions]::SequentialScan)
 $sha=[Security.Cryptography.SHA256]::Create()
 try{return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','')}finally{$sha.Dispose();$stream.Dispose()}
}
function Assert-OldFile([string]$path){
 $full=[IO.Path]::GetFullPath($path)
 if(-not $full.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Outside old backup root'}
 $relative=$full.Substring($base.Length+1)
 $folder=$relative.Split('\')[0]
 if($folder -notmatch '^(browser-port-2026090[12]-\d{6}|source-build-20260901-\d{6}|pre-(pnpm-json|relocation)-fix-20260831-\d{6}|failed-incomplete-browser-port-20260901-\d{6})$'){throw "Not an approved historical program backup: $full"}
 $tail=$relative.Substring($folder.Length+1)
 if($tail -notin @('DSH Codex Desktop.exe','dxcompiler.dll','resources.pak','icudtl.dat','resources\node\node.exe','resources\dsh-runtime.tgz','resources\plugins-store.tgz')){throw 'Not a packaged vendor/runtime file'}
 $walk=$full
 while($walk -ne $base){$item=Get-Item -LiteralPath $walk -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Reparse point: $walk"};$walk=[IO.Path]::GetDirectoryName($walk)}
 return $full
}
if(-not $Apply){
 $files=@(foreach($dir in Get-ChildItem -LiteralPath $base -Directory){
  if($dir.Name -notmatch '^(browser-port-2026090[12]-\d{6}|source-build-20260901-\d{6}|pre-(pnpm-json|relocation)-fix-20260831-\d{6}|failed-incomplete-browser-port-20260901-\d{6})$'){continue}
  foreach($tail in @('DSH Codex Desktop.exe','dxcompiler.dll','resources.pak','icudtl.dat','resources\node\node.exe','resources\dsh-runtime.tgz','resources\plugins-store.tgz')){
   $path=Join-Path $dir.FullName $tail
   if(Test-Path -LiteralPath $path -PathType Leaf){$valid=Assert-OldFile $path;Get-Item -LiteralPath $valid}
  }
 })
 $hashes=@(foreach($group in ($files|Group-Object Length|Where-Object Count -gt 1)){foreach($file in $group.Group){[pscustomobject]@{path=$file.FullName;bytes=$file.Length;hash=(Get-BufferedSha256 $file.FullName)}}})
 $plan=@(foreach($group in ($hashes|Group-Object hash|Where-Object Count -gt 1)){
  $sorted=@($group.Group|Sort-Object path -Descending);$keep=$sorted[0]
  foreach($duplicate in $sorted|Select-Object -Skip 1){[pscustomobject]@{delete=$duplicate.path;keep=$keep.path;bytes=$duplicate.bytes;sha256=$duplicate.hash}}
 })
 $plan|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $planPath -Encoding utf8
 [pscustomobject]@{duplicateFiles=$plan.Count;logicalBytes=($plan|Measure-Object bytes -Sum).Sum;plan=$planPath}|ConvertTo-Json
 exit
}
$plan=@(Get-Content -LiteralPath $planPath -Raw|ConvertFrom-Json)
$processes=@(Get-CimInstance Win32_Process)
$verified=@{}
foreach($entry in $plan){
 $delete=Assert-OldFile $entry.delete;$keep=Assert-OldFile $entry.keep
 if($delete -eq $keep){throw 'Same source and retained copy'}
 foreach($proc in $processes){if($proc.CommandLine -and $proc.CommandLine.Replace('/','\').IndexOf([IO.Path]::GetDirectoryName($delete),[StringComparison]::OrdinalIgnoreCase) -ge 0){throw "Referenced by PID $($proc.ProcessId)"}}
 foreach($path in @($delete,$keep)){if(-not $verified.ContainsKey($path)){$verified[$path]=Get-BufferedSha256 $path};if($verified[$path] -ne $entry.sha256){throw "Changed since plan: $path"}}
}
foreach($entry in $plan){
 if(-not(Test-Path -LiteralPath $entry.keep -PathType Leaf)){throw 'Retained copy missing'}
 Remove-Item -LiteralPath $entry.delete -Force
 [pscustomobject]@{at=(Get-Date).ToString('o');deleted=$entry.delete;recoverFrom=$entry.keep;sha256=$entry.sha256;bytes=$entry.bytes}|ConvertTo-Json -Compress|Add-Content -LiteralPath "$PSScriptRoot\old-backup-deleted.jsonl" -Encoding utf8
}
Write-Output "Removed $($plan.Count) byte-identical old packaged files. Retained copies and restoration mapping preserved."
