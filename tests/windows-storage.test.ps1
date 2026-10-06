#requires -Version 5.1
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\server\agent\windows-agent.ps1')
Initialize-Native
function Assert($Value,[string]$Message) { if (!$Value) { throw $Message } }
$actual = Invoke-Storage @{action='overview'}
Assert ($actual.volumes.Count -gt 0) 'Live volume enumeration failed'
Assert ($actual.topology.available -and $actual.topology.devices.Count -gt 0) 'Live Windows disk topology unavailable'
Assert (@($actual.topology.devices | Where-Object {$_.volumeIds.Count}).Count -gt 0) 'No live volume-to-partition mapping'
Assert (!(($actual.topology | ConvertTo-Json -Depth 8) -match 'SerialNumber|UniqueId')) 'Private disk identity exposed'
Write-Output 'PASS live Windows volume capacity, disk/partition mapping and public topology.'

$fixtureBase = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$fixturePath = Join-Path $fixtureBase ('.storage-lab-' + [Guid]::NewGuid().ToString('N'))
try {
    [void][IO.Directory]::CreateDirectory($fixturePath)
    [IO.File]::WriteAllText((Join-Path $fixturePath 'sample.txt'),'Synthetic storage fixture')
    $virtualFixture = Virtual-Path $fixturePath
    $wrapper = Join-Path $PSScriptRoot '..\scripts\server-lab-agent.ps1'
    $usageRequest = @{action='usage';path=$virtualFixture} | ConvertTo-Json -Compress
    $usage = ($usageRequest | & powershell.exe -NoProfile -File $wrapper -Helper storage -Root $fixturePath) | ConvertFrom-Json
    Assert ($usage.status -eq 'ready' -and $usage.entries.Count -eq 1) 'Lab wrapper did not initialize file-drive access for scans'
    $fileRequest = @{action='read';path=($virtualFixture+'/sample.txt')} | ConvertTo-Json -Compress
    $file = ($fileRequest | & powershell.exe -NoProfile -File $wrapper -Helper files -Root $fixturePath) | ConvertFrom-Json
    Assert ($file.ok -and !$file.editable -and $file.content -eq 'Synthetic storage fixture') 'Lab file preview is not read-only'
    $escapeRequest = @{action='list';path=(Virtual-Path $PSScriptRoot)} | ConvertTo-Json -Compress
    $denied = ($escapeRequest | & powershell.exe -NoProfile -File $wrapper -Helper files -Root $fixturePath) | ConvertFrom-Json
    Assert ($denied.status -eq 403) 'Lab allowed a read outside its fixture'
    Write-Output 'PASS lab wrapper scan, read-only preview and outside-root denial.'
} finally {
    $verifiedFixture = [IO.Path]::GetFullPath($fixturePath)
    if (!$verifiedFixture.StartsWith($fixtureBase,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup' }
    if (Test-Path -LiteralPath $verifiedFixture) { Remove-Item -LiteralPath $verifiedFixture -Recurse -Force }
}

# Deterministic doubles exercise duplicate mounts, inaccessible volumes and missing counters.
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction)
    if ($ClassName -eq 'Win32_Volume') { return @(
      [pscustomobject]@{Name='C:\';DeviceID='volume-a';FileSystem='NTFS'},
      [pscustomobject]@{Name='C:\alias\';DeviceID='volume-a';FileSystem='NTFS'},
      [pscustomobject]@{Name='D:\';DeviceID='volume-b';FileSystem='NTFS'}) }
    return @([pscustomobject]@{Name='0 C:';DiskReadBytesPersec=0;DiskWriteBytesPersec=$null})
}
$script:FailVolume=$false
function Get-VolumeCapacity($Name) { if($Name -eq 'D:\' -and $script:FailVolume){throw 'Unavailable'};return ,@(1000,300,200) }
function Get-Disk { param($ErrorAction);return @([pscustomobject]@{Number=0;Size=2500;FriendlyName='Example';PartitionStyle='GPT'}) }
function Get-Partition { param($ErrorAction);return @([pscustomobject]@{DiskNumber=0;PartitionNumber=1;Size=1000;AccessPaths=@('volume-a','C:\')}) }
$normal=Get-Volumes
Assert ($normal.summary.totalBytes -eq 2000 -and $normal.volumes.Count -eq 2) 'Duplicate volume counted twice'
$topology=Get-StorageTopology $normal.volumes
Assert ($topology.devices[1].parentIds[0] -eq 'disk:0') 'Partition parent lost'
Assert ($topology.devices[1].volumeIds[0] -eq (Hash-Text 'volume-a')) 'Volume identity mapping lost'
Assert ($topology.devices[0].readBytesPerSecond -eq 0 -and $null -eq $topology.devices[0].writeBytesPerSecond) 'Unknown counter reported as zero'
$script:FailVolume=$true; $partial=Get-Volumes
Assert (!$partial.available -and $null -eq $partial.summary.totalBytes -and $partial.volumes.Count -eq 2) 'Partial total incorrectly reported as complete'
Write-Output 'PASS volume deduplication, partial capacity, topology mapping and unknown counters.'
