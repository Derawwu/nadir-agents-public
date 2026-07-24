# Nadir stack restore script.
# Usage: powershell -File D:\nadir-agents\scripts\restore.ps1 -BackupDate "2026-06-05_14-30"
#        powershell -File D:\nadir-agents\scripts\restore.ps1 -BackupDate "2026-06-05_14-30" -Target sqlite

param(
    [Parameter(Mandatory = $true)]
    [string]$BackupDate,

    [ValidateSet('all', 'sqlite', 'plane', 'outline')]
    [string]$Target = 'all'
)

$BackupsRoot = "D:\nadir-agents\backups"
$backupDir   = "$BackupsRoot\$BackupDate"

# ── Validate backup folder ─────────────────────────────────────────────────────
if (-not (Test-Path $backupDir)) {
    Write-Host "ERROR: Backup folder not found: $backupDir" -ForegroundColor Red
    Write-Host "Available backups:" -ForegroundColor Yellow
    Get-ChildItem -Path $BackupsRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$' } |
        Sort-Object Name -Descending |
        ForEach-Object { Write-Host "  $($_.Name)" }
    exit 1
}

# ── Validate manifest ──────────────────────────────────────────────────────────
$manifestPath = "$backupDir\manifest.json"
if (-not (Test-Path $manifestPath)) {
    Write-Host "ERROR: manifest.json not found in $backupDir - backup may be corrupt" -ForegroundColor Red
    exit 1
}

$manifest = Get-Content $manifestPath | ConvertFrom-Json

# ── Print restore plan ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Nadir Restore" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Backup date : $BackupDate"
Write-Host "  Taken at    : $($manifest.timestamp)"
Write-Host "  Target      : $Target"
Write-Host ""

if ($Target -eq 'all' -or $Target -eq 'sqlite') {
    $sz = if ($manifest.sizes.PSObject.Properties['nadir.db']) { "$($manifest.sizes.'nadir.db') bytes" } else { "unknown" }
    Write-Host "  [sqlite]  nadir.db -> D:\nadir-agents\backend\data\nadir.db  ($sz)"
}
if ($Target -eq 'all' -or $Target -eq 'plane') {
    $sz = if ($manifest.sizes.PSObject.Properties['plane.sql']) { "$($manifest.sizes.'plane.sql') bytes" } else { "unknown" }
    Write-Host "  [plane]   plane.sql -> Plane PostgreSQL  ($sz)"
}
if ($Target -eq 'all' -or $Target -eq 'outline') {
    $sz = if ($manifest.sizes.PSObject.Properties['outline.sql']) { "$($manifest.sizes.'outline.sql') bytes" } else { "unknown" }
    Write-Host "  [outline] outline.sql -> Outline PostgreSQL  ($sz)"
}

Write-Host ""
Write-Host "WARNING: This will OVERWRITE current data." -ForegroundColor Yellow
Write-Host ""

# ── Confirmation prompt ────────────────────────────────────────────────────────
$confirm = Read-Host "Type YES to confirm"
if ($confirm -cne 'YES') {
    Write-Host "Restore cancelled." -ForegroundColor Gray
    exit 0
}

Write-Host ""
$anyFail = $false

# ── Restore SQLite ─────────────────────────────────────────────────────────────
if ($Target -eq 'all' -or $Target -eq 'sqlite') {
    try {
        $src = "$backupDir\nadir.db"
        $dst = "D:\nadir-agents\backend\data\nadir.db"
        if (-not (Test-Path $src)) {
            throw "Source file not found: $src"
        }
        $dstDir = Split-Path $dst -Parent
        if (-not (Test-Path $dstDir)) {
            New-Item -ItemType Directory -Force $dstDir | Out-Null
        }
        Copy-Item -Path $src -Destination $dst -Force
        Write-Host "[OK] sqlite: nadir.db restored" -ForegroundColor Green
    } catch {
        Write-Host "[FAIL] sqlite restore failed: $_" -ForegroundColor Red
        $anyFail = $true
    }
}

# ── Restore Plane ──────────────────────────────────────────────────────────────
if ($Target -eq 'all' -or $Target -eq 'plane') {
    try {
        $src = "$backupDir\plane.sql"
        if (-not (Test-Path $src)) {
            throw "Source file not found: $src"
        }
        Get-Content $src | docker-compose -f "D:\nadir-agents\plane\docker-compose.yml" `
            exec -T plane-db psql -U plane plane
        if ($LASTEXITCODE -ne 0) {
            throw "psql exited with code $LASTEXITCODE"
        }
        Write-Host "[OK] plane: PostgreSQL restored" -ForegroundColor Green
    } catch {
        Write-Host "[FAIL] plane restore failed: $_" -ForegroundColor Red
        $anyFail = $true
    }
}

# ── Restore Outline ────────────────────────────────────────────────────────────
if ($Target -eq 'all' -or $Target -eq 'outline') {
    try {
        $src = "$backupDir\outline.sql"
        if (-not (Test-Path $src)) {
            throw "Source file not found: $src"
        }
        Get-Content $src | docker-compose -f "D:\nadir-agents\outline\docker-compose.yml" `
            exec -T outline-postgres psql -U outline outline
        if ($LASTEXITCODE -ne 0) {
            throw "psql exited with code $LASTEXITCODE"
        }
        Write-Host "[OK] outline: PostgreSQL restored" -ForegroundColor Green
    } catch {
        Write-Host "[FAIL] outline restore failed: $_" -ForegroundColor Red
        $anyFail = $true
    }
}

Write-Host ""
if ($anyFail) {
    Write-Host "Restore completed with ERRORS - check output above." -ForegroundColor Red
    exit 1
} else {
    Write-Host "Restore completed successfully." -ForegroundColor Green
    exit 0
}
