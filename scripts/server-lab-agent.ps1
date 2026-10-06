#requires -Version 5.1
param([ValidateSet('capabilities','resources','processes','services','scan','storage','files','control')][string]$Helper, [string]$Root, [int]$AllowedProcessId = -1, [string]$AllowedProcessToken = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$SelectedHelper = $Helper
. (Join-Path $PSScriptRoot '..\server\agent\windows-agent.ps1')
Initialize-Native
$script:Drives = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [IO.DriveType]::Fixed -and $_.IsReady } | ForEach-Object { $_.Name.Substring(0, 2).ToUpperInvariant() })
$script:AllowedRoots = @((Virtual-Path $Root))
$script:Configuration = @{ roots = $script:AllowedRoots; services = @() }
$script:LabProcessId = $AllowedProcessId
$script:LabProcessToken = $AllowedProcessToken
try {
    switch ($SelectedHelper) {
        'resources' { $result = Invoke-Resources }
        'processes' { $result = Invoke-Processes (Read-Request) }
        'services' { $request = Read-Request; if ($request.action -notin @('list','details','logs')) { Fail 'Real Windows service mutations are disabled in the lab.' 403 }; $result = Invoke-Services $request }
        'storage' {
            $request = Read-Request
            if ($request.action -eq 'overview') { $result = Invoke-Storage $request; $result.labRoot = Virtual-Path $Root }
            elseif ($request.action -eq 'usage') {
                $virtualRoot = Virtual-Path $Root
                if ($request.path -eq '/' -or $request.path -eq $virtualRoot.Substring(0,3)) {
                    $result = @{status='ready';path=$request.path;scannedAt=(Timestamp);totalBytes=$null;partial=$true;
                        reason='Lab scope: only sample-files can be inspected; this is not a scan of the whole volume.';
                        entries=@(@{name='sample-files';path=$virtualRoot;kind='directory';bytes=$null;partial=$true})}
                } else { [void](File-Path $request.path); $result = Invoke-Storage $request }
            }
            elseif ($request.action -eq 'apps') { foreach ($item in @($request.paths)) { [void](File-Path $item) }; $result = Invoke-Storage $request }
            else { Fail 'Unsupported lab storage operation.' 403 }
        }
        'files' {
            $request = Read-Request
            if ($request.action -notin @('capabilities','list','read','properties')) { Fail 'Lab files are read-only.' 403 }
            $virtualRoot = Virtual-Path $Root
            if ($request.action -ne 'capabilities' -and !($request.action -eq 'list' -and ($request.path -eq '/' -or $request.path -eq $virtualRoot.Substring(0,3)))) { [void](File-Path $request.path) }
            $result = Invoke-Agent 'files' $request
            if ($request.action -eq 'capabilities') { $result.upload = $false; $result.reason = 'Local lab: only the sample-files directory is readable.' }
            if ($request.action -eq 'read') { $result.editable = $false }
            if ($request.action -eq 'list') { $result.writable = $false; foreach ($entry in $result.entries) { $entry.mutable = $false } }
        }
        'scan' { $result = Invoke-Scan @{start=3281;end=3281}; foreach ($app in $result.apps) { $app.directory = (Virtual-Path $Root) + '/example-app'; $app.name = 'ViiOS Lab Example App' } }
        'control' { $result = @{ok=$true;controls=@{}} }
        'capabilities' { $result = @{available=$true;os='windows';lab=$true;capabilities=@{inventory=$true;resources=$true;storage=$true;files=$true;control=$false;versions=$false;models=$false}} }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 24 -Compress))
} catch {
    $exception = $_.Exception
    $status = if ($exception.Data['public']) { [int]$exception.Data['status'] } else { 503 }
    [Console]::Out.WriteLine((@{ok=$false;available=$false;status=$status;error='Local operation unavailable.'} | ConvertTo-Json -Compress))
}
