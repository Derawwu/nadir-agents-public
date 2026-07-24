@echo off
echo ================================
echo   Nadir Dev Stack Launcher
echo ================================
echo.

REM Show last backup status
echo Last backup:
powershell -Command "Get-Content D:\nadir-agents\backups\backup.log -Tail 1 -ErrorAction SilentlyContinue"
echo.

REM Start Podman machine
echo [1/5] Starting Podman...
podman machine start 2>nul
timeout /t 5 /nobreak >nul

REM Start Plane
echo [2/5] Starting Plane (issue tracker)...
cd /d D:\nadir-agents\plane
docker-compose up -d
timeout /t 5 /nobreak >nul

REM Start Outline
echo [3/5] Starting Outline (wiki)...
cd /d D:\nadir-agents\outline
docker-compose up -d
timeout /t 5 /nobreak >nul

REM Start nadir-agents backend
echo [4/5] Starting agent backend...
cd /d D:\nadir-agents\backend
start "Nadir Backend" cmd /k "npm run dev"
timeout /t 5 /nobreak >nul

REM Start nadir-agents frontend
echo [5/5] Starting agent frontend...
cd /d D:\nadir-agents\frontend
start "Nadir Frontend" cmd /k "npm run dev"

echo.
echo ================================
echo   Stack is up!
echo   Agents:  http://localhost:5173
echo   Plane:   http://localhost
echo   Outline: http://localhost:3002
echo ================================
echo.
pause
