@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (
  echo Installing dependencies...
  python -m venv .venv
  call .venv\Scripts\pip install -r requirements.txt
)
start "" http://localhost:8000/admin
.venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
pause
