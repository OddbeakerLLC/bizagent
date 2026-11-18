#!/usr/bin/env bash
# install-oddbeaker-stt.sh — install/start shared oddbeaker-stt for BizAgent.
#
# Intent-aware speech-to-text service (verbatim + LLM cleanup). One daemon per
# host on 127.0.0.1:9202 — loopback-only by design: the control plane proxies
# /api/stt/* to it, the browser never talks to :9202 directly. Safe to re-run.
# Never clobbers an existing BIZAGENT_STT_URL in hub .bizagent/env.
#
# Usage:
#   scripts/install-oddbeaker-stt.sh [--hub PATH] [--source PATH|URL]
#       [--no-start] [--no-stt] [--yes|-y] [--quiet] [--require]
#
# Env:
#   BIZAGENT_STT_SOURCE     Clone path or git URL (default: discover / HTTPS first)
#   BIZAGENT_STT_URL        Service base URL (default http://127.0.0.1:9202;
#                           existing value in .bizagent/env is never overwritten)
#   BIZAGENT_STT_BIND       Address the daemon binds (default 127.0.0.1 — the
#                           control plane proxies it; keep it off the LAN)
#   BIZAGENT_STT_DIR        Install root (default ~/.bizagent/oddbeaker-stt)
#   BIZAGENT_SKIP_STT=1     Exit 0 immediately (installer/upgrade honor this)
#   BIZAGENT_NONINTERACTIVE Non-empty → no prompts
#   BIZAGENT_STT_REF        Git ref when cloning (default: main)
#   BIZAGENT_STT_PYTHON     Python interpreter for the venv (default: python3;
#                           needs >=3.10)
#
# Exit codes:
#   0  ok (installed, already running, or intentionally skipped)
#   3  soft failure — warned and skipped; callers must NOT print an
#      "installed/finished" ok line (best-effort callers: warn and continue)
#   1  hard failure only when --require is set
set -euo pipefail

HUB=""
SOURCE="${BIZAGENT_STT_SOURCE:-}"
NO_START=0
NO_STT=0
YES=0
QUIET=0
REQUIRE=0
DEFAULT_STT_PORT="9202"
DEFAULT_STT_BIND="127.0.0.1"
DEFAULT_GIT_HTTPS="https://github.com/OddbeakerLLC/oddbeaker-stt.git"
DEFAULT_GIT_SSH="ssh://git@github.com/OddbeakerLLC/oddbeaker-stt.git"
DEFAULT_GIT_SCP="git@github.com:OddbeakerLLC/oddbeaker-stt.git"
STT_REF="${BIZAGENT_STT_REF:-main}"
STT_PYTHON="${BIZAGENT_STT_PYTHON:-python3}"

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \?//'
  exit 2
}

log() { [[ "$QUIET" -eq 1 ]] || printf '%s\n' "$*"; }
ok()  { [[ "$QUIET" -eq 1 ]] || printf '  ✓ %s\n' "$*"; }
note(){ [[ "$QUIET" -eq 1 ]] || printf '  %s\n' "$*"; }
warn(){ printf '  ! %s\n' "$*" >&2; }
die() {
  printf 'install-oddbeaker-stt: %s\n' "$*" >&2
  exit 1
}
soft_fail() {
  warn "$*"
  if [[ "$REQUIRE" -eq 1 ]]; then
    die "$*"
  fi
  warn "Console STT (mic dictation) stays optional — chat input works without it. Re-run: scripts/install-oddbeaker-stt.sh"
  # Exit 3 (not 0): callers can tell a soft-failed STT step from a real
  # success and must not print an "installed/finished" ok line for it.
  # Best-effort callers treat any nonzero as "warn and continue".
  exit 3
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --no-stt) NO_STT=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --require) REQUIRE=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

if [[ -n "${BIZAGENT_SKIP_STT:-}" || "$NO_STT" -eq 1 ]]; then
  ok "skipping oddbeaker-stt (BIZAGENT_SKIP_STT or --no-stt)"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$HUB" ]]; then
  HUB="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  HUB="$(cd "$HUB" && pwd)"
fi

STT_BIND="${BIZAGENT_STT_BIND:-$DEFAULT_STT_BIND}"
STT_URL="$(printf '%s' "${BIZAGENT_STT_URL:-http://127.0.0.1:$DEFAULT_STT_PORT}" | sed 's:/*$::')"
STT_DIR="${BIZAGENT_STT_DIR:-$HOME/.bizagent/oddbeaker-stt}"
ENV_FILE="$HUB/.bizagent/env"
PORT="$DEFAULT_STT_PORT"
if [[ "$STT_URL" =~ :([0-9]+)$ ]]; then
  PORT="${BASH_REMATCH[1]}"
fi

have() { command -v "$1" >/dev/null 2>&1; }

stt_health_ok_at() {
  local url="$1" body
  body="$(curl -fsS --max-time 2 "$url/health" 2>/dev/null)" || return 1
  printf '%s' "$body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' 2>/dev/null
}

stt_health_ok() { stt_health_ok_at "$STT_URL"; }
stt_local_ok() { stt_health_ok_at "http://127.0.0.1:$PORT"; }

# --- env helpers (plain KEY=val for loadHubEnv + systemd EnvironmentFile) ---

env_get() {
  local key="$1" file="${2:-$ENV_FILE}"
  [[ -f "$file" ]] || return 1
  # shellcheck disable=SC2002
  cat "$file" 2>/dev/null \
    | grep -E "^(export[[:space:]]+)?${key}=" \
    | tail -n1 \
    | sed -E "s/^(export[[:space:]]+)?${key}=//" \
    | sed -E 's/^["'\'']//; s/["'\'']$//'
}

env_set() {
  local key="$1" val="$2" file="${3:-$ENV_FILE}"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  chmod 600 "$file" 2>/dev/null || true
  local tmp
  tmp="$(mktemp)"
  # Drop prior KEY= and export KEY= lines
  grep -v -E "^(export[[:space:]]+)?${key}=" "$file" >"$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file" 2>/dev/null || true
}

# Record the service URL only when the operator has not set one already.
persist_url() {
  local existing=""
  existing="$(env_get BIZAGENT_STT_URL 2>/dev/null || true)"
  if [[ -n "$existing" ]]; then
    ok "keeping existing BIZAGENT_STT_URL=$existing"
    return 0
  fi
  env_set BIZAGENT_STT_URL "$STT_URL"
  ok "wrote BIZAGENT_STT_URL=$STT_URL → $ENV_FILE"
}

# --- discover / install tree ---

is_stt_tree() {
  local d="$1"
  [[ -d "$d" ]] || return 1
  [[ -f "$d/pyproject.toml" ]] || return 1
  grep -q 'oddbeaker-stt' "$d/pyproject.toml" 2>/dev/null
}

discover_source() {
  local c
  if [[ -n "$SOURCE" ]]; then
    printf '%s\n' "$SOURCE"
    return 0
  fi
  for c in \
    "$STT_DIR" \
    "$HUB/../oddbeaker-stt" \
    "$HUB/../../dev/oddbeaker-stt" \
    "$HOME/dev/oddbeaker-stt" \
    "$HOME/oddbeaker-stt" \
    "/opt/oddbeaker-stt"
  do
    if is_stt_tree "$c"; then
      (cd "$c" && pwd)
      return 0
    fi
  done
  # HTTPS first (repo is public — works on fresh hosts with no SSH key),
  # then SSH variants for private/enterprise deployments. On total failure,
  # warn() with the real git error (stderr passes through the $(…) subshell).
  if have git; then
    local probe_err=""
    for c in "$DEFAULT_GIT_HTTPS" "$DEFAULT_GIT_SSH" "$DEFAULT_GIT_SCP"; do
      if probe_err="$(git ls-remote --heads "$c" 2>&1)"; then
        printf '%s\n' "$c"
        return 0
      fi
    done
    warn "no default oddbeaker-stt source reachable — last git error: $(printf '%s' "$probe_err" | tr '\n' ' ' | cut -c1-300)"
  fi
  return 1
}

ensure_python() {
  have "$STT_PYTHON" || soft_fail "$STT_PYTHON required to install oddbeaker-stt (set BIZAGENT_STT_PYTHON to override)"
  if ! "$STT_PYTHON" -m venv --help >/dev/null 2>&1; then
    soft_fail "$STT_PYTHON venv module missing (install python3-venv) — cannot install oddbeaker-stt"
  fi
}

clone_or_link_source() {
  local src="$1"
  if is_stt_tree "$src"; then
    if [[ "$(cd "$src" && pwd)" == "$STT_DIR" ]]; then
      ok "using existing oddbeaker-stt tree at $STT_DIR"
      return 0
    fi
    # Prefer working against the discovered tree directly when writable.
    STT_DIR="$(cd "$src" && pwd)"
    ok "using oddbeaker-stt source tree: $STT_DIR"
    return 0
  fi

  # Git URL → clone into STT_DIR
  mkdir -p "$(dirname "$STT_DIR")"
  if [[ -d "$STT_DIR/.git" ]] && is_stt_tree "$STT_DIR"; then
    ok "oddbeaker-stt already cloned at $STT_DIR"
    # best-effort fetch
    git -C "$STT_DIR" fetch --quiet origin 2>/dev/null || true
    git -C "$STT_DIR" checkout --quiet "$STT_REF" 2>/dev/null \
      || git -C "$STT_DIR" checkout --quiet main 2>/dev/null \
      || git -C "$STT_DIR" checkout --quiet master 2>/dev/null \
      || true
    return 0
  fi
  if [[ -e "$STT_DIR" && ! -d "$STT_DIR/.git" ]]; then
    soft_fail "STT install path exists but is not a git checkout: $STT_DIR (set BIZAGENT_STT_DIR or BIZAGENT_STT_SOURCE)"
  fi
  note "cloning oddbeaker-stt → $STT_DIR ..."
  local clone_err=""
  if ! clone_err="$(git clone --quiet --branch "$STT_REF" -- "$src" "$STT_DIR" 2>&1)"; then
    rm -rf "$STT_DIR" 2>/dev/null || true
    if ! clone_err="$(git clone --quiet -- "$src" "$STT_DIR" 2>&1)"; then
      rm -rf "$STT_DIR" 2>/dev/null || true
      clone_err="$(printf '%s' "$clone_err" | tr '\n' ' ' | cut -c1-300)"
      soft_fail "failed to clone oddbeaker-stt from $src (need access to OddbeakerLLC/oddbeaker-stt or a local BIZAGENT_STT_SOURCE)${clone_err:+ — git said: $clone_err}"
    fi
  fi
  ok "cloned oddbeaker-stt"
}

pip_install_runtime() {
  local venv="$STT_DIR/.venv"
  note "creating venv + installing oddbeaker-stt [stt] (may take several minutes for faster-whisper)..."
  if [[ ! -x "$venv/bin/python" ]]; then
    "$STT_PYTHON" -m venv "$venv" || soft_fail "$STT_PYTHON -m venv failed in $STT_DIR"
  fi
  # shellcheck disable=SC1091
  # Upgrade pip quietly; tolerate failure
  "$venv/bin/pip" install --upgrade pip setuptools wheel >/dev/null 2>&1 || true

  if ! "$venv/bin/pip" install --quiet -e "$STT_DIR[stt]"; then
    # Fallback: base package only (service boots; transcription needs the
    # [stt] extra — faster-whisper — to actually answer /transcribe).
    warn "pip install -e '.[stt]' failed — trying base package only"
    "$venv/bin/pip" install --quiet -e "$STT_DIR" \
      || soft_fail "pip install oddbeaker-stt failed (network or build tools missing)"
    warn "faster-whisper extra missing — /transcribe will fail until 'pip install -e .[stt]' succeeds in $venv"
  fi

  if [[ ! -x "$venv/bin/oddbeaker-stt" ]]; then
    soft_fail "oddbeaker-stt entrypoint missing after pip install"
  fi
  ok "oddbeaker-stt package installed ($venv)"
}

write_user_unit() {
  local venv="$STT_DIR/.venv"
  local unitdir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local unit="$unitdir/oddbeaker-stt.service"
  mkdir -p "$unitdir"

  cat >"$unit" <<EOF
[Unit]
Description=Oddbeaker STT Service (speech-to-text) — BizAgent shared
After=network.target
# Do not fight another host product already bound to :$PORT

[Service]
Type=simple
WorkingDirectory=$STT_DIR
ExecStart=$venv/bin/oddbeaker-stt serve --host $STT_BIND --port $PORT
Restart=on-failure
RestartSec=5
Environment=HOME=$HOME
Environment=PATH=$venv/bin:/usr/local/bin:/usr/bin:/bin
Environment=PYTHONUNBUFFERED=1
Environment=LANG=C.UTF-8

[Install]
WantedBy=default.target
EOF
  ok "wrote user unit $unit"

  # Try enable --now when user bus is available
  if have systemctl && [[ -n "${XDG_RUNTIME_DIR:-}" || -S "/run/user/$(id -u)/bus" ]]; then
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
    systemctl --user daemon-reload 2>/dev/null || true
    if systemctl --user enable --now oddbeaker-stt.service 2>/dev/null; then
      ok "systemctl --user enable --now oddbeaker-stt.service"
      return 0
    fi
    warn "systemctl --user start failed — will try foreground nohup fallback"
  else
    note "no user systemd bus — using nohup fallback for oddbeaker-stt"
  fi
  return 1
}

start_daemon_nohup() {
  local venv="$STT_DIR/.venv"
  local logdir="$HOME/.bizagent/logs"
  local pidfile="$HOME/.bizagent/oddbeaker-stt.pid"
  local logfile="$logdir/oddbeaker-stt.log"
  mkdir -p "$logdir"
  if [[ -f "$pidfile" ]]; then
    local old
    old="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
      ok "oddbeaker-stt already running (pid $old)"
      return 0
    fi
  fi
  note "starting oddbeaker-stt on $STT_BIND:$PORT (nohup)..."
  nohup "$venv/bin/oddbeaker-stt" serve \
    --host "$STT_BIND" --port "$PORT" \
    >>"$logfile" 2>&1 &
  echo $! >"$pidfile"
  ok "started pid $(cat "$pidfile") — log $logfile"
}

wait_health() {
  local i=0
  while (( i < 30 )); do
    if stt_health_ok || stt_local_ok; then
      ok "oddbeaker-stt healthy at http://127.0.0.1:$PORT/health"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  warn "oddbeaker-stt did not become healthy within 30s (model may still be loading)"
  note "check: curl -sS http://127.0.0.1:$PORT/health"
  return 1
}

port_in_use() {
  if have ss; then
    ss -ltn 2>/dev/null | grep -qE ":${PORT}\s" && return 0
  fi
  if (echo >/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then
    return 0
  fi
  return 1
}

start_service() {
  [[ "$NO_START" -eq 1 ]] && { note "--no-start: not launching daemon"; return 0; }

  if stt_health_ok || stt_local_ok; then
    ok "oddbeaker-stt already running"
    return 0
  fi

  if port_in_use && ! stt_health_ok; then
    warn "port $PORT is in use but /health failed — not starting a second daemon"
    note "fix the listener or set BIZAGENT_STT_URL to the correct base URL"
    return 1
  fi

  if ! write_user_unit; then
    start_daemon_nohup || return 1
  fi
  wait_health || true
}

# --- main flow ---

main() {
  log "install-oddbeaker-stt: hub=$HUB"
  log "install-oddbeaker-stt: url=$STT_URL dir=$STT_DIR"

  # Already up (upgrade / re-run path): just make sure the URL is recorded.
  if stt_health_ok || stt_local_ok; then
    ok "oddbeaker-stt already running"
    persist_url
    exit 0
  fi

  ensure_python

  local src=""
  if ! src="$(discover_source)"; then
    soft_fail "could not find oddbeaker-stt source (set BIZAGENT_STT_SOURCE to a local checkout or git URL with access)"
  fi
  note "source: $src"
  clone_or_link_source "$src"
  pip_install_runtime
  start_service

  persist_url

  if stt_health_ok || stt_local_ok; then
    ok "oddbeaker-stt ready"
    note "verify: curl -sS http://127.0.0.1:$PORT/health"
  else
    warn "install finished but service not healthy yet — the console mic stays disabled until it is"
    note "manual start: $STT_DIR/.venv/bin/oddbeaker-stt serve --host $STT_BIND --port $PORT"
  fi
}

main "$@"
