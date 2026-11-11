# Smart Pager: the order's QR at the end of every receipt this branch prints.
# Run once on the cashier PC that prints the receipts (it asks for admin by itself). It finds
# the receipt printer and puts the Smart Pager agent between it and the POS; the POS keeps
# printing to the same printer name. Running it again updates the agent. To undo: the remove
# command from the Smart Pager super page.

$ErrorActionPreference = 'Stop'
$Server = '__SERVER__'
$Branch = '__BRANCH__'
$Token = '__TOKEN__'
$Wanted = '__PRINTER__'
$Self = $Server + '/api/pos/' + $Branch + '/' + $Token + '/printer.ps1'
$TaskName = 'SmartPager Print'
$PortName = 'SmartPager_9101'
$Port = 9101

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Asking for administrator rights...'
  $cmd = "[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm '" + $Self + "' | iex"
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', $cmd)
  return
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Dir = Join-Path $env:ProgramData 'SmartPagerPrint'
$ConfigFile = Join-Path $Dir 'config.json'
New-Item -ItemType Directory -Force $Dir | Out-Null

function Stop-Agent {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*SmartPagerPrint*agent.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if (Test-Path $ConfigFile) {
  # Installed before: keep the printer it was put on, update the agent.
  $old = Get-Content $ConfigFile -Raw | ConvertFrom-Json
  $printer = $old.printer
  $direct = $old.direct
  $originalPort = $old.originalPort
  Write-Host ('Updating the agent for "' + $printer + '"')
} else {
  $all = @(Get-Printer | Where-Object {
      $_.Name -notmatch 'PDF|XPS|OneNote|Fax|SmartPager|Microsoft|AnyDesk|TeamViewer' -and $_.PortName -notmatch '^(PORTPROMPT|nul|FILE|SmartPager)'
    })
  $pick = $null
  if ($Wanted) { $pick = $all | Where-Object { $_.Name -eq $Wanted } | Select-Object -First 1 }
  if (-not $pick) {
    $guess = @($all | Where-Object { $_.Name -match 'POS|Receipt|Thermal|XP-|Xprinter|TM-|Epson|Rongta|Sewoo|Bixolon|Star|Zjiang|Gprinter|80|58' })
    if ($guess.Count -eq 1) { $pick = $guess[0] }
    elseif ($all.Count -eq 1) { $pick = $all[0] }
    elseif ($all.Count -gt 1) {
      Write-Host 'Which printer prints the customer receipts?'
      for ($i = 0; $i -lt $all.Count; $i++) { Write-Host ('  ' + ($i + 1) + ') ' + $all[$i].Name) }
      $n = [int](Read-Host 'Number')
      if ($n -ge 1 -and $n -le $all.Count) { $pick = $all[$n - 1] }
    }
  }
  if (-not $pick) { throw 'No receipt printer found on this PC.' }
  $printer = $pick.Name
  $direct = $printer + ' (SmartPager direct)'
  $originalPort = $pick.PortName
  Write-Host ('Receipt printer: "' + $printer + '" on ' + $originalPort)
  # The agent sends the receipts on through this second queue, on the printer's own port.
  if (-not (Get-Printer -Name $direct -ErrorAction SilentlyContinue)) {
    Add-Printer -Name $direct -DriverName $pick.DriverName -PortName $originalPort
  }
}

@{ server = $Server; branch = $Branch; token = $Token; printer = $printer; direct = $direct; originalPort = $originalPort; port = $Port } |
  ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8
Invoke-WebRequest -Uri ($Server + '/api/pos/' + $Branch + '/' + $Token + '/printer/agent.ps1') -OutFile (Join-Path $Dir 'agent.ps1') -UseBasicParsing

Stop-Agent
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Dir 'agent.ps1') + '"')
$triggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1))
)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

# The printer switches over only once the agent answers, so no receipt is ever lost.
$ready = $false
for ($i = 0; $i -lt 30 -and -not $ready; $i++) {
  Start-Sleep -Seconds 1
  try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', $Port); $c.Close(); $ready = $true } catch { }
}
if (-not $ready) { throw 'The agent did not start. Nothing was changed on the printer.' }
if (-not (Get-PrinterPort -Name $PortName -ErrorAction SilentlyContinue)) {
  Add-PrinterPort -Name $PortName -PrinterHostAddress '127.0.0.1' -PortNumber $Port
}
Set-Printer -Name $printer -PortName $PortName

Write-Host ''
Write-Host 'Done. Print a receipt from the POS: the order QR is at the bottom.' -ForegroundColor Green
Write-Host ('Log: ' + (Join-Path $Dir 'agent.log'))
