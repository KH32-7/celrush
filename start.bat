@echo off
rem Double-click to play CEL RUSH. Needs Node.js (https://nodejs.org).
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing packages...
  call npm install
)
echo Starting CEL RUSH... the browser opens by itself. Close this window to stop the game server.
call npx vite --open
