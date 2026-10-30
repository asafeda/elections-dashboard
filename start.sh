#!/bin/sh
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8000}"
echo "Dashboard: http://localhost:$PORT  (Ctrl+C to stop)"
(sleep 1 && open "http://localhost:$PORT" 2>/dev/null) &
exec python3 -m http.server "$PORT"
