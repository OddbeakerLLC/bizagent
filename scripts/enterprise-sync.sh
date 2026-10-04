#!/usr/bin/env bash
# enterprise-sync.sh
#
# Push this hub's company/ tree to the connected Enterprise Server.
# Called automatically from nightly.sh while connected; safe to run manually.
# No-op (exit 0) when the hub is not connected.
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HUB"

CONN="$HUB/.bizagent/enterprise-server.json"
if [ ! -f "$CONN" ]; then
  echo "enterprise-sync: not connected, skipping"
  exit 0
fi

CONNECTED="$(python3 -c '
import json
try:
    c = json.load(open("'"$CONN"'"))
    print("1" if c.get("connected") else "0")
except Exception:
    print("0")
' 2>/dev/null || echo 0)"
if [ "$CONNECTED" != "1" ]; then
  echo "enterprise-sync: connection disabled, skipping"
  exit 0
fi

echo "enterprise-sync: pushing company/ to the enterprise server..."
node "$HUB/scripts/enterprise-sync.js"
