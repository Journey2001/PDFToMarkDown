@echo off
setlocal

cd /d "%~dp0"
title PDFToMarkDown GUI

netstat -ano | findstr ":3210" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3210/api/config' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
  if not errorlevel 1 (
    echo [INFO] GUI is already running. Opening browser...
    start "" "http://127.0.0.1:3210/"
    exit /b 0
  )

  echo [ERROR] Port 3210 is already occupied by another process or a non-responsive service.
  echo [ERROR] Please free port 3210 and try again.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Please install Node.js 24+ and ensure node is in PATH.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Please check your Node.js installation.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] Installing npm dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [INFO] Starting GUI...
echo [INFO] If the browser does not open automatically, visit http://127.0.0.1:3210/
call npm run gui

set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo [ERROR] GUI exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
