#!/usr/bin/env bash
set -euo pipefail
# Start the Demo 1 Telegram approval poller (long-polls getUpdates, forwards
# approval replies to the n8n responder webhook). The bot token is decrypted
# in-memory from n8n's credential store; it is never written to a file.
POLLER_DIR="$HOME/workspace/n8n/telegram-poller"
LOG_FILE="$POLLER_DIR/poller.log"
PID_FILE="$POLLER_DIR/poller.pid"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "telegram poller already running (PID $(cat "$PID_FILE"))"
  exit 0
fi
setsid node "$POLLER_DIR/poller.js" >> "$LOG_FILE" 2>&1 < /dev/null &
echo $! > "$PID_FILE"
echo "telegram poller starting (PID $!)"
