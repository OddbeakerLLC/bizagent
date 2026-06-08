#!/usr/bin/env bash
# bizagent installer — macOS, Linux, and WSL on Windows.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/OddbeakerLLC/bizagent/main/install.sh | bash
#
# Installs git, python3, cron, and Claude Code; clones bizagent;
# hands you off to Claude Code with the right opening instruction.
#
# Env vars (optional):
#   BIZAGENT_DIR=/path/to/clone    Override the default install dir (~/bizagent)
#   BIZAGENT_NO_LAUNCH=1           Skip auto-launching Claude Code at the end

set -euo pipefail

# When piped through `bash`, stdin is the pipe. Reopen it from the controlling
# terminal so prompts (sudo, Homebrew, our own) keep working.
if [[ ! -t 0 ]]; then
  if [[ -r /dev/tty ]]; then
    exec </dev/tty
  else
    echo "No interactive terminal available; aborting." >&2
    exit 1
  fi
fi

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
    eval "$INSTALL $pkg"
    have "$cmd" || die "Installed $pkg but '$cmd' isn't on PATH. Open a new terminal and re-run."
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
# Format: "binary|display_name|prompt_flag|install_method|install_target"
#   install_method: "curl" or "npm"
#   install_target: URL (curl) or package name (npm)
KNOWN_CLIS=(
  "claude|Claude Code (Anthropic)|-p|curl|https://claude.ai/install.sh"
  "gemini|Gemini CLI (Google)|-p|npm|@google/gemini-cli"
  "codex|Codex CLI (OpenAI)|--prompt|npm|@openai/codex"
  "grok|Grok CLI (xAI)|-p|npm|@vibe-kit/grok-cli"
)

SELECTED_CLI=""
SELECTED_PROMPT_FLAG=""

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
  have npm || die "Node.js installed but 'npm' isn't on PATH. Open a new terminal and re-run."
  ok "npm ready"
}

install_cli() {
  local bin="$1" method="$2" target="$3"
  have "$bin" && return
  note "installing $bin..."
  case "$method" in
    curl)
      curl -fsSL "$target" | bash
      for p in "$HOME/.local/bin" "$HOME/.claude/bin"; do
        [[ -d "$p" ]] && export PATH="$p:$PATH"
      done
      ;;
    npm)
      ensure_npm
      npm install -g "$target"
      ;;
  esac
  hash -r 2>/dev/null || true
  have "$bin" || die "Installed $bin but it isn't on PATH. Open a new terminal and re-run this installer."
  ok "$bin installed"
}

detect_and_select_cli() {
  local all_bins=() all_names=() all_flags=() all_methods=() all_targets=()
  local default_idx=0

  for entry in "${KNOWN_CLIS[@]}"; do
    IFS='|' read -r bin name flag method target <<< "$entry"
    all_bins+=("$bin")
    all_names+=("$name")
    all_flags+=("$flag")
    all_methods+=("$method")
    all_targets+=("$target")
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
    read -r -p "Enter number [$((default_idx+1))]: " choice
    choice="${choice:-$((default_idx+1))}"
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#all_bins[@]} )); then
      break
    fi
    warn "Please enter a number between 1 and ${#all_bins[@]}."
  done

  local idx=$(( choice - 1 ))
  SELECTED_CLI="${all_bins[$idx]}"
  SELECTED_PROMPT_FLAG="${all_flags[$idx]}"

  if ! have "$SELECTED_CLI"; then
    local confirm
    read -r -p "  ${all_names[$idx]} is not installed. Install it now? [Y/n]: " confirm
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
EOF
  ok "CLI config written (.cli)"
}

# --- clone + handoff ---
DEFAULT_DIR="$HOME/bizagent"

choose_dir() {
  INSTALL_DIR="${BIZAGENT_DIR:-$DEFAULT_DIR}"
  if [[ -e "$INSTALL_DIR" ]]; then
    if [[ -d "$INSTALL_DIR/.git" ]] && grep -q "bizagent" "$INSTALL_DIR/README.md" 2>/dev/null; then
      warn "$INSTALL_DIR already exists — using existing clone."
      ALREADY_CLONED=1
      return
    fi
    die "$INSTALL_DIR exists and isn't a bizagent clone. Move it or set BIZAGENT_DIR to a different path and re-run."
  fi
  ALREADY_CLONED=0
}

clone_repo() {
  [[ "$ALREADY_CLONED" == "1" ]] && return
  note "cloning bizagent into $INSTALL_DIR..."
  git clone --quiet https://github.com/OddbeakerLLC/bizagent "$INSTALL_DIR"
  ok "cloned"
}

handoff() {
  cat <<EOF

${BOLD}You're set.${NC}

  ${DIM}bizagent lives at:${NC} $INSTALL_DIR
  ${DIM}AI CLI:${NC}           $SELECTED_CLI

Once your CLI is running in that directory, tell it:

  ${BOLD}Read AGENT.md and set up my system.${NC}

It will interview you about your products and projects, then build the
whole thing for you.

EOF

  if [[ -n "${BIZAGENT_NO_LAUNCH:-}" ]]; then
    note "Auto-launch skipped (BIZAGENT_NO_LAUNCH set). When ready:  cd $INSTALL_DIR && $SELECTED_CLI"
    exit 0
  fi

  read -r -p "Press Enter to launch $SELECTED_CLI now (Ctrl-C to launch it yourself later): " _
  cd "$INSTALL_DIR"
  exec "$SELECTED_CLI"
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
