$ErrorActionPreference='Stop'
$modelRoot='G:\DSH-3-Portable\Data\ollama-models'
$name='sha256-f5f1dd8920d417aac2718b0bda3403da274301efdd6760b4f0f4b864ff2ad57d'
$target=[IO.Path]::GetFullPath((Join-Path "$modelRoot\blobs" $name))
if([IO.Path]::GetDirectoryName($target) -ne "$modelRoot\blobs"){throw 'Invalid exact target'}
foreach($path in @('G:\DSH-3-Portable','G:\DSH-3-Portable\Data',$modelRoot,"$modelRoot\blobs",$target)){
 if((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked path: $path"}
}
$processes=@(Get-CimInstance Win32_Process)
if(@($processes|Where-Object {$_.Name -like '*ollama*'}).Count){throw 'Ollama is running; deletion refused'}
foreach($process in $processes){if($process.ProcessId -ne $PID -and $process.CommandLine -and $process.CommandLine.Contains($name)){throw 'Target referenced by process'} }
$manifests=@(Get-ChildItem -LiteralPath "$modelRoot\manifests" -File -Recurse)
if(-not $manifests.Count){throw 'No model manifests; cannot determine references'}
$snapshot=@(foreach($file in $manifests){
 $manifest=Get-Content -LiteralPath $file.FullName -Raw|ConvertFrom-Json
 foreach($layer in @($manifest.config)+@($manifest.layers)){
  if($layer.digest -and $layer.digest.Replace(':','-') -eq $name){throw 'Model now referenced; deletion refused'}
 }
 [pscustomobject]@{path=$file.FullName;sha256=(Get-FileHash -LiteralPath $file.FullName).Hash}
})
$file=Get-Item -LiteralPath $target
if($file.Length -ne 16810714464){throw 'Target changed size since approval'}
$before=(Get-Volume -DriveLetter G).SizeRemaining
[ordered]@{approvedBy='Explicit user reply: delete the file not referenced by model manifests';target=$target;bytes=$file.Length;manifests=$snapshot}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath "$PSScriptRoot\orphan-model-before.json" -Encoding utf8
Remove-Item -LiteralPath $target -Force
if(Test-Path -LiteralPath $target){throw 'Model removal incomplete'}
foreach($item in $snapshot){if((Get-FileHash -LiteralPath $item.path).Hash -ne $item.sha256){throw 'Model manifest changed; review required'} }
$after=(Get-Volume -DriveLetter G).SizeRemaining
[ordered]@{at=(Get-Date).ToString('o');deleted=$target;logicalBytes=16810714464;manifestCountUnchanged=$snapshot.Count;freeBefore=$before;freeAfter=$after;netFreedDuringRemoval=$after-$before;recoverability='Requires re-download; not retained locally'}|ConvertTo-Json|Tee-Object -FilePath "$PSScriptRoot\orphan-model-result.json"
