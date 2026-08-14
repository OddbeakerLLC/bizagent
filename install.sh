#!/usr/bin/env bash
# bizagent installer — macOS, Linux, and WSL on Windows.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/OddbeakerLLC/bizagent/main/install.sh | bash
#
# Installs git, python3, cron, and Claude Code; clones bizagent;
# starts the BizAgent control plane and opens the web UI.
#
# Env vars (optional):
#   BIZAGENT_DIR=/path/to/clone    Override the default install dir (./bizagent)
#   BIZAGENT_SOURCE=/path/or/url    Override the source repo (local path, file:// URL, or git URL)
#   BIZAGENT_REINSTALL=1           Wipe an existing clone and reinstall from scratch
#   BIZAGENT_API_KEY=...           Non-interactive: write this as the selected CLI's API key
#                                  into INSTALL_DIR/.bizagent/env (preferred over prompting)

set -euo pipefail

# --- presentation ---
BOLD=$'\033[1m'; DIM=$'\033[2m'
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'
NC=$'\033[0m'

step() { printf "\n${BOLD}${BLUE}==>${NC} ${BOLD}%s${NC}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${NC} %s\n" "$1"; }
note() { printf "  ${DIM}%s${NC}\n" "$1"; }
warn() { printf "  ${YELLOW}!${NC} %s\n" "$1"; }
die()  { printf "\n${RED}✗ %s${NC}\n\n" "$1" >&2; exit 1; }

banner() {
  cat <<'EOF'

  ┌─────────────────────────────────────┐
  │          bizagent installer         │
  │                                     │
  │   Your Products Team Lead,          │
  │   ready in about two minutes.       │
  └─────────────────────────────────────┘

EOF
}

# --- platform + package manager ---
detect_platform() {
  case "$(uname -s)" in
    Darwin) PLATFORM="macos" ;;
    Linux)
      if grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null; then
        PLATFORM="wsl"
      else
        PLATFORM="linux"
      fi
      ;;
    *) die "Unsupported OS: $(uname -s). bizagent runs on macOS, Linux, or WSL on Windows." ;;
  esac
  ok "platform: $PLATFORM"
}

detect_pkg_manager() {
  if [[ "$PLATFORM" == "macos" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      warn "Homebrew not found — installing it (this takes a few minutes)..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      # Make brew available in this shell (Apple Silicon vs Intel paths differ).
      if   [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"
      elif [[ -x /usr/local/bin/brew     ]]; then eval "$(/usr/local/bin/brew shellenv)"
      fi
    fi
    PKG="brew";  INSTALL="brew install"
  else
    if   command -v apt-get >/dev/null 2>&1; then PKG="apt";    INSTALL="sudo apt-get install -y"
    elif command -v dnf     >/dev/null 2>&1; then PKG="dnf";    INSTALL="sudo dnf install -y"
    elif command -v pacman  >/dev/null 2>&1; then PKG="pacman"; INSTALL="sudo pacman -S --noconfirm"
    elif command -v zypper  >/dev/null 2>&1; then PKG="zypper"; INSTALL="sudo zypper install -y"
    else die "No supported package manager found (need apt, dnf, pacman, or zypper)."
    fi
    [[ "$PKG" == "apt" ]] && sudo apt-get update -qq
  fi
  ok "package manager: $PKG"
}

# --- dependency helpers ---
have() { command -v "$1" >/dev/null 2>&1; }

ensure() {
  local cmd="$1" pkg="${2:-$1}"
  if have "$cmd"; then
    ok "$cmd present"
  else
    note "installing $pkg..."
    local install_exit=0
    eval "$INSTALL $pkg" || install_exit=$?
    if [[ $install_exit -ne 0 ]]; then
      die "Failed to install $pkg (exit $install_exit). Check that you have permission to install packages and try again."
    fi
    if ! have "$cmd"; then
      die "'$cmd' still not found after installing $pkg. Open a new terminal and re-run this installer."
    fi
    ok "$cmd installed"
  fi
}

ensure_cron() {
  if have crontab; then
    ok "cron present"
  else
    case "$PKG" in
      brew)              ok "cron present" ;;   # macOS ships cron
      apt)               $INSTALL cron ;;
      dnf|pacman|zypper) $INSTALL cronie ;;
    esac
  fi
  if [[ "$PLATFORM" == "wsl" ]]; then
    warn "WSL doesn't auto-start cron. After install, start it with:  sudo service cron start"
    note "To make it persist across WSL restarts, see:"
    note "  https://learn.microsoft.com/en-us/windows/wsl/tutorials/wsl-systemd"
  fi
}

# --- AI CLI detection and selection ---
# Format: "binary|display_name|prompt_flag|install_method|install_target|yolo_flag"
#   install_method: "curl" or "npm"
#   install_target: URL (curl) or package name (npm)
#   yolo_flag: the CLI-specific flag for autonomous/unattended operation (no prompts)
#              Empty string means the flag is unknown; operator must set CLI_EXTRA_ARGS manually.
KNOWN_CLIS=(
  "claude|Claude Code (Anthropic)|-p|curl|https://claude.ai/install.sh|--dangerously-skip-permissions"
  "agy|Antigravity CLI (Google)|-p|curl|https://antigravity.google/cli/install.sh|--dangerously-skip-permissions"
  "codex|Codex CLI (OpenAI)|exec|curl|https://chatgpt.com/codex/install.sh|--full-auto"
  # Grok: -p/--single is prompt *text*; hub turns pass a file path → must use --prompt-file.
  # --always-approve is required so the agent can write reserved-body / run write-message.
  "grok|Grok CLI (xAI)|--prompt-file|curl|https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh|--always-approve"
)

SELECTED_CLI=""
SELECTED_PROMPT_FLAG=""
SELECTED_YOLO_FLAG=""
SELECTED_API_KEY_VAR=""
SELECTED_API_KEY=""

ensure_npm() {
  if have npm; then return; fi
  note "npm not found — installing Node.js..."
  case "$PKG" in
    brew)   brew install node ;;
    apt)    $INSTALL nodejs npm ;;
    dnf)    $INSTALL nodejs npm ;;
    pacman) $INSTALL nodejs npm ;;
    zypper) $INSTALL nodejs npm ;;
  esac
  if ! have npm; then
    die "Node.js was installed but 'npm' still isn't on PATH. Open a new terminal and re-run this installer."
  fi
  ok "npm ready"
}

ensure_node() {
  if have node; then
    ok "node present"
    return
  fi
  note "node not found — installing Node.js..."
  case "$PKG" in
    brew)   brew install node ;;
    apt)    $INSTALL nodejs npm ;;
    dnf)    $INSTALL nodejs npm ;;
    pacman) $INSTALL nodejs npm ;;
    zypper) $INSTALL nodejs npm ;;
  esac
  if ! have node; then
    die "Node.js was installed but 'node' still is not on PATH. Open a new terminal and re-run this installer."
  fi
  ok "node installed"
}

validate_source() {
  local source="$1"
  case "$source" in
    ''|'-'*)
      die "BIZAGENT_SOURCE must be a local path, file:// URL, http(s) URL, ssh:// URL, or scp-style git URL."
      ;;
    file://*|https://*|http://*|ssh://*)
      return
      ;;
    *://*)
      die "Unsupported BIZAGENT_SOURCE URL scheme. Use file://, https://, http://, ssh://, a local path, or scp-style git URL."
      ;;
    *@*:*)
      return
      ;;
  esac
  if [[ -e "$source" ]]; then
    return
  fi
  die "BIZAGENT_SOURCE local path does not exist: $source"
}

install_cli() {
  local bin="$1" method="$2" target="$3"
  have "$bin" && return
  note "installing $bin..."
  local install_failed=0

  case "$method" in
    curl)
      # Capture curl-piped-bash failures explicitly.
      if ! curl -fsSL "$target" | bash; then
        die "Failed to download or run the $bin installer from $target. Check your network connection and try again."
      fi
      for p in "$HOME/.local/bin" "$HOME/.claude/bin" "$HOME/.grok/bin"; do
        [[ -d "$p" ]] && export PATH="$p:$PATH"
      done
      ;;
    npm)
      ensure_npm
      # Try a global install first; fall back to a user-writable prefix on EACCES.
      local npm_out npm_exit
      npm_out=$(npm install -g "$target" 2>&1)
      npm_exit=$?
      if [[ $npm_exit -ne 0 ]]; then
        if echo "$npm_out" | grep -qiE "EACCES|permission denied"; then
          warn "Global npm install failed (permission denied). Retrying with --prefix=\$HOME/.npm-global ..."
          local npm_global="$HOME/.npm-global"
          mkdir -p "$npm_global"
          if npm install -g --prefix "$npm_global" "$target" 2>&1; then
            export PATH="$npm_global/bin:$PATH"
            note "Installed to $npm_global/bin — add this to your shell profile to make it permanent:"
            note "  export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
          else
            install_failed=1
            die "Failed to install $bin even with --prefix=$npm_global.\nTry adding npm-global to your PATH:\n  export PATH=\"\$HOME/.npm-global/bin:\$PATH\"\nOr use sudo: sudo npm install -g $target"
          fi
        else
          install_failed=1
          printf "%s\n" "$npm_out" >&2
          die "Failed to install $bin via npm. If you see an EACCES error above, try:\n  npm install -g --prefix=\$HOME/.npm-global $target\nThen add to your shell profile:\n  export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
        fi
      fi
      ;;
  esac
  hash -r 2>/dev/null || true
  if ! have "$bin"; then
    if [[ $install_failed -eq 1 ]]; then
      die "Installation of $bin failed. See error messages above for details."
    else
      die "$bin was installed but not found on PATH. Try opening a new terminal and re-running this installer, or manually add the install directory to your PATH."
    fi
  fi
  ok "$bin installed"
}

# Default LLM provider for new hubs (bizagent-agent is always the runtime).
# Override with BIZAGENT_PROVIDER=openai|venice|openrouter|grok
select_default_provider() {
  SELECTED_PROVIDER="${BIZAGENT_PROVIDER:-grok}"
  case "$SELECTED_PROVIDER" in
    grok|chatgpt|claude|gemini|venice|ollama) ;;
    xai) SELECTED_PROVIDER="grok" ;;
    openai|codex) SELECTED_PROVIDER="chatgpt" ;;
    openrouter) SELECTED_PROVIDER="claude" ;;
    agy) SELECTED_PROVIDER="gemini" ;;
    *)
      warn "Unknown BIZAGENT_PROVIDER=$SELECTED_PROVIDER — using grok"
      SELECTED_PROVIDER="grok"
      ;;
  esac
  # Legacy vars still set for older install paths that reference SELECTED_CLI
  SELECTED_CLI="bizagent-agent"
  SELECTED_PROMPT_FLAG="-f"
  SELECTED_YOLO_FLAG="-y"
  ok "LLM runtime: bizagent-agent · default provider: $SELECTED_PROVIDER"
}

# Map provider → primary API key env var for .bizagent/env
api_key_var_for_cli() {
  case "$1" in
    grok|xai) echo "XAI_API_KEY" ;;
    chatgpt|openai|codex) echo "OPENAI_API_KEY" ;;
    claude) echo "ANTHROPIC_API_KEY" ;;
    openrouter) echo "OPENROUTER_API_KEY" ;;
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
  if ! have curl; then
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

prompt_api_key() {
  SELECTED_API_KEY_VAR="$(api_key_var_for_cli "${SELECTED_PROVIDER:-grok}")"
  SELECTED_API_KEY=""

  # Non-interactive / CI: BIZAGENT_API_KEY wins when set.
  if [[ -n "${BIZAGENT_API_KEY:-}" ]]; then
    if [[ -z "$SELECTED_API_KEY_VAR" ]]; then
      SELECTED_API_KEY_VAR="XAI_API_KEY"
    fi
    SELECTED_API_KEY="$BIZAGENT_API_KEY"
    ok "Using BIZAGENT_API_KEY for $SELECTED_API_KEY_VAR (will write .bizagent/env)"
    if ! validate_api_key "$SELECTED_PROVIDER" "$SELECTED_API_KEY"; then
      warn "BIZAGENT_API_KEY was rejected by the provider — installation may fail until it is corrected."
    fi
    return
  fi

  if [[ -z "$SELECTED_API_KEY_VAR" ]]; then
    note "No standard API-key variable — put keys in $INSTALL_DIR/.bizagent/env later."
    return
  fi

  # Already present in the installer shell (e.g. headless export before curl|bash).
  local existing="${!SELECTED_API_KEY_VAR:-}"
  if [[ -n "$existing" ]]; then
    local save
    read -r -p "  $SELECTED_API_KEY_VAR is set in this shell. Save it to .bizagent/env for the hub? [Y/n]: " save </dev/tty
    save="${save:-Y}"
    if [[ "$save" =~ ^[Yy] ]]; then
      SELECTED_API_KEY="$existing"
      ok "Will write $SELECTED_API_KEY_VAR to .bizagent/env"
    else
      note "Leaving .bizagent/env without $SELECTED_API_KEY_VAR (hub must inherit the key another way)."
    fi
    return
  fi

  printf "\n${BOLD}API key for provider %s${NC}\n" "${SELECTED_PROVIDER:-grok}"
  warn "An incorrectly entered API key will prevent completing the installation."
  note "Hub turns need $SELECTED_API_KEY_VAR in .bizagent/env (sourced by control-plane + hub-daemon)."
  note "Paste the key (input hidden). It is required — installation cannot finish without it."
  local key=""
  # -r: raw; -s: silent. Read from /dev/tty so curl|bash still works.
  # Loop until a non-empty key that passes a live 'hello' check is entered
  # (required for the hub to run turns — keeps the install error-free).
  while true; do
    read -r -s -p "  $SELECTED_API_KEY_VAR (required): " key </dev/tty
    printf "\n"
    if [[ -z "$key" ]]; then
      warn "API key is required — an empty or incorrect key will prevent completing the installation. Please enter it."
      continue
    fi
    if validate_api_key "$SELECTED_PROVIDER" "$key"; then
      break
    fi
    warn "That API key was rejected by the provider. Please re-enter it."
    key=""
  done
  SELECTED_API_KEY="$key"
  ok "$SELECTED_API_KEY_VAR validated and will be written to .bizagent/env (mode 600)"
}

# Seed cli.json (LLM provider catalog + fixed _runtime). Runtime is always bizagent-agent.
write_cli_json() {
  local dest="$INSTALL_DIR/cli.json"
  local src="$INSTALL_DIR/cli.json.example"
  local provider="${SELECTED_PROVIDER:-grok}"

  if [[ ! -f "$dest" ]]; then
    if [[ -f "$src" ]]; then
      cp "$src" "$dest"
      ok "cli.json seeded from example (provider catalog)"
    else
      cat > "$dest" <<'EOF'
{
  "_runtime": {
    "executable": "scripts/bizagent-agent",
    "promptFlag": "-f",
    "flags": { "extra": "-y" }
  },
  "grok": {
    "label": "Grok (xAI)",
    "baseURL": "https://api.x.ai/v1",
    "keyEnv": "XAI_API_KEY",
    "models": ["grok-4.5"]
  },
  "openai": {
    "label": "OpenAI",
    "baseURL": "https://api.openai.com/v1",
    "keyEnv": "OPENAI_API_KEY",
    "models": ["gpt-4o"]
  },
  "venice": {
    "label": "Venice",
    "baseURL": "https://api.venice.ai/api/v1",
    "keyEnv": "VENICE_API_KEY",
    "models": ["llama-3.3-70b"]
  }
}
EOF
      ok "cli.json written (built-in provider catalog)"
    fi
  fi

  if ! python3 - "$dest" "$provider" <<'PY'
import json, sys
path, provider = sys.argv[1:3]
try:
    d = json.load(open(path))
except Exception:
    d = {}
if not isinstance(d, dict):
    d = {}
if "_runtime" not in d or not isinstance(d.get("_runtime"), dict):
    d["_runtime"] = {
        "executable": "scripts/bizagent-agent",
        "promptFlag": "-f",
        "flags": {"extra": "-y"},
    }
# Ensure selected provider exists as a minimal entry
if provider not in d or not isinstance(d.get(provider), dict):
    defaults = {
        "grok": {"label": "Grok (xAI)", "baseURL": "https://api.x.ai/v1", "keyEnv": "XAI_API_KEY", "models": ["grok-4.5"]},
        "openai": {"label": "OpenAI", "baseURL": "https://api.openai.com/v1", "keyEnv": "OPENAI_API_KEY", "models": ["gpt-4o"]},
        "venice": {"label": "Venice", "baseURL": "https://api.venice.ai/api/v1", "keyEnv": "VENICE_API_KEY", "models": ["llama-3.3-70b"]},
        "openrouter": {"label": "OpenRouter", "baseURL": "https://openrouter.ai/api/v1", "keyEnv": "OPENROUTER_API_KEY", "models": ["anthropic/claude-sonnet-4"]},
    }
    d[provider] = defaults.get(provider, {"label": provider, "baseURL": "https://api.x.ai/v1", "keyEnv": "XAI_API_KEY", "models": []})
json.dump(d, open(path, "w"), indent=2)
open(path, "a").write("\n")
print("ok")
PY
  then
    warn "could not ensure cli.json provider catalog — runtime may fail until fixed"
  else
    ok "cli.json has provider '$provider' (runtime: bizagent-agent)"
  fi

  # Install agent-runtime deps if present
  if [[ -f "$INSTALL_DIR/agent-runtime/package.json" ]]; then
    if command -v npm >/dev/null 2>&1; then
      (cd "$INSTALL_DIR/agent-runtime" && npm install --silent) \
        && ok "agent-runtime npm dependencies installed" \
        || warn "agent-runtime npm install failed — run: cd agent-runtime && npm install"
    fi
    chmod +x "$INSTALL_DIR/scripts/bizagent-agent" "$INSTALL_DIR/agent-runtime/bin/bizagent-agent" 2>/dev/null || true
  fi
}

# Seed operator registry.json; set settings.hub_agent.provider to the default LLM.
# registry.json is gitignored; the public repo only ships registry.example.json.
write_registry_seed() {
  local dest="$INSTALL_DIR/registry.json"
  local src="$INSTALL_DIR/registry.example.json"
  local provider="${SELECTED_PROVIDER:-grok}"

  if [[ ! -f "$dest" ]]; then
    if [[ ! -f "$src" ]]; then
      warn "registry.example.json missing — control plane needs a registry.json"
      return
    fi
    if ! python3 - "$src" "$dest" "$provider" <<'PY'
import json, sys
src, dest, provider = sys.argv[1:4]
d = json.load(open(src))
d["org"] = ""
d["products"] = []
d["cross_product_edges"] = []
if "hub" in d and isinstance(d["hub"], dict):
    d["hub"]["name"] = "BizAgent"
settings = d.setdefault("settings", {})
hub_agent = settings.setdefault("hub_agent", {})
hub_agent["provider"] = provider
hub_agent["cliName"] = provider  # legacy alias
if provider == "grok" and not hub_agent.get("model"):
    hub_agent["model"] = "grok-4.5"
json.dump(d, open(dest, "w"), indent=2)
open(dest, "a").write("\n")
PY
    then
      cp "$src" "$dest"
      warn "seeded registry.json as a full example copy (python seed failed)"
    else
      ok "registry.json seeded (empty products, hub_agent.provider=$provider)"
    fi
  else
    # Existing registry: ensure hub provider is set.
    if ! python3 - "$dest" "$provider" <<'PY'
import json, sys
path, provider = sys.argv[1:3]
d = json.load(open(path))
settings = d.setdefault("settings", {})
hub_agent = settings.setdefault("hub_agent", {})
current = (hub_agent.get("provider") or hub_agent.get("cliName") or hub_agent.get("cli") or "").strip()
legacy_map = {"claude": "openrouter", "codex": "openai", "agy": "openrouter", "bizagent-agent": provider or "grok", "xai": "grok"}
if current:
    current = legacy_map.get(current, current)
    hub_agent["provider"] = current
    hub_agent["cliName"] = current
    json.dump(d, open(path, "w"), indent=2)
    open(path, "a").write("\n")
    print("keep")
    raise SystemExit(0)
hub_agent["provider"] = provider
hub_agent["cliName"] = provider
if provider == "grok" and not hub_agent.get("model"):
    hub_agent["model"] = "grok-4.5"
json.dump(d, open(path, "w"), indent=2)
open(path, "a").write("\n")
print(provider)
PY
    then
      warn "could not set hub_agent.provider on existing registry.json"
    else
      ok "registry.json hub_agent.provider ensured"
    fi
  fi

  if [[ -f "$INSTALL_DIR/.cli" ]]; then
    note "legacy .cli present — hub provider is in registry.json; .cli is migration-only"
  fi
}

# Persist selected API key (and nothing else) under .bizagent/env — never committed.
write_env_file() {
  mkdir -p "$INSTALL_DIR/.bizagent"
  local env_file="$INSTALL_DIR/.bizagent/env"
  if [[ -z "$SELECTED_API_KEY" || -z "$SELECTED_API_KEY_VAR" ]]; then
    if [[ ! -f "$env_file" ]] && [[ -f "$INSTALL_DIR/.bizagent/env.example" ]]; then
      note "No API key saved. See .bizagent/env.example for the format."
    fi
    return
  fi

  # Merge: replace existing KEY= line or append. Preserve other keys/comments.
  if [[ -f "$env_file" ]]; then
    local tmp
    tmp="$(mktemp)"
    # Drop prior lines for this key (exact key= prefix).
    grep -v -E "^${SELECTED_API_KEY_VAR}=" "$env_file" > "$tmp" || true
    printf '%s=%s\n' "$SELECTED_API_KEY_VAR" "$SELECTED_API_KEY" >> "$tmp"
    mv "$tmp" "$env_file"
  else
    cat > "$env_file" <<EOF
# Written by install.sh — never commit this file.
# Sourced by control-plane.sh, hub-daemon, and systemd EnvironmentFile.
${SELECTED_API_KEY_VAR}=${SELECTED_API_KEY}
EOF
  fi
  chmod 600 "$env_file"
  ok "API key written to .bizagent/env ($SELECTED_API_KEY_VAR)"
}

# --- clone + handoff ---
DEFAULT_DIR="$HOME/bizagent"
BIZAGENT_SOURCE_EXPLICIT=0
if [[ -n "${BIZAGENT_SOURCE:-}" ]]; then
  BIZAGENT_SOURCE_EXPLICIT=1
fi
BIZAGENT_SOURCE="${BIZAGENT_SOURCE:-https://github.com/OddbeakerLLC/bizagent.git}"

choose_dir() {
  INSTALL_DIR="${BIZAGENT_DIR:-$DEFAULT_DIR}"
  if [[ -d "$INSTALL_DIR" ]] && [[ ! -d "$INSTALL_DIR/.git" ]]; then
    if pgrep -f "bizagent-control-plane" >/dev/null 2>&1; then
      note "Stopping running control plane..."
      pkill -f "bizagent-control-plane" 2>/dev/null || true
      sleep 1
    fi
    note "Clearing $INSTALL_DIR (no .git found)..."
    rm -rf "$INSTALL_DIR"
  fi
  if [[ -d "$INSTALL_DIR/.git" ]] && [[ -n "${BIZAGENT_REINSTALL:-}" ]]; then
    if ! ([[ -f "$INSTALL_DIR/AGENT.md" ]] && grep -qi "bizagent" "$INSTALL_DIR/AGENT.md" 2>/dev/null); then
      die "$INSTALL_DIR has a .git but isn't a bizagent clone — refusing to wipe. Unset BIZAGENT_REINSTALL or set BIZAGENT_DIR to a fresh path."
    fi
    if pgrep -f "bizagent-control-plane" >/dev/null 2>&1; then
      note "Stopping running control plane..."
      pkill -f "bizagent-control-plane" 2>/dev/null || true
      sleep 1
    fi
    note "Wiping existing clone for reinstall..."
    rm -rf "$INSTALL_DIR"
  fi
  if [[ -e "$INSTALL_DIR" ]]; then
    if [[ -d "$INSTALL_DIR/.git" ]] && [[ -f "$INSTALL_DIR/AGENT.md" ]] && grep -qi "bizagent" "$INSTALL_DIR/AGENT.md" 2>/dev/null; then
      if [[ "$BIZAGENT_SOURCE_EXPLICIT" == "1" ]]; then
        die "$INSTALL_DIR already exists and BIZAGENT_SOURCE is set. Remove it or set BIZAGENT_DIR to a fresh path so the requested source is tested."
      fi
      warn "$INSTALL_DIR already exists — using existing clone."
      ALREADY_CLONED=1
      return
    fi
    die "$INSTALL_DIR exists and isn't a bizagent clone. If you deleted it while the control plane was running, try: pkill -f bizagent-control-plane && rm -rf '$INSTALL_DIR' — then re-run."
  fi
  # Ensure parent directory is writable before attempting clone.
  local parent_dir
  parent_dir=$(dirname "$INSTALL_DIR")
  if [[ ! -d "$parent_dir" ]]; then
    if ! mkdir -p "$parent_dir" 2>/dev/null; then
      die "Cannot create $parent_dir. Check that you have write permission and try again, or set BIZAGENT_DIR to a different path."
    fi
  elif [[ ! -w "$parent_dir" ]]; then
    die "Cannot write to $parent_dir. Set BIZAGENT_DIR to a directory you can write to and try again."
  fi
  ALREADY_CLONED=0
}

clone_repo() {
  [[ "$ALREADY_CLONED" == "1" ]] && return
  validate_source "$BIZAGENT_SOURCE"
  note "cloning bizagent into $INSTALL_DIR..."
  if ! git clone --quiet -- "$BIZAGENT_SOURCE" "$INSTALL_DIR" 2>/dev/null; then
    rm -rf "$INSTALL_DIR" 2>/dev/null || true
    die "Failed to clone bizagent. Check that BIZAGENT_SOURCE is reachable and that you have write permission to $INSTALL_DIR."
  fi
  ok "cloned"
}

# Sever the public framework remote so ops data can never push there. Advise a
# private hub remote for nightly commit/push of registry, journals, KS, etc.
detach_framework_remote() {
  if [[ ! -x "$INSTALL_DIR/scripts/detach-framework-remote.sh" ]]; then
    warn "detach-framework-remote.sh missing — remove public origin manually before first commit"
    return
  fi
  step "Detach public framework remote"
  bash "$INSTALL_DIR/scripts/detach-framework-remote.sh" "$INSTALL_DIR" || true
  ok "framework remote detached (or none found); private hub remote recommended — see message above"
}

handoff() {
  local port
  port=$(python3 - "$INSTALL_DIR/registry.json" <<'PY' 2>/dev/null || echo "8787"
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('settings', {}).get('control_plane', {}).get('port', 8787))
except Exception:
    print(8787)
PY
)
  port="${port:-8787}"

  step "Starting BizAgent"
  bash "$INSTALL_DIR/scripts/control-plane.sh" start "$INSTALL_DIR"

  note "Waiting for port $port..."
  local i=0
  while (( i < 10 )); do
    if (echo >/dev/tcp/localhost/"$port") 2>/dev/null; then
      break
    fi
    sleep 1
    i=$(( i + 1 ))
  done

  if ! (echo >/dev/tcp/localhost/"$port") 2>/dev/null; then
    warn "Control plane did not respond on port $port within 10s."
    note "Check the log: $INSTALL_DIR/logs/control-plane-server.log"
  fi

  printf "\n${BOLD}Open this URL in your browser to set up BizAgent:${NC}\n\n"
  printf "  ${BOLD}http://localhost:%s${NC}\n\n" "$port"

  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:$port" 2>/dev/null &
  elif command -v open >/dev/null 2>&1; then
    open "http://localhost:$port"
  fi

  exit 0
}

# --- main ---
main() {
  banner

  step "Checking your system"
  detect_platform
  detect_pkg_manager

  step "Installing dependencies"
  ensure git
  ensure python3
  ensure_node
  ensure_cron

  step "Default LLM provider"
  select_default_provider

  step "API key for hub agents"
  # INSTALL_DIR is not finalized yet; prompt still works — path hints use default until choose_dir.
  INSTALL_DIR="${BIZAGENT_DIR:-$HOME/bizagent}"
  prompt_api_key

  step "Setting up bizagent"
  choose_dir
  clone_repo
  detach_framework_remote
  write_cli_json
  write_registry_seed
  write_env_file

  handoff
}

main "$@"
