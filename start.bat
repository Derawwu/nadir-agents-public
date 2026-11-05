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
  echo [1/8] Podman already running - skipping.
) else (
  echo [1/8] Starting Podman...
  podman machine start 2>nul
  timeout /t 5 /nobreak >nul
)

REM Start Plane (its proxy listens on port 80)
call :is_listening 80
if %errorlevel%==0 (
  echo [2/8] Plane already running on :80 - skipping.
) else (
  echo [2/8] Starting Plane ^(issue tracker^)...
  cd /d D:\nadir-agents\plane
  docker-compose up -d
  timeout /t 5 /nobreak >nul
)

REM Start Outline
call :is_listening 3002
if %errorlevel%==0 (
  echo [3/8] Outline already running on :3002 - skipping.
) else (
  echo [3/8] Starting Outline ^(wiki^)...
  cd /d D:\nadir-agents\outline
  docker-compose up -d
  timeout /t 5 /nobreak >nul
)

REM Start Ollama (local embeddings for retrieval) before the backend, which
REM embeds new messages on startup, and pull the embedding model if missing.
REM Optional: without it retrieval falls back to keyword search, so a missing
REM install only prints a note.
call :is_listening 11434
if %errorlevel%==0 (
  echo [4/8] Ollama already running on :11434.
) else (
  call :start_ollama
)
call :ensure_embedding_model

REM Start nadir-agents backend
call :is_listening 3001
if %errorlevel%==0 (
  echo [5/8] Agent backend already running on :3001 - skipping.
) else (
  echo [5/8] Starting agent backend...
  cd /d D:\nadir-agents\backend
  start "Nadir Backend" cmd /k "npm run dev"
  timeout /t 5 /nobreak >nul
)

REM Start nadir-agents frontend
call :is_listening 5173
if %errorlevel%==0 (
  echo [6/8] Agent frontend already running on :5173 - skipping.
) else (
  echo [6/8] Starting agent frontend...
  cd /d D:\nadir-agents\frontend
  start "Nadir Frontend" cmd /k "npm run dev"
)

REM Start diagram tool backend (the main app's Diagrams tab proxies to it)
call :is_listening 3010
if %errorlevel%==0 (
  echo [7/8] Diagram backend already running on :3010 - skipping.
) else (
  echo [7/8] Starting diagram tool backend...
  cd /d D:\nadir-agents\diagram-tool\backend
  start "Diagram Backend" cmd /k "npm run dev"
)

REM Start diagram tool frontend (the editor behind "Open editor")
call :is_listening 5180
if %errorlevel%==0 (
  echo [8/8] Diagram editor already running on :5180 - skipping.
) else (
  echo [8/8] Starting diagram tool editor...
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
echo   Ollama:   http://localhost:11434
echo ================================
echo.
pause
exit /b 0

REM Finds the Ollama CLI: on PATH, else the default install location.
REM Sets OLLAMA_EXE (empty if Ollama is not installed).
:find_ollama
set "OLLAMA_EXE="
for /f "delims=" %%p in ('where ollama 2^>nul') do if not defined OLLAMA_EXE set "OLLAMA_EXE=%%p"
if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
exit /b 0

REM Starts Ollama if it is installed: the tray app from the default install
REM location, else `ollama serve`. Waits up to 15s for its port.
:start_ollama
set "OLLAMA_APP=%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
call :find_ollama
if exist "%OLLAMA_APP%" (
  echo [4/8] Starting Ollama ^(embeddings^)...
  start "" "%OLLAMA_APP%"
) else (
  if not defined OLLAMA_EXE (
    echo [4/8] Ollama not installed - skipping ^(retrieval uses keyword search only^).
    exit /b 0
  )
  echo [4/8] Starting Ollama ^(embeddings^)...
  start "Ollama" /min "%OLLAMA_EXE%" serve
)
for /L %%i in (1,1,15) do (
  call :is_listening 11434
  if not errorlevel 1 exit /b 0
  timeout /t 1 /nobreak >nul
)
echo       Ollama did not open :11434 yet - the backend will retry when it is up.
exit /b 0

REM Pulls the embedding model the backend uses (EMBEDDING_MODEL in
REM backend\.env, default qwen3-embedding:0.6b) if Ollama is up and lacks it.
:ensure_embedding_model
call :is_listening 11434
if errorlevel 1 exit /b 0
call :find_ollama
if not defined OLLAMA_EXE exit /b 0
set "EMBED_MODEL=qwen3-embedding:0.6b"
for /f "tokens=1,* delims==" %%a in ('findstr /B /C:"EMBEDDING_MODEL=" D:\nadir-agents\backend\.env 2^>nul') do set "EMBED_MODEL=%%b"
"%OLLAMA_EXE%" show "%EMBED_MODEL%" >nul 2>nul
if not errorlevel 1 (
  echo       Embedding model %EMBED_MODEL% is present.
  exit /b 0
)
echo       Pulling embedding model %EMBED_MODEL% ^(first run only^)...
"%OLLAMA_EXE%" pull "%EMBED_MODEL%"
if errorlevel 1 echo       Pull failed - retrieval uses keyword search until the model is available.
exit /b 0

REM Sets errorlevel 0 if something is listening on TCP port %1 (IPv4 or IPv6).
:is_listening
netstat -ano | findstr /R /C:":%1 .*LISTENING" >nul
exit /b %errorlevel%
