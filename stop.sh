#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PIDFILE=agent-remote.pid

if [ ! -f "$PIDFILE" ]; then
  echo "agent-remote is not running (no pidfile)"
  exit 0
fi

PID=$(cat "$PIDFILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "agent-remote stopped (pid $PID)"
else
  echo "agent-remote was not running (stale pidfile)"
fi
rm -f "$PIDFILE"
