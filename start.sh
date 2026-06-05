#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PIDFILE=agent-remote.pid
LOGFILE=agent-remote.log

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "agent-remote is already running (pid $(cat "$PIDFILE"))"
  exit 1
fi

# Run the server directly via tsx (single node process for a clean pid). Serves
# the prebuilt dist/web, so run ./rebuild.sh first.
CMD="node --import tsx server/index.ts"
if [ "${1:-}" = "dev" ]; then
  CMD="./node_modules/.bin/tsx watch server/index.ts --dev"
fi

nohup $CMD >> "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"
echo "agent-remote started (pid $!, log: $LOGFILE)$([ "${1:-}" = "dev" ] && echo " in dev mode")"
