@echo off
setlocal
chcp 65001 >nul
title Gakja Answer - Start Server
cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Install Node.js 22 or newer, then try again.
  pause
  exit /b 1
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js, then try again.
  pause
  exit /b 1
)
if not exist ".env" (
  echo [ERROR] The project .env file is missing.
  pause
  exit /b 1
)

if not exist "node_modules\pg\package.json" goto install
if not exist "node_modules\dotenv\package.json" goto install
if not exist "node_modules\.bin\next.cmd" goto install
goto launch

:install
echo Installing project dependencies...
call npm.cmd ci
if errorlevel 1 (
  echo [ERROR] Dependency installation failed.
  pause
  exit /b 1
)

:launch
node.exe "scripts\start-server.mjs" %*
if errorlevel 1 (
  pause
  exit /b 1
)
exit /b 0
