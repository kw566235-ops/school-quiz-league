@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --omit=dev
)
start "" http://localhost:3000/admin
node server.js
pause
