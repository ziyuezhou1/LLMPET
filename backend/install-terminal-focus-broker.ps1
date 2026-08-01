param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('install', 'uninstall')]
  [string]$Mode,

  [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$TaskName = 'LLMPET Terminal Focus Broker'
$TaskPath = '\LLMPET\'

function Remove-BrokerTask {
  $existing = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if (-not $existing) { return }
  try { Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue } catch {}
  Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false -ErrorAction Stop
}

if ($Mode -eq 'uninstall') {
  Remove-BrokerTask
  exit 0
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) { throw 'InstallRoot is required.' }
$resolvedRoot = (Resolve-Path -LiteralPath $InstallRoot -ErrorAction Stop).Path.TrimEnd('\')
$brokerPath = Join-Path $resolvedRoot 'backend\terminal-focus-broker.ps1'
$helperPath = Join-Path $resolvedRoot 'backend\focus-windows-terminal.ps1'
if (-not (Test-Path -LiteralPath $brokerPath -PathType Leaf)) { throw 'Terminal focus broker is missing.' }
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { throw 'Terminal focus helper is missing.' }
if (-not $brokerPath.StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Broker path escaped the installation root.'
}

Remove-BrokerTask

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$userName = $identity.Name
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (
  $brokerPath.Replace('"', '""')
)
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory (Split-Path $brokerPath)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Focuses an already-bound Windows Terminal tab for LLMPET. It cannot launch commands or terminals.'
Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath

$running = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 100
  $state = (Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop).State
  if ($state -eq 'Running') { $running = $true; break }
}
if (-not $running) {
  Remove-BrokerTask
  throw 'Terminal focus broker did not stay running.'
}
