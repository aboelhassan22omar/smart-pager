# Smart Pager: removes the receipt QR agent. The receipt printer goes back to its own port,
# exactly as it was before the install.

$ErrorActionPreference = 'Stop'
$Self = '__SELF__'
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $cmd = "[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm '" + $Self + "' | iex"
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', $cmd)
  return
}

$Dir = Join-Path $env:ProgramData 'SmartPagerPrint'
$ConfigFile = Join-Path $Dir 'config.json'
if (-not (Test-Path $ConfigFile)) { Write-Host 'Smart Pager print agent is not installed here.'; return }
$cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json

Set-Printer -Name $cfg.printer -PortName $cfg.originalPort
Unregister-ScheduledTask -TaskName 'SmartPager Print' -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*SmartPagerPrint*agent.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Printer -Name $cfg.direct -ErrorAction SilentlyContinue
Remove-PrinterPort -Name 'SmartPager_9101' -ErrorAction SilentlyContinue
Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ('Removed. "' + $cfg.printer + '" prints as before.') -ForegroundColor Green
