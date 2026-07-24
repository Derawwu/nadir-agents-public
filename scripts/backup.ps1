# Nadir full-stack backup script.
# Backs up: SQLite (nadir-agents), Plane PostgreSQL, Outline PostgreSQL.
# Safe to run any time - Docker check at top; every section wrapped in try/catch.
# Exit 0 on success, 1 on any failure.

$LogFile = "D:\nadir-agents\backups\backup.log"
$BackupsRoot = "D:\nadir-agents\backups"

function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
}

# ── Ensure backups root exists ─────────────────────────────────────────────────
try {
    if (-not (Test-Path $BackupsRoot)) {
        New-Item -ItemType Directory -Force $BackupsRoot | Out-Null
    }
} catch {
    # Can't even create the backup dir - nothing we can do.
    exit 1
}

# ── Step 1: Podman/Docker health check ────────────────────────────────────────
# Use docker-compose (always available on this Podman setup) rather than
# 'docker' which may not be in PATH. Check against the Outline compose file
# since that stack is lightest and always expected to be up.
$composeAvailable = $false
try {
    $null = docker-compose -f "D:\nadir-agents\outline\docker-compose.yml" ps 2>$null
    if ($LASTEXITCODE -eq 0) {
        $composeAvailable = $true
    }
} catch {
    # docker-compose not found at all.
}

if (-not $composeAvailable) {
    Write-Log "[SKIP] Backup skipped - docker-compose not available or containers not running"
    exit 0
}

# ── Step 2: Create timestamped backup folder ───────────────────────────────────
$timestamp = Get-Date -Format 'yyyy-MM-dd_HH-mm'
$backupDir = "$BackupsRoot\$timestamp"
$anyFail = $false

try {
    New-Item -ItemType Directory -Force $backupDir | Out-Null
} catch {
    Write-Log "[FAIL] Backup failed: could not create backup folder - $_"
    exit 1
}

# ── Step 3: SQLite backup ──────────────────────────────────────────────────────
try {
    $src = "D:\nadir-agents\backend\data\nadir.db"
    $dst = "$backupDir\nadir.db"
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination $dst -Force
        Write-Log "[OK] nadir.db backed up"
    } else {
        Write-Log "[WARN] nadir.db not found at $src - skipping"
    }
} catch {
    Write-Log "[FAIL] nadir.db backup failed: $_"
    $anyFail = $true
}

# ── Step 4: Plane PostgreSQL ───────────────────────────────────────────────────
try {
    $dst = "$backupDir\plane.sql"
    docker-compose -f "D:\nadir-agents\plane\docker-compose.yml" `
        exec -T plane-db pg_dump -U plane plane > $dst 2>$null
    if ($LASTEXITCODE -eq 0 -and (Test-Path $dst) -and (Get-Item $dst).Length -gt 0) {
        Write-Log "[OK] plane.sql backed up"
    } else {
        Write-Log "[FAIL] plane.sql backup produced empty output or non-zero exit"
        $anyFail = $true
    }
} catch {
    Write-Log "[FAIL] plane.sql backup failed: $_"
    $anyFail = $true
}

# ── Step 5: Outline PostgreSQL ─────────────────────────────────────────────────
try {
    $dst = "$backupDir\outline.sql"
    docker-compose -f "D:\nadir-agents\outline\docker-compose.yml" `
        exec -T outline-postgres pg_dump -U outline outline > $dst 2>$null
    if ($LASTEXITCODE -eq 0 -and (Test-Path $dst) -and (Get-Item $dst).Length -gt 0) {
        Write-Log "[OK] outline.sql backed up"
    } else {
        Write-Log "[FAIL] outline.sql backup produced empty output or non-zero exit"
        $anyFail = $true
    }
} catch {
    Write-Log "[FAIL] outline.sql backup failed: $_"
    $anyFail = $true
}

# ── Step 6: Write manifest.json ────────────────────────────────────────────────
try {
    $files = @("nadir.db", "plane.sql", "outline.sql")
    $sizes = @{}
    foreach ($f in $files) {
        $p = "$backupDir\$f"
        if (Test-Path $p) {
            $sizes[$f] = (Get-Item $p).Length
        } else {
            $sizes[$f] = 0
        }
    }

    $manifest = [ordered]@{
        timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        files     = $files
        sizes     = $sizes
    }
    $manifest | ConvertTo-Json -Depth 3 | Set-Content -Path "$backupDir\manifest.json" -Encoding utf8
    Write-Log "[OK] manifest.json written"
} catch {
    Write-Log "[WARN] manifest.json write failed: $_"
    # Not a fatal failure - backup files still exist.
}

# ── Step 7: Retention policy ───────────────────────────────────────────────────
try {
    $cutoff = (Get-Date).AddDays(-7)

    # Get all backup subdirectories (timestamped folders only), sorted newest first.
    $allBackups = Get-ChildItem -Path $BackupsRoot -Directory |
        Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$' } |
        Sort-Object -Property LastWriteTime -Descending

    # Delete folders older than 7 days.
    foreach ($dir in $allBackups) {
        if ($dir.LastWriteTime -lt $cutoff) {
            Remove-Item -Path $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
            Write-Log "[PRUNE] Deleted old backup: $($dir.Name)"
        }
    }

    # Enforce maximum of 14 folders after age pruning.
    $remaining = Get-ChildItem -Path $BackupsRoot -Directory |
        Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$' } |
        Sort-Object -Property LastWriteTime -Descending

    if ($remaining.Count -gt 14) {
        $toDelete = $remaining | Select-Object -Skip 14
        foreach ($dir in $toDelete) {
            Remove-Item -Path $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
            Write-Log "[PRUNE] Deleted excess backup: $($dir.Name)"
        }
    }
} catch {
    Write-Log "[WARN] Retention cleanup failed: $_"
    # Non-fatal - old backups accumulate but current backup is fine.
}

# ── Step 8: Final log entry ────────────────────────────────────────────────────
if ($anyFail) {
    Write-Log "[FAIL] Backup completed with errors → $timestamp"
    exit 1
} else {
    Write-Log "[OK] Backup completed → $timestamp"
    exit 0
}
