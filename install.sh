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
  "grok|Grok CLI (xAI)|-p|curl|https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh|"
)

SELECTED_CLI=""
SELECTED_PROMPT_FLAG=""
SELECTED_YOLO_FLAG=""

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

detect_and_select_cli() {
  local all_bins=() all_names=() all_flags=() all_methods=() all_targets=() all_yolo=()
  local default_idx=0

  for entry in "${KNOWN_CLIS[@]}"; do
    IFS='|' read -r bin name flag method target yolo <<< "$entry"
    all_bins+=("$bin")
    all_names+=("$name")
    all_flags+=("$flag")
    all_methods+=("$method")
    all_targets+=("$target")
    all_yolo+=("$yolo")
  done

  # Find default: first installed CLI, or 0 (claude) if none
  local i
  for i in "${!all_bins[@]}"; do
    if have "${all_bins[$i]}"; then
      default_idx=$i
      break
    fi
  done

  printf "\n${BOLD}Which AI CLI should bizagent use?${NC}\n\n"
  for i in "${!all_bins[@]}"; do
    local marker="  "
    have "${all_bins[$i]}" && marker="${GREEN}✓${NC}"
    local default_hint=""
    [[ "$i" -eq "$default_idx" ]] && default_hint=" ${DIM}(default)${NC}"
    printf "  %b %d) %s%b\n" "$marker" "$((i+1))" "${all_names[$i]}" "$default_hint"
  done
  printf "\n"
  note "✓ = already installed"
  printf "\n"

  local choice
  while true; do
    read -r -p "Enter number [$((default_idx+1))]: " choice </dev/tty
    choice="${choice:-$((default_idx+1))}"
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#all_bins[@]} )); then
      break
    fi
    warn "Please enter a number between 1 and ${#all_bins[@]}."
  done

  local idx=$(( choice - 1 ))
  SELECTED_CLI="${all_bins[$idx]}"
  SELECTED_PROMPT_FLAG="${all_flags[$idx]}"
  SELECTED_YOLO_FLAG="${all_yolo[$idx]}"

  if ! have "$SELECTED_CLI"; then
    local confirm
    read -r -p "  ${all_names[$idx]} is not installed. Install it now? [Y/n]: " confirm </dev/tty
    confirm="${confirm:-Y}"
    if [[ "$confirm" =~ ^[Yy] ]]; then
      install_cli "$SELECTED_CLI" "${all_methods[$idx]}" "${all_targets[$idx]}"
    else
      die "Cannot continue without an AI CLI. Re-run and choose an installed CLI or allow installation."
    fi
  fi

  ok "Selected: ${all_names[$idx]} ($SELECTED_CLI)"
}

write_cli_config() {
  cat > "$INSTALL_DIR/.cli" <<EOF
# bizagent CLI config — written by installer, read by AGENT.md setup
CLI_CMD=$SELECTED_CLI
CLI_PROMPT_FLAG=$SELECTED_PROMPT_FLAG
CLI_EXTRA_ARGS=$SELECTED_YOLO_FLAG
EOF
  ok "CLI config written (.cli)"
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

  step "Selecting AI CLI"
  detect_and_select_cli

  step "Setting up bizagent"
  choose_dir
  clone_repo
  write_cli_config

  handoff
}

main "$@"
