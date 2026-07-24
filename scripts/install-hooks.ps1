# Installs the tracked git hooks (scripts/hooks/*) into .git/hooks/.
# .git/hooks/ is never version-controlled, so this needs to be re-run after
# cloning this repo fresh, or whenever a file under scripts/hooks/ changes.

$RepoRoot = Split-Path -Parent $PSScriptRoot
$HooksSrc = Join-Path $RepoRoot "scripts\hooks"
$HooksDst = Join-Path $RepoRoot ".git\hooks"

if (-not (Test-Path $HooksDst)) {
    Write-Error "No .git\hooks directory found at $HooksDst - is $RepoRoot a git repo?"
    exit 1
}

Get-ChildItem -Path $HooksSrc -File | ForEach-Object {
    $dest = Join-Path $HooksDst $_.Name
    Copy-Item -Path $_.FullName -Destination $dest -Force
    Write-Host "Installed $($_.Name) -> $dest"
}

Write-Host "Done."
