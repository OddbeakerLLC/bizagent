#!/usr/bin/env bash
# bizagent control-plane installer
# Run from the bizagent hub directory after cloning:
#   bash install/install.sh
set -euo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[32m'; BLUE=$'\033[34m'; NC=$'\033[0m'
step() { printf "\n${BOLD}${BLUE}==>${NC} ${BOLD}%s${NC}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${NC} %s\n" "$1"; }
note() { printf "  %s\n" "$1"; }
warn() { printf "  ! %s\n" "$1"; }

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

# --- 1. LLM provider (runtime is always bizagent-agent) ---
step "Default LLM"
PROVIDER="${BIZAGENT_PROVIDER:-grok}"
case "$PROVIDER" in
  grok|chatgpt|claude|gemini|venice|ollama) ;;
  xai) PROVIDER="grok" ;;
  openai|codex) PROVIDER="chatgpt" ;;
  agy) PROVIDER="gemini" ;;
  *) note "Unknown BIZAGENT_PROVIDER=$PROVIDER — using grok"; PROVIDER="grok" ;;
esac
# Default model per provider (overridable via BIZAGENT_MODEL)
default_model_for() {
  case "$1" in
    grok) echo "grok-4.5" ;;
    chatgpt) echo "gpt-4o" ;;
    claude) echo "claude-sonnet-4-6" ;;
    gemini) echo "gemini-2.5-flash" ;;
    venice) echo "llama-3.3-70b" ;;
    ollama) echo "llama3.2" ;;
    *) echo "" ;;
  esac
}
MODEL="${BIZAGENT_MODEL:-$(default_model_for "$PROVIDER")}"
ok "provider=$PROVIDER model=$MODEL (runtime=bizagent-agent)"

if [[ ! -f "$HUB/cli.json" && -f "$HUB/cli.json.example" ]]; then
  cp "$HUB/cli.json.example" "$HUB/cli.json"
  ok "cli.json seeded from example"
fi

if [[ ! -f "$HUB/registry.json" && -f "$HUB/registry.example.json" ]]; then
  python3 - "$HUB/registry.example.json" "$HUB/registry.json" "$PROVIDER" "$MODEL" <<'PY' 2>/dev/null || cp "$HUB/registry.example.json" "$HUB/registry.json"
import json, sys
src, dest, provider, model = sys.argv[1:5]
d = json.load(open(src))
d["org"] = ""
d["products"] = []
d["cross_product_edges"] = []
if "hub" in d and isinstance(d["hub"], dict):
    d["hub"]["name"] = "BizAgent"
ha = d.setdefault("settings", {}).setdefault("hub_agent", {})
ha["provider"] = provider
ha["cliName"] = provider
if model:
    ha["model"] = model
json.dump(d, open(dest, "w"), indent=2)
open(dest, "a").write("\n")
PY
  ok "registry.json seeded (provider=$PROVIDER model=$MODEL)"
else
  python3 - "$HUB/registry.json" "$PROVIDER" "$MODEL" <<'PY' 2>/dev/null || true
import json, sys
path, provider, model = sys.argv[1:4]
d = json.load(open(path))
ha = d.setdefault("settings", {}).setdefault("hub_agent", {})
if not (ha.get("provider") or ha.get("cliName") or ha.get("cli")):
    ha["provider"] = provider
    ha["cliName"] = provider
if not (ha.get("model") or "").strip() and model:
    ha["model"] = model
json.dump(d, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
  ok "registry.json hub_agent provider/model ensured"
fi

# --- 1b. API key → .bizagent/env (required for hub turns) ---
api_key_var_for_provider() {
  case "$1" in
    grok|xai) echo "XAI_API_KEY" ;;
    chatgpt|openai|codex) echo "OPENAI_API_KEY" ;;
    claude) echo "ANTHROPIC_API_KEY" ;;
    gemini|agy) echo "GEMINI_API_KEY" ;;
    venice) echo "VENICE_API_KEY" ;;
    ollama) echo "OLLAMA_API_KEY" ;;
    *) echo "XAI_API_KEY" ;;
  esac
}
# Provider → OpenAI-compatible endpoint + a cheap model for the hello check.
provider_hello_endpoint() {
  case "$1" in
    grok|xai)        echo "https://api.x.ai/v1|grok-4.3" ;;
    chatgpt|openai|codex) echo "https://api.openai.com/v1|gpt-5.4-mini" ;;
    claude)          echo "https://api.anthropic.com/v1/|claude-haiku-4-5-20251001" ;;
    openrouter)      echo "https://openrouter.ai/api/v1|anthropic/claude-sonnet-4" ;;
    gemini|agy)      echo "https://generativelanguage.googleapis.com/v1beta/openai/|gemini-2.5-flash-lite" ;;
    venice)          echo "https://api.venice.ai/api/v1|deepseek-v4-flash-0731" ;;
    ollama)          echo "http://127.0.0.1:11434/v1|llama3.2" ;;
    *)               echo "" ;;
  esac
}

# Send a tiny 'hello' prompt to the LLM to confirm the API key works before
# proceeding. Returns 0 on success, 1 on failure. Skips (returns 0) when the
# provider endpoint is unknown or curl is unavailable — never blocks install.
validate_api_key() {
  local provider="$1" key="$2"
  local ep base model code
  ep="$(provider_hello_endpoint "$provider")"
  [[ -z "$ep" ]] && return 0
  base="${ep%%|*}"; model="${ep#*|}"
  base="${base%/}"
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not found — skipping API key validation"
    return 0
  fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "$base/chat/completions" \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}],\"max_tokens\":1}" 2>/dev/null)"
  [[ "$code" == "200" ]]
}

API_KEY_VAR="$(api_key_var_for_provider "$PROVIDER")"
mkdir -p "$HUB/.bizagent"
if [[ ! -f "$HUB/.bizagent/env.example" && -f "$HUB/cli.json.example" ]]; then
  : # env.example may already exist from clone
fi
if [[ -n "${BIZAGENT_API_KEY:-}" && -n "$API_KEY_VAR" ]]; then
  # Merge or create
  if [[ -f "$HUB/.bizagent/env" ]] && grep -q "^${API_KEY_VAR}=" "$HUB/.bizagent/env" 2>/dev/null; then
    grep -v "^${API_KEY_VAR}=" "$HUB/.bizagent/env" > "$HUB/.bizagent/env.tmp" || true
    printf '%s=%s\n' "$API_KEY_VAR" "$BIZAGENT_API_KEY" >> "$HUB/.bizagent/env.tmp"
    mv "$HUB/.bizagent/env.tmp" "$HUB/.bizagent/env"
  else
    printf '%s=%s\n' "$API_KEY_VAR" "$BIZAGENT_API_KEY" >> "$HUB/.bizagent/env"
  fi
  chmod 600 "$HUB/.bizagent/env"
  ok ".bizagent/env updated ($API_KEY_VAR from BIZAGENT_API_KEY)"
  if ! validate_api_key "$PROVIDER" "$BIZAGENT_API_KEY"; then
    warn "BIZAGENT_API_KEY was rejected by the provider — installation may fail until it is corrected."
  fi
elif [[ -n "$API_KEY_VAR" ]]; then
  existing_val="${!API_KEY_VAR:-}"
  if [[ -z "$existing_val" && -f "$HUB/.bizagent/env" ]]; then
    # shellcheck disable=SC1091
    set -a; source "$HUB/.bizagent/env" 2>/dev/null || true; set +a
    existing_val="${!API_KEY_VAR:-}"
  fi
  if [[ -n "$existing_val" ]]; then
    if [[ ! -f "$HUB/.bizagent/env" ]] || ! grep -q "^${API_KEY_VAR}=" "$HUB/.bizagent/env" 2>/dev/null; then
      read -r -p "  $API_KEY_VAR is available. Save to .bizagent/env? [Y/n]: " save_key </dev/tty
      save_key="${save_key:-Y}"
      if [[ "$save_key" =~ ^[Yy] ]]; then
        printf '%s=%s\n' "$API_KEY_VAR" "$existing_val" >> "$HUB/.bizagent/env"
        chmod 600 "$HUB/.bizagent/env"
        ok ".bizagent/env written ($API_KEY_VAR)"
      fi
    else
      ok ".bizagent/env already has $API_KEY_VAR"
    fi
  else
    printf "\nHub turns need %s in .bizagent/env (first-run will not work without it).\n" "$API_KEY_VAR"
    printf "  ! An incorrectly entered API key will prevent completing the installation.\n"
    typed_key=""
    while true; do
      read -r -s -p "  $API_KEY_VAR (required, hidden): " typed_key </dev/tty
      printf "\n"
      if [[ -z "$typed_key" ]]; then
        printf "  ! API key is required — an empty or incorrect key will prevent completing the installation. Please enter it.\n"
        continue
      fi
      if validate_api_key "$PROVIDER" "$typed_key"; then
        break
      fi
      printf "  ! That API key was rejected by the provider. Please re-enter it.\n"
      typed_key=""
    done
    printf '%s=%s\n' "$API_KEY_VAR" "$typed_key" >> "$HUB/.bizagent/env"
    chmod 600 "$HUB/.bizagent/env"
    ok ".bizagent/env written ($API_KEY_VAR, validated)"
  fi
fi

# --- 2. npm install (control-plane + agent-runtime) ---
step "Dependencies"
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is required." >&2; exit 1; }
if [[ -f "$CP_DIR/package.json" ]]; then
  (cd "$CP_DIR" && npm install --silent) && ok "control-plane npm install complete"
elif [[ -f "$HUB/package.json" ]]; then
  (cd "$HUB" && npm install --silent) && ok "hub npm install complete"
fi
if [[ -f "$HUB/agent-runtime/package.json" ]]; then
  (cd "$HUB/agent-runtime" && npm install --silent) && ok "agent-runtime npm install complete"
  chmod +x "$HUB/scripts/bizagent-agent" "$HUB/agent-runtime/bin/bizagent-agent" 2>/dev/null || true
fi

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

# --- 6. Pre-flight + first-run inbox seed ---
step "First-run readiness"
READY=0
if [[ -x "$HUB/scripts/check-hub-ready.sh" ]]; then
  if bash "$HUB/scripts/check-hub-ready.sh" "$HUB"; then
    READY=1
  else
    printf "  ! Hub is not ready to run turns (see above). Fix provider/model/API key, then re-check:\n"
    note "  bash scripts/check-hub-ready.sh"
  fi
else
  note "check-hub-ready.sh missing — skipping pre-flight"
  READY=1
fi

mkdir -p "$HUB/inbox"
TODAY="$(date -u +%Y-%m-%d)"
SEED_FILE="$HUB/inbox/${TODAY}-install-first-run.md"
# Glob-guard: skip if any prior-date seed already exists (prevents duplicate on same-day re-run).
_EXISTING=$(ls "$HUB/inbox/"*"-install-first-run.md" 2>/dev/null | head -1)
if [ -z "$_EXISTING" ]; then
  if [[ "$READY" -eq 1 ]]; then
    printf '---\nfrom: installer\nto: hub\ndate: %s\nsubject: first-run setup\n---\n\nA new bizagent installation just completed. Welcome the operator in the web UI, interview them about their organization and products (gather → build → distribute), write registry.json and agent dirs as needed, and report when setup is done.\n\nPrerequisites are already checked: bizagent-agent runtime, hub provider/model, and API key in .bizagent/env.\n' \
      "$TODAY" > "$SEED_FILE"
    ok "first-run message queued (hub is ready to execute it)"
  else
    printf '---\nfrom: installer\nto: hub\ndate: %s\nsubject: first-run setup blocked\n---\n\nInstallation finished but the hub was NOT ready to launch (missing provider, model, API key, or agent-runtime deps). Do not run product onboarding until the operator fixes that.\n\nOperator: run `bash scripts/check-hub-ready.sh`, fix any ✗ items, restart control plane, then send a console message: "Run first-run setup / interview me and onboard my products."\n' \
      "$TODAY" > "$SEED_FILE"
    printf "  ! first-run seed written as BLOCKED (will not usefully execute until ready)\n"
  fi
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
