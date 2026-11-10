@echo off
setlocal
echo ================================
echo   Nadir Dev Stack Shutdown
echo ================================
echo.

REM Stops what start.bat starts, in reverse order. Each step skips a service
REM that is not running, so it is safe to run at any time. Nothing is removed:
REM containers are stopped (not "down"), so Plane and Outline keep their data
REM and start again quickly.

set "STOP_PORT=powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-port.ps1""

echo [1/6] Diagram tool...
%STOP_PORT% -Port 5180 -Name "Diagram editor"
%STOP_PORT% -Port 3010 -Name "Diagram backend"

echo [2/6] Agent app...
%STOP_PORT% -Port 5173 -Name "Agent frontend"
%STOP_PORT% -Port 3001 -Name "Agent backend"

echo [3/6] Ollama...
call :stop_ollama

REM The containers need the Podman machine, so only touch them while it runs.
podman machine inspect --format "{{.State}}" 2>nul | findstr /I "running" >nul
if errorlevel 1 (
  echo [4/6] Outline - Podman not running, skipping.
  echo [5/6] Plane - Podman not running, skipping.
  echo [6/6] Podman already stopped.
  goto :done
)

echo [4/6] Stopping Outline ^(wiki^)...
cd /d "%~dp0outline"
docker-compose stop

echo [5/6] Stopping Plane ^(issue tracker^)...
cd /d "%~dp0plane"
docker-compose stop

echo [6/6] Stopping Podman machine...
podman machine stop

:done
echo.
echo ================================
echo   Stack is down. Run start.bat to bring it back.
echo ================================
echo.
pause
exit /b 0

REM Stops the Ollama server and, if it is open, the Ollama desktop app (which
REM would otherwise restart the server).
:stop_ollama
set "OLLAMA_FOUND="
tasklist /FI "IMAGENAME eq ollama app.exe" 2>nul | find /I "ollama app.exe" >nul && set "OLLAMA_FOUND=1"
tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | find /I "ollama.exe" >nul && set "OLLAMA_FOUND=1"
if not defined OLLAMA_FOUND (
  echo       Ollama not running.
  exit /b 0
)
taskkill /F /T /IM "ollama app.exe" >nul 2>nul
taskkill /F /T /IM "ollama.exe" >nul 2>nul
echo       Stopped Ollama.
exit /b 0
