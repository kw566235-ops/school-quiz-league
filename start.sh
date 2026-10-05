#!/usr/bin/env sh
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --omit=dev
node server.js
