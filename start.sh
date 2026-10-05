#!/usr/bin/env sh
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -r requirements.txt; }
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
