#requires -Version 5.1
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\server\agent\windows-agent.ps1')
Initialize-Native
$script:Configuration=@{services=@()}
function Assert($Value,[string]$Message){if(!$Value){throw $Message}}
function Reject([scriptblock]$Work,[int]$Status){$caught=$false;try{& $Work | Out-Null}catch{$caught=$true;Assert ($_.Exception.Data['status'] -eq $Status) "Expected status $Status; got $($_.Exception.Data['status']): $($_.Exception.Message) at $($_.ScriptStackTrace)"};Assert $caught 'Expected rejection'}
Reject {Assert-ServiceRequest @{action='details';name="bad';shutdown"}} 400
Reject {Assert-ServiceRequest @{action='list';command='bad'}} 400
Reject {Assert-ServiceRequest @{action='stop';name='demo';token='bad'}} 400
Reject {Assert-ServiceRequest @{action='logs';name='demo';limit=201}} 400
$live=Invoke-Services @{action='list'}
Assert ($live.available -and $live.services.Count -gt 0) 'Real Windows service enumeration failed'
Assert (@($live.services | Where-Object {$_.actions.Count}).Count -eq 0) 'Empty allowlist exposed real service mutations'
Assert (!(($live|ConvertTo-Json -Depth 10) -match 'PathName|StartName')) 'Executable/account configuration leaked'
Write-Output 'PASS real Windows service list; empty allowlist read-only; no executable or account configuration exposure.'

# All mutations below use explicit in-memory CIM doubles, never the host SCM.
$script:Configuration=@{services=@(@{name='ExampleAppService'})}
$script:FakeService=[pscustomobject]@{Name='ExampleAppService';DisplayName='Test Service';Description='Disposable service double';State='Running';StartMode='Manual';ProcessId=$PID;ServiceType='Own Process';PathName='private command';StartName='private account'}
$script:FakeController=[pscustomobject]@{CanStop=$true;ServicesDependedOn=@();DependentServices=@()}
$script:FakeController|Add-Member ScriptMethod WaitForStatus {param($state,$timeout)}
$script:Calls=New-Object 'System.Collections.Generic.List[string]'
function Service-Context {return @{services=@($script:FakeService);controllers=@{ExampleAppService=$script:FakeController};protected=(New-Object 'System.Collections.Generic.HashSet[int]');administrator=$true}}
function Invoke-CimMethod($InputObject,[string]$MethodName,$Arguments){
 Assert ($InputObject.Name -eq 'ExampleAppService') 'Attempted non-fixture CIM mutation'
 $script:Calls.Add($MethodName)
 switch($MethodName){
  'StopService' {$script:FakeService.State='Stopped';$script:FakeService.ProcessId=0}
  'StartService' {$script:FakeService.State='Running';$script:FakeService.ProcessId=$PID}
  'ChangeStartMode' {$script:FakeService.StartMode=@{Automatic='Auto';Manual='Manual';Disabled='Disabled'}[$Arguments.StartMode]}
  default {throw 'Unexpected mutation'}
 };return @{ReturnValue=0}
}
function Details {(Invoke-Services @{action='details';name='ExampleAppService'}).service}
Reject {Invoke-Services @{action='stop';name='ExampleAppService';token=('b'*64)}} 409
Assert ($script:Calls.Count -eq 0) 'Stale identity mutated service'
$script:FakeController.DependentServices=@([pscustomobject]@{Name='dependent';Status='Running'})
Reject {Invoke-Services @{action='stop';name='ExampleAppService';token=(Details).token}} 409
Assert ($script:Calls.Count -eq 0) 'Active dependents cascaded'
$script:FakeController.DependentServices=@()
foreach($action in @('stop','start','restart','automatic','manual','disabled')) {
 $result=Invoke-Services @{action=$action;name='ExampleAppService';token=(Details).token}
 Assert $result.ok "Action $action failed"
}
Assert ($script:FakeService.State -eq 'Running' -and $script:FakeService.StartMode -eq 'Disabled') 'Startup change changed running state'
Assert ('start' -notin (Details).actions -and 'restart' -notin (Details).actions) 'Disabled service permits start'
Assert (!(Invoke-Services @{action='logs';name='ExampleAppService';limit=10}).available) 'Windows logs availability invented'
$script:FakeService.Name='sshd';$script:Configuration=@{services=@(@{name='sshd'})}
$context=Service-Context;$context.controllers=@{sshd=$script:FakeController}
Assert ((Service-Row $script:FakeService $context).actions.Count -eq 0) 'SSH protection bypassed by allowlist'
Write-Output 'PASS Windows service doubles: stale identity, active dependents, start/stop/restart, all startup modes, protected SSH, unsupported logs.'
