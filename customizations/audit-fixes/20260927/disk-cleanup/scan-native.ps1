$ErrorActionPreference='Stop'
Add-Type @'
using System;using System.IO;using System.Collections.Generic;using System.Runtime.InteropServices;
public class NativeDiskRow {public string Path;public long Bytes;public long Files;public long Links;}
public static class NativeDiskAudit {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct FindData {
  public uint Attr; public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;
  public uint High,Low,Reserved0,Reserved1;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=14)] public string Alternate;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstFileExW(string path,int level,out FindData data,int search,IntPtr filter,int flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextFileW(IntPtr handle,out FindData data);
 [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr handle);
 public static List<NativeDiskRow> Rows=new List<NativeDiskRow>();
 public static List<NativeDiskRow> Large=new List<NativeDiskRow>();
 public static List<string> Errors=new List<string>();
 public static NativeDiskRow Scan(string path,int depth){
  var row=new NativeDiskRow{Path=path};FindData data;
  var h=FindFirstFileExW(@"\\?\"+path.TrimEnd('\\')+@"\*",1,out data,0,IntPtr.Zero,2);
  if(h==new IntPtr(-1)){Errors.Add(path+": Win32 "+Marshal.GetLastWin32Error());return row;}
  try {do {
   if(data.Name=="."||data.Name=="..")continue;
   string next=Path.Combine(path,data.Name);
   if((data.Attr&1024)!=0){row.Links++;continue;}
   if((data.Attr&16)!=0){var child=Scan(next,depth+1);row.Bytes+=child.Bytes;row.Files+=child.Files;row.Links+=child.Links;}
   else{long size=((long)data.High<<32)+data.Low;row.Bytes+=size;row.Files++;if(size>=268435456)Large.Add(new NativeDiskRow{Path=next,Bytes=size,Files=1});}
  }while(FindNextFileW(h,out data));int error=Marshal.GetLastWin32Error();if(error!=18)Errors.Add(path+": enumeration Win32 "+error);
  }finally{FindClose(h);}
  if(depth<=5)Rows.Add(row);
  if(depth==1||(depth==2&&path.StartsWith(@"G:\DSH-3-Portable\",StringComparison.OrdinalIgnoreCase)))Console.WriteLine(path+" "+Math.Round(row.Bytes/1073741824.0,2)+" GiB logical; "+row.Files+" files");
  return row;
 }
}
'@
$started=Get-Date
[void][NativeDiskAudit]::Scan('G:\',0)
[ordered]@{at=$started.ToString('o');finished=(Get-Date).ToString('o');scope='G:\';note='Read-only native enumeration, no reparse traversal. Logical bytes include duplicate hardlinks. Concurrent cleanup means this is not an atomic snapshot.';rows=[NativeDiskAudit]::Rows;largeFiles=[NativeDiskAudit]::Large;errors=[NativeDiskAudit]::Errors}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath "$PSScriptRoot\scan-native.json" -Encoding utf8
Write-Output 'Native disk audit complete.'
