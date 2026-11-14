#!/usr/bin/env bash
# wsl-cp-autostart.sh — non-blocking control-plane starter for WSL shell open.
# Called from ~/.bashrc / ~/.zshrc / ~/.profile (installed by install/install.sh).
# Quiet, fast, idempotent. Exits 0 immediately if the control plane is already up.

# Resolve HUB from this script's location (scripts/ → parent = hub root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB="${BIZAGENT_HUB:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# --- Already running? (port check, then process check) ---
# Read the configured port (default 8787).
PORT=8787
if [ -f "$HUB/registry.json" ]; then
  _p=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('settings',{}).get('control_plane',{}).get('port',8787))" "$HUB/registry.json" 2>/dev/null) || true
  [ -n "${_p:-}" ] && PORT="$_p"
fi
# Env override wins.
[ -n "${BIZAGENT_PORT:-}" ] && PORT="$BIZAGENT_PORT"

# Quick port probe (1s timeout, no output).
if command -v curl >/dev/null 2>&1; then
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    exit 0
  fi
fi
# Fallback: process check.
if pgrep -f "control-plane/server\.js" >/dev/null 2>&1; then
  exit 0
fi

# --- Start in background (non-blocking) ---
mkdir -p "$HUB/logs" 2>/dev/null
nohup bash "$HUB/scripts/control-plane.sh" start "$HUB" >> "$HUB/logs/control-plane-server.log" 2>&1 &
disown 2>/dev/null || true
exit 0
