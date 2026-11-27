#!/usr/bin/env bash
set -euo pipefail
# Start the Demo 1 Telegram approval poller (long-polls getUpdates, forwards
# approval replies to the n8n responder webhook). The bot token is decrypted
# in-memory from n8n's credential store; it is never written to a file.
POLLER_DIR="${POLLER_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
LOG_FILE="$POLLER_DIR/poller.log"
PID_FILE="$POLLER_DIR/poller.pid"
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE")"
  if kill -0 "$OLD_PID" 2>/dev/null && tr '\0' ' ' < "/proc/$OLD_PID/cmdline" 2>/dev/null | grep -q "poller.js"; then
    echo "telegram poller already running (PID $OLD_PID)"
    exit 0
  fi
  echo "stale poller pid file (PID $OLD_PID not poller.js) — removing"
  rm -f "$PID_FILE"
fi
setsid node "$POLLER_DIR/poller.js" >> "$LOG_FILE" 2>&1 < /dev/null &
echo $! > "$PID_FILE"
echo "telegram poller starting (PID $!)"
