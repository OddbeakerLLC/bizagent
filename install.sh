#!/usr/bin/env bash
# bizagent installer — macOS, Linux, and WSL on Windows.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/OddbeakerLLC/bizagent/main/install.sh | bash
#
# Installs runtime deps (git, python3, curl, Node.js, cron, Java, Graphviz,
# PlantUML), clones bizagent, starts the control plane, and opens the web UI.
#
# Env vars (optional):
#   BIZAGENT_DIR=/path/to/clone    Override the default install dir (./bizagent)
#   BIZAGENT_SOURCE=/path/or/url    Override the source repo (local path, file:// URL, or git URL)
#   BIZAGENT_REINSTALL=1           Wipe an existing clone and reinstall from scratch
#   BIZAGENT_API_KEY=...           Non-interactive: write this as the selected CLI's API key
#                                  into INSTALL_DIR/.bizagent/env (preferred over prompting)
#   BIZAGENT_AUTO_UPDATE=0|1       Non-interactive: framework auto-update preference
#                                  (0=manual-only default, 1=nightly may run scripts/upgrade.sh)
#                                  Persisted as registry.json settings.auto_update
#   BIZAGENT_TTS_VOICE=id          Non-interactive: Kokoro voice id (default af_heart)
#   BIZAGENT_TTS_SOURCE=path|url   oddbeaker-tts checkout or git URL (default: discover/SSH)
#   BIZAGENT_TTS_DIR=path          Install root for oddbeaker-tts (default ~/.bizagent/oddbeaker-tts)
#   BIZAGENT_SKIP_TTS=1            Skip oddbeaker-tts install (console TTS stays browser-only)
#   BIZAGENT_NONINTERACTIVE=1      No prompts (provider/key/voice use env/defaults)

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

# Minimum Node major — keep in sync with agent-runtime engines and scripts/lib/require-node.sh
BIZAGENT_MIN_NODE_MAJOR="${BIZAGENT_MIN_NODE_MAJOR:-18}"

_node_major() {
  local ver major
  ver="$(node -v 2>/dev/null || node --version 2>/dev/null || true)"
  ver="${ver#v}"
  major="${ver%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$major"
}

_die_node_too_old() {
  local detected="$1"
  cat >&2 <<EOF

${RED}✗ Node.js ${detected} is too old (need v${BIZAGENT_MIN_NODE_MAJOR}+).${NC}

Detected: ${detected}
Required: v${BIZAGENT_MIN_NODE_MAJOR}.0.0 or newer

This machine/setup may not run BizAgent until Node is upgraded.
Older distro packages (common on WSL / Ubuntu 20.04) often ship Node 12 or 16,
which can look "installed" then fail when the control plane or agent-runtime starts.

Fix (WSL / Ubuntu / Debian) — pick one:

  # NodeSource current LTS (recommended on WSL)
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs

  # or nvm (user-local, no sudo)
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # restart shell, then:
  nvm install --lts
  nvm use --lts

Then confirm:  node -v   # should print v${BIZAGENT_MIN_NODE_MAJOR}.x or newer
and re-run this installer.

EOF
  exit 1
}

_require_node_version() {
  local detected major
  if ! have node; then
    die "Node.js not found on PATH (need v${BIZAGENT_MIN_NODE_MAJOR}+)."
  fi
  detected="$(node -v 2>/dev/null || node --version 2>/dev/null || echo unknown)"
  if ! major="$(_node_major)"; then
    _die_node_too_old "$detected"
  fi
  if [[ "$major" -lt "$BIZAGENT_MIN_NODE_MAJOR" ]]; then
    _die_node_too_old "$detected"
  fi
  ok "node ${detected} (>= v${BIZAGENT_MIN_NODE_MAJOR})"
}

ensure_node() {
  if have node; then
    _require_node_version
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
  # Distro packages (esp. WSL/Ubuntu) may install Node below our minimum — fail before clone/start.
  _require_node_version
}

ensure_curl() {
  if have curl; then
    ok "curl present"
    return
  fi
  note "installing curl..."
  case "$PKG" in
    brew)   brew install curl ;;
    apt)    $INSTALL curl ;;
    dnf)    $INSTALL curl ;;
    pacman) $INSTALL curl ;;
    zypper) $INSTALL curl ;;
  esac
  if ! have curl; then
    die "curl is required (downloads + API key check) but is not on PATH after install."
  fi
  ok "curl installed"
}

# User-local tool root for JDK / PlantUML / Graphviz when package install is unavailable.
# Override with BIZAGENT_TOOLS_DIR. PATH snippets are written into .bizagent/env later.
TOOLS_DIR="${BIZAGENT_TOOLS_DIR:-$HOME/.bizagent/tools}"
TOOLS_BIN="$TOOLS_DIR/bin"

# Track env exports the control plane should inherit (PATH, JAVA_HOME, GRAPHVIZ_DOT, PLANTUML_SH).
TOOLS_ENV_LINES=()

tools_env_add() {
  local line="$1"
  local i
  for i in "${TOOLS_ENV_LINES[@]+"${TOOLS_ENV_LINES[@]}"}"; do
    [[ "$i" == "$line" ]] && return
  done
  TOOLS_ENV_LINES+=("$line")
}

tools_path_prepend() {
  local dir="$1"
  [[ -d "$dir" ]] || return
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) export PATH="$dir:$PATH" ;;
  esac
  tools_env_add "export PATH=\"$dir:\$PATH\""
}

can_install_pkgs() {
  # brew never needs sudo; Linux INSTALL uses sudo — accept passwordless or interactive tty.
  if [[ "$PKG" == "brew" ]]; then
    return 0
  fi
  if sudo -n true >/dev/null 2>&1; then
    return 0
  fi
  # Allow a sudo password prompt only when a real tty is available (interactive install).
  if [[ -r /dev/tty ]] && [[ -z "${BIZAGENT_NONINTERACTIVE:-}" ]]; then
    return 0
  fi
  return 1
}

pkg_install() {
  # Run package install; return non-zero on failure without dying.
  local pkgs="$*"
  [[ -n "$pkgs" ]] || return 1
  if ! can_install_pkgs; then
    return 1
  fi
  # shellcheck disable=SC2086
  eval "$INSTALL $pkgs"
}

detect_os_arch() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="mac" ;;
    Linux)  os="linux" ;;
    *)      os="linux" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="aarch64" ;;
    armv7l) arch="arm" ;;
    *) arch="x64" ;;
  esac
  printf '%s %s\n' "$os" "$arch"
}

# --- Java (PlantUML) ---
ensure_java() {
  if have java; then
    ok "java present ($(java -version 2>&1 | head -1))"
    return
  fi
  # Homebrew often leaves openjdk keg-only — check common prefixes.
  if [[ "$PKG" == "brew" ]]; then
    local brew_java
    for brew_java in \
      "$(brew --prefix openjdk@17 2>/dev/null)/bin" \
      "$(brew --prefix openjdk 2>/dev/null)/bin" \
      "/opt/homebrew/opt/openjdk@17/bin" \
      "/usr/local/opt/openjdk@17/bin"
    do
      if [[ -x "$brew_java/java" ]]; then
        tools_path_prepend "$brew_java"
        tools_env_add "export JAVA_HOME=\"$(dirname "$brew_java")\""
        ok "java present (Homebrew keg)"
        return
      fi
    done
  fi

  note "java not found — installing a JRE/JDK for PlantUML..."
  local installed=0
  case "$PKG" in
    brew)
      if pkg_install openjdk@17 || pkg_install openjdk; then installed=1; fi
      ;;
    apt)
      if pkg_install openjdk-17-jre-headless || pkg_install default-jre-headless; then installed=1; fi
      ;;
    dnf)
      if pkg_install java-17-openjdk-headless || pkg_install java-11-openjdk-headless; then installed=1; fi
      ;;
    pacman)
      if pkg_install jre17-openjdk-headless || pkg_install jre-openjdk-headless; then installed=1; fi
      ;;
    zypper)
      if pkg_install java-17-openjdk-headless || pkg_install java-11-openjdk-headless; then installed=1; fi
      ;;
  esac

  # Refresh brew keg path after install.
  if [[ "$PKG" == "brew" ]]; then
    local brew_java
    for brew_java in \
      "$(brew --prefix openjdk@17 2>/dev/null)/bin" \
      "$(brew --prefix openjdk 2>/dev/null)/bin"
    do
      if [[ -x "${brew_java}/java" ]]; then
        tools_path_prepend "$brew_java"
        tools_env_add "export JAVA_HOME=\"$(dirname "$brew_java")\""
        have java && { ok "java installed (Homebrew)"; return; }
      fi
    done
  fi

  if have java; then
    ok "java installed"
    return
  fi

  # User-local Temurin JDK 17 (no sudo).
  install_java_userlocal
}

install_java_userlocal() {
  have curl || die "curl required to download a user-local JDK"
  local os arch
  read -r os arch <<<"$(detect_os_arch)"
  local dest="$TOOLS_DIR/jdk"
  mkdir -p "$TOOLS_DIR"
  if [[ -x "$dest/bin/java" ]]; then
    tools_path_prepend "$dest/bin"
    tools_env_add "export JAVA_HOME=\"$dest\""
    ok "java present (user-local $dest)"
    return
  fi
  note "downloading Temurin JDK 17 to $dest (user-local, no sudo)..."
  local url tmp tarball top
  url="https://api.adoptium.net/v3/binary/latest/17/ga/${os}/${arch}/jdk/hotspot/normal/eclipse?project=jdk"
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  if ! curl -fsSL "$url" -o "$tmp/jdk.tgz"; then
    die "Failed to download Temurin JDK 17. Install a JRE manually (openjdk 17+) and re-run."
  fi
  tar -xzf "$tmp/jdk.tgz" -C "$tmp"
  top="$(find "$tmp" -maxdepth 1 -type d -name 'jdk-*' | head -1)"
  [[ -n "$top" && -x "$top/bin/java" ]] || die "JDK archive did not contain bin/java"
  rm -rf "$dest"
  mv "$top" "$dest"
  tools_path_prepend "$dest/bin"
  tools_env_add "export JAVA_HOME=\"$dest\""
  if ! have java; then
    die "User-local JDK installed at $dest but java is not on PATH"
  fi
  ok "java installed user-local ($dest)"
}

# --- Graphviz / dot (PlantUML non-sequence diagrams) ---
ensure_graphviz() {
  if have dot; then
    ok "dot present ($(dot -V 2>&1 | head -1))"
    return
  fi
  note "graphviz (dot) not found — installing for PlantUML diagrams..."
  case "$PKG" in
    brew)   pkg_install graphviz || true ;;
    apt)    pkg_install graphviz || true ;;
    dnf)    pkg_install graphviz || true ;;
    pacman) pkg_install graphviz || true ;;
    zypper) pkg_install graphviz || true ;;
  esac
  hash -r 2>/dev/null || true
  if have dot; then
    ok "dot installed"
    return
  fi
  install_graphviz_userlocal
}

install_graphviz_userlocal() {
  local dest="$TOOLS_DIR/graphviz"
  local bin_dir="$dest/usr/bin"
  if [[ -x "$bin_dir/dot" ]]; then
    expose_userlocal_graphviz "$dest"
    if have dot && dot -V >/dev/null 2>&1; then
      ok "dot present (user-local $bin_dir/dot)"
      return
    fi
  fi

  # Debian/Ubuntu: download .debs + recursive Depends and extract (no sudo).
  # Package SONAMEs change across releases (libgvc6 vs libgvc7, etc.).
  if have apt-get && have apt-cache && have dpkg-deb; then
    note "extracting graphviz packages user-local into $dest..."
    local debdir="$TOOLS_DIR/debs-graphviz"
    mkdir -p "$debdir" "$dest"
    # Resolve package names dynamically from apt metadata.
    local -a pkgs=()
    local line dep
    pkgs+=(graphviz)
    while IFS= read -r line; do
      # apt-cache depends lines look like: "  Depends: libgvc7"
      dep="$(printf '%s\n' "$line" | sed -n 's/^[[:space:]]*Depends:[[:space:]]*//p')"
      [[ -n "$dep" ]] || continue
      # Skip alternatives / debconf virtuals / libc
      case "$dep" in
        *\|*|libc6|libc6_*|libstdc++*|libgcc*|base-files|fonts-* ) continue ;;
      esac
      # Strip version operators: "libfoo (>= 1)" → libfoo
      dep="${dep%% *}"
      dep="${dep%%:*}"; # drop :any
      pkgs+=("$dep")
    done < <(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts \
      --no-breaks --no-replaces --no-enhances graphviz 2>/dev/null | head -200)

    # Also pull common Graphviz plugin packages when present in the index.
    local plug
    for plug in libgvplugin-core8 libgvplugin-dot-layout8 libgvplugin-gd8 \
                libgvplugin-pango8 libgvplugin-neato-layout8; do
      if apt-cache show "$plug" >/dev/null 2>&1; then
        pkgs+=("$plug")
      fi
    done

    # Unique package list
    local -a uniq=()
    local p seen
    for p in "${pkgs[@]}"; do
      seen=0
      for u in "${uniq[@]+"${uniq[@]}"}"; do
        [[ "$u" == "$p" ]] && { seen=1; break; }
      done
      [[ $seen -eq 0 ]] && uniq+=("$p")
    done

    if (cd "$debdir" && apt-get download "${uniq[@]}" >/dev/null 2>&1); then
      local deb
      for deb in "$debdir"/*.deb; do
        [[ -f "$deb" ]] || continue
        dpkg-deb -x "$deb" "$dest" 2>/dev/null || true
      done
      if [[ -x "$bin_dir/dot" ]]; then
        expose_userlocal_graphviz "$dest"
        if have dot && dot -V >/dev/null 2>&1; then
          ok "dot installed user-local ($bin_dir/dot)"
          return
        fi
        # If wrapper failed, surface ldd clues in a soft warn then fall through to die.
        warn "user-local dot extracted but failed to run (missing libs?)"
      fi
    else
      warn "apt-get download of graphviz deps failed (offline or no universe mirror?)"
    fi
  fi

  die "Graphviz 'dot' is required for PlantUML (non-sequence diagrams) but could not be installed.
Install it with your package manager and re-run, e.g.:
  sudo apt-get install -y graphviz
  sudo dnf install -y graphviz
  brew install graphviz"
}

expose_userlocal_graphviz() {
  local dest="$1"
  local bin_dir="$dest/usr/bin"
  local lib_dir=""
  # Prefer multiarch lib dir when present.
  if [[ -d "$dest/usr/lib/x86_64-linux-gnu" ]]; then
    lib_dir="$dest/usr/lib/x86_64-linux-gnu"
  elif [[ -d "$dest/usr/lib/aarch64-linux-gnu" ]]; then
    lib_dir="$dest/usr/lib/aarch64-linux-gnu"
  elif [[ -d "$dest/usr/lib" ]]; then
    lib_dir="$dest/usr/lib"
  fi
  mkdir -p "$TOOLS_BIN"

  # Register Graphviz plugins into configN (required after unpacking .debs without dpkg).
  if [[ -n "$lib_dir" && -d "$lib_dir/graphviz" && -x "$bin_dir/dot" ]]; then
    LD_LIBRARY_PATH="$lib_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
      GVBINDIR="$lib_dir/graphviz" \
      "$bin_dir/dot" -c >/dev/null 2>&1 || true
  fi

  # Wrapper so consumers only need TOOLS_BIN on PATH (sets LD_LIBRARY_PATH).
  cat > "$TOOLS_BIN/dot" <<EOF
#!/usr/bin/env bash
set -euo pipefail
LIB="$lib_dir"
BIN="$bin_dir"
if [[ -n "\$LIB" ]]; then
  export LD_LIBRARY_PATH="\$LIB\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
  # Graphviz plugins live under lib/graphviz
  export GVBINDIR="\$LIB/graphviz"
fi
exec "\$BIN/dot" "\$@"
EOF
  chmod +x "$TOOLS_BIN/dot"
  # Also expose sibling layout engines commonly invoked as `dot` alternatives.
  local eng
  for eng in neato fdp sfdp twopi circo; do
    if [[ -x "$bin_dir/$eng" && ! -e "$TOOLS_BIN/$eng" ]]; then
      cat > "$TOOLS_BIN/$eng" <<EOF
#!/usr/bin/env bash
set -euo pipefail
LIB="$lib_dir"
BIN="$bin_dir"
if [[ -n "\$LIB" ]]; then
  export LD_LIBRARY_PATH="\$LIB\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
  export GVBINDIR="\$LIB/graphviz"
fi
exec "\$BIN/$eng" "\$@"
EOF
      chmod +x "$TOOLS_BIN/$eng"
    fi
  done
  tools_path_prepend "$TOOLS_BIN"
  tools_env_add "export GRAPHVIZ_DOT=\"$TOOLS_BIN/dot\""
  if [[ -n "$lib_dir" ]]; then
    tools_env_add "export LD_LIBRARY_PATH=\"$lib_dir\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}\""
    tools_env_add "export GVBINDIR=\"$lib_dir/graphviz\""
  fi
}

# --- PlantUML (jar + wrapper) ---
find_plantuml_bin() {
  local c
  for c in \
    "${PLANTUML_SH:-}" \
    "$TOOLS_DIR/plantuml.sh" \
    "$HOME/tools/plantuml.sh" \
    "$HOME/.local/bin/plantuml" \
    "/usr/local/bin/plantuml" \
    "/usr/bin/plantuml"
  do
    [[ -n "$c" && -f "$c" && -x "$c" ]] && { printf '%s\n' "$c"; return 0; }
  done
  if have plantuml; then
    command -v plantuml
    return 0
  fi
  return 1
}

ensure_plantuml() {
  local existing
  if existing="$(find_plantuml_bin 2>/dev/null)"; then
    ok "plantuml present ($existing)"
    tools_env_add "export PLANTUML_SH=\"$existing\""
    return
  fi

  note "PlantUML not found — installing..."
  # Distro package when available (often pulls Java; Graphviz may be recommended only).
  case "$PKG" in
    brew)   pkg_install plantuml || true ;;
    apt)    pkg_install plantuml || true ;;
    dnf)    pkg_install plantuml || true ;;
    pacman) pkg_install plantuml || true ;;
    zypper) pkg_install plantuml || true ;;
  esac
  hash -r 2>/dev/null || true
  if existing="$(find_plantuml_bin 2>/dev/null)"; then
    ok "plantuml installed ($existing)"
    tools_env_add "export PLANTUML_SH=\"$existing\""
    return
  fi

  install_plantuml_userlocal
}

install_plantuml_userlocal() {
  have curl || die "curl required to download PlantUML"
  have java || die "java required before PlantUML jar install"
  mkdir -p "$TOOLS_DIR" "$TOOLS_BIN" "$HOME/.local/bin"
  local jar="$TOOLS_DIR/plantuml.jar"
  local wrap="$TOOLS_DIR/plantuml.sh"
  local ver="1.2024.7"
  local url="https://github.com/plantuml/plantuml/releases/download/v${ver}/plantuml-${ver}.jar"

  if [[ ! -f "$jar" ]]; then
    note "downloading PlantUML ${ver} jar to $jar..."
    if ! curl -fsSL "$url" -o "$jar"; then
      # Fallback: latest redirect from plantuml.com
      if ! curl -fsSL "https://github.com/plantuml/plantuml/releases/latest/download/plantuml.jar" -o "$jar"; then
        die "Failed to download plantuml.jar. Install the plantuml package or place plantuml.jar at $jar."
      fi
    fi
  fi

  # Portable wrapper: prefers java on PATH / JAVA_HOME, jar next to the script.
  cat > "$wrap" <<'EOF'
#!/usr/bin/env bash
# PlantUML render wrapper (user-local install).
# Usage:
#   plantuml.sh <file.puml> [format]     # format: svg (default) | png | both
#   plantuml.sh -tsvg <file.puml>        # passthrough to java -jar
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAR="${PLANTUML_JAR:-$ROOT/plantuml.jar}"

resolve_java() {
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then
    printf '%s\n' "$JAVA_HOME/bin/java"
    return
  fi
  if command -v java >/dev/null 2>&1; then
    command -v java
    return
  fi
  local c
  for c in "$ROOT/jdk/bin/java" "$HOME/.bizagent/tools/jdk/bin/java"; do
    if [[ -x "$c" ]]; then
      printf '%s\n' "$c"
      return
    fi
  done
  echo "java not found (install a JRE 17+ or set JAVA_HOME)" >&2
  exit 1
}

JAVA="$(resolve_java)"
[[ -f "$JAR" ]] || { echo "PlantUML jar not found at $JAR" >&2; exit 1; }

# Prefer installer-provided Graphviz wrapper / GRAPHVIZ_DOT.
if [[ -n "${GRAPHVIZ_DOT:-}" && -x "$GRAPHVIZ_DOT" ]]; then
  export GRAPHVIZ_DOT
elif [[ -x "$HOME/.bizagent/tools/bin/dot" ]]; then
  export GRAPHVIZ_DOT="$HOME/.bizagent/tools/bin/dot"
  export PATH="$HOME/.bizagent/tools/bin:$PATH"
fi

DOT_ARGS=()
if [[ -n "${GRAPHVIZ_DOT:-}" && -x "$GRAPHVIZ_DOT" ]]; then
  DOT_ARGS=(-graphvizdot "$GRAPHVIZ_DOT")
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: plantuml.sh <file.puml> [svg|png|both]" >&2
  exit 1
fi

if [[ "$1" == -* ]]; then
  exec "$JAVA" -jar "$JAR" ${DOT_ARGS[@]+"${DOT_ARGS[@]}"} "$@"
fi

PUML="$1"
FMT="${2:-svg}"
case "$FMT" in
  svg)  "$JAVA" -jar "$JAR" ${DOT_ARGS[@]+"${DOT_ARGS[@]}"} -tsvg "$PUML" ;;
  png)  "$JAVA" -jar "$JAR" ${DOT_ARGS[@]+"${DOT_ARGS[@]}"} -tpng "$PUML" ;;
  both)
    "$JAVA" -jar "$JAR" ${DOT_ARGS[@]+"${DOT_ARGS[@]}"} -tsvg "$PUML"
    "$JAVA" -jar "$JAR" ${DOT_ARGS[@]+"${DOT_ARGS[@]}"} -tpng "$PUML"
    ;;
  *)    echo "Unknown format: $FMT (use svg|png|both)" >&2; exit 1 ;;
esac
EOF
  chmod +x "$wrap"

  # PATH convenience: plantuml → wrapper
  ln -sfn "$wrap" "$TOOLS_BIN/plantuml"
  ln -sfn "$wrap" "$HOME/.local/bin/plantuml" 2>/dev/null || true
  tools_path_prepend "$TOOLS_BIN"
  tools_path_prepend "$HOME/.local/bin"
  tools_env_add "export PLANTUML_SH=\"$wrap\""
  tools_env_add "export PLANTUML_JAR=\"$jar\""

  if ! find_plantuml_bin >/dev/null; then
    die "PlantUML wrapper written to $wrap but not discoverable"
  fi
  ok "plantuml installed user-local ($wrap)"
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
  if [[ -n "${BIZAGENT_PROVIDER:-}" ]]; then
    # Non-interactive: respect the env override.
    SELECTED_PROVIDER="${BIZAGENT_PROVIDER}"
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
  else
    # Interactive: let the user pick a provider (default grok).
    # Prefer /dev/tty so piping the installer still works when a real terminal exists.
    printf "\nChoose an LLM provider for the hub:\n"
    printf "  1) grok\n  2) chatgpt\n  3) claude\n  4) gemini\n  5) venice\n  6) ollama\n"
    _provider_choice=""
    if [[ -r /dev/tty ]]; then
      read -r -p "  Select provider [1-6, default 1 (grok)]: " _provider_choice </dev/tty || true
    else
      # No TTY (fully non-interactive pipe without BIZAGENT_PROVIDER): default grok.
      _provider_choice="1"
    fi
    case "${_provider_choice:-1}" in
      2|chatgpt) SELECTED_PROVIDER="chatgpt" ;;
      3|claude)  SELECTED_PROVIDER="claude" ;;
      4|gemini)  SELECTED_PROVIDER="gemini" ;;
      5|venice)  SELECTED_PROVIDER="venice" ;;
      6|ollama)  SELECTED_PROVIDER="ollama" ;;
      *)         SELECTED_PROVIDER="grok" ;;
    esac
  fi
  # Legacy vars still set for older install paths that reference SELECTED_CLI
  SELECTED_CLI="bizagent-agent"
  SELECTED_PROMPT_FLAG="-f"
  SELECTED_YOLO_FLAG="-y"
  ok "LLM runtime: bizagent-agent · default provider: $SELECTED_PROVIDER"

  # If the user doesn't already have their API key, now is the time to grab it:
  # the install will NOT complete until a valid key is entered at the next step.
  if [[ -z "${BIZAGENT_API_KEY:-}" ]]; then
    note "If you don't already have an API key for ${SELECTED_PROVIDER:-grok}, grab it now —"
    note "the next step requires it and the install will not finish until a valid key is entered."
  fi
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

  # Install root (control-plane) deps if present — e.g. `ws` for the web UI.
  if [[ -f "$INSTALL_DIR/package.json" ]]; then
    if command -v npm >/dev/null 2>&1; then
      (cd "$INSTALL_DIR" && npm install --silent) \
        && ok "control-plane npm dependencies installed" \
        || warn "root npm install failed — run: cd $INSTALL_DIR && npm install"
    fi
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

# Ask (or take BIZAGENT_AUTO_UPDATE) whether nightly may auto-upgrade framework code.
# Default: manual-only (false). Choice is written to registry.json settings.auto_update.
SELECTED_AUTO_UPDATE="false"

prompt_auto_update() {
  # Non-interactive override
  if [[ -n "${BIZAGENT_AUTO_UPDATE:-}" ]]; then
    case "${BIZAGENT_AUTO_UPDATE}" in
      1|true|TRUE|yes|YES|on|ON)
        SELECTED_AUTO_UPDATE="true"
        ok "auto-update: enabled (BIZAGENT_AUTO_UPDATE) — nightly may run scripts/upgrade.sh"
        ;;
      0|false|FALSE|no|NO|off|OFF)
        SELECTED_AUTO_UPDATE="false"
        ok "auto-update: manual-only (BIZAGENT_AUTO_UPDATE)"
        ;;
      *)
        warn "Unknown BIZAGENT_AUTO_UPDATE=$BIZAGENT_AUTO_UPDATE — defaulting to manual-only"
        SELECTED_AUTO_UPDATE="false"
        ;;
    esac
    return
  fi

  # No TTY: safe default
  if [[ ! -r /dev/tty ]] || [[ -n "${BIZAGENT_NONINTERACTIVE:-}" ]]; then
    SELECTED_AUTO_UPDATE="false"
    ok "auto-update: manual-only (non-interactive default)"
    note "Change later: registry.json → settings.auto_update true|false"
    return
  fi

  step "Framework updates"
  note "BizAgent can pull framework upgrades from the public repo (OddbeakerLLC/bizagent)."
  note "Upgrades never overwrite registry.json, cli.json, agents/, company/, or mail."
  note "Default is manual-only — you (or PTL) run scripts/upgrade.sh when ready."
  printf "\n"
  printf "  ${BOLD}1)${NC} Manual only ${DIM}(recommended default)${NC}\n"
  printf "  ${BOLD}2)${NC} Automatic ${DIM}(nightly may run upgrade when appropriate)${NC}\n"
  printf "\n"
  local choice=""
  while true; do
    read -r -p "  Choose [1/2] (default 1): " choice </dev/tty || choice="1"
    choice="${choice:-1}"
    case "$choice" in
      1|m|M|manual|Manual)
        SELECTED_AUTO_UPDATE="false"
        ok "auto-update: manual-only"
        break
        ;;
      2|a|A|auto|Auto|automatic|Automatic)
        SELECTED_AUTO_UPDATE="true"
        ok "auto-update: enabled (nightly may run scripts/upgrade.sh)"
        break
        ;;
      *)
        warn "Enter 1 (manual) or 2 (automatic)"
        ;;
    esac
  done
}

# Seed operator registry.json; set settings.hub_agent.provider to the default LLM.
# registry.json is gitignored; the public repo only ships registry.example.json.
write_registry_seed() {
  local dest="$INSTALL_DIR/registry.json"
  local src="$INSTALL_DIR/registry.example.json"
  local provider="${SELECTED_PROVIDER:-grok}"
  local auto_update="${SELECTED_AUTO_UPDATE:-false}"

  if [[ ! -f "$dest" ]]; then
    if [[ ! -f "$src" ]]; then
      warn "registry.example.json missing — control plane needs a registry.json"
      return
    fi
    if ! python3 - "$src" "$dest" "$provider" "$auto_update" <<'PY'
import json, sys
src, dest, provider, auto_update = sys.argv[1:5]
d = json.load(open(src))
d["org"] = ""
d["products"] = []
d["cross_product_edges"] = []
if "hub" in d and isinstance(d["hub"], dict):
    d["hub"]["name"] = "BizAgent"
settings = d.setdefault("settings", {})
settings["auto_update"] = auto_update.strip().lower() in ("1", "true", "yes", "on")
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
      ok "registry.json seeded (empty products, hub_agent.provider=$provider, auto_update=$auto_update)"
    fi
  else
    # Existing registry: ensure hub provider + auto_update preference are set.
    if ! python3 - "$dest" "$provider" "$auto_update" <<'PY'
import json, sys
path, provider, auto_update = sys.argv[1:4]
d = json.load(open(path))
settings = d.setdefault("settings", {})
# Only set auto_update when missing so re-install over existing clone keeps operator choice
# unless they explicitly passed BIZAGENT_AUTO_UPDATE (SELECTED already resolved).
# Installer always writes the choice from this run when key was prompted/env-set.
settings["auto_update"] = auto_update.strip().lower() in ("1", "true", "yes", "on")
hub_agent = settings.setdefault("hub_agent", {})
current = (hub_agent.get("provider") or hub_agent.get("cliName") or hub_agent.get("cli") or "").strip()
legacy_map = {"claude": "openrouter", "codex": "openai", "agy": "openrouter", "bizagent-agent": provider or "grok", "xai": "grok"}
if current:
    current = legacy_map.get(current, current)
    hub_agent["provider"] = current
    hub_agent["cliName"] = current
else:
    hub_agent["provider"] = provider
    hub_agent["cliName"] = provider
    if provider == "grok" and not hub_agent.get("model"):
        hub_agent["model"] = "grok-4.5"
json.dump(d, open(path, "w"), indent=2)
open(path, "a").write("\n")
print(settings.get("auto_update"))
PY
    then
      warn "could not set hub_agent.provider / auto_update on existing registry.json"
    else
      ok "registry.json hub_agent.provider + auto_update ensured"
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
    write_tools_env_lines
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
  write_tools_env_lines
}

# Append tool PATH / PlantUML / Graphviz exports so control-plane.sh inherits them.
write_tools_env_lines() {
  local env_file="$INSTALL_DIR/.bizagent/env"
  mkdir -p "$INSTALL_DIR/.bizagent"
  if [[ ${#TOOLS_ENV_LINES[@]} -eq 0 ]]; then
    # Still record discovery hints when tools were already on PATH from packages.
    local puml
    if puml="$(find_plantuml_bin 2>/dev/null)"; then
      TOOLS_ENV_LINES+=("export PLANTUML_SH="$puml"")
    fi
    if have dot; then
      TOOLS_ENV_LINES+=("export GRAPHVIZ_DOT="$(command -v dot)"")
    fi
  fi
  [[ ${#TOOLS_ENV_LINES[@]} -eq 0 ]] && return 0
  touch "$env_file"
  chmod 600 "$env_file" 2>/dev/null || true
  local line key
  for line in "${TOOLS_ENV_LINES[@]}"; do
    # Idempotent: drop prior export of same VAR then append.
    key="${line%%=*}"
    key="${key#export }"
    if grep -qE "^export ${key}=" "$env_file" 2>/dev/null; then
      local tmp
      tmp="$(mktemp)"
      grep -v -E "^export ${key}=" "$env_file" > "$tmp" || true
      mv "$tmp" "$env_file"
    fi
    printf '%s
' "$line" >> "$env_file"
  done
  ok "tool paths written to .bizagent/env (PlantUML/Graphviz/Java)"
}

# --- optional oddbeaker-tts (Kokoro) local service ---
# Installs/starts shared daemon on :9201 when possible; prompts for voice;
# persists BIZAGENT_TTS_VOICE in .bizagent/env. Soft-fails so hub install still succeeds.
ensure_oddbeaker_tts() {
  if [[ -n "${BIZAGENT_SKIP_TTS:-}" ]]; then
    ok "skipping oddbeaker-tts (BIZAGENT_SKIP_TTS)"
    return 0
  fi
  local helper=""
  if [[ -x "$INSTALL_DIR/scripts/install-oddbeaker-tts.sh" ]]; then
    helper="$INSTALL_DIR/scripts/install-oddbeaker-tts.sh"
  elif [[ -x "$(dirname "${BASH_SOURCE[0]}")/scripts/install-oddbeaker-tts.sh" ]]; then
    helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/install-oddbeaker-tts.sh"
  fi
  if [[ -z "$helper" ]]; then
    warn "install-oddbeaker-tts.sh missing — console TTS will use browser speechSynthesis only"
    note "Later: place oddbeaker-tts on the host and run scripts/install-oddbeaker-tts.sh"
    return 0
  fi
  step "Console TTS (oddbeaker-tts / Kokoro)"
  note "Optional local service on 127.0.0.1:9201. UI TTS toggle stays off until you enable it."
  note "One daemon per host — shared with other Oddbeaker products if already running."
  local args=(--hub "$INSTALL_DIR" --yes)
  # Interactive install: prompt for voice when a TTY exists
  if [[ -r /dev/tty ]] && [[ -z "${BIZAGENT_NONINTERACTIVE:-}" ]]; then
    args+=(--prompt-voice)
  fi
  if [[ -n "${BIZAGENT_TTS_VOICE:-}" ]]; then
    args+=(--voice "$BIZAGENT_TTS_VOICE")
  fi
  if [[ -n "${BIZAGENT_TTS_SOURCE:-}" ]]; then
    args+=(--source "$BIZAGENT_TTS_SOURCE")
  fi
  # Do not fail the whole BizAgent install if TTS cannot be built on this host.
  if ! bash "$helper" "${args[@]}"; then
    warn "oddbeaker-tts install reported failure — hub continues; browser TTS fallback remains"
    return 0
  fi
  ok "oddbeaker-tts step finished (voice in .bizagent/env when set)"
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
  ensure_curl
  ensure_node
  ensure_cron
  # PlantUML UI preview stack (must be present before software setup / handoff)
  ensure_java
  ensure_graphviz
  ensure_plantuml

  step "Default LLM provider"
  select_default_provider

  step "API key for hub agents"
  # INSTALL_DIR is not finalized yet; prompt still works — path hints use default until choose_dir.
  INSTALL_DIR="${BIZAGENT_DIR:-$HOME/bizagent}"
  prompt_api_key

  prompt_auto_update

  step "Setting up bizagent"
  choose_dir
  clone_repo
  detach_framework_remote
  write_cli_json
  write_registry_seed
  write_env_file
  ensure_oddbeaker_tts

  handoff
}

main "$@"
