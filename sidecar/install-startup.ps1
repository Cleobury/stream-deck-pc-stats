# One-time setup, run as administrator. Installs the PawnIO driver if it is missing, then starts StatsReader
# elevated at login so CPU temperature and power work.
# Remove the login task again with: .\install-startup.ps1 -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$taskName = 'StatsReader'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
	throw 'Run this from an administrator PowerShell window.'
}

if ($Uninstall) {
	Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
	Write-Host "Removed the $taskName login task."
	return
}

if (-not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Services\PawnIO')) {
	Write-Host 'Installing the PawnIO driver...'
	winget install --exact --id namazso.PawnIO --silent --accept-package-agreements --accept-source-agreements
	if (-not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Services\PawnIO')) {
		Write-Warning 'PawnIO did not install, so CPU temperature and power will show N/A.'
	}
}

$exe = Join-Path $PSScriptRoot 'StatsReader.exe'
$action = New-ScheduledTaskAction -Execute $exe
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
$taskUser = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskUser -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host 'StatsReader will now start at login, and has been started.'
