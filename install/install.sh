#!/usr/bin/env bash
# bizagent control-plane installer
# Run from the bizagent hub directory after cloning:
#   bash install/install.sh
set -euo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[32m'; BLUE=$'\033[34m'; NC=$'\033[0m'
step() { printf "\n${BOLD}${BLUE}==>${NC} ${BOLD}%s${NC}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${NC} %s\n" "$1"; }

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CP_DIR="$HUB/control-plane"
SERVER="$CP_DIR/server.js"

[ -f "$SERVER" ] || { echo "ERROR: $SERVER not found — run from the bizagent hub root." >&2; exit 1; }

registry_port() {
  python3 - "$HUB/registry.json" <<'PY' 2>/dev/null || echo "8787"
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('settings', {}).get('control_plane', {}).get('port', 8787))
except Exception:
    print(8787)
PY
}
PORT="$(registry_port)"

# --- 1. Which Claude CLI? ---
step "AI CLI"
DEFAULT_CLI="claude"
printf "\nWhich Claude CLI command is installed on this machine?\n"
printf "  [1] claude  (default)\n"
printf "  [2] Enter a custom path\n\n"
read -r -p "Choice [1]: " choice </dev/tty
choice="${choice:-1}"
if [ "$choice" = "2" ]; then
  read -r -p "  Custom CLI path: " CLI_CMD </dev/tty
  CLI_CMD="${CLI_CMD:-$DEFAULT_CLI}"
else
  CLI_CMD="$DEFAULT_CLI"
fi
ok "CLI: $CLI_CMD"

# Write CLI choice to .cli so the control-plane picks it up at runtime.
cat > "$HUB/.cli" <<EOF
CLI_CMD=$CLI_CMD
CLI_PROMPT_FLAG=-p
CLI_EXTRA_ARGS=--dangerously-skip-permissions
EOF
ok ".cli written"

# --- 2. npm install ---
step "Dependencies"
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is required." >&2; exit 1; }
(cd "$CP_DIR" && npm install --silent)
ok "npm install complete"

# --- 3. Cron or systemd ---
step "Service"
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-system-running 2>/dev/null | grep -qE '^(running|degraded)$'; then
  bash "$HUB/scripts/install-control-plane.sh"
  ok "systemd service installed"
else
  CRON_CMD="*/6 * * * * node $SERVER $HUB >> $HUB/logs/control-plane-server.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v "$SERVER"; echo "$CRON_CMD" ) | crontab -
  mkdir -p "$HUB/logs"
  ok "cron entry installed"
fi

# --- 4. Start the control plane ---
step "Starting"
bash "$HUB/scripts/control-plane.sh" start "$HUB"

# --- 5. Drop first-run-setup inbox message ---
mkdir -p "$HUB/inbox"
TODAY="$(date -u +%Y-%m-%d)"
MSG_FILE="$HUB/inbox/${TODAY}-installer-first-run-setup.md"
if [ ! -f "$MSG_FILE" ]; then
  cat > "$MSG_FILE" <<FRONTMATTER
---
from: installer
to: hub
date: $TODAY
subject: first-run-setup
---

New installation detected. Please greet the operator and guide them through
initial setup: company name, repo discovery, and adding their first product
agent.
FRONTMATTER
  ok "first-run-setup message queued"
fi

# --- 6. Open browser ---
sleep 1
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:$PORT" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "http://localhost:$PORT"
fi

printf "\nBizAgent is running. Opening http://localhost:%s …\n" "$PORT"
