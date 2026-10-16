#!/bin/sh
cd "$(dirname "$0")"
[ -d node_modules ] || npm install || exit 1
[ -f .env ] || { cp .env.example .env; echo "Created .env - add OPENROUTER_API_KEY, then run ./start.sh again"; exit 0; }
exec node server.js
