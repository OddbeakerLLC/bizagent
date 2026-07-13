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
CLI_CMD="$CLI_CMD"
CLI_PROMPT_FLAG="-p"
CLI_EXTRA_ARGS="--dangerously-skip-permissions"
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

# --- 4. Detect headless and patch registry if needed ---
_is_headless=0
if [[ "$(uname -s)" == "Linux" ]]; then
  if grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null; then
    _is_headless=0
  elif [[ -z "${DISPLAY:-}" ]] && [[ -z "${WAYLAND_DISPLAY:-}" ]]; then
    _is_headless=1
  fi
fi

if [[ "$_is_headless" -eq 1 ]]; then
  python3 - "$HUB/registry.json" <<'PY' 2>/dev/null || true
import json, sys
path = sys.argv[1]
try:
    d = json.load(open(path))
    d.setdefault('settings', {}).setdefault('control_plane', {})['host'] = '0.0.0.0'
    json.dump(d, open(path, 'w'), indent=2)
except Exception:
    pass
PY
  ok "registry: host set to 0.0.0.0 for headless install"
fi

# --- 5. Start the control plane ---
step "Starting"
bash "$HUB/scripts/control-plane.sh" start "$HUB"

# --- 6. Drop first-run inbox seed ---
mkdir -p "$HUB/inbox"
TODAY="$(date -u +%Y-%m-%d)"
SEED_FILE="$HUB/inbox/${TODAY}-install-first-run.md"
# Glob-guard: skip if any prior-date seed already exists (prevents duplicate on same-day re-run).
_EXISTING=$(ls "$HUB/inbox/"*"-install-first-run.md" 2>/dev/null | head -1)
if [ -z "$_EXISTING" ]; then
  printf '---\nfrom: installer\nto: hub\ndate: %s\nsubject: first-run setup\n---\n\nA new bizagent installation just completed. Welcome the user, interview them about their products and projects, then set up the full system.\n' \
    "$TODAY" > "$SEED_FILE"
  ok "first-run message queued"
fi

# --- 7. Open browser ---
sleep 1

if [[ "$_is_headless" -eq 1 ]]; then
  _ips=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | head -3)
  if [[ -n "$_ips" ]]; then
    printf "\n${BOLD}Open one of these URLs in your browser to set up BizAgent:${NC}\n\n"
    while IFS= read -r ip; do
      printf "  ${BOLD}http://%s:%s${NC}\n" "$ip" "$PORT"
    done <<< "$_ips"
    printf "\n"
  else
    printf "\n${BOLD}Open this URL in your browser to set up BizAgent:${NC}\n\n"
    printf "  ${BOLD}http://localhost:%s${NC} (or replace 'localhost' with this machine's IP)\n\n" "$PORT"
  fi
else
  printf "\nBizAgent is running. Opening http://localhost:%s …\n" "$PORT"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:$PORT" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then
    open "http://localhost:$PORT"
  fi
fi
