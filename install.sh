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
# Format: "binary|display_name|prompt_flag|install_hint"
KNOWN_CLIS=(
  "claude|Claude Code (Anthropic)|-p|curl -fsSL https://claude.ai/install.sh | bash"
  "gemini|Gemini CLI (Google)|-p|npm install -g @google/gemini-cli"
  "codex|Codex CLI (OpenAI)|--prompt|npm install -g @openai/codex"
  "grok|Grok CLI (xAI)|-p|npm install -g @vibe-kit/grok-cli"
)

SELECTED_CLI=""
SELECTED_PROMPT_FLAG=""

detect_and_select_cli() {
  local available_bins=()
  local available_names=()
  local available_flags=()

  for entry in "${KNOWN_CLIS[@]}"; do
    IFS='|' read -r bin name flag _ <<< "$entry"
    if have "$bin"; then
      available_bins+=("$bin")
      available_names+=("$name")
      available_flags+=("$flag")
    fi
  done

  local count="${#available_bins[@]}"

  if [[ "$count" -eq 0 ]]; then
    warn "No supported AI CLI found. Installing Claude Code (recommended default)..."
    _install_claude
    SELECTED_CLI="claude"
    SELECTED_PROMPT_FLAG="-p"
    ok "Claude Code selected"
    return
  fi

  if [[ "$count" -eq 1 ]]; then
    SELECTED_CLI="${available_bins[0]}"
    SELECTED_PROMPT_FLAG="${available_flags[0]}"
    ok "AI CLI detected: ${available_names[0]} ($SELECTED_CLI)"
    return
  fi

  # Multiple found — let the user choose
  printf "\n${BOLD}Multiple AI CLIs found. Which one should bizagent use?${NC}\n\n"
  for i in "${!available_bins[@]}"; do
    printf "  %d) %s\n" "$((i+1))" "${available_names[$i]}"
  done
  printf "\n"

  local choice
  while true; do
    read -r -p "Enter number [1]: " choice
    choice="${choice:-1}"
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= count )); then
      break
    fi
    warn "Please enter a number between 1 and $count."
  done

  local idx=$(( choice - 1 ))
  SELECTED_CLI="${available_bins[$idx]}"
  SELECTED_PROMPT_FLAG="${available_flags[$idx]}"
  ok "Selected: ${available_names[$idx]} ($SELECTED_CLI)"
}

_install_claude() {
  if have claude; then return; fi
  note "installing Claude Code..."
  curl -fsSL https://claude.ai/install.sh | bash
  for p in "$HOME/.local/bin" "$HOME/.claude/bin"; do
    [[ -d "$p" ]] && export PATH="$p:$PATH"
  done
  hash -r 2>/dev/null || true
  have claude || die "Claude Code installed but 'claude' isn't on PATH. Open a new terminal and re-run this installer."
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
