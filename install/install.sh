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
fail() { printf "  ✗ %s\n" "$1"; }
die()  { printf "\n✗ %s\n\n" "$1" >&2; exit 1; }

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
if [[ -n "${BIZAGENT_PROVIDER:-}" ]]; then
  # Non-interactive: respect the env override.
  PROVIDER="${BIZAGENT_PROVIDER}"
  case "$PROVIDER" in
    grok|chatgpt|claude|gemini|venice|ollama) ;;
    xai) PROVIDER="grok" ;;
    openai|codex) PROVIDER="chatgpt" ;;
    agy) PROVIDER="gemini" ;;
    *) die "Unknown BIZAGENT_PROVIDER=$PROVIDER — valid values: grok, chatgpt, claude, gemini, venice, ollama (aliases: xai, openai, codex, agy)." ;;
  esac
else
  # Interactive: let the user pick a provider (default grok).
  printf "\nChoose an LLM provider for the hub:\n"
  printf "  1) grok\n  2) chatgpt\n  3) claude\n  4) gemini\n  5) venice\n  6) ollama\n"
  read -r -p "  Select provider [1-6, default 1 (grok)]: " _provider_choice </dev/tty
  case "${_provider_choice:-1}" in
    2|chatgpt) PROVIDER="chatgpt" ;;
    3|claude)  PROVIDER="claude" ;;
    4|gemini)  PROVIDER="gemini" ;;
    5|venice)  PROVIDER="venice" ;;
    6|ollama)  PROVIDER="ollama" ;;
    *)         PROVIDER="grok" ;;
  esac
fi
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
  if ! python3 - "$HUB/registry.example.json" "$HUB/registry.json" "$PROVIDER" "$MODEL" <<'PY'
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
  then
    if cp "$HUB/registry.example.json" "$HUB/registry.json" 2>/dev/null; then
      fail "REGISTRY SEED DEGRADED: python seed failed — registry.json is a full example copy (example products/settings included). Inspect $HUB/registry.json and remove the example entries before adding real products."
    else
      die "Could not seed registry.json (python seed failed and registry.example.json could not be copied). Place a writable registry.json at $HUB/registry.json and re-run."
    fi
  else
    ok "registry.json seeded (provider=$PROVIDER model=$MODEL)"
  fi
else
  if ! python3 - "$HUB/registry.json" "$PROVIDER" "$MODEL" <<'PY'
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
  then
    warn "could not set hub_agent provider/model on existing registry.json — check it manually (install continues)"
  else
    ok "registry.json hub_agent provider/model ensured"
  fi
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
if [[ "$PROVIDER" == "ollama" ]]; then
  # Keyless provider (local Ollama) — no API key required; the runtime falls back.
  ok "Ollama is local and needs no API key — skipping key setup"
elif [[ -n "${BIZAGENT_API_KEY:-}" && -n "$API_KEY_VAR" ]]; then
  if ! validate_api_key "$PROVIDER" "$BIZAGENT_API_KEY"; then
    die "BIZAGENT_API_KEY was rejected by $PROVIDER (provider hello-check failed). Nothing was written to .bizagent/env — fix the key and re-run."
  fi
  # Merge or create
  if [[ -f "$HUB/.bizagent/env" ]] && grep -q "^${API_KEY_VAR}=" "$HUB/.bizagent/env" 2>/dev/null; then
    grep -v "^${API_KEY_VAR}=" "$HUB/.bizagent/env" > "$HUB/.bizagent/env.tmp" || true
    printf '%s=%s\n' "$API_KEY_VAR" "$BIZAGENT_API_KEY" >> "$HUB/.bizagent/env.tmp"
    mv "$HUB/.bizagent/env.tmp" "$HUB/.bizagent/env"
  else
    printf '%s=%s\n' "$API_KEY_VAR" "$BIZAGENT_API_KEY" >> "$HUB/.bizagent/env"
  fi
  chmod 600 "$HUB/.bizagent/env"
  ok ".bizagent/env updated ($API_KEY_VAR from BIZAGENT_API_KEY, validated)"
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

# --- 1c. llmapi URL -> .bizagent/env (live dispatch routes through the API) ---
# llmapi listens on 8788 by default (8787 is the control plane's default);
# LLMAPI_PORT in .bizagent/env overrides both the service and this URL.
if [[ -f "$HUB/llmapi.js" ]]; then
  LLMAPI_URL_PORT="${LLMAPI_PORT:-8788}"
  mkdir -p "$HUB/.bizagent"
  touch "$HUB/.bizagent/env"
  if ! grep -qE '^BIZAGENT_LLMAPI_URL=' "$HUB/.bizagent/env" 2>/dev/null; then
    printf 'BIZAGENT_LLMAPI_URL=http://127.0.0.1:%s\n' "$LLMAPI_URL_PORT" >> "$HUB/.bizagent/env"
    chmod 600 "$HUB/.bizagent/env" 2>/dev/null || true
    ok ".bizagent/env: BIZAGENT_LLMAPI_URL written (dispatch routes through llmapi)"
  else
    ok ".bizagent/env already has BIZAGENT_LLMAPI_URL"
  fi
fi

# --- 2. npm install (control-plane + agent-runtime) ---
step "Dependencies"
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is required." >&2; exit 1; }
if [[ -f "$CP_DIR/package.json" ]]; then
  (cd "$CP_DIR" && npm install --silent) && ok "control-plane npm install complete" \
    || die "control-plane npm install failed (hard dependency). Re-run it manually, then re-run: cd $CP_DIR && npm install"
elif [[ -f "$HUB/package.json" ]]; then
  (cd "$HUB" && npm install --silent) && ok "hub npm install complete" \
    || die "hub npm install failed (hard dependency). Re-run it manually, then re-run: cd $HUB && npm install"
fi
if [[ -f "$HUB/agent-runtime/package.json" ]]; then
  (cd "$HUB/agent-runtime" && npm install --silent) && ok "agent-runtime npm install complete" \
    || die "agent-runtime npm install failed (hard dependency). Re-run it manually, then re-run: cd $HUB/agent-runtime && npm install"
  chmod +x "$HUB/scripts/bizagent-agent" "$HUB/agent-runtime/bin/bizagent-agent" 2>/dev/null || true
fi

# --- 3. Cron or systemd ---
step "Service"
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-system-running 2>/dev/null | grep -qE '^(running|degraded)$'; then
  bash "$HUB/scripts/install-control-plane.sh"
  ok "systemd service installed"
  if [[ -f "$HUB/scripts/install-llmapi.sh" && -f "$HUB/llmapi.js" ]]; then
    if bash "$HUB/scripts/install-llmapi.sh"; then
      ok "llmapi systemd service installed"
    else
      warn "llmapi service unit could not be installed (start/stop still manage it as a process)"
    fi
  fi
else
  CRON_CMD="*/6 * * * * node $SERVER $HUB >> $HUB/logs/control-plane-server.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v "$SERVER"; echo "$CRON_CMD" ) | crontab -
  mkdir -p "$HUB/logs"
  ok "cron entry installed"
  if [[ -f "$HUB/llmapi.js" ]] && command -v node >/dev/null 2>&1; then
    LLMAPI_CRON_CMD="*/6 * * * * node $HUB/llmapi.js >> $HUB/logs/llmapi.log 2>&1"
    ( crontab -l 2>/dev/null | grep -v "$HUB/llmapi.js"; echo "$LLMAPI_CRON_CMD" ) | crontab -
    ok "llmapi cron entry installed (exits cleanly when already running)"
  fi
fi

# --- 3b. Health watchdog (out-of-process probe timer / cron fallback) ---
if [[ -n "${BIZAGENT_SKIP_HEALTH_TIMER:-}" ]]; then
  note "skipping health probe timer (BIZAGENT_SKIP_HEALTH_TIMER)"
elif [[ -f "$HUB/scripts/install-health-timer.sh" ]]; then
  if bash "$HUB/scripts/install-health-timer.sh" "$HUB"; then
    ok "health probe timer installed and enabled"
  else
    warn "could not enable the health probe timer automatically (no systemd user session?)"
    note "Enable it with one command:"
    note "  bash $HUB/scripts/install-health-timer.sh $HUB"
  fi
else
  warn "scripts/install-health-timer.sh missing — out-of-process health probe not installed"
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
  if ! python3 - "$HUB/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
d.setdefault('settings', {}).setdefault('control_plane', {})['host'] = '0.0.0.0'
json.dump(d, open(path, 'w'), indent=2)
open(path, 'a').write('\n')
PY
  then
    warn "could not set control_plane.host=0.0.0.0 on registry.json — the console may only be reachable from localhost on this headless host"
  else
    ok "registry: host set to 0.0.0.0 for headless install"
  fi
fi

# --- 5. Start the control plane ---
step "Starting"
cp_start_rc=0
bash "$HUB/scripts/control-plane.sh" start "$HUB" || cp_start_rc=$?
PORT="${BIZAGENT_PORT:-$PORT}"

note "Waiting for port $PORT..."
_i=0
while (( _i < 10 )); do
  if (echo >/dev/tcp/localhost/"$PORT") 2>/dev/null; then
    break
  fi
  sleep 1
  _i=$(( _i + 1 ))
done

if ! (echo >/dev/tcp/localhost/"$PORT") 2>/dev/null; then
  warn "Control plane did not respond on port $PORT within 10s — install did not finish cleanly."
  if [[ -f "$HUB/logs/control-plane-server.log" ]]; then
    note "Last log lines ($HUB/logs/control-plane-server.log):"
    tail -n 15 "$HUB/logs/control-plane-server.log" 2>/dev/null | sed 's/^/    | /' || true
  fi
  note "Fix the issue above and re-run, or start manually: bash $HUB/scripts/control-plane.sh start $HUB"
  exit 1
fi
ok "control plane answering on port $PORT"

# llmapi probe: with BIZAGENT_LLMAPI_URL configured every agent LLM call
# routes through llmapi — a dead llmapi must not pass as a healthy install.
LLMAPI_URL_CFG=""
if [[ -f "$HUB/.bizagent/env" ]]; then
  LLMAPI_URL_CFG="$(grep -E '^BIZAGENT_LLMAPI_URL=' "$HUB/.bizagent/env" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"\t\r\n ' || true)"
fi
if [[ -n "$LLMAPI_URL_CFG" ]] && command -v curl >/dev/null 2>&1; then
  LLMAPI_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${LLMAPI_URL_CFG%/}/health" 2>/dev/null || echo 0)"
  if [[ "$LLMAPI_CODE" != "200" ]]; then
    warn "llmapi not reachable at ${LLMAPI_URL_CFG%/}/health (HTTP ${LLMAPI_CODE:-no answer}) — agent LLM calls will fail (502 llmapi unreachable)."
    if [[ -f "$HUB/logs/llmapi.log" ]]; then
      note "Last log lines ($HUB/logs/llmapi.log):"
      tail -n 10 "$HUB/logs/llmapi.log" 2>/dev/null | sed 's/^/    | /' || true
    fi
    note "Start it: bash $HUB/scripts/llmapi.sh start $HUB · log: $HUB/logs/llmapi.log"
    exit 1
  fi
  ok "llmapi answering at ${LLMAPI_URL_CFG%/}/health"
fi

# --- 6. Pre-flight + first-run inbox seed (shared with root install.sh) ---
step "First-run readiness"
if [[ -x "$HUB/scripts/seed-first-run.sh" ]]; then
  bash "$HUB/scripts/seed-first-run.sh" "$HUB" || true
else
  warn "scripts/seed-first-run.sh missing — no first-run welcome seed"
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
