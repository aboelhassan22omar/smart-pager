# Smart Pager receipt QR agent.
# The POS prints to its receipt printer as before. Windows hands each print job to this agent
# (a printer port on 127.0.0.1), which asks the Smart Pager server for the order's QR, adds it
# before the paper cut, and sends the job on to the real printer. No answer within 3 seconds,
# or any error: the receipt prints exactly as it came. Installed by printer.ps1, which runs it
# as a scheduled task (every minute: a second copy exits at once while this one listens).

$ErrorActionPreference = 'Stop'
$Dir = Join-Path $env:ProgramData 'SmartPagerPrint'
if ($env:SP_PRINT_DIR) { $Dir = $env:SP_PRINT_DIR }
$Config = Get-Content (Join-Path $Dir 'config.json') -Raw | ConvertFrom-Json
$LogFile = Join-Path $Dir 'agent.log'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Log([string]$Message) {
  try {
    Add-Content -Path $LogFile -Value ((Get-Date -Format 's') + ' ' + $Message)
    if ((Get-Item $LogFile).Length -gt 1MB) { Move-Item $LogFile ($LogFile + '.old') -Force }
  } catch { }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SmartPagerRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DocInfo { public string Name; public string OutputFile; public string DataType; }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr handle, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DocInfo info);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr handle, byte[] data, int count, out int written);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter " + Marshal.GetLastWin32Error());
    try {
      if (StartDocPrinter(h, 1, new DocInfo { Name = "Receipt", DataType = "RAW" }) == 0) throw new Exception("StartDocPrinter " + Marshal.GetLastWin32Error());
      StartPagePrinter(h);
      int written;
      if (!WritePrinter(h, data, data.Length, out written)) throw new Exception("WritePrinter " + Marshal.GetLastWin32Error());
      EndPagePrinter(h);
      EndDocPrinter(h);
    } finally { ClosePrinter(h); }
  }
}
'@

function Send-Job([byte[]]$Bytes) {
  if ($Config.sinkFile) { [IO.File]::WriteAllBytes($Config.sinkFile, $Bytes); return }
  [SmartPagerRaw]::Send($Config.direct, $Bytes)
}

# Where the QR goes: before the last paper cut (GS V, ESC i, ESC m) near the end, else at the end.
function Get-CutIndex([byte[]]$Bytes) {
  $stop = [Math]::Max(0, $Bytes.Length - 2048)
  for ($i = $Bytes.Length - 2; $i -ge $stop; $i--) {
    $a = $Bytes[$i]; $b = $Bytes[$i + 1]
    if (($a -eq 0x1D -and $b -eq 0x56) -or ($a -eq 0x1B -and ($b -eq 0x69 -or $b -eq 0x6D))) { return $i }
  }
  return $Bytes.Length
}

function Add-Qr([byte[]]$Job) {
  $text = [Text.Encoding]::GetEncoding(1256).GetString($Job) -replace '[\x00-\x08\x0B-\x1F\x7F]+', ' '
  if ($text.Length -gt 40000) { $text = $text.Substring(0, 40000) }
  $sha = [Security.Cryptography.SHA256]::Create()
  $hash = -join ($sha.ComputeHash($Job) | ForEach-Object { $_.ToString('x2') })
  $body = @{ text = $text; hash = $hash; size = $Job.Length } | ConvertTo-Json -Compress
  $url = $Config.server + '/api/pos/' + $Config.branch + '/' + $Config.token + '/printer/job'
  $res = Invoke-RestMethod -Method Post -Uri $url -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 3 -UseBasicParsing
  if (-not $res.append) { return $Job }
  $add = [Convert]::FromBase64String($res.append)
  $at = Get-CutIndex $Job
  $out = New-Object byte[] ($Job.Length + $add.Length)
  [Array]::Copy($Job, 0, $out, 0, $at)
  [Array]::Copy($add, 0, $out, $at, $add.Length)
  [Array]::Copy($Job, $at, $out, $at + $add.Length, $Job.Length - $at)
  return $out
}

try {
  $listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, [int]$Config.port)
  $listener.Start()
} catch {
  exit 0 # another copy is listening already
}
Log ('listening on ' + $Config.port + ' for ' + $Config.printer)

while ($true) {
  $client = $listener.AcceptTcpClient()
  $buffer = New-Object IO.MemoryStream
  try {
    $client.ReceiveTimeout = 15000
    $stream = $client.GetStream()
    $chunk = New-Object byte[] 65536
    while (($n = $stream.Read($chunk, 0, $chunk.Length)) -gt 0) { $buffer.Write($chunk, 0, $n) }
  } catch {
    Log ('read: ' + $_.Exception.Message)
  } finally {
    $client.Close()
  }
  $job = $buffer.ToArray()
  if ($job.Length -eq 0) { continue }
  $out = $job
  try { $out = Add-Qr $job } catch { Log ('printed without the QR: ' + $_.Exception.Message) }
  try {
    Send-Job $out
  } catch {
    Log ('print failed: ' + $_.Exception.Message)
    try { Send-Job $job } catch { Log ('print failed again: ' + $_.Exception.Message) }
  }
}
