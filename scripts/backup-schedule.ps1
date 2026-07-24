# ================================
# Nadir Backup Schedule Manager
# ================================
# To DISABLE tasks (pause without deleting):
#   Disable-ScheduledTask -TaskName 'NadirBackupFrequent'
#   Disable-ScheduledTask -TaskName 'NadirBackupOnLogon'
#
# To RE-ENABLE tasks:
#   Enable-ScheduledTask -TaskName 'NadirBackupFrequent'
#   Enable-ScheduledTask -TaskName 'NadirBackupOnLogon'
#
# To PERMANENTLY REMOVE tasks:
#   Unregister-ScheduledTask -TaskName 'NadirBackupFrequent' -Confirm:$false
#   Unregister-ScheduledTask -TaskName 'NadirBackupOnLogon' -Confirm:$false
#
# To CHECK task status:
#   Get-ScheduledTask -TaskName 'NadirBackupFrequent'
#   Get-ScheduledTask -TaskName 'NadirBackupOnLogon'
#
# To RUN backup manually:
#   powershell -File D:\nadir-agents\scripts\backup.ps1
#
# To RESTORE from backup:
#   powershell -File D:\nadir-agents\scripts\restore.ps1 -BackupDate "YYYY-MM-DD_HH-mm"
# ================================
# Run this script as Administrator to register or update the schedule.

if (-not ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(`
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: Run this script as Administrator" -ForegroundColor Red
    exit 1
}

# ── Remove existing tasks if present ──────────────────────────────────────────
'NadirBackupFrequent', 'NadirBackupOnLogon' | ForEach-Object {
    Unregister-ScheduledTask -TaskName $_ -Confirm:$false -ErrorAction SilentlyContinue
}

$scriptPath = "D:\nadir-agents\scripts\backup.ps1"
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -File `"$scriptPath`""

$settings = New-ScheduledTaskSettingsSet `
    -Hidden `
    -RunOnlyIfIdle:$false `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

# ── Task A: every 2 hours ──────────────────────────────────────────────────────
$triggerFrequent = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours 2) -Once -At (Get-Date)
$triggerFrequent.Repetition.StopAtDurationEnd = $false

Register-ScheduledTask `
    -TaskName "NadirBackupFrequent" `
    -Action $action `
    -Trigger $triggerFrequent `
    -Settings $settings `
    -RunLevel Highest `
    -Description "Backs up Nadir stack (SQLite + Plane + Outline) every 2 hours" `
    -Force | Out-Null

Write-Host "[OK] Registered NadirBackupFrequent (every 2 hours)" -ForegroundColor Green

# ── Task B: at logon + 3-minute delay ─────────────────────────────────────────
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerLogon.Delay = "PT3M"

Register-ScheduledTask `
    -TaskName "NadirBackupOnLogon" `
    -Action $action `
    -Trigger $triggerLogon `
    -Settings $settings `
    -RunLevel Highest `
    -Description "Backs up Nadir stack 3 minutes after logon (lets Docker start first)" `
    -Force | Out-Null

Write-Host "[OK] Registered NadirBackupOnLogon (3 min after logon)" -ForegroundColor Green

Write-Host ""
Write-Host "Backup schedule registered:" -ForegroundColor Cyan
Write-Host "  Every 2 hours while logged in"
Write-Host "  3 minutes after each logon (allows Docker to start first)"
Write-Host ""
Write-Host "To run a manual backup now:"
Write-Host "  powershell -File D:\nadir-agents\scripts\backup.ps1"
Write-Host "To restore from a backup:"
Write-Host "  powershell -File D:\nadir-agents\scripts\restore.ps1 -BackupDate `"YYYY-MM-DD_HH-mm`""
