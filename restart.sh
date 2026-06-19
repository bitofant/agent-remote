#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

SERVICE=agent-remote
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${SERVICE}.service"

./rebuild.sh

# Production: systemctl restart is atomic (stop+start). Fall back to the
# pidfile dance only if the service isn't installed.
if [ -f "$UNIT" ]; then
  systemctl --user restart "$SERVICE"
  echo "agent-remote restarted (systemctl --user restart $SERVICE)"
else
  ./stop.sh
  ./start.sh
fi
