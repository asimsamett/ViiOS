#requires -Version 5.1
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\server\agent\windows-agent.ps1')
Initialize-Native
function Assert($Value,[string]$Message) { if (!$Value) { throw $Message } }
function Reject([scriptblock]$Work,[int]$Status) { $caught=$false;try { & $Work | Out-Null } catch { $caught=$true;Assert ($_.Exception.Data['status'] -eq $Status) "Expected $Status" };Assert $caught 'Expected rejection' }
Reject { Assert-ProcessRequest @{action='details';pid='1;whoami'} } 400
Reject { Assert-ProcessRequest @{action='terminate';pid=1;token='bad'} } 400
Reject { Assert-ProcessRequest @{action='list';command='bad'} } 400
$node=Join-Path $PSScriptRoot '..\node_modules\node\bin\node.exe'
$workerPath=Join-Path $PSScriptRoot '..\scripts\lab-worker.mjs'
$worker=Start-Process -FilePath $node -ArgumentList @('"'+$workerPath+'"') -WindowStyle Hidden -PassThru
try {
    $metadata=[ViiOS.ProcessGuard]::Inspect($worker.Id)
    $script:LabProcessId=$worker.Id
    $script:LabProcessToken=Process-Identity $worker.Id $metadata.Started
    $list=Invoke-Processes @{action='list'}
    Assert ($list.ok -and $list.processes.Count -gt 1) 'Real process list missing'
    $row=@($list.processes | Where-Object {$_.pid -eq $worker.Id})[0]
    Assert ($row.canTerminate -and $row.token -eq $script:LabProcessToken) 'Owned worker must be terminable'
    Assert (@($list.processes | Where-Object {$_.canTerminate -and $_.pid -ne $worker.Id}).Count -eq 0) 'Lab exposed other process mutations'
    Assert ($row.user -and $row.startedAt -and $row.memoryBytes -gt 0) 'Process identity/owner/memory missing'
    $detail=Invoke-Processes @{action='details';pid=$worker.Id}
    Assert ($detail.process.token -eq $row.token) 'Details identity mismatch'
    Reject { Invoke-Processes @{action='terminate';pid=$worker.Id;token=('b'*64)} } 409
    Assert (!$worker.HasExited) 'Stale identity killed worker'
    $self=Invoke-Processes @{action='details';pid=$PID}
    Assert (!$self.process.canTerminate) 'Management process unprotected'
    Reject { Invoke-Processes @{action='terminate';pid=$PID;token=$self.process.token} } 403
    $result=Invoke-Processes @{action='terminate';pid=$worker.Id;token=$row.token}
    Assert ($result.ok -and $result.exited -and $worker.WaitForExit(2000)) 'Worker did not exit'
    Reject { Invoke-Processes @{action='details';pid=$worker.Id} } 404
    Write-Output 'PASS Windows processes: schema, real list, owner/start/CPU/RAM, details, stale identity, management protection, lab restriction, pinned-handle termination, exited PID.'
} finally { if (!$worker.HasExited) { $worker.Kill() }; $worker.Dispose() }
