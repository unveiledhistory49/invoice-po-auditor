#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/pdf-service.pid"
LOG_FILE="$SCRIPT_DIR/pdf-service.log"
PYTHON_BIN="$SCRIPT_DIR/.venv/bin/python"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "pdf-service already running (PID $(cat "$PID_FILE"))"
  exit 0
fi

setsid "$PYTHON_BIN" "$SCRIPT_DIR/server.py" > "$LOG_FILE" 2>&1 < /dev/null &
echo $! > "$PID_FILE"

for _ in $(seq 1 20); do
  if curl -s -f "http://127.0.0.1:${PDF_SERVICE_PORT:-5681}/health" > /dev/null; then
    echo "pdf-service started (PID $(cat "$PID_FILE"))"
    exit 0
  fi
  sleep 0.25
done

echo "pdf-service failed to become healthy" >&2
exit 1
