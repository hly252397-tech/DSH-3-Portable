param([string]$ScanRoot='G:\',[string]$OutFile="$PSScriptRoot\scan.json")
$ErrorActionPreference='Stop'
Add-Type @'
using System; using System.IO; using System.Collections.Generic;
public class DiskRow { public string Path; public long Bytes; public long Files; public long Links; }
public static class DiskAudit {
 public static List<DiskRow> Rows=new List<DiskRow>();
 public static List<string> Errors=new List<string>();
 public static List<DiskRow> Large=new List<DiskRow>();
 public static DiskRow Scan(string path,int depth) {
  var row=new DiskRow{Path=path};
  try { foreach(var item in new DirectoryInfo(path).EnumerateFileSystemInfos()) {
   if((item.Attributes & FileAttributes.ReparsePoint)!=0){row.Links++;continue;}
   if((item.Attributes & FileAttributes.Directory)!=0){var child=Scan(item.FullName,depth+1);row.Bytes+=child.Bytes;row.Files+=child.Files;row.Links+=child.Links;}
   else {long bytes=((FileInfo)item).Length; row.Bytes+=bytes;row.Files++;if(bytes>=268435456) Large.Add(new DiskRow{Path=item.FullName,Bytes=bytes,Files=1});}
  }} catch(Exception e){Errors.Add(path+": "+e.Message);}
  if(depth<=5)Rows.Add(row);
  if(depth==1)Console.WriteLine("scanned "+path+" "+Math.Round(row.Bytes/1073741824.0,2)+" GiB logical");
  return row;
 }
}
'@
$volume=Get-Volume -DriveLetter G
$started=Get-Date
[void][DiskAudit]::Scan($ScanRoot,0)
[ordered]@{at=$started.ToString('o');finished=(Get-Date).ToString('o');freeBytesBefore=$volume.SizeRemaining;scope=$ScanRoot;note='Logical file bytes; hardlinks may be counted more than once. Reparse points never followed.';rows=[DiskAudit]::Rows;largeFiles=[DiskAudit]::Large;errors=[DiskAudit]::Errors} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutFile -Encoding utf8
Write-Output "Report: $OutFile"
