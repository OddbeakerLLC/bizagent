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

ensure_claude_code() {
  if have claude; then
    ok "Claude Code present"
    return
  fi
  note "installing Claude Code (native installer)..."
  curl -fsSL https://claude.ai/install.sh | bash
  # The native installer drops `claude` in ~/.local/bin (sometimes ~/.claude/bin).
  # Add those to PATH for this shell so we can exec it at the end.
  for p in "$HOME/.local/bin" "$HOME/.claude/bin"; do
    [[ -d "$p" ]] && export PATH="$p:$PATH"
  done
  hash -r 2>/dev/null || true
  have claude || die "Claude Code installed but 'claude' isn't on PATH. Open a new terminal and re-run this installer."
  ok "Claude Code installed"
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

What's next: Claude Code will open in that directory. The first time you
run it, it opens your browser to sign in to your Anthropic account.
(That's the API key / billing step — grab a friend if you need a hand.)

Once it's running, tell it:

  ${BOLD}Read AGENT.md and set up my system.${NC}

It will interview you about your products and projects, then build the
whole thing for you.

EOF

  if [[ -n "${BIZAGENT_NO_LAUNCH:-}" ]]; then
    note "Auto-launch skipped (BIZAGENT_NO_LAUNCH set). When ready:  cd $INSTALL_DIR && claude"
    exit 0
  fi

  read -r -p "Press Enter to launch Claude Code now (Ctrl-C to launch it yourself later): " _
  cd "$INSTALL_DIR"
  exec claude
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

  step "Installing Claude Code"
  ensure_claude_code

  step "Setting up bizagent"
  choose_dir
  clone_repo

  handoff
}

main "$@"
