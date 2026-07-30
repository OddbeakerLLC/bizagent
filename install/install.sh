#!/usr/bin/env bash
# bizagent control-plane installer
# Run from the bizagent hub directory after cloning:
#   bash install/install.sh
set -euo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[32m'; BLUE=$'\033[34m'; NC=$'\033[0m'
step() { printf "\n${BOLD}${BLUE}==>${NC} ${BOLD}%s${NC}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${NC} %s\n" "$1"; }
note() { printf "  %s\n" "$1"; }

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

_cli_key="$(basename "$CLI_CMD")"
_cli_key="${_cli_key%.exe}"
cli_prompt_flag() {
  case "$(basename "$1")" in
    grok) echo "--prompt-file" ;;
    codex) echo "--prompt" ;;
    *) echo "-p" ;;
  esac
}
cli_extra_args() {
  case "$(basename "$1")" in
    grok) echo "--always-approve" ;;
    claude|agy) echo "--dangerously-skip-permissions" ;;
    codex) echo "--full-auto" ;;
    *) echo "" ;;
  esac
}
CLI_PROMPT_FLAG="$(cli_prompt_flag "$CLI_CMD")"
CLI_EXTRA_ARGS="$(cli_extra_args "$CLI_CMD")"

# cli.json = engine catalog; registry hub_agent.cliName = which engine the hub uses.
# Legacy .cli is not written (migration-only if already present).
if [[ ! -f "$HUB/cli.json" && -f "$HUB/cli.json.example" ]]; then
  cp "$HUB/cli.json.example" "$HUB/cli.json"
  ok "cli.json seeded from example"
fi
if [[ -f "$HUB/cli.json" ]]; then
  python3 - "$HUB/cli.json" "$_cli_key" "$CLI_CMD" "$CLI_PROMPT_FLAG" "$CLI_EXTRA_ARGS" <<'PY' 2>/dev/null || true
import json, sys
path, key, exe, pflag, extra = sys.argv[1:6]
try:
    d = json.load(open(path))
except Exception:
    d = {}
if not isinstance(d, dict):
    d = {}
if key not in d or not isinstance(d.get(key), dict):
    d[key] = {
        "executable": exe or key,
        "promptFlag": pflag or "-p",
        "flags": {"extra": extra or ""},
    }
    json.dump(d, open(path, "w"), indent=2)
    open(path, "a").write("\n")
PY
  ok "cli.json has entry for '$_cli_key'"
fi

if [[ ! -f "$HUB/registry.json" && -f "$HUB/registry.example.json" ]]; then
  python3 - "$HUB/registry.example.json" "$HUB/registry.json" "$_cli_key" <<'PY' 2>/dev/null || cp "$HUB/registry.example.json" "$HUB/registry.json"
import json, sys
src, dest, cli_name = sys.argv[1:4]
d = json.load(open(src))
d["org"] = ""
d["products"] = []
d["cross_product_edges"] = []
if "hub" in d and isinstance(d["hub"], dict):
    d["hub"]["name"] = "BizAgent"
d.setdefault("settings", {}).setdefault("hub_agent", {})["cliName"] = cli_name
json.dump(d, open(dest, "w"), indent=2)
open(dest, "a").write("\n")
PY
  ok "registry.json seeded (hub_agent.cliName=$_cli_key)"
else
  python3 - "$HUB/registry.json" "$_cli_key" <<'PY' 2>/dev/null || true
import json, sys
path, cli_name = sys.argv[1:3]
d = json.load(open(path))
ha = d.setdefault("settings", {}).setdefault("hub_agent", {})
if not (ha.get("cliName") or ha.get("cli")):
    ha["cliName"] = cli_name
    json.dump(d, open(path, "w"), indent=2)
    open(path, "a").write("\n")
PY
  ok "registry.json hub_agent.cliName ensured"
fi
if [[ -f "$HUB/.cli" ]]; then
  note "legacy .cli present — ignored for flags; hub CLI name is registry hub_agent.cliName"
fi

# --- 1b. API key → .bizagent/env (required for hub turns) ---
api_key_var_for_cli() {
  case "$1" in
    claude) echo "ANTHROPIC_API_KEY" ;;
    grok)   echo "XAI_API_KEY" ;;
    codex)  echo "OPENAI_API_KEY" ;;
    *)      echo "" ;;
  esac
}
API_KEY_VAR="$(api_key_var_for_cli "$(basename "$CLI_CMD")")"
mkdir -p "$HUB/.bizagent"
if [[ -n "${BIZAGENT_API_KEY:-}" && -n "$API_KEY_VAR" ]]; then
  printf '%s=%s\n' "$API_KEY_VAR" "$BIZAGENT_API_KEY" > "$HUB/.bizagent/env"
  chmod 600 "$HUB/.bizagent/env"
  ok ".bizagent/env written ($API_KEY_VAR from BIZAGENT_API_KEY)"
elif [[ -n "$API_KEY_VAR" ]]; then
  existing_val=""
  if [[ -n "${!API_KEY_VAR:-}" ]]; then
    existing_val="${!API_KEY_VAR}"
  fi
  if [[ -n "$existing_val" ]]; then
    read -r -p "  $API_KEY_VAR is set in this shell. Save to .bizagent/env? [Y/n]: " save_key </dev/tty
    save_key="${save_key:-Y}"
    if [[ "$save_key" =~ ^[Yy] ]]; then
      printf '%s=%s\n' "$API_KEY_VAR" "$existing_val" > "$HUB/.bizagent/env"
      chmod 600 "$HUB/.bizagent/env"
      ok ".bizagent/env written ($API_KEY_VAR)"
    fi
  else
    printf "\nHub turns need %s in .bizagent/env.\n" "$API_KEY_VAR"
    read -r -s -p "  $API_KEY_VAR (hidden, Enter to skip): " typed_key </dev/tty
    printf "\n"
    if [[ -n "$typed_key" ]]; then
      printf '%s=%s\n' "$API_KEY_VAR" "$typed_key" > "$HUB/.bizagent/env"
      chmod 600 "$HUB/.bizagent/env"
      ok ".bizagent/env written ($API_KEY_VAR)"
    else
      printf "  ! Skipped — add .bizagent/env before expecting hub replies.\n"
    fi
  fi
fi

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
  _ips=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+
 | grep -v '^127\.' | head -3)
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

# --- 8. CLI setup completion instructions ---
printf "\n${BOLD}${GREEN}=== CLI Setup Complete ===${NC}\n\n"
printf "Next steps:\n\n"
printf "1. Add your API key to ~/bizagent/.bizagent/env:\n"
if [[ -n "$API_KEY_VAR" ]]; then
  printf "   echo '%s=your_api_key_here' >> ~/bizagent/.bizagent/env\n" "$API_KEY_VAR"
else
  printf "   echo 'ANTHROPIC_API_KEY=your_api_key_here' >> ~/bizagent/.bizagent/env\n"
  printf "   (or XAI_API_KEY, OPENAI_API_KEY, VENICE_API_KEY depending on your CLI)\n"
fi
printf "\n"
printf "2. Set the default model for %s in your shell profile:\n" "$CLI_CMD"
case "$_cli_key" in
  claude)
    printf "   # Claude uses ANTHROPIC_API_KEY; no additional model flag needed\n" ;;
  grok)
    printf "   # Grok uses XAI_API_KEY; no additional model flag needed\n" ;;
  codex)
    printf "   # Codex uses OPENAI_API_KEY; no additional model flag needed\n" ;;
  agy)
    printf "   # Agy uses ANTHROPIC_API_KEY; no additional model flag needed\n" ;;
  venice)
    printf "   export VENICE_AI_MODEL=kimi-k2-7-code  # or your preferred model\n" ;;
  *)
    printf "   # Check your CLI's documentation for model configuration\n" ;;
esac
printf "\n"
printf "3. Launch the browser to begin onboarding and adding projects:\n"
printf "   http://localhost:%s\n\n" "$PORT"
