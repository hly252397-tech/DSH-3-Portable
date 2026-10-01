$ErrorActionPreference='Stop'
$repo='G:\DSH-3-Portable'
$base=Join-Path $repo 'Data\Temp'
$names=@('desktop-fix-pack','desktop-fix-pack2','desktop-fix-pack3','desktop-fix-pack4','desktop-fix-pack5')
$processes=@(Get-CimInstance Win32_Process)
$targets=@(foreach($name in $names){
 $path=[IO.Path]::GetFullPath((Join-Path $base $name))
 if([IO.Path]::GetDirectoryName($path) -ne $base){throw 'Target escaped exact temp parent'}
 $item=Get-Item -LiteralPath $path -Force
 if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked target: $path"}
 foreach($proc in $processes){if($proc.CommandLine -and ($proc.CommandLine.Replace('/','\').IndexOf($path,[StringComparison]::OrdinalIgnoreCase) -ge 0)){throw "In-use target PID $($proc.ProcessId): $path"}}
 $all=@(Get-ChildItem -LiteralPath $path -Recurse -Force)
 if(@($all|Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw "Nested link: $path"}
 $files=@($all|Where-Object {-not $_.PSIsContainer})
 if(@($files|Where-Object {$_.LastWriteTime -ge [datetime]'2026-09-20'}).Count){throw "Recently changed target: $path"}
 [pscustomobject]@{path=$path;bytes=($files|Measure-Object Length -Sum).Sum;files=$files.Count;reason='Obsolete 2026-09-19 packaged temp output; no active process references; no reparse points'}
})
$before=(Get-Volume -DriveLetter G).SizeRemaining
$targets|ConvertTo-Json -Depth 5|Set-Content -LiteralPath "$PSScriptRoot\first-batch-targets.json" -Encoding utf8
foreach($target in $targets){
 Write-Output "Deleting verified obsolete output: $($target.path)"
 Remove-Item -LiteralPath $target.path -Recurse -Force
 if(Test-Path -LiteralPath $target.path){throw 'Removal incomplete'}
 [pscustomobject]@{at=(Get-Date).ToString('o');deleted=$target.path;logicalBytes=$target.bytes}|ConvertTo-Json -Compress|Add-Content -LiteralPath "$PSScriptRoot\deleted.jsonl" -Encoding utf8
 Write-Output "Deleted: $($target.path)"
}
# User separately authorized permanently emptying the G: recycle bin.
Write-Output 'Emptying only G: recycle bin (explicit user approval).'
Clear-RecycleBin -DriveLetter G -Force -ErrorAction Stop
$after=(Get-Volume -DriveLetter G).SizeRemaining
[ordered]@{at=(Get-Date).ToString('o');freeBefore=$before;freeAfter=$after;netFreed=$after-$before;recycleBinEmptied=$true}|ConvertTo-Json|Set-Content -LiteralPath "$PSScriptRoot\first-batch-result.json" -Encoding utf8
Write-Output "First batch finished; free bytes $before -> $after"
