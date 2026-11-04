@echo off
setlocal
echo ================================
echo   Nadir Dev Stack Launcher
echo ================================
echo.

REM Show last backup status
echo Last backup:
powershell -Command "Get-Content D:\nadir-agents\backups\backup.log -Tail 1 -ErrorAction SilentlyContinue"
echo.

REM Every step checks whether its service is already up and skips it if so,
REM so this script is safe to re-run while part of the stack is running.

REM Start Podman machine
podman machine inspect --format "{{.State}}" 2>nul | findstr /I "running" >nul
if %errorlevel%==0 (
  echo [1/7] Podman already running - skipping.
) else (
  echo [1/7] Starting Podman...
  podman machine start 2>nul
  timeout /t 5 /nobreak >nul
)

REM Start Plane (its proxy listens on port 80)
call :is_listening 80
if %errorlevel%==0 (
  echo [2/7] Plane already running on :80 - skipping.
) else (
  echo [2/7] Starting Plane ^(issue tracker^)...
  cd /d D:\nadir-agents\plane
  docker-compose up -d
  timeout /t 5 /nobreak >nul
)

REM Start Outline
call :is_listening 3002
if %errorlevel%==0 (
  echo [3/7] Outline already running on :3002 - skipping.
) else (
  echo [3/7] Starting Outline ^(wiki^)...
  cd /d D:\nadir-agents\outline
  docker-compose up -d
  timeout /t 5 /nobreak >nul
)

REM Start nadir-agents backend
call :is_listening 3001
if %errorlevel%==0 (
  echo [4/7] Agent backend already running on :3001 - skipping.
) else (
  echo [4/7] Starting agent backend...
  cd /d D:\nadir-agents\backend
  start "Nadir Backend" cmd /k "npm run dev"
  timeout /t 5 /nobreak >nul
)

REM Start nadir-agents frontend
call :is_listening 5173
if %errorlevel%==0 (
  echo [5/7] Agent frontend already running on :5173 - skipping.
) else (
  echo [5/7] Starting agent frontend...
  cd /d D:\nadir-agents\frontend
  start "Nadir Frontend" cmd /k "npm run dev"
)

REM Start diagram tool backend (the main app's Diagrams tab proxies to it)
call :is_listening 3010
if %errorlevel%==0 (
  echo [6/7] Diagram backend already running on :3010 - skipping.
) else (
  echo [6/7] Starting diagram tool backend...
  cd /d D:\nadir-agents\diagram-tool\backend
  start "Diagram Backend" cmd /k "npm run dev"
)

REM Start diagram tool frontend (the editor behind "Open editor")
call :is_listening 5180
if %errorlevel%==0 (
  echo [7/7] Diagram editor already running on :5180 - skipping.
) else (
  echo [7/7] Starting diagram tool editor...
  cd /d D:\nadir-agents\diagram-tool\frontend
  start "Diagram Editor" cmd /k "npm run dev"
)

echo.
echo ================================
echo   Stack is up!
echo   Agents:   http://localhost:5173
echo   Plane:    http://localhost
echo   Outline:  http://localhost:3002
echo   Diagrams: http://localhost:5180
echo ================================
echo.
pause
exit /b 0

REM Sets errorlevel 0 if something is listening on TCP port %1 (IPv4 or IPv6).
:is_listening
netstat -ano | findstr /R /C:":%1 .*LISTENING" >nul
exit /b %errorlevel%
