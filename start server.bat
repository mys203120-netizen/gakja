@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install an LTS version from https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0scripts\start-local.mjs" --reset-ports %*
set "serverExit=%errorlevel%"
if not "%serverExit%"=="0" (
  echo.
  echo Server startup failed. Please read the error above.
)
echo.
echo Server stopped. Press any key to close this window.
pause >nul
endlocal & exit /b %serverExit%
