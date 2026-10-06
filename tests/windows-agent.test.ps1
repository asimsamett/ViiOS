#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$agent = Join-Path $PSScriptRoot '..\server\agent\windows-agent.ps1'
. $agent
Initialize-Native
Initialize-Configuration
Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
namespace ViiOSTest {
 public sealed class HttpFixture : IDisposable {
  TcpListener listener; Task worker; public int Port,Requests; volatile bool stopped;
  public HttpFixture(string response) {
   listener=new TcpListener(IPAddress.Loopback,0); listener.Start(); Port=((IPEndPoint)listener.LocalEndpoint).Port;
   worker=Task.Run(()=> { while(!stopped) { try { using(TcpClient client=listener.AcceptTcpClient()) { Interlocked.Increment(ref Requests); client.ReceiveTimeout=500; client.SendTimeout=500; var stream=client.GetStream(); byte[] input=new byte[4096]; try { stream.Read(input,0,input.Length); } catch { } byte[] bytes=Encoding.UTF8.GetBytes(response); stream.Write(bytes,0,bytes.Length); } } catch { if(stopped) break; } } });
  }
  public void Dispose() { stopped=true; listener.Stop(); worker.Wait(2000); }
 }
}
'@ | Out-Null
$sandboxBase = Join-Path $PSScriptRoot '.windows-agent-test'
$sandbox = Join-Path $sandboxBase ([Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($sandbox)
$virtual = Virtual-Path $sandbox
$script:AllowedRoots = @($virtual)
$script:Configuration = @{ roots=@($virtual); services=@() }
$passed = New-Object 'System.Collections.Generic.List[string]'
function Assert-True($Condition, [string]$Message) { if (!$Condition) { throw "Assertion failed: $Message" } }
function Expect-Failure([scriptblock]$Work, [int]$Status, [string]$Label) {
    $failed = $false
    try { & $Work | Out-Null } catch { $failed = $true; Assert-True ($_.Exception.Data['status'] -eq $Status) "$Label status" }
    Assert-True $failed $Label
}
try {
    $htmlFixture = New-Object ViiOSTest.HttpFixture("HTTP/1.1 200 OK`r`nContent-Type: text/html`r`nConnection: close`r`n`r`n<html><title>Vii &amp; Windows</title></html>")
    $redirectFixture = New-Object ViiOSTest.HttpFixture("HTTP/1.1 302 Found`r`nLocation: https://example.invalid/do-not-follow`r`nContent-Length: 0`r`nConnection: close`r`n`r`n")
    $tcpFixture = New-Object ViiOSTest.HttpFixture("SSH-2.0-test`r`n")
    $udpFixture = New-Object ViiOSTest.HttpFixture("HTTP/1.1 200 OK`r`nContent-Length: 0`r`n`r`n")
    try {
        $webApps = @(
            @{port=$htmlFixture.Port;addresses=@('127.0.0.1');transports=@('tcp');httpApplicable=$false},
            @{port=$redirectFixture.Port;addresses=@('0.0.0.0');transports=@('tcp');httpApplicable=$false},
            @{port=$tcpFixture.Port;addresses=@('127.0.0.1');transports=@('tcp');httpApplicable=$false},
            @{port=$udpFixture.Port;addresses=@('127.0.0.1');transports=@('udp');httpApplicable=$false},
            @{port=8123;addresses=@('203.0.113.99');transports=@('tcp');httpApplicable=$false}
        )
        Update-WebApplications $webApps
        Assert-True ($webApps[0].httpApplicable -and $webApps[0].kind -eq 'web' -and $webApps[0].protocol -eq 'http' -and $webApps[0].title -eq 'Vii & Windows') 'HTTP metadata enables web application'
        Assert-True ($webApps[1].status -eq 302 -and $redirectFixture.Requests -eq 1) 'External redirect never followed'
        Assert-True (!$webApps[2].httpApplicable -and !$webApps[3].httpApplicable -and $udpFixture.Requests -eq 0) 'Non-HTTP and UDP never promoted'
        Assert-True (!$webApps[4].ContainsKey('httpProbeError')) 'External address never probed'
    } finally { $htmlFixture.Dispose(); $redirectFixture.Dispose(); $tcpFixture.Dispose(); $udpFixture.Dispose() }
    $passed.Add('Local bounded HTTP fixtures: HTML metadata, external redirect refusal, non-HTTP rejection, UDP exclusion and external-address exclusion passed.')
    $originalInput = [Console]::In
    try {
        foreach ($invalidJson in @('true','123','[]','"text"','null','{broken')) {
            [Console]::SetIn((New-Object IO.StringReader($invalidJson)))
            Expect-Failure { Read-Request } 400 'Only a valid JSON object is accepted'
        }
        [Console]::SetIn((New-Object IO.StringReader('{"action":"capabilities"}')))
        Assert-True ((Read-Request).action -eq 'capabilities') 'JSON object accepted'
    } finally { [Console]::SetIn($originalInput) }
    foreach ($invalid in @('/C:/../Windows','/C:/Users/file:stream','//server/share','/C:/Users/NUL.txt','/C:/Users/trailing.','/C:/Users/back\slash')) {
        Expect-Failure { Resolve-WindowsPath $invalid } 400 "Reject $invalid"
    }
    $unavailableDrive = @([char[]]([char]'A'..[char]'Z') | ForEach-Object { [string]$_ + ':' } | Where-Object { $script:Drives -notcontains $_ })[0]
    if ($unavailableDrive) { Expect-Failure { Resolve-WindowsPath ('/'+$unavailableDrive+'/not-allowed') } 403 'Reject unknown fixed drive' }
    Expect-Failure { File-Path '/C:/Windows/System32' } 403 'Protected system location'
    Expect-Failure { File-Path $virtual $true } 403 'Root cannot be mutated'
    $passed.Add('Path validation rejects traversal, UNC, ADS, device names, noncanonical names, nonlocal drives, protected roots and root mutations.')
    $file = $virtual + '/sample.txt'
    Invoke-Files @{action='create';path=$file;content='first value'} | Out-Null
    $read = Invoke-Files @{action='read';path=$file}
    Assert-True ($read.content -eq 'first value' -and $read.editable -and $read.revision.Length -eq 64) 'UTF8 text read and revision'
    Expect-Failure { Invoke-Files @{action='create';path=$file;content='overwrite'} } 409 'Create does not overwrite'
    Expect-Failure { Invoke-Files @{action='write';path=$file;revision=('0'*64);content='overwrite'} } 409 'Stale write rejected'
    Invoke-Files @{action='write';path=$file;revision=$read.revision;content='updated value'} | Out-Null
    $updated = Invoke-Files @{action='read';path=$file}
    Assert-True ($updated.content -eq 'updated value' -and $updated.revision -ne $read.revision) 'Current revision write'
    Invoke-Files @{action='copy';path=$file;destination=($virtual+'/copy.txt');revision=$updated.revision} | Out-Null
    $copy = Invoke-Files @{action='read';path=($virtual+'/copy.txt')}
    Assert-True ($copy.content -eq 'updated value') 'Copy content'
    Invoke-Files @{action='move';path=($virtual+'/copy.txt');destination=($virtual+'/moved.txt');revision=$copy.revision} | Out-Null
    $moved = Invoke-Files @{action='read';path=($virtual+'/moved.txt')}
    $trash = Invoke-Files @{action='trash';path=($virtual+'/moved.txt');revision=$moved.revision}
    Assert-True (!(Test-Path -LiteralPath (Join-Path $sandbox 'moved.txt'))) 'Trash removes original name'
    $trashList = Invoke-Files @{action='trash-list'}
    Assert-True ($trashList.entries.Count -eq 1) 'Recoverable trash entry'
    Invoke-Files @{action='restore';root=$virtual;id=$trash.id} | Out-Null
    Assert-True ((Invoke-Files @{action='read';path=($virtual+'/moved.txt')}).content -eq 'updated value') 'Restore content'
    Invoke-Files @{action='mkdir';path=($virtual+'/folder')} | Out-Null
    $binary = [byte[]](1,2,0,4)
    Invoke-Files @{action='upload';path=($virtual+'/binary.bin');data=[Convert]::ToBase64String($binary)} | Out-Null
    $download = Invoke-Files @{action='download';path=($virtual+'/binary.bin')}
    Assert-True ($download.data -eq [Convert]::ToBase64String($binary)) 'Binary bounded transfer'
    $list = Invoke-Files @{action='list';path=$virtual}
    Assert-True ($list.entries.Count -ge 4 -and @($list.entries | Where-Object {$_.name -eq 'folder'}).Count -eq 1) 'Directory listing'
    $properties = Invoke-Files @{action='properties';path=$file}
    Assert-True ($properties.sizeBytes -eq 13 -and $properties.allocatedBytes -ge 0) 'Native allocated bytes'
    $search = Invoke-Files @{action='search';path=$virtual;query='sample'}
    Assert-True ($search.entries.Count -eq 1) 'Bounded recursive search'
    $hardLink = Join-Path $sandbox 'hard-link.txt'
    New-Item -ItemType HardLink -Path $hardLink -Target (Join-Path $sandbox 'sample.txt') | Out-Null
    Expect-Failure { Invoke-Files @{action='read';path=($virtual+'/hard-link.txt')} } 403 'Hard-linked file blocked'
    [IO.File]::Delete($hardLink)
    $usage = Storage-Usage $virtual
    Assert-True ($usage.status -eq 'ready' -and $usage.totalBytes -ge 0 -and $usage.measurement -eq 'allocated') 'Bounded storage allocation'
    $passed.Add('Sandbox create/read/write with revision conflicts, copy/move, trash/restore, mkdir, upload/download, search and allocated metadata passed.')
    $junction = Join-Path $sandbox 'junction'
    New-Item -ItemType Junction -Path $junction -Target (Join-Path $sandbox 'folder') | Out-Null
    Expect-Failure { Resolve-WindowsPath ($virtual+'/junction/test.txt') } 403 'Junction ancestor rejected'
    $linked = [IO.File]::GetAttributes($junction)
    Assert-True ([bool]($linked -band [IO.FileAttributes]::ReparsePoint)) 'Junction exists'
    $scanned = Measure-Directory $sandbox 100 .8
    Assert-True ($scanned.partial -and $scanned.skipped -ge 1) 'Junction scan skipped'
    [IO.Directory]::Delete($junction)
    $passed.Add('Junction ancestor traversal blocked; bounded metadata scans skip reparse entries.')
    # Mock OS discovery without changing real services or production resources.
    function Get-CimInstance {
        param($ClassName,$Filter,$Property)
        if ($ClassName -eq 'Win32_Process') { return @([pscustomobject]@{ProcessId=100;ParentProcessId=1;Name='app.exe';ExecutablePath='C:\Apps\app.exe';CreationDate='stable';KernelModeTime=100;UserModeTime=100;WorkingSetSize=4096;ReadTransferCount=0;WriteTransferCount=0}) }
        if ($ClassName -eq 'Win32_Service') { return @([pscustomobject]@{Name='DemoApp';DisplayName='Demo application';ProcessId=100;State='Running';StartMode='Auto';ServiceType='Own Process'},[pscustomobject]@{Name='sshd';DisplayName='OpenSSH';ProcessId=101;State='Running';StartMode='Auto';ServiceType='Own Process'}) }
        if ($ClassName -eq 'Win32_OperatingSystem') { return [pscustomobject]@{TotalVisibleMemorySize=8*1024*1024;FreePhysicalMemory=4*1024*1024;LastBootUpTime=[DateTime]::Now.AddHours(-1)} }
        if ($ClassName -eq 'Win32_Processor') { return [pscustomobject]@{NumberOfLogicalProcessors=4;LoadPercentage=25} }
        if ($ClassName -eq 'Win32_PageFileUsage') { return [pscustomobject]@{AllocatedBaseSize=2048;CurrentUsage=512} }
        if ($ClassName -eq 'Win32_Volume') { $volume=[pscustomobject]@{Name=[IO.Path]::GetPathRoot($sandbox);DeviceID='fixture-volume';FileSystem='NTFS'}; return @($volume,$volume) }
        throw 'Unexpected mocked CIM query'
    }
    function Get-NetTCPConnection { param($State,$ErrorAction); @([pscustomobject]@{LocalPort=8000;LocalAddress='127.0.0.1';OwningProcess=100},[pscustomobject]@{LocalPort=22;LocalAddress='0.0.0.0';OwningProcess=101}) }
    function Get-NetUDPEndpoint { param($ErrorAction); @([pscustomobject]@{LocalPort=5353;LocalAddress='0.0.0.0';OwningProcess=100}) }
    # HTTP behavior was exercised against owned fixtures above. Inventory mocks
    # must never send probes to unrelated real listeners on their synthetic ports.
    function Update-WebApplications { param($Applications) }
    $scan = Invoke-Scan @{}
    Assert-True ($scan.apps.Count -eq 3) 'Both TCP and UDP listeners grouped by distinct port'
    Assert-True (($scan | ConvertTo-Json -Depth 10) -notmatch 'CommandLine|password|arguments') 'No process command arguments'
    $script:Configuration.services = @(@{name='DemoApp';ports=@(8000)},@{name='sshd';ports=@(22)})
    $controls = Service-Controls
    Assert-True ($controls.controls['8000'].canStop -and $controls.controls['8000'].token.Length -eq 64) 'Allowlisted application control'
    Assert-True (!$controls.controls['22'].canStop -and !$controls.controls['5353'].canStop) 'SSH and unregistered ports protected'
    Expect-Failure { Invoke-Control @{action='stop';port=8000;token=('0'*64)} } 409 'Stale service token rejected before action'
    function Get-Service { param($Name); return [pscustomobject]@{DependentServices=@([pscustomobject]@{Status='Running'});ServicesDependedOn=@()} }
    Expect-Failure { Invoke-Control @{action='stop';port=8000;token=$controls.controls['8000'].token} } 409 'Dependent services are never stopped implicitly'
    $passed.Add('Mock CIM: TCP/UDP inventory, no argument exposure, application allowlist, system-service protection and stale control tokens passed.')
    $resources = Invoke-Agent 'resources' @{}
    Assert-True ($resources.available -and $resources.applications.Count -eq 2 -and $resources.system.cpuPercent -eq 25 -and $resources.system.memory.totalBytes -eq 8GB) 'Resource wire shape and mock values'
    $firstNet = @{at=0;counters=@{Ethernet=@{read=100;write=200};Reset=@{read=100;write=200}}}
    $lastNet = @{at=[Diagnostics.Stopwatch]::Frequency;counters=@{Ethernet=@{read=300;write=600};Reset=@{read=10;write=10}}}
    $beforeTop = @{0=@{sampled=$true;started='idle';cpu=0};7=@{sampled=$true;started='same';cpu=0};8=@{sampled=$true;started='old';cpu=0}}
    $afterTop = @{0=@{sampled=$true;started='idle';cpu=40000000;name='Idle';memoryAvailable=$true;memory=0};7=@{sampled=$true;started='same';cpu=10000000;name='Worker';memoryAvailable=$true;memory=100};8=@{sampled=$true;started='new';cpu=90000000;name='Reused';memoryAvailable=$false;memory=0}}
    $extended = Get-ServerOverview @{Caption='Test Windows';Version='Test'} $beforeTop $afterTop 1 4 $firstNet $lastNet
    Assert-True ($extended.version -eq 1 -and $extended.platform -eq 'windows' -and $null -eq $extended.cpuTemperatureC) 'Overview platform and missing temperature'
    Assert-True ($extended.topProcesses.Count -eq 2 -and @($extended.topProcesses | Where-Object {$_.pid -eq 0}).Count -eq 0) 'Idle process excluded'
    Assert-True (($extended.topProcesses | Where-Object {$_.pid -eq 7}).cpuPercent -eq 25) 'Process CPU normalized by logical CPU count'
    Assert-True ($null -eq ($extended.topProcesses | Where-Object {$_.pid -eq 8}).cpuPercent) 'Reused PID not assigned old CPU usage'
    Assert-True (($extended.network | Where-Object {$_.name -eq 'Ethernet'}).readBytesPerSecond -eq 200) 'Network uses elapsed sample duration'
    Assert-True ($null -eq ($extended.network | Where-Object {$_.name -eq 'Reset'}).readBytesPerSecond) 'Reset network counter is unknown instead of negative or zero'
    $passed.Add('Overview: idle PID exclusion, process identity, normalized CPU, adapter rate/reset and unavailable temperature passed.')
    Assert-True (@($resources.applications | Where-Object { $_.listenerPids[0] -eq 101 -and $null -eq $_.cpuPercent }).Count -eq 1) 'Missing listener process CPU remains null'
    $overview = Invoke-Agent 'storage' @{action='overview'}
    Assert-True ($overview.available -and $overview.volumes.Count -eq 1 -and $overview.summary.volumeCount -eq 1 -and $overview.summary.totalBytes -gt 0) 'Storage overview deduplicates same volume and has summary'
    $appUsage = Invoke-Agent 'storage' @{action='apps';paths=@($virtual)}
    Assert-True ($appUsage.status -eq 'ready' -and $appUsage.applications.Count -eq 1 -and $appUsage.applications[0].path -eq $virtual -and $appUsage.applications[0].bytes -ge 0) 'Storage apps response measurement shape'
    function Invoke-RestMethod {
        param($Uri,$Method,$TimeoutSec,$MaximumRedirection)
        Assert-True ($Uri -eq 'http://127.0.0.1:11434/api/tags' -and $Method -eq 'Get' -and $MaximumRedirection -eq 0) 'Model metadata fixed endpoint'
        return @{models=@(@{name='fixture-model';size=12345;details=@{family='fixture';parameter_size='1B';quantization_level='Q4'}})}
    }
    $models = Invoke-Agent 'models' @{}
    Assert-True ($models.available -and $models.models.Count -eq 1 -and $models.models[0].runtime -eq 'Ollama' -and $models.models[0].kind -eq 'unknown' -and $models.models[0].evidence[0].source -and $models.models[0].checkedAt -and $models.coverage.hostsChecked -eq 1) 'Model catalog wire fields match frontend contract'
    $cap = File-Capabilities
    Assert-True (!$cap.streamUpload -and !$cap.streamExport -and !$cap.streamingUpload -and !$cap.streamingExport -and !$cap.directoryCopy) 'Unsupported transfers declared'
    Assert-True (!(Invoke-Versions @{action='capabilities'}).available) 'Unavailable version UI declared'
    Assert-True ((Invoke-Agent 'files' @{action='capabilities'}).ok -eq $true) 'Files wire success envelope accepted by controller'
    $concurrency = Invoke-Agent 'concurrency' @{}
    Assert-True ($concurrency.checkedAt -and $concurrency.services.Count -eq 0 -and !$concurrency.available) 'Valid explicit unavailable concurrency envelope'
    $script:Configuration.services = @()
    Assert-True (!(Agent-Capabilities).capabilities.control) 'Unregistered control is not advertised as enabled'
    $passed.Add('Wire envelopes: resource nulls, storage volume deduplication/apps, file ok success, model frontend fields and explicit concurrency/control gaps passed.')
    @{ ok=$true; powershell=$PSVersionTable.PSVersion.ToString(); checks=@($passed.ToArray()) } | ConvertTo-Json -Depth 5
} finally {
    # Only a verified, test-created directory beneath this clone's tests folder.
    $resolvedBase = [IO.Path]::GetFullPath($sandboxBase).TrimEnd('\')+'\'
    $resolvedTarget = [IO.Path]::GetFullPath($sandbox)
    if (!$resolvedTarget.StartsWith($resolvedBase,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path' }
    if (Test-Path -LiteralPath (Join-Path $sandbox 'junction')) { [IO.Directory]::Delete((Join-Path $sandbox 'junction')) }
    if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}
