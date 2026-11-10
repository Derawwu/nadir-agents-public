<#
.SYNOPSIS
  Stops the dev server listening on a TCP port, together with the watcher
  and npm processes that started it (used by shutdown.bat).

.DESCRIPTION
  A dev server is a chain such as  cmd /k "npm run dev" -> npm -> tsx watch
  -> node. Stopping only the process on the port would leave the watcher
  alive, so this climbs from it through node.exe / non-interactive cmd.exe
  parents and stops that whole tree. It stops climbing at anything else
  (PowerShell, Git Bash, a plain interactive cmd, Explorer), so a terminal
  you opened yourself stays open.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-port.ps1 -Port 3001 -Name "Agent backend"
#>
param(
  [Parameter(Mandatory)] [int] $Port,
  [Parameter(Mandatory)] [string] $Name
)

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
  Write-Host "      $Name not running on :$Port."
  exit 0
}

function Get-Proc([int] $id) { Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue }

# A cmd.exe started with /c or /k is a wrapper (npm's shell, or the window
# start.bat opened); a bare cmd.exe is someone's own terminal.
function Test-Wrapper($proc) {
  if (-not $proc) { return $false }
  if ($proc.Name -eq 'node.exe') { return $true }
  if ($proc.Name -eq 'cmd.exe') { return $proc.CommandLine -match '(?i)\s/[ck]\s' }
  return $false
}

$top = Get-Proc $listener.OwningProcess
while ($true) {
  $parent = Get-Proc $top.ParentProcessId
  if (-not (Test-Wrapper $parent)) { break }
  $top = $parent
}

# taskkill /T ends the whole tree; /F because console apps ignore a polite close.
taskkill /F /T /PID $top.ProcessId *> $null
Start-Sleep -Milliseconds 500
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "      $Name is still listening on :$Port - stop it by hand." -ForegroundColor Yellow
  exit 1
}
Write-Host "      Stopped $Name (:$Port)."
exit 0
