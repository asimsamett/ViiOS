@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.13 or later from https://nodejs.org then retry.
  pause
  exit /b 1
)
if not exist "node_modules\vinext" goto setup
if not exist "dist\client\index.html" goto setup
goto start
:setup
node scripts\setup.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
:start
call npm start
pause
