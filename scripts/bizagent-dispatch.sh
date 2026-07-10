#!/usr/bin/env bash
# Compatibility wrapper. Dispatch is implemented by the Node control plane.
set -u
HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "bizagent-dispatch.sh: Node.js is required; run install.sh or install node, then retry." >&2
  exit 127
fi
exec node "$HUB/scripts/bizagent-control-plane.js" dispatch-once --hub "$HUB"
