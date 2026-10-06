#requires -Version 5.1
[CmdletBinding()]
param([ValidateSet('capabilities','scan','resources','processes','services','storage','files','control','versions','models','concurrency')][string]$Helper = 'capabilities')

# Fixed dispatcher for the administrator-installed ViiOS Windows agent.
# No request is ever evaluated as PowerShell, a command line, or a script.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# SSH can be launched by PowerShell 7. Prefer this engine's bundled modules over
# inherited module search paths so Windows PowerShell loads matching CIM types.
$nativeModules = Join-Path $PSHOME 'Modules'
$env:PSModulePath = (@($nativeModules) + @($env:PSModulePath.Split(';') | Where-Object { $_ -and $_ -ne $nativeModules })) -join ';'
$script:Utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$script:StateDirectory = Join-Path $env:ProgramData 'ViiOS\agent'
$script:Configuration = @{ roots = @(); services = @() }
$script:TextLimit = 1MB
$script:FileLimit = 16MB
$script:CopyLimit = 200MB
$script:EntryLimit = 5000

function Fail([string]$Message, [int]$Status = 400) {
    $exception = New-Object System.InvalidOperationException($Message)
    $exception.Data['status'] = $Status
    $exception.Data['public'] = $true
    throw $exception
}
function Timestamp { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Hash-Text([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($script:Utf8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Initialize-Native {
    if ('ViiOS.Native' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
namespace ViiOS {
 public sealed class ProcessInfo { public long Started; public string User, Sid; public bool Critical; }
 public static class ProcessGuard {
  [DllImport("kernel32.dll",SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeProcessHandle h,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessCritical(SafeProcessHandle h,out bool critical);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(SafeProcessHandle h,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(SafeProcessHandle h,uint timeout);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(SafeProcessHandle h,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int size,out int required);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static ConcurrentDictionary<string,string> names=new ConcurrentDictionary<string,string>();
  static ProcessInfo InspectHandle(SafeProcessHandle h) {
   long started,exited,kernel,user; bool critical;
   if(h.IsInvalid || !GetProcessTimes(h,out started,out exited,out kernel,out user)) throw new IOException("Process unavailable");
   if(!IsProcessCritical(h,out critical)) critical=true;
   string sid="",name=""; IntPtr token;
   if(OpenProcessToken(h,8,out token)) { try { int size; GetTokenInformation(token,1,IntPtr.Zero,0,out size);
    if(size>0 && size<65536) { IntPtr buffer=Marshal.AllocHGlobal(size); try {
     if(GetTokenInformation(token,1,buffer,size,out size)) { var identity=new System.Security.Principal.SecurityIdentifier(Marshal.ReadIntPtr(buffer)); sid=identity.Value;
      name=names.GetOrAdd(sid,key=>{try {return identity.Translate(typeof(System.Security.Principal.NTAccount)).Value;}catch{return key;}});
     }
    } finally {Marshal.FreeHGlobal(buffer);} }
   } finally {CloseHandle(token);} }
   return new ProcessInfo {Started=started,User=name,Sid=sid,Critical=critical};
  }
  public static ProcessInfo Inspect(int pid) { using(var h=OpenProcess(0x1000,false,pid)) {return InspectHandle(h);} }
  public static bool Terminate(int pid,long expected) {
   // Keep one kernel handle from identity verification through termination.
   using(var h=OpenProcess(0x101001,false,pid)) {var info=InspectHandle(h);
    if(info.Started!=expected) throw new InvalidOperationException("Process identity changed");
    if(info.Critical || info.Sid=="" || info.Sid=="S-1-5-18" || info.Sid=="S-1-5-19" || info.Sid=="S-1-5-20") throw new UnauthorizedAccessException("Protected process");
    if(!TerminateProcess(h,1)) throw new IOException("Termination unavailable");
    return WaitForSingleObject(h,1500)==0;
   }
  }
 }
 public sealed class ProbeTarget { public string Host; public int Port; }
 public sealed class ProbeResult {
  public string Host,Protocol,Title,Kind,ContentType; public int Port,Status,Latency; public bool TlsUnverified;
 }
 public static class WebProbe {
  static ProbeResult Request(ProbeTarget target,bool secure) {
   Stopwatch timer=Stopwatch.StartNew(); TcpClient client=new TcpClient(); Stream stream=null;
   try {
    IAsyncResult connect=client.BeginConnect(target.Host,target.Port,null,null);
    using(connect.AsyncWaitHandle) { if(!connect.AsyncWaitHandle.WaitOne(400)) return null; }
    client.EndConnect(connect); stream=client.GetStream(); bool unverified=false;
    if(secure) {
     SslStream ssl=new SslStream(stream,false,(sender,certificate,chain,errors)=> { unverified=errors!=SslPolicyErrors.None; return true; }); stream=ssl;
     IAsyncResult auth=ssl.BeginAuthenticateAsClient("localhost",null,SslProtocols.Tls12,false,null,null);
     using(auth.AsyncWaitHandle) { if(!auth.AsyncWaitHandle.WaitOne(500)) return null; }
     ssl.EndAuthenticateAsClient(auth);
    }
    stream.WriteTimeout=250; string host=target.Host.IndexOf(':')>=0 ? "["+target.Host+"]" : target.Host;
    byte[] request=Encoding.ASCII.GetBytes("GET / HTTP/1.1\r\nHost: "+host+":"+target.Port+"\r\nUser-Agent: ViiOS/1.0 (read-only inventory)\r\nAccept: text/html,application/json;q=0.8\r\nConnection: close\r\n\r\n");
    stream.Write(request,0,request.Length); byte[] buffer=new byte[32768]; int length=0; string text="";
    while(length<buffer.Length && timer.ElapsedMilliseconds<1200) {
     stream.ReadTimeout=Math.Max(25,Math.Min(250,1200-(int)timer.ElapsedMilliseconds)); int count;
     try { count=stream.Read(buffer,length,buffer.Length-length); } catch(IOException) { break; }
     if(count==0) break; length+=count; text=Encoding.UTF8.GetString(buffer,0,length);
     if(length>=12 && !text.StartsWith("HTTP/1.")) return null;
     int headerEnd=text.IndexOf("\r\n\r\n",StringComparison.Ordinal);
     if(headerEnd<0 && length>8192) return null;
     if(headerEnd>=0 && (text.IndexOf("</title>",StringComparison.OrdinalIgnoreCase)>=0 || length>16384)) break;
    }
    text=Encoding.UTF8.GetString(buffer,0,length); int boundary=text.IndexOf("\r\n\r\n",StringComparison.Ordinal); if(boundary<0) return null;
    Match status=Regex.Match(text,@"\AHTTP/1\.[01] ([1-5]\d\d)\b"); if(!status.Success) return null;
    string header=text.Substring(0,boundary); Match mime=Regex.Match(header,@"(?im)^Content-Type:\s*([^\r\n]+)"); string content=mime.Success ? mime.Groups[1].Value.Trim() : "";
    string title=""; if(content.IndexOf("html",StringComparison.OrdinalIgnoreCase)>=0) {
     Match match=Regex.Match(text.Substring(boundary+4),@"(?is)<title(?:\s[^>]*)?>(.*?)</title>");
     if(match.Success) { title=WebUtility.HtmlDecode(Regex.Replace(match.Groups[1].Value,"<[^>]*>","")); title=Regex.Replace(title,@"[\s\x00-\x1f\x7f]+"," ").Trim(); if(title.Length>180) title=title.Substring(0,180); }
    }
    int code=int.Parse(status.Groups[1].Value); string kind=content.IndexOf("html",StringComparison.OrdinalIgnoreCase)>=0 && code<400 ? "web" : content.IndexOf("json",StringComparison.OrdinalIgnoreCase)>=0 ? "api" : code>=300 && code<400 ? "web" : "service";
    return new ProbeResult { Host=target.Host,Port=target.Port,Protocol=secure ? "https":"http",Status=code,Title=title,Kind=kind,ContentType=content,TlsUnverified=unverified,Latency=(int)timer.ElapsedMilliseconds };
   } catch { return null; } finally { if(stream!=null) stream.Dispose(); client.Close(); }
  }
  public static ProbeResult[] Probe(ProbeTarget[] targets) {
   ConcurrentBag<ProbeResult> results=new ConcurrentBag<ProbeResult>(); Stopwatch budget=Stopwatch.StartNew();
   Parallel.ForEach(targets,new ParallelOptions { MaxDegreeOfParallelism=6 },target=> {
    if(budget.ElapsedMilliseconds>=20000) return;
    ProbeResult result=Request(target,false); if(result==null && budget.ElapsedMilliseconds<20000) result=Request(target,true);
    if(result!=null) results.Add(result);
   });
   return results.ToArray();
  }
 }
 public sealed class FileInfo {
  public long Size, Allocated, Written, Created; public uint Attributes, Links, Volume;
  public ulong Identity;
 }
 public static class Native {
  [StructLayout(LayoutKind.Sequential)] struct Standard { public long AllocationSize, EndOfFile; public uint Links; public byte DeletePending, Directory; }
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int kind,out Standard info,uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetDiskFreeSpaceEx(string path,out ulong available,out ulong total,out ulong free);
  public static SafeFileHandle Guard(string path) {
   SafeFileHandle h=CreateFile(path,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
   if(h.IsInvalid) { h.Dispose(); throw new IOException("Cannot inspect filesystem entry"); }
   Info i; if(!GetFileInformationByHandle(h,out i) || (i.Attributes & 0x400)!=0) { h.Dispose(); throw new IOException("Reparse entry is not allowed"); }
   return h;
  }
  public static FileInfo Inspect(string path) {
   using(SafeFileHandle h=Guard(path)) { return InspectHandle(h); }
  }
  public static FileInfo InspectHandle(SafeFileHandle h) {
    Info i; Standard s;
    if(!GetFileInformationByHandle(h,out i)) throw new IOException("Metadata unavailable");
    if(!GetFileInformationByHandleEx(h,1,out s,(uint)Marshal.SizeOf(typeof(Standard)))) throw new IOException("Allocation metadata unavailable");
    return new FileInfo { Size=s.EndOfFile,Allocated=s.AllocationSize,Attributes=i.Attributes,Links=i.Links,Volume=i.Volume,
     Identity=((ulong)i.IndexHigh<<32)|i.IndexLow,Written=((long)i.Written.dwHighDateTime<<32)|(uint)i.Written.dwLowDateTime,
     Created=((long)i.Created.dwHighDateTime<<32)|(uint)i.Created.dwLowDateTime };
  }
  public static FileStream OpenFile(string path,bool writable,bool create) {
   SafeFileHandle h=CreateFile(path,writable ? 0xC0000000u : 0x80000000u,writable ? 0u : 1u,IntPtr.Zero,create ? 1u : 3u,0x00200000,IntPtr.Zero);
   if(h.IsInvalid) { h.Dispose(); throw new IOException("Cannot open file safely"); }
   try {
    FileInfo i=InspectHandle(h);
    if((i.Attributes & (0x400|0x10))!=0 || i.Links>1) throw new IOException("Only regular files without hard links can be opened");
    return new FileStream(h,writable ? FileAccess.ReadWrite : FileAccess.Read);
   } catch { h.Dispose(); throw; }
  }
  public static ulong[] Capacity(string path) {
   ulong a,t,f; if(!GetDiskFreeSpaceEx(path,out a,out t,out f)) throw new IOException("Volume unavailable");
   return new ulong[]{t,f,a};
  }
 }
}
'@ | Out-Null
}
function Initialize-Configuration {
    $configPath = Join-Path $script:StateDirectory 'windows-agent.json'
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $raw = [IO.File]::ReadAllText($configPath, $script:Utf8)
        if ($raw.Length -gt 65536) { Fail 'Agent configuration exceeds the limit.' 503 }
        $script:Configuration = $raw | ConvertFrom-Json
    }
    $script:Drives = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [IO.DriveType]::Fixed -and $_.IsReady } | ForEach-Object { $_.Name.Substring(0, 2).ToUpperInvariant() })
    $roots = @($script:Configuration.roots)
    if (!$roots.Count) { $roots = @('/C:/Users', '/C:/Projects', '/C:/inetpub', '/C:/Apps') }
    $script:AllowedRoots = @($roots | ForEach-Object { $native = Resolve-WindowsPath $_; if (Test-Path -LiteralPath $native -PathType Container) { $_.TrimEnd('/') } })
}
function Virtual-Path([string]$Native) { '/' + $Native.Replace('\', '/').TrimEnd('/') }
function Resolve-WindowsPath([string]$Value) {
    if (!$Value -or $Value.Length -gt 4096 -or $Value -notmatch '^/[A-Za-z]:(/|$)' -or $Value -match '[\x00-\x1f\x7f\\]' -or $Value.Contains('//')) { Fail 'Use a virtual Windows path such as /C:/Users.' }
    $drive = $Value.Substring(1, 2).ToUpperInvariant()
    if ($script:Drives -notcontains $drive) { Fail 'The drive is unavailable or is not a local fixed drive.' 403 }
    $parts = @($Value.Substring(3).Split('/') | Where-Object { $_ -ne '' })
    foreach ($part in $parts) {
        if ($part -in @('.', '..') -or $part -match '[:<>"|?*]' -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { Fail 'The path contains a disallowed Windows filename.' }
    }
    $native = $drive + '\' + ($parts -join '\')
    $current = $drive + '\'
    foreach ($part in $parts) {
        $current = Join-Path $current $part
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'Reparse points, junctions and symbolic links are not followed.' 403 }
        }
    }
    return $native
}
function Is-Within([string]$Value, [string]$Root) { $Value.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $Value.StartsWith($Root.TrimEnd('/') + '/', [StringComparison]::OrdinalIgnoreCase) }
function Is-Protected([string]$Value) {
    if ($Value -match '(?i)/(\.ssh|\.gnupg|\.codex|AppData|Windows|Program Files(?: \(x86\))?|ProgramData|System Volume Information|\$Recycle\.Bin|\.viios-trash)(/|$)') { return $true }
    $agent = Virtual-Path $script:StateDirectory
    return (Is-Within $Value $agent)
}
function File-Path([string]$Value, [bool]$Mutation = $false) {
    $native = Resolve-WindowsPath $Value
    if (Is-Protected $Value) { Fail 'This system, credential or agent location is protected.' 403 }
    $roots = @($script:AllowedRoots | Where-Object { Is-Within $Value $_ })
    if (!$roots.Count) { Fail 'The path is outside configured file-management roots.' 403 }
    if ($Mutation -and @($script:AllowedRoots | Where-Object { Is-Within $_ $Value }).Count) { Fail 'A configured root cannot be replaced, moved or removed.' 403 }
    return $native
}
function Path-Guards([string[]]$Paths) {
    $handles = New-Object 'System.Collections.Generic.List[IDisposable]'
    try {
        foreach ($path in ($Paths | Select-Object -Unique)) {
            $part = [IO.Path]::GetPathRoot($path)
            $handles.Add([ViiOS.Native]::Guard($part))
            foreach ($name in $path.Substring($part.Length).Split('\')) {
                if (!$name) { continue }; $part = Join-Path $part $name
                if (!(Test-Path -LiteralPath $part -PathType Container)) { break }
                $handles.Add([ViiOS.Native]::Guard($part))
            }
        }
        return ,$handles
    } catch { foreach ($handle in $handles) { $handle.Dispose() }; throw }
}
function File-Revision([string]$Native) {
    $info = [ViiOS.Native]::Inspect($Native)
    Revision-Info $info
}
function Revision-Info($info) {
    Hash-Text "$($info.Volume):$($info.Identity):$($info.Written):$($info.Created):$($info.Size):$($info.Attributes):$($info.Links)"
}
function Check-Revision([string]$Native, [string]$Expected) {
    if ($Expected -notmatch '^[a-f0-9]{64}$' -or (File-Revision $Native) -ne $Expected) { Fail 'The item changed; refresh it before trying again.' 409 }
}
function Assert-RegularFile([string]$Native) {
    $info = [ViiOS.Native]::Inspect($Native)
    if (($info.Attributes -band 16) -ne 0 -or $info.Links -gt 1) { Fail 'A regular file without multiple hard links is required.' 403 }
    return $info
}
function File-Entry([IO.FileSystemInfo]$Item) {
    $virtual = Virtual-Path $Item.FullName
    $link = [bool]($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    $allowed = !$link -and !(Is-Protected $virtual)
    $info = $null; if ($allowed) { try { $info = [ViiOS.Native]::Inspect($Item.FullName) } catch { $allowed = $false } }
    if ($info -and !$Item.PSIsContainer -and $info.Links -gt 1) { $allowed = $false }
    $kind = if ($link) { 'link' } elseif ($Item.PSIsContainer) { 'directory' } else { 'file' }
    return @{ name = $Item.Name; path = $virtual; kind = $kind; size = $(if ($kind -eq 'file') { $Item.Length } else { $null }); modifiedAt = ([DateTimeOffset]$Item.LastWriteTimeUtc).ToUnixTimeMilliseconds(); mode = $Item.Attributes.ToString(); uid = $null; gid = $null; revision = $(if ($allowed) { File-Revision $Item.FullName } else { '' }); accessible = $allowed; mutable = $allowed -and $script:AllowedRoots -notcontains $virtual }
}
function Measure-Directory([string]$Native, [int]$MaxEntries = 15000, [double]$Seconds = 8) {
    $watch = [Diagnostics.Stopwatch]::StartNew(); $stack = New-Object 'System.Collections.Generic.Stack[string]'; $stack.Push($Native)
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'; [long]$allocated = 0; [long]$logical = 0; $visited = 0; $skipped = 0; $files = 0; $folders = 0
    $rootVolume = ([ViiOS.Native]::Inspect($Native)).Volume
    while ($stack.Count -and $visited -lt $MaxEntries -and $watch.Elapsed.TotalSeconds -lt $Seconds) {
        $folder = $stack.Pop()
        try {
            # Lock each visited directory against replacement while enumerating it.
            $folderGuards = Path-Guards @($folder)
            try {
                foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($folder)) {
                    if ($visited -ge $MaxEntries -or $watch.Elapsed.TotalSeconds -ge $Seconds) { $skipped++; break }; $visited++
                    try {
                        if (Is-Protected (Virtual-Path $child)) { $skipped++; continue }
                        $info = [ViiOS.Native]::Inspect($child)
                        if ($info.Volume -ne $rootVolume) { $skipped++; continue }
                        $identity = "$($info.Volume):$($info.Identity)"
                        if (!$seen.Add($identity)) { continue }
                        $allocated += $info.Allocated; $logical += $info.Size
                        if ($info.Attributes -band 16) { $folders++; $stack.Push($child) } else { $files++ }
                    } catch { $skipped++ }
                }
            } finally { foreach ($folderGuard in $folderGuards) { $folderGuard.Dispose() } }
        } catch { $skipped++ }
    }
    return @{ bytes = $allocated; logicalBytes = $logical; partial = [bool]($skipped -or $stack.Count); visited = $visited; skipped = $skipped; files = $files; directories = $folders; timedOut = $watch.Elapsed.TotalSeconds -ge $Seconds; measurement = 'allocated'; reason = 'Allocated bytes from FileStandardInfo; hard links counted once; reparse points and other volumes excluded.' }
}
function Get-VolumeCapacity([string]$Name) { return ,([ViiOS.Native]::Capacity($Name)) }
function Get-Volumes {
    $rows = New-Object 'System.Collections.Generic.List[object]'; $seen = @{}; $failures = 0
    foreach ($volume in @(Get-CimInstance -ClassName Win32_Volume -Filter 'DriveType=3')) {
        if (!$volume.Name -or $volume.Name -notmatch '^[A-Za-z]:\\' -or $seen.ContainsKey([string]$volume.DeviceID)) { continue }
        $seen[[string]$volume.DeviceID] = $true
        try {
            $capacity = Get-VolumeCapacity $volume.Name
            $total = [long]$capacity[0]; $free = [long]$capacity[1]; $available = [long]$capacity[2]; $used = $total - $free
            $rows.Add(@{ id = Hash-Text $volume.DeviceID; source = [string]$volume.DeviceID; mount = Virtual-Path $volume.Name; filesystem = [string]$volume.FileSystem; totalBytes = $total; usedBytes = $used; freeBytes = $free; availableBytes = $available; reservedBytes = [Math]::Max(0, $free - $available); percent = $(if ($total -gt 0) { [Math]::Round(100 * $used / $total, 2) } else { $null }) })
        } catch {
            $failures++
            $rows.Add(@{ id = Hash-Text $volume.DeviceID; source = [string]$volume.DeviceID; mount = Virtual-Path $volume.Name; filesystem = [string]$volume.FileSystem;
                totalBytes = $null; usedBytes = $null; freeBytes = $null; availableBytes = $null; reservedBytes = $null; percent = $null; reason = 'Volume capacity could not be measured.' })
        }
    }
    $summary = @{ totalBytes = [long]0; usedBytes = [long]0; freeBytes = [long]0; availableBytes = [long]0; reservedBytes = [long]0; percent = $null; volumeCount = $rows.Count }
    foreach ($row in $rows) { foreach ($key in @('totalBytes','usedBytes','freeBytes','availableBytes','reservedBytes')) { $summary[$key] += $row[$key] } }
    if ($summary.totalBytes -gt 0) { $summary.percent = [Math]::Round(100 * $summary.usedBytes / $summary.totalBytes, 2) }
    if ($failures -or !$rows.Count) { foreach ($key in @('totalBytes','usedBytes','freeBytes','availableBytes','reservedBytes','percent')) { $summary[$key] = $null } }
    return @{ available = ($rows.Count -gt 0 -and !$failures); sampledAt = Timestamp; hostname = $env:COMPUTERNAME; summary = $summary; volumes = @($rows.ToArray()); reason = $(if ($failures) { 'Some mounted volumes could not be measured; server totals are unavailable.' } else { 'Mounted local fixed volumes, deduplicated by volume identity. Available excludes quota-reserved capacity.' }) }
}
function Get-StorageTopology($Volumes) {
    try {
        $disks = @(Get-Disk -ErrorAction Stop); $partitions = @(Get-Partition -ErrorAction Stop)
        $rates = @{}
        try { foreach ($rate in @(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -ErrorAction Stop)) {
            if ([string]$rate.Name -match '^(\d+)(?:\s|$)') { $rates[[string]$Matches[1]] = $rate }
        } } catch { }
        $rows = @()
        foreach ($disk in $disks) {
            $rate = $rates[[string]$disk.Number]
            $rows += @{ id = "disk:$($disk.Number)"; name = "Disk $($disk.Number)"; kind = 'disk'; sizeBytes = [long]$disk.Size;
                parentIds = @(); volumeIds = @(); model = [string]$disk.FriendlyName; partitionStyle = [string]$disk.PartitionStyle;
                readBytesPerSecond = $(if ($null -ne $rate -and $null -ne $rate.DiskReadBytesPersec) { [double]$rate.DiskReadBytesPersec } else { $null });
                writeBytesPerSecond = $(if ($null -ne $rate -and $null -ne $rate.DiskWriteBytesPersec) { [double]$rate.DiskWriteBytesPersec } else { $null }) }
        }
        foreach ($partition in $partitions) {
            $ids = @($Volumes | Where-Object { $partition.AccessPaths -contains $_.source } | ForEach-Object { $_.id })
            $rows += @{ id = "partition:$($partition.DiskNumber):$($partition.PartitionNumber)"; name = "Partition $($partition.PartitionNumber)";
                kind = 'partition'; sizeBytes = [long]$partition.Size; parentIds = @("disk:$($partition.DiskNumber)"); volumeIds = $ids;
                readBytesPerSecond = $null; writeBytesPerSecond = $null }
        }
        return @{ available = $disks.Count -gt 0; partial = $rows.Count -gt 512; devices = @($rows | Select-Object -First 512);
            reason = 'Disk and partition capacities overlap; do not add them. I/O comes from physical-disk performance counters.' }
    } catch { return @{ available = $false; partial = $true; devices = @(); reason = 'Windows Storage topology is unavailable; volume capacities remain available.' } }
}
function Storage-Usage([string]$Path) {
    if ($Path -eq '/') { return @{ status = 'ready'; path = '/'; scannedAt = Timestamp; totalBytes = $null; partial = $false; entries = @($script:Drives | ForEach-Object { @{ name = $_; path = "/$_"; kind = 'directory'; bytes = $null; mount = $true; partial = $false; reason = 'Separate Windows volume; open to measure a bounded directory snapshot.' } }) } }
    $native = Resolve-WindowsPath $Path
    if (!(Test-Path -LiteralPath $native -PathType Container)) { Fail 'The directory is unavailable.' 404 }
    $rows = New-Object 'System.Collections.Generic.List[object]'; $watch = [Diagnostics.Stopwatch]::StartNew(); [long]$total = 0; $partial = $false; $remaining = 15000
    $guards = Path-Guards @($native)
    try {
        foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($native)) {
            if ($rows.Count -ge 200 -or $watch.Elapsed.TotalSeconds -gt 12) { $partial = $true; break }
            $virtual = Virtual-Path $child; $row = @{ name = [IO.Path]::GetFileName($child); path = $virtual; kind = 'directory'; bytes = $null; partial = $true }
            try {
                if (Is-Protected $virtual) { $row.reason = 'Protected location; not traversed.'; $partial = $true; $rows.Add($row); continue }
                $info = [ViiOS.Native]::Inspect($child)
                if ($info.Attributes -band 16) {
                    if ($remaining -le 0) { $partial = $true; $row.reason = 'Entry budget reached.' }
                    else { $measure = Measure-Directory $child $remaining ([Math]::Max(.1, 12 - $watch.Elapsed.TotalSeconds)); $row.bytes = $measure.bytes; $row.partial = $measure.partial; $row.reason = $measure.reason; $remaining -= $measure.visited }
                } else { $row.kind = 'file'; $row.bytes = $info.Allocated; $row.partial = $false }
                if ($null -ne $row.bytes) { $total += $row.bytes }; $partial = $partial -or $row.partial
            } catch { $row.reason = 'Entry inaccessible or a reparse point; not traversed.'; $partial = $true }
            $rows.Add($row)
        }
    } finally { foreach ($guard in $guards) { $guard.Dispose() } }
    return @{ status = 'ready'; path = $Path; scannedAt = Timestamp; totalBytes = $total; partial = $partial; measurement = 'allocated'; entries = @($rows.ToArray() | Sort-Object @{Expression={if ($null -eq $_.bytes) {-1} else {$_.bytes}};Descending=$true}); reason = 'Bounded allocation metadata scan; protected locations, junctions and inaccessible entries excluded. Partial values are lower bounds.' }
}
function Invoke-Storage($Request) {
    switch ($Request.action) {
        'overview' { $result = Get-Volumes; $result.topology = Get-StorageTopology $result.volumes; return $result }
        'usage' { return Storage-Usage $Request.path }
        'applications' { }
        'apps' { }
        default { Fail 'Unsupported storage action.' }
    }
    $paths = @($Request.paths); if ($paths.Count -gt 100) { Fail 'Too many application paths.' }
    $watch = [Diagnostics.Stopwatch]::StartNew(); $rows = @()
    foreach ($path in $paths) {
        $row = @{ path = $path; bytes = $null; partial = $true }
        try {
            if ($watch.Elapsed.TotalSeconds -gt 20) { $row.reason = 'Scan time budget reached.' }
            else { $native = File-Path $path; $measure = Measure-Directory $native 15000 ([Math]::Min(5, 20 - $watch.Elapsed.TotalSeconds)); $row.bytes = $measure.bytes; $row.partial = $measure.partial; $row.reason = $measure.reason }
        } catch { $row.reason = 'Application path is unavailable, protected or outside configured roots.' }
        $rows += $row
    }
    return @{ status = 'ready'; scannedAt = Timestamp; partial = [bool]@($rows | Where-Object { $_.partial }).Count; applications = @($rows) }
}
function Get-Listeners {
    $rows = @()
    foreach ($tcp in @(Get-NetTCPConnection -State Listen -ErrorAction Stop)) { $rows += @{ port = [int]$tcp.LocalPort; address = [string]$tcp.LocalAddress; pid = [int]$tcp.OwningProcess; transport = 'tcp' } }
    foreach ($udp in @(Get-NetUDPEndpoint -ErrorAction Stop)) { $rows += @{ port = [int]$udp.LocalPort; address = [string]$udp.LocalAddress; pid = [int]$udp.OwningProcess; transport = 'udp' } }
    return @($rows)
}
function Get-ProcessSnapshot {
    $snapshot = @{}
    foreach ($process in @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize,ReadTransferCount,WriteTransferCount)) {
        $snapshot[[int]$process.ProcessId] = @{ id = [int]$process.ProcessId; parent = [int]$process.ParentProcessId; name = [string]$process.Name; executable = [string]$process.ExecutablePath; started = [string]$process.CreationDate; cpu = [double]$process.KernelModeTime + [double]$process.UserModeTime; memory = [long]$process.WorkingSetSize; read = [double]$process.ReadTransferCount; write = [double]$process.WriteTransferCount; sampled = ($null -ne $process.KernelModeTime -and $null -ne $process.UserModeTime -and $null -ne $process.ReadTransferCount -and $null -ne $process.WriteTransferCount -and !!$process.CreationDate); memoryAvailable = $null -ne $process.WorkingSetSize }
    }
    return $snapshot
}
function Update-WebApplications($Applications) {
    $targets = New-Object 'System.Collections.Generic.List[ViiOS.ProbeTarget]'
    $byPort = @{}
    foreach ($app in $Applications) {
        if ($app.transports -notcontains 'tcp' -or $app.port -in @(21,22,25,53,110,135,139,143,445,465,587,993,995,1433,3306,3389,5432,5433,5900,6379) -or $targets.Count -ge 128) { continue }
        $hostAddress = $null
        foreach ($address in $app.addresses) {
            if ($address -eq '0.0.0.0' -or $address -eq '127.0.0.1') { $hostAddress = '127.0.0.1'; break }
            if ($address -eq '::' -or $address -eq '::1') { $hostAddress = '::1'; continue }
            $parsed = $null
            if ([Net.IPAddress]::TryParse($address,[ref]$parsed)) {
                $bytes = $parsed.GetAddressBytes()
                $private = [Net.IPAddress]::IsLoopback($parsed) -or ($bytes.Length -eq 4 -and ($bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168))) -or ($bytes.Length -eq 16 -and (($bytes[0] -band 254) -eq 252 -or $parsed.IsIPv6LinkLocal))
                if ($private -and !$hostAddress) { $hostAddress = $parsed.ToString() }
            }
        }
        if (!$hostAddress) { continue }
        $target = New-Object ViiOS.ProbeTarget; $target.Host = $hostAddress; $target.Port = $app.port; $targets.Add($target); $byPort[$app.port] = $app
        $app.httpProbeError = 'HTTP/HTTPS was not recognized within the bounded local probe budget.'
    }
    foreach ($result in [ViiOS.WebProbe]::Probe($targets.ToArray())) {
        $app = $byPort[$result.Port]; $app.httpApplicable = $true; $app.protocol = $result.Protocol; $app.status = $result.Status; $app.title = $result.Title; $app.kind = $result.Kind; $app.contentType = $result.ContentType; $app.tlsUnverified = $result.TlsUnverified; $app.latency = $result.Latency; $app.probeHost = $result.Host
        $app.Remove('httpProbeError')
    }
}
function Invoke-Scan($Request) {
    $snapshot = Get-ProcessSnapshot; $listeners = @(Get-Listeners); $services = @(Get-CimInstance Win32_Service -Property Name,DisplayName,ProcessId,State)
    $start = 1; $end = 65535
    if ($Request.start) { $start = [int]$Request.start }; if ($Request.end) { $end = [int]$Request.end }
    if ($start -lt 1 -or $end -gt 65535 -or $start -gt $end) { Fail 'Invalid port range.' }
    $apps = @()
    foreach ($group in @($listeners | Where-Object { $_.port -ge $start -and $_.port -le $end } | Group-Object { $_.port } | Sort-Object {[int]$_.Name})) {
        $owners = @($group.Group | ForEach-Object { $_.pid } | Select-Object -Unique); $owner = $snapshot[$owners[0]]
        $addresses = @($group.Group | ForEach-Object { $_.address } | Select-Object -Unique); $transports = @($group.Group | ForEach-Object { $_.transport } | Select-Object -Unique)
        $directory = ''; if ($owner -and $owner.executable) { $directory = Virtual-Path ([IO.Path]::GetDirectoryName($owner.executable)) }
        $serviceNames = @($services | Where-Object { $_.ProcessId -gt 0 -and $owners -contains [int]$_.ProcessId } | ForEach-Object { $_.Name })
        $apps += @{ port = [int]$group.Name; addresses = $addresses; transports = $transports; listeners = @($group.Group | ForEach-Object { @{ transport = $_.transport; address = $_.address; pid = $_.pid; process = $(if ($snapshot.ContainsKey($_.pid)) { $snapshot[$_.pid].name } else { '' }) } }); pid = $owners[0]; process = $(if ($owner) { $owner.name } else { '' }); directory = $directory; entry = $(if ($owner) { $owner.name } else { '' }); serviceNames = $serviceNames; internal = !@($addresses | Where-Object { $_ -notmatch '^(127\.|::1$)' }).Count; protocol = $transports -join '+'; path = '/'; title = ''; name = $(if ($serviceNames.Count) { $serviceNames[0] } elseif ($owner) { $owner.name } else { "Port $($group.Name)" }); status = $null; httpApplicable = $false; kind = 'service'; latency = 0; active = $true; networkState = 'open'; modelConnections = @(); modelDiscovery = @{ status = 'unavailable' } }
    }
    Update-WebApplications $apps
    return @{ hostname = $env:COMPUTERNAME; apps = @($apps); modelProfiles = @(); scope = 'Windows TCP listeners and UDP bindings; bounded HTTP/HTTPS GET metadata probes to local listener addresses, without following redirects.' }
}
function Get-OverviewNetwork {
    $result = @{}
    try {
        foreach ($adapter in @(Get-NetAdapterStatistics -ErrorAction Stop)) {
            $result[[string]$adapter.Name] = @{ read = [double]$adapter.ReceivedBytes; write = [double]$adapter.SentBytes }
        }
    } catch { }
    return @{ counters = $result; at = [Diagnostics.Stopwatch]::GetTimestamp() }
}
function Get-ServerOverview($Os, $Before, $After, $Elapsed, $CpuCount, $FirstNetwork, $LastNetwork) {
    $network = @(); $disks = @(); $addresses = @(); $top = @()
    $networkSeconds = ($LastNetwork.at - $FirstNetwork.at) / [double][Diagnostics.Stopwatch]::Frequency
    foreach ($name in $LastNetwork.counters.Keys) {
        $first = $FirstNetwork.counters[$name]; $last = $LastNetwork.counters[$name]
        $valid = $first -and $networkSeconds -gt 0 -and $last.read -ge $first.read -and $last.write -ge $first.write
        $network += @{ name = $name; readBytesPerSecond = $(if ($valid) { [Math]::Round(($last.read-$first.read)/$networkSeconds) } else { $null }); writeBytesPerSecond = $(if ($valid) { [Math]::Round(($last.write-$first.write)/$networkSeconds) } else { $null }) }
    }
    try {
        foreach ($disk in @(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -ErrorAction Stop | Where-Object { $_.Name -ne '_Total' })) {
            $disks += @{ name = [string]$disk.Name; readBytesPerSecond = $disk.DiskReadBytesPersec; writeBytesPerSecond = $disk.DiskWriteBytesPersec }
        }
    } catch { }
    try { $addresses = @(Get-NetIPAddress -ErrorAction Stop | Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notin @('127.0.0.1','::1') -and $_.IPAddress -notlike 'fe80:*' } | Select-Object -First 64 -ExpandProperty IPAddress) } catch { }
    foreach ($processId in $After.Keys) {
        if ($processId -eq 0) { continue } # Idle time is not CPU work by a process.
        $last = $After[$processId]; $first = $Before[$processId]; $cpu = $null
        if ($first -and $first.sampled -and $last.sampled -and $first.started -eq $last.started -and $last.cpu -ge $first.cpu -and $Elapsed -gt 0) { $cpu = [Math]::Round([Math]::Min([double]100,($last.cpu-$first.cpu)/10000000/$Elapsed/$CpuCount*100),2) }
        $top += @{ pid = [int]$processId; name = [string]$last.name; state = $null; cpuPercent = $cpu; memoryBytes = $(if ($last.memoryAvailable) { $last.memory } else { $null }) }
    }
    $top = @($top | Sort-Object @{Expression={if ($null -eq $_.cpuPercent) {-1} else {$_.cpuPercent}};Descending=$true}, @{Expression={$_.memoryBytes};Descending=$true} | Select-Object -First 10)
    return @{ version = 1; platform = 'windows'; os = [string]$Os.Caption; kernel = [string]$Os.Version; addresses = $addresses; cpuTemperatureC = $null; disks = $disks; network = $network; topProcesses = $top; notes = @('CPU temperature is not exposed by the standard Windows adapter.', 'Network rates are per adapter; virtual adapters may count the same traffic more than once.', 'Disk I/O uses physical-disk performance counters, not process I/O.') }
}
function Invoke-Resources {
    $os = Get-CimInstance Win32_OperatingSystem; $cpus = @(Get-CimInstance Win32_Processor); $cpuCount = [int](($cpus | Measure-Object NumberOfLogicalProcessors -Sum).Sum)
    if ($cpuCount -lt 1) { $cpuCount = [Environment]::ProcessorCount }
    $firstNetwork = Get-OverviewNetwork
    $before = Get-ProcessSnapshot; $watch = [Diagnostics.Stopwatch]::StartNew(); Start-Sleep -Milliseconds 650; $after = Get-ProcessSnapshot; $elapsed = $watch.Elapsed.TotalSeconds
    $lastNetwork = Get-OverviewNetwork
    $listeners = @(Get-Listeners); $rows = @(); $ownedBy = @{}
    foreach ($listener in $listeners) { if ($listener.pid -gt 0) { $ownedBy[$listener.pid] = $true } }
    $totalMemory = [long]$os.TotalVisibleMemorySize * 1024; $usedMemory = $totalMemory - [long]$os.FreePhysicalMemory * 1024
    foreach ($group in @($listeners | Group-Object { $_.pid })) {
        $ownerId = [int]$group.Name; $owned = @()
        foreach ($processId in @($after.Keys)) {
            $cursor = $processId; $seen = @{}
            while ($cursor -gt 0 -and $after.ContainsKey($cursor) -and !$seen.ContainsKey($cursor)) {
                $seen[$cursor] = $true
                if ($ownedBy.ContainsKey($cursor)) { if ($cursor -eq $ownerId) { $owned += $processId }; break }
                $cursor = $after[$cursor].parent
            }
        }
        $complete = $ownerId -gt 0 -and $owned.Count -gt 0; $memoryComplete = $owned.Count -gt 0; [double]$cpu = 0; [long]$memory = 0; [double]$read = 0; [double]$write = 0
        foreach ($processId in $owned) {
            $last = $after[$processId]; $first = $before[$processId]; $memory += $last.memory; if (!$last.memoryAvailable) { $memoryComplete = $false }
            if (!$first -or !$first.sampled -or !$last.sampled -or $first.started -ne $last.started -or $last.cpu -lt $first.cpu) { $complete = $false; continue }
            $cpu += ($last.cpu - $first.cpu) / 10000000 / $elapsed / $cpuCount * 100; $read += [Math]::Max(0, $last.read - $first.read) / $elapsed; $write += [Math]::Max(0, $last.write - $first.write) / $elapsed
        }
        $ports = @($group.Group | ForEach-Object { $_.port } | Sort-Object -Unique)
        $rows += @{ id = "windows-process-$ownerId"; ports = $ports; listenerPids = @($ownerId); pids = @($owned); processNames = @($(if ($after.ContainsKey($ownerId)) { $after[$ownerId].name })); transports = @($group.Group | ForEach-Object { $_.transport } | Sort-Object -Unique); cpuPercent = $(if ($complete) { [Math]::Round([Math]::Min(100,$cpu),2) } else { $null }); memoryBytes = $(if ($memoryComplete) { $memory } else { $null }); memoryPercent = $(if ($memoryComplete -and $totalMemory) { [Math]::Round($memory/$totalMemory*100,2) } else { $null }); readBytesPerSecond = $(if ($complete) { [Math]::Round($read) } else { $null }); writeBytesPerSecond = $(if ($complete) { [Math]::Round($write) } else { $null }); scope = $(if ($complete) { 'process-tree' } else { 'unavailable' }) }
    }
    $storage = Get-Volumes; $disk = @{ scope = 'server'; mount = $null; available = $storage.available }; foreach ($key in $storage.summary.Keys) { $disk[$key] = $storage.summary[$key] }
    $swapTotal = $null; $swapUsed = $null
    try { $pageFiles = @(Get-CimInstance Win32_PageFileUsage); $swapTotal = [long](($pageFiles | Measure-Object AllocatedBaseSize -Sum).Sum) * 1MB; $swapUsed = [long](($pageFiles | Measure-Object CurrentUsage -Sum).Sum) * 1MB } catch { }
    return @{ available = $true; hostname = $env:COMPUTERNAME; sampledAt = Timestamp; sampleSeconds = [Math]::Round($elapsed,2); portCount = @($listeners | ForEach-Object { $_.port } | Sort-Object -Unique).Count; applications = @($rows); overview = (Get-ServerOverview $os $before $after $elapsed $cpuCount $firstNetwork $lastNetwork); system = @{ cpuPercent = (($cpus | Measure-Object LoadPercentage -Average).Average); cpuCount = $cpuCount; memory = @{ totalBytes = $totalMemory; usedBytes = $usedMemory; percent = [Math]::Round($usedMemory/$totalMemory*100,2); swapTotalBytes = $swapTotal; swapUsedBytes = $swapUsed }; disk = $disk; uptimeSeconds = ([DateTime]::UtcNow - $os.LastBootUpTime.ToUniversalTime()).TotalSeconds; loadAverage = @(); processCount = $after.Count }; notes = @('Process I/O counters include all Windows I/O, not only physical disk transfers. CPU is normalized by logical processor count. Linux load-average is not available on Windows.') }
}

function File-Capabilities {
    return @{ available = $true; roots = @($script:AllowedRoots); defaultPath = $(if ($script:AllowedRoots.Count) { $script:AllowedRoots[0] } else { '/' }); textLimit = $script:TextLimit; fileLimit = $script:FileLimit; copyLimit = $script:CopyLimit; streamUpload = $false; streamExport = $false; streamingUpload = $false; streamingExport = $false; upload = $true; directoryCopy = $false; reason = 'Windows virtual paths use /C:/Users. System, credential and reparse-point locations are protected. JSON uploads/downloads are limited to 16 MiB; directory copy and streaming ZIP exports are not supported.' }
}
function Invoke-Files($Request) {
    $action = [string]$Request.action
    if ($action -eq 'capabilities') { return File-Capabilities }
    if ($action -in @('upload-stream','export-stream','export')) { Fail 'Windows streaming transfers and ZIP export are not supported; use bounded file download/upload.' 501 }
    if ($action -eq 'trash-list') {
        $entries = @()
        foreach ($root in $script:AllowedRoots) {
            $trash = Join-Path (Resolve-WindowsPath $root) '.viios-trash'
            if (!(Test-Path -LiteralPath $trash -PathType Container)) { continue }
            if ((Get-Item -LiteralPath $trash -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
            foreach ($metadata in @(Get-ChildItem -LiteralPath $trash -Filter '*.json' -File -Force | Select-Object -First 1000)) {
                try { $entry = [IO.File]::ReadAllText($metadata.FullName, $script:Utf8) | ConvertFrom-Json; if ($entry.id -match '^[a-f0-9]{32}$' -and $entry.root -eq $root) { $entries += $entry } } catch { }
            }
        }
        return @{ entries = @($entries | Sort-Object deletedAt -Descending) }
    }
    if ($action -eq 'restore') {
        if ($script:AllowedRoots -notcontains [string]$Request.root -or $Request.id -notmatch '^[a-f0-9]{32}$') { Fail 'Invalid trash record.' }
        $trash = Join-Path (Resolve-WindowsPath $Request.root) '.viios-trash'; $guards = Path-Guards @($trash)
        try {
            $metadataPath = Join-Path $trash ($Request.id + '.json'); $payloadPath = Join-Path $trash ($Request.id + '.item')
            $record = [IO.File]::ReadAllText($metadataPath, $script:Utf8) | ConvertFrom-Json
            if ($record.id -ne $Request.id -or $record.root -ne $Request.root) { Fail 'Invalid trash metadata.' 409 }
            $target = File-Path $record.path $true
            if (Test-Path -LiteralPath $target) { Fail 'The original location is occupied; nothing was overwritten.' 409 }
            $targetGuards = Path-Guards @([IO.Path]::GetDirectoryName($target))
            try { [void][ViiOS.Native]::Inspect($payloadPath); Move-Item -LiteralPath $payloadPath -Destination $target -ErrorAction Stop; [IO.File]::Delete($metadataPath) }
            finally { foreach ($guard in $targetGuards) { $guard.Dispose() } }
            return @{ path = $record.path; message = 'Item restored.' }
        } finally { foreach ($guard in $guards) { $guard.Dispose() } }
    }
    $path = [string]$Request.path
    if (!$path) { $path = (File-Capabilities).defaultPath }
    if ($action -eq 'list' -and ($path -eq '/' -or $path -match '^/[A-Za-z]:/?$')) {
        $entries = @()
        $values = if ($path -eq '/') { @($script:Drives | ForEach-Object { "/$_" }) } else { @($script:AllowedRoots | Where-Object { Is-Within $_ $path.TrimEnd('/') }) }
        foreach ($value in $values) { $entries += @{ name = $(if ($path -eq '/') { $value.Substring(1) } else { $value.Substring(4) }); path = $value; kind = 'directory'; size = $null; modifiedAt = $null; mode = 'ReadOnly'; uid = $null; gid = $null; revision = ''; accessible = $true; mutable = $false } }
        return @{ path = $path; parent = '/'; total = $entries.Count; offset = 0; entries = @($entries); writable = $false }
    }
    $mutating = $action -in @('create','write','mkdir','upload','upload-directory','copy','move','trash')
    $native = File-Path $path ($mutating -and $action -ne 'copy')
    if ($action -eq 'list') {
        $offset = 0; if ($null -ne $Request.offset) { $offset = [int]$Request.offset }; if ($offset -lt 0 -or $offset -gt 1000000) { Fail 'Invalid list offset.' }
        $query = [string]$Request.query; if ($query.Length -gt 200) { Fail 'Search text is too long.' }
        $entries = @(); $guards = Path-Guards @($native)
        try {
            foreach ($item in @(Get-ChildItem -LiteralPath $native -Force | Select-Object -First 10000)) {
                if (!$Request.hidden -and ($item.Attributes -band [IO.FileAttributes]::Hidden)) { continue }
                if ($query -and $item.Name.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
                $entries += File-Entry $item
            }
        } finally { foreach ($guard in $guards) { $guard.Dispose() } }
        $entries = @($entries | Sort-Object @{Expression={ $_.kind -ne 'directory' }},@{Expression={$_.name}})
        return @{ path = $path; parent = $path.Substring(0,$path.LastIndexOf('/')); total = $entries.Count; offset = $offset; entries = @($entries | Select-Object -Skip $offset -First 200); writable = $true; partial = $entries.Count -ge 10000 }
    }
    if ($action -eq 'search') {
        $query = [string]$Request.query; if ($query.Trim().Length -lt 2 -or $query.Length -gt 120) { Fail 'Search text must have 2-120 characters.' }
        $stack = New-Object 'System.Collections.Generic.Stack[string]'; $stack.Push($native); $watch = [Diagnostics.Stopwatch]::StartNew(); $entries = @(); $visited = 0; $folders = 0
        while ($stack.Count -and $visited -lt 10000 -and $watch.Elapsed.TotalSeconds -lt 2 -and $entries.Count -lt 80) {
            $folder = $stack.Pop(); $folders++
            $folderGuards = $null
            try {
                $folderGuards = Path-Guards @($folder)
                foreach ($item in @(Get-ChildItem -LiteralPath $folder -Force)) {
                    $visited++; if ($visited -gt 10000 -or $watch.Elapsed.TotalSeconds -gt 2) { break }
                    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Is-Protected (Virtual-Path $item.FullName))) { continue }
                    if (!$Request.hidden -and ($item.Attributes -band [IO.FileAttributes]::Hidden)) { continue }
                    if ($item.Name.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $entries += File-Entry $item; if ($entries.Count -ge 80) { break } }
                    if ($item.PSIsContainer -and $item.Name -notin @('.git','node_modules','.venv','dist','build')) { $stack.Push($item.FullName) }
                }
            } catch { } finally { if ($folderGuards) { foreach ($folderGuard in $folderGuards) { $folderGuard.Dispose() } } }
        }
        return @{ path = $path; query = $query; entries = @($entries); visited = $visited; folders = $folders; partial = [bool]$stack.Count; truncated = [bool]($stack.Count -or $entries.Count -ge 80); elapsedMs = $watch.ElapsedMilliseconds }
    }
    if ($action -eq 'properties') {
        $item = Get-Item -LiteralPath $native -Force; $info = [ViiOS.Native]::Inspect($native); $directory = [bool]($info.Attributes -band 16)
        $measure = if ($directory) { Measure-Directory $native } else { @{ bytes = $info.Allocated; logicalBytes = $info.Size; partial = $false; files = 0; directories = 0; skipped = 0; timedOut = $false } }
        $owner = ''; try { $owner = (Get-Acl -LiteralPath $native).Owner } catch { }
        return @{ path = $path; name = $item.Name; parent = Virtual-Path ([IO.Path]::GetDirectoryName($native)); kind = $(if ($directory) { 'directory' } else { 'file' }); mode = $item.Attributes.ToString(); permissions = 'Windows ACL'; owner = $owner; group = ''; uid = $null; gid = $null; modifiedAt = ([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeMilliseconds(); accessedAt = ([DateTimeOffset]$item.LastAccessTimeUtc).ToUnixTimeMilliseconds(); metadataChangedAt = ([DateTimeOffset]$item.CreationTimeUtc).ToUnixTimeMilliseconds(); sizeBytes = $measure.logicalBytes; allocatedBytes = $measure.bytes; files = $measure.files; directories = $measure.directories; links = 0; special = 0; sharedReferences = 0; restricted = $false; partial = $measure.partial; skipped = $measure.skipped; changed = $false; timedOut = $measure.timedOut; scannedAt = Timestamp }
    }
    if ($action -in @('read','download')) {
        $info = Assert-RegularFile $native; if ($info.Size -gt $script:FileLimit) { Fail 'File exceeds the 16 MiB read limit.' 413 }
        $guards = Path-Guards @([IO.Path]::GetDirectoryName($native)); $stream = $null
        try { $stream = [ViiOS.Native]::OpenFile($native,$false,$false); if ($stream.Length -gt $script:FileLimit) { Fail 'File exceeds the 16 MiB read limit.' 413 }; $data = New-Object byte[] ([int]$stream.Length); $offset = 0; while ($offset -lt $data.Length) { $count = $stream.Read($data,$offset,$data.Length-$offset); if (!$count) { break }; $offset += $count }; $revision = Revision-Info ([ViiOS.Native]::InspectHandle($stream.SafeFileHandle)) }
        finally { if ($stream) { $stream.Dispose() }; foreach ($guard in $guards) { $guard.Dispose() } }
        $mime = 'application/octet-stream'; $extension = [IO.Path]::GetExtension($native).ToLowerInvariant(); $images = @{ '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.gif'='image/gif'; '.webp'='image/webp' }
        if ($images.ContainsKey($extension)) { $mime = $images[$extension] }
        if ($action -eq 'download') { return @{ name = [IO.Path]::GetFileName($native); size = $data.Length; data = [Convert]::ToBase64String($data); mime = $mime } }
        $result = @{ path = $path; name = [IO.Path]::GetFileName($native); size = $data.Length; revision = $revision; editable = $false; kind = 'binary'; mime = $mime }
        if ($images.ContainsKey($extension)) { $result.kind = 'image' }
        elseif ($data.Length -le $script:TextLimit -and $data -notcontains 0) { try { $result.content = $script:Utf8.GetString($data); $result.kind = 'text'; $result.editable = $true } catch { } }
        return $result
    }
    if (!$mutating) { Fail 'Unsupported Windows file action.' 501 }
    $parent = [IO.Path]::GetDirectoryName($native); $guards = Path-Guards @($parent)
    $mutex = New-Object Threading.Mutex($false, 'Global\ViiOSFileMutations'); $locked = $false
    try {
        $locked = $mutex.WaitOne(5000); if (!$locked) { Fail 'Another file operation is running.' 409 }
        if ($action -in @('create','write','upload')) {
            $content = if ($action -eq 'upload') { try { [Convert]::FromBase64String([string]$Request.data) } catch { Fail 'Invalid base64 upload.' } } else { $script:Utf8.GetBytes([string]$Request.content) }
            $limit = if ($action -eq 'upload') { $script:FileLimit } else { $script:TextLimit }; if ($content.Length -gt $limit) { Fail 'The content exceeds the bounded transfer limit.' 413 }
            $stream = $null
            try {
                if ($action -eq 'write') {
                    $info = Assert-RegularFile $native; Check-Revision $native $Request.revision
                    $stream = [ViiOS.Native]::OpenFile($native,$true,$false)
                    $lockedInfo = [ViiOS.Native]::InspectHandle($stream.SafeFileHandle)
                    if ((Revision-Info $lockedInfo) -ne $Request.revision -or $lockedInfo.Links -gt 1) { Fail 'The file changed before it could be locked; contents were preserved.' 409 }
                }
                else { if (Test-Path -LiteralPath $native) { Fail 'The destination already exists; nothing was overwritten.' 409 }; $stream = [ViiOS.Native]::OpenFile($native,$true,$true) }
                $stream.Write($content,0,$content.Length); $stream.SetLength($content.Length); $stream.Flush($true)
            } finally { if ($stream) { $stream.Dispose() } }
            return @{ path = $path; bytes = $content.Length; message = 'File saved.' }
        }
        if ($action -in @('mkdir','upload-directory')) {
            if (Test-Path -LiteralPath $native) { if ($action -eq 'upload-directory' -and (Test-Path -LiteralPath $native -PathType Container)) { return @{ path = $path; existing = $true } }; Fail 'The destination already exists.' 409 }
            [void][IO.Directory]::CreateDirectory($native); return @{ path = $path; message = 'Directory created.' }
        }
        Check-Revision $native $Request.revision
        if ($action -eq 'trash') {
            $root = @($script:AllowedRoots | Where-Object { Is-Within $path $_ } | Sort-Object Length -Descending)[0]; $trash = Join-Path (Resolve-WindowsPath $root) '.viios-trash'
            if (!(Test-Path -LiteralPath $trash)) { [void][IO.Directory]::CreateDirectory($trash) }
            $trashGuard = [ViiOS.Native]::Guard($trash)
            try {
                $id = [Guid]::NewGuid().ToString('N'); $metadata = @{ root = $root; id = $id; path = $path; name = [IO.Path]::GetFileName($native); deletedAt = Timestamp; kind = $(if (Test-Path -LiteralPath $native -PathType Container) { 'directory' } else { 'file' }) }
                [IO.File]::WriteAllText((Join-Path $trash ($id+'.json')),($metadata | ConvertTo-Json -Compress),$script:Utf8)
                Move-Item -LiteralPath $native -Destination (Join-Path $trash ($id+'.item')) -ErrorAction Stop
                $metadata.message = 'Item moved to recoverable ViiOS trash.'; return $metadata
            } finally { $trashGuard.Dispose() }
        }
        $destination = File-Path $Request.destination $true
        if (Test-Path -LiteralPath $destination) { Fail 'The destination already exists; nothing was overwritten.' 409 }
        if (Is-Within $Request.destination $path) { Fail 'An item cannot be moved or copied into itself.' }
        $targetGuards = Path-Guards @([IO.Path]::GetDirectoryName($destination))
        try {
            if ($action -eq 'copy') {
                $info = Assert-RegularFile $native; if ($info.Size -gt $script:CopyLimit) { Fail 'File exceeds the 200 MiB copy limit.' 413 }
                $sourceStream = $null; $destinationStream = $null
                try {
                    $sourceStream = [ViiOS.Native]::OpenFile($native,$false,$false)
                    $lockedInfo = [ViiOS.Native]::InspectHandle($sourceStream.SafeFileHandle)
                    if ((Revision-Info $lockedInfo) -ne $Request.revision -or $lockedInfo.Links -gt 1) { Fail 'The source changed; copy was cancelled.' 409 }
                    $destinationStream = [ViiOS.Native]::OpenFile($destination,$true,$true)
                    $sourceStream.CopyTo($destinationStream); $destinationStream.Flush($true)
                } finally { if ($sourceStream) { $sourceStream.Dispose() }; if ($destinationStream) { $destinationStream.Dispose() } }
            }
            elseif ($action -eq 'move') { if ([IO.Path]::GetPathRoot($native) -ne [IO.Path]::GetPathRoot($destination)) { Fail 'Cross-volume moves are not supported; copy files instead.' 409 }; Move-Item -LiteralPath $native -Destination $destination -ErrorAction Stop }
            return @{ path = $path; destination = $Request.destination; message = 'File operation completed.' }
        } finally { foreach ($guard in $targetGuards) { $guard.Dispose() } }
    } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose(); foreach ($guard in $guards) { $guard.Dispose() } }
}
function Service-Controls {
    $listeners = @(Get-Listeners); $services = @(Get-CimInstance Win32_Service -Property Name,DisplayName,ProcessId,State,StartMode,ServiceType); $processes = Get-ProcessSnapshot; $controls = @{}; $targets = @{}
    foreach ($registration in @($script:Configuration.services)) {
        if (!$registration.name -or $registration.name -notmatch '^[A-Za-z0-9_. -]{1,160}$' -or $registration.name -match '(?i)(ssh|winrm|viios|rpc|dcom|eventlog|lanman|winmgmt|bfe|mpssvc|cryptsvc|samss|lsm|plugplay|schedule|w32time|wuauserv|trustedinstaller)') { continue }
        $matches = @($services | Where-Object { $_.Name -eq $registration.name }); if ($matches.Count -ne 1) { continue }; $service = $matches[0]
        if ($service.ServiceType -ne 'Own Process' -or $service.StartMode -eq 'Disabled') { continue }
        $serviceId = [int]$service.ProcessId; $process = $processes[$serviceId]
        $ports = @($registration.ports | Where-Object { $_ -is [int] -and $_ -gt 0 -and $_ -le 65535 } | Sort-Object -Unique)
        if (!$ports.Count) { continue }
        $conflict = @($listeners | Where-Object { $ports -contains $_.port -and $_.pid -ne $serviceId }).Count -gt 0
        $active = $service.State -eq 'Running'; $stable = $service.State -in @('Running','Stopped'); $token = Hash-Text "$($service.Name):$serviceId`:$($process.started):$($service.State):$($ports -join ',')"
        $item = @{ canStop = $stable -and $active -and !$conflict; canStart = $stable -and !$active -and !$conflict; canRestart = $stable -and $active -and !$conflict; active = $active; kind = 'windows-service'; label = [string]$service.DisplayName; unit = [string]$service.Name; affectedPorts = $ports; token = $token; reason = $(if ($conflict) { 'A registered port belongs to another process.' } elseif (!$stable) { 'The service is changing state.' } else { '' }) }
        foreach ($port in $ports) { $controls[[string]$port] = $item; $targets[[string]$port] = [string]$service.Name }
    }
    foreach ($listener in $listeners) { if (!$controls.ContainsKey([string]$listener.port)) { $controls[[string]$listener.port] = @{ canStop = $false; canStart = $false; canRestart = $false; active = $true; reason = 'Service control requires an administrator-configured application-service allowlist. Arbitrary processes and system services cannot be controlled.' } } }
    return @{ controls = $controls; targets = $targets }
}
function Invoke-Control($Request) {
    if ($Request.action -notin @('status','start','stop','restart')) { Fail 'Unsupported service action.' }
    $snapshot = Service-Controls; $key = [string]$Request.port
    if ($Request.action -eq 'status') { if (!$key) { return @{ ok = $true; controls = $snapshot.controls } }; return @{ ok = $true; control = $snapshot.controls[$key] } }
    $mutex = New-Object Threading.Mutex($false,'Global\ViiOSServiceControl'); $locked = $false
    try {
        $locked = $mutex.WaitOne(0); if (!$locked) { Fail 'Another service operation is running.' 409 }
        $snapshot = Service-Controls; $control = $snapshot.controls[$key]; $capability = @{ start='canStart';stop='canStop';restart='canRestart' }[$Request.action]
        if (!$control -or !$control[$capability] -or $Request.token -notmatch '^[a-f0-9]{64}$' -or $Request.token -cne $control.token) { Fail 'Service identity or state changed; refresh the controls.' 409 }
        $service = Get-Service -Name $snapshot.targets[$key]
        if ($Request.action -in @('start','restart') -and @($service.ServicesDependedOn | Where-Object { [string]$_.Status -ne 'Running' }).Count) { Fail 'A required service is not running; dependencies must be managed separately.' 409 }
        if ($Request.action -in @('stop','restart')) {
            if (@($service.DependentServices | Where-Object { [string]$_.Status -ne 'Stopped' }).Count) { Fail 'Other running services depend on this application; they will not be stopped automatically.' 409 }
            # .NET Framework ServiceController.Stop() cascades to dependents.
            # The fixed CIM method refuses active dependents, including races.
            $target = Get-CimInstance Win32_Service -Filter ("Name='" + $snapshot.targets[$key] + "'")
            $stopped = Invoke-CimMethod -InputObject $target -MethodName StopService
            if ($stopped.ReturnValue -ne 0) { Fail 'Windows refused the service stop request; dependent services were not changed.' 409 }
            $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(20))
        }
        if ($Request.action -in @('start','restart')) { $service.Start(); $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(20)) }
        $updated = Service-Controls
        return @{ ok = $true; control = $updated.controls[$key]; affectedPorts = $control.affectedPorts; message = 'Windows service state verified; listener state is refreshed by inventory.' }
    } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
function Invoke-Models {
    $models = @(); $errorText = $null; $status = 'online'
    try {
        # Fixed loopback endpoint only. This reads metadata; it never loads a model.
        $result = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -Method Get -TimeoutSec 3 -MaximumRedirection 0
        if ($null -eq $result -or $result.models -isnot [array]) { throw 'Invalid Ollama metadata response' }
        foreach ($model in @($result.models | Select-Object -First 1000)) {
            $name = [string]$model.name; if (!$name -or $name.Length -gt 200) { continue }
            $models += @{ id = 'ollama:' + $name; name = $name; family = [string]$model.details.family; kind = 'unknown'; runtime = 'Ollama'; status = 'available'; provider = 'Ollama'; host = $env:COMPUTERNAME; endpoint = 'http://127.0.0.1:11434'; sizeBytes = $model.size; parameterSize = $model.details.parameter_size; quantization = $model.details.quantization_level; contextLength = $null; checkedAt = [DateTime]::UtcNow.ToString('o'); evidence = @(@{ kind='api'; source='http://127.0.0.1:11434/api/tags'; detail='Ollama /api/tags metadata; memory residency was not measured.' }); paths = @(); applications = @() }
        }
    } catch { $status = 'unreachable'; $errorText = 'The local Ollama metadata endpoint is unavailable. This does not establish that no models are installed.' }
    return @{ available = !$errorText; models = @($models); hosts = @(@{ id=$env:COMPUTERNAME;name=$env:COMPUTERNAME;host='127.0.0.1';status=$status;gpus=@() }); warnings = @(); error = $errorText; coverage = @{ hostsChecked=1;endpointsChecked=1;filesChecked=0;notes=@('Only local Ollama metadata is supported on Windows; no model directory, network, GPU or inference scan is performed.');endpoints=@(@{ endpoint='http://127.0.0.1:11434';host='127.0.0.1';status=$status }) } }
}
function Invoke-Versions($Request) {
    if ($Request.action -eq 'capabilities') { return @{ available = $false; readOnly = $true; automatic = $false; roots = @($script:AllowedRoots); root = ''; ignore = @(); reason = 'Windows Git integration is not enabled. Repository mutation, registration and history UI require a compatible read-only adapter; use Git directly.' } }
    Fail 'Windows repository operations are not implemented; existing repositories were not modified.' 501
}
function Assert-ServiceRequest($Request) {
    if (!$Request -or $Request.action -notin @('list','details','logs','start','stop','restart','automatic','manual','disabled')) { Fail 'Unsupported Windows service action.' }
    $fields = if ($Request.action -eq 'list') { @('action') } elseif ($Request.action -eq 'details') { @('action','name') } elseif ($Request.action -eq 'logs') { @('action','name','limit') } else { @('action','name','token') }
    $keys = if ($Request -is [Collections.IDictionary]) { @($Request.Keys) } else { @($Request.PSObject.Properties.Name) }
    if ($keys.Count -ne $fields.Count -or @($keys | Where-Object { $_ -notin $fields }).Count) { Fail 'Invalid service fields.' }
    if ($Request.action -ne 'list' -and ($Request.name -isnot [string] -or $Request.name -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.@ -]{0,159}$')) { Fail 'Invalid service name.' }
    if ($Request.action -eq 'logs' -and (($Request.limit -isnot [int] -and $Request.limit -isnot [long]) -or $Request.limit -lt 1 -or $Request.limit -gt 200)) { Fail 'Invalid log limit.' }
    if ($Request.action -notin @('list','details','logs') -and ($Request.token -isnot [string] -or $Request.token -cnotmatch '^[a-f0-9]{64}$')) { Fail 'Invalid service identity.' }
}
function Service-Context {
    $services = @(Get-CimInstance Win32_Service -Property Name,DisplayName,Description,State,StartMode,ProcessId,ServiceType,PathName,StartName -ErrorAction Stop)
    $controllers = @{}; foreach ($service in @(Get-Service -ErrorAction Stop)) { $controllers[$service.Name] = $service }
    $parents = @{}; foreach ($process in @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId -ErrorAction Stop)) { $parents[[int]$process.ProcessId] = [int]$process.ParentProcessId }
    $protected = New-Object 'System.Collections.Generic.HashSet[int]'; $cursor = [int]$PID
    while ($parents.ContainsKey($cursor) -and $protected.Add($cursor)) { $cursor = $parents[$cursor] }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return @{services=$services;controllers=$controllers;protected=$protected;administrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}
}
function Service-Row($Service, $Context) {
    $name = [string]$Service.Name; $controller = $Context.controllers[$name]; $reason = ''; $actions = @(); $started = 0
    if ($Service.ProcessId -gt 0) { try { $started = [ViiOS.ProcessGuard]::Inspect([int]$Service.ProcessId).Started } catch {} }
    $allowed = @($script:Configuration.services | Where-Object { $_.name -eq $name }).Count -eq 1
    if ($name -match '(?i)(ssh|winrm|viios|rpc|dcom|eventlog|lanman|winmgmt|bfe|mpssvc|cryptsvc|samss|lsm|plugplay|schedule|w32time|wuauserv|trustedinstaller|windefend|sense|securityhealth|wdnissvc)' -or ($Service.ProcessId -gt 0 -and $Context.protected.Contains([int]$Service.ProcessId))) { $reason = 'System or management service is protected.' }
    elseif (!$allowed) { $reason = 'Administrator service allowlist required.' }
    elseif (!$Context.administrator) { $reason = 'Administrator privileges are required.' }
    elseif ($Service.ServiceType -ne 'Own Process' -or !$controller) { $reason = 'Only standalone application services can be managed.' }
    elseif ($Service.State -notin @('Running','Stopped')) { $reason = 'Service is changing state or is paused.' }
    elseif ($Service.State -eq 'Running' -and !$started) { $reason = 'Service process identity cannot be inspected.' }
    $dependencies = @(); $dependents = @()
    if ($controller) {
        try { $dependencies = @($controller.ServicesDependedOn | ForEach-Object {$_.Name}); $dependents = @($controller.DependentServices | ForEach-Object {$_.Name}) }
        catch { $reason = 'Service dependencies cannot be inspected.' }
    }
    if (!$reason) {
        if ($Service.State -eq 'Stopped' -and $Service.StartMode -ne 'Disabled') { $actions += 'start' }
        if ($Service.State -eq 'Running' -and $controller.CanStop) { $actions += 'stop'; if ($Service.StartMode -ne 'Disabled') { $actions += 'restart' } }
        if ($Service.StartMode -ne 'Auto') { $actions += 'automatic' }
        if ($Service.StartMode -ne 'Manual') { $actions += 'manual' }
        if ($Service.StartMode -ne 'Disabled') { $actions += 'disabled' }
    }
    $token = Hash-Text (([ordered]@{name=$name;path=$Service.PathName;account=$Service.StartName;pid=$Service.ProcessId;started=$started;state=$Service.State;startup=$Service.StartMode;kind=$Service.ServiceType;dependencies=(($dependencies | Sort-Object) -join ',');dependents=(($dependents | Sort-Object) -join ',')} | ConvertTo-Json -Compress))
    return @{name=$name;displayName=[string]$Service.DisplayName;description=[string]$Service.Description;state=[string]$Service.State;subState='';startup=[string]$Service.StartMode;pid=[int]$Service.ProcessId;token=$token;actions=@($actions);reason=$reason;dependencies=@($dependencies);dependents=@($dependents);canLogs=$false}
}
function Service-Selected($Context, [string]$Name) {
    $matches = @($Context.services | Where-Object { $_.Name -eq $Name }); if ($matches.Count -ne 1) { Fail 'Service not found.' 404 }; return $matches[0]
}
function Invoke-Services($Request) {
    Assert-ServiceRequest $Request
    $context = Service-Context
    if ($Request.action -eq 'list') { return @{ok=$true;available=$true;platform='windows';sampledAt=(Timestamp);partial=($context.services.Count -gt 2000);services=@($context.services | Select-Object -First 2000 | ForEach-Object { Service-Row $_ $context })} }
    $selected = Service-Selected $context $Request.name
    if ($Request.action -eq 'details') { return @{ok=$true;service=(Service-Row $selected $context)} }
    if ($Request.action -eq 'logs') { return @{ok=$true;available=$false;entries=@();reason='Windows Event Log integration is not part of this phase.'} }
    $mutex = New-Object Threading.Mutex($false,'Global\ViiOSServiceControl'); $locked=$false
    try {
        $locked=$mutex.WaitOne(0); if (!$locked) { Fail 'Another service operation is running.' 409 }
        $context=Service-Context; $selected=Service-Selected $context $Request.name; $current=Service-Row $selected $context
        if ($current.token -cne $Request.token) { Fail 'Service configuration or state changed; refresh details.' 409 }
        if ($Request.action -notin $current.actions) { Fail 'Service mutation is protected.' 403 }
        $controller=$context.controllers[$selected.Name]
        if ($Request.action -in @('start','restart') -and @($controller.ServicesDependedOn | Where-Object { [string]$_.Status -ne 'Running' }).Count) { Fail 'Start dependencies separately.' 409 }
        if ($Request.action -in @('stop','restart')) {
            if (@($controller.DependentServices | Where-Object { [string]$_.Status -ne 'Stopped' }).Count) { Fail 'Other active services depend on this service.' 409 }
            $result=Invoke-CimMethod -InputObject $selected -MethodName StopService
            if ($result.ReturnValue -ne 0) { Fail 'Windows refused to stop the service.' 409 }
            $controller.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(15))
        }
        if ($Request.action -in @('start','restart')) {
            $result=Invoke-CimMethod -InputObject $selected -MethodName StartService
            if ($result.ReturnValue -notin @(0,10)) { Fail 'Windows refused to start the service.' 409 }
            $controller.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(15))
        }
        if ($Request.action -in @('automatic','manual','disabled')) {
            $mode=@{automatic='Automatic';manual='Manual';disabled='Disabled'}[$Request.action]
            $result=Invoke-CimMethod -InputObject $selected -MethodName ChangeStartMode -Arguments @{StartMode=$mode}
            if ($result.ReturnValue -ne 0) { Fail 'Windows refused the startup change.' 409 }
        }
        $updatedContext=Service-Context; $updated=Service-Selected $updatedContext $Request.name
        $expected=@{start='Running';stop='Stopped';restart='Running';automatic='Auto';manual='Manual';disabled='Disabled'}[$Request.action]
        $actual=if($Request.action -in @('start','stop','restart')){$updated.State}else{$updated.StartMode}
        if ($actual -ne $expected) { Fail 'Resulting service state was not confirmed; refresh details.' 409 }
        return @{ok=$true;service=(Service-Row $updated $updatedContext)}
    } finally { if($locked){$mutex.ReleaseMutex()};$mutex.Dispose() }
}
function Assert-ProcessRequest($Request) {
    $fields = @{list=@('action');details=@('action','pid');terminate=@('action','pid','token')}
    if (!$Request -or $Request.action -notin @('list','details','terminate')) { Fail 'Invalid process action.' }
    $keys = if ($Request -is [Collections.IDictionary]) { @($Request.Keys) } else { @($Request.PSObject.Properties.Name) }
    if ($keys.Count -ne $fields[$Request.action].Count -or @($keys | Where-Object { $_ -notin $fields[$Request.action] }).Count) { Fail 'Invalid process fields.' }
    if ($Request.action -ne 'list' -and (($Request.pid -isnot [int] -and $Request.pid -isnot [long]) -or $Request.pid -lt 1 -or $Request.pid -gt [int]::MaxValue)) { Fail 'Invalid PID.' }
    if ($Request.action -eq 'terminate' -and ($Request.token -isnot [string] -or $Request.token -cnotmatch '^[a-f0-9]{64}$')) { Fail 'Invalid process identity.' }
}
function Process-Identity([int]$ProcessId, [long]$Started) { Hash-Text "$($ProcessId):$Started" }
function Process-Row($Item, $Before, [double]$Elapsed, [int]$CpuCount, $ProtectedIds) {
    $metadata = $null
    try { $metadata = [ViiOS.ProcessGuard]::Inspect($Item.id) } catch { }
    $blocked = !$metadata -or $metadata.Critical -or !$metadata.Sid -or $metadata.Sid -in @('S-1-5-18','S-1-5-19','S-1-5-20') -or $Item.id -le 4 -or $ProtectedIds.Contains([int]$Item.id)
    $token = $null; $started = $null; $owner = ''
    if ($metadata) { $token = Process-Identity $Item.id $metadata.Started; $started = [DateTime]::FromFileTimeUtc($metadata.Started).ToString('o'); $owner = $metadata.User }
    $cpu = $null; $old = $Before[$Item.id]
    if ($old -and $old.sampled -and $Item.sampled -and $old.started -eq $Item.started -and $Elapsed -gt 0 -and $CpuCount -gt 0 -and $Item.cpu -ge $old.cpu -and $Item.id -gt 0) { $cpu = [Math]::Round([Math]::Min([double]100, ($Item.cpu - $old.cpu) / 10000000 / $Elapsed / $CpuCount * 100),2) }
    $reason = if ($blocked) { 'System, service, inaccessible or management process is protected.' } else { '' }
    # The local lab sets this server-side restriction. It cannot be supplied by a request.
    if ($null -ne $script:LabProcessId -and ($Item.id -ne $script:LabProcessId -or $token -ne $script:LabProcessToken)) { $blocked = $true; $reason = 'Local lab: only the dedicated test process may be terminated.' }
    return @{pid=$Item.id;name=$Item.name;user=$owner;state=if($metadata){'Running'}else{'Unknown'};parentPid=$Item.parent;cpuPercent=$cpu;memoryBytes=if($Item.memoryAvailable){$Item.memory}else{$null};startedAt=$started;token=$token;canTerminate=(!$blocked);reason=$reason}
}
function Invoke-Processes($Request) {
    Assert-ProcessRequest $Request
    $before = Get-ProcessSnapshot; $watch = [Diagnostics.Stopwatch]::StartNew(); Start-Sleep -Milliseconds 650; $after = Get-ProcessSnapshot; $elapsed = $watch.Elapsed.TotalSeconds
    $protectedIds = New-Object 'System.Collections.Generic.HashSet[int]'
    $cursor = [int]$PID
    while ($after.ContainsKey($cursor) -and $protectedIds.Add($cursor)) { $cursor = [int]$after[$cursor].parent }
    # Fail closed if service ownership cannot be determined.
    foreach ($service in @(Get-CimInstance Win32_Service -Property ProcessId -ErrorAction Stop)) { if ($service.ProcessId -gt 0) { [void]$protectedIds.Add([int]$service.ProcessId) } }
    $cpuCount = [Math]::Max(1,[Environment]::ProcessorCount)
    if ($Request.action -ne 'list') {
        if (!$after.ContainsKey([int]$Request.pid)) { Fail 'Process no longer exists.' 404 }
        $item = $after[[int]$Request.pid]; $row = Process-Row $item $before $elapsed $cpuCount $protectedIds
        if ($Request.action -eq 'details') { return @{ok=$true;process=$row} }
        if ($row.token -ne $Request.token) { Fail 'Process identity changed; refresh the list.' 409 }
        if (!$row.canTerminate) { Fail $row.reason 403 }
        try {
            $metadata = [ViiOS.ProcessGuard]::Inspect($Request.pid)
            if ((Process-Identity $Request.pid $metadata.Started) -ne $Request.token) { Fail 'Process identity changed; refresh the list.' 409 }
            $exited = [ViiOS.ProcessGuard]::Terminate($Request.pid,$metadata.Started)
            return @{ok=$true;exited=$exited}
        } catch { if ($_.Exception.Data['public']) { throw }; Fail 'Process exited or termination was denied.' 409 }
    }
    $rows = @($after.Values | Select-Object -First 10000 | ForEach-Object { Process-Row $_ $before $elapsed $cpuCount $protectedIds })
    return @{ok=$true;available=$true;platform='windows';sampledAt=(Timestamp);processes=$rows;partial=($after.Count -gt 10000)}
}
function Agent-Capabilities {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = New-Object Security.Principal.WindowsPrincipal($identity); $admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    return @{ available = $true; os = 'windows'; agentVersion = 1; administrator = $admin; powershell = $PSVersionTable.PSVersion.ToString(); capabilities = @{ inventory = $true; resources = $true; processes = $true; services = $true; storage = $true; files = $true; control = @($script:Configuration.services | Where-Object { $_.name -and @($_.ports).Count }).Count -gt 0; versions = $false; models = $true; concurrency = $false }; limitations = @{ fileStreaming = $false; directoryCopy = $false; httpProbing = 'Bounded local HTTP/HTTPS GET; no external addresses or redirects'; control = 'Requires explicit registration in administrator-owned windows-agent.json; no service is enabled automatically.'; models = 'Local Ollama metadata only'; resources = 'Process I/O is total Windows I/O, not physical disk I/O'; versions = 'Unavailable'; concurrency = 'Windows model concurrency telemetry is not implemented.' } }
}
function Invoke-Agent([string]$SelectedHelper, $Request) {
    switch ($SelectedHelper) {
        'capabilities' { return Agent-Capabilities }
        'scan' { return Invoke-Scan $Request }
        'resources' { return Invoke-Resources }
        'processes' { return Invoke-Processes $Request }
        'services' { return Invoke-Services $Request }
        'storage' { return Invoke-Storage $Request }
        'files' { $result = Invoke-Files $Request; $result.ok = $true; return $result }
        'control' { return Invoke-Control $Request }
        'versions' { return Invoke-Versions $Request }
        'models' { return Invoke-Models }
        'concurrency' { return @{ available=$false;reason='Windows model concurrency telemetry is not implemented.';checkedAt=[DateTime]::UtcNow.ToString('o');services=@();error='Concurrency telemetry unavailable.' } }
    }
}
function Read-Request {
    $builder = New-Object Text.StringBuilder
    $buffer = New-Object char[] 8192
    while (($count = [Console]::In.Read($buffer,0,$buffer.Length)) -gt 0) {
        if ($builder.Length + $count -gt 24MB) { Fail 'Request exceeds the transfer limit.' 413 }
        [void]$builder.Append($buffer,0,$count)
    }
    $raw = $builder.ToString()
    if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
    if (!$raw.TrimStart().StartsWith('{')) { Fail 'A JSON request object is required.' }
    try { $request = $raw | ConvertFrom-Json } catch { Fail 'Invalid JSON request.' }
    if ($request -isnot [pscustomobject]) { Fail 'A JSON request object is required.' }
    return $request
}
if ($MyInvocation.InvocationName -ne '.') {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
    try {
        Initialize-Native
        Initialize-Configuration
        $request = Read-Request
        $result = Invoke-Agent $Helper $request
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 24 -Compress))
    } catch {
        $exception = $_.Exception
        $public = $exception.Data['public']; $message = if ($public) { $exception.Message } else { 'The Windows operation could not be completed. Check target permissions, configuration and supported capabilities.' }
        $status = if ($public) { [int]$exception.Data['status'] } else { 503 }
        [Console]::Out.WriteLine((@{ ok=$false;available=$false;status=$status;error=$message } | ConvertTo-Json -Compress))
    }
}
