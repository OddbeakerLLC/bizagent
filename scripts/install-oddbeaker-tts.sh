#!/usr/bin/env bash
# install-oddbeaker-tts.sh — install/start shared oddbeaker-tts (Kokoro) for BizAgent.
#
# One daemon per host on 127.0.0.1:9201. Safe to re-run. Does not clobber an
# existing BIZAGENT_TTS_VOICE in hub .bizagent/env unless --force-voice.
#
# Usage:
#   scripts/install-oddbeaker-tts.sh [--hub PATH] [--source PATH|URL]
#       [--voice ID] [--prompt-voice] [--force-voice] [--no-start]
#       [--yes|-y] [--quiet]
#
# Env:
#   BIZAGENT_TTS_SOURCE     Clone path or git URL (default: discover / SSH origin)
#   BIZAGENT_TTS_VOICE      Preferred voice id (default af_heart when prompting skipped)
#   BIZAGENT_TTS_URL        Service base URL (default http://127.0.0.1:9201)
#   BIZAGENT_TTS_DIR        Install root (default ~/.bizagent/oddbeaker-tts)
#   BIZAGENT_SKIP_TTS=1     Exit 0 immediately (installer/upgrade honor this)
#   BIZAGENT_NONINTERACTIVE Non-empty → no prompts (use env/default voice)
#   BIZAGENT_TTS_REF        Git ref when cloning (default: master)
#
# Exit codes:
#   0  ok (installed, already running, or intentionally skipped)
#   1  hard failure only when --require is set; otherwise soft-fail → 0 with warn
set -euo pipefail

HUB=""
SOURCE="${BIZAGENT_TTS_SOURCE:-}"
VOICE="${BIZAGENT_TTS_VOICE:-}"
PROMPT_VOICE=0
FORCE_VOICE=0
NO_START=0
YES=0
QUIET=0
REQUIRE=0
DEFAULT_TTS_URL="http://127.0.0.1:9201"
DEFAULT_VOICE="af_heart"
DEFAULT_GIT_SSH="ssh://git@github.com/OddbeakerLLC/oddbeaker-tts.git"
DEFAULT_GIT_SCP="git@github.com:OddbeakerLLC/oddbeaker-tts.git"
TTS_REF="${BIZAGENT_TTS_REF:-master}"

# Built-in catalog (matches oddbeaker-tts packaged defaults) for offline prompt.
BUILTIN_VOICES=(
  "af_heart|Heart|female|american"
  "af_bella|Bella|female|american"
  "am_adam|Adam|male|american"
  "am_michael|Michael|male|american"
  "bf_emma|Emma|female|british"
  "bf_isabella|Isabella|female|british"
  "bm_george|George|male|british"
  "bm_daniel|Daniel|male|british"
)

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \?//'
  exit 2
}

log() { [[ "$QUIET" -eq 1 ]] || printf '%s\n' "$*"; }
ok()  { [[ "$QUIET" -eq 1 ]] || printf '  ✓ %s\n' "$*"; }
note(){ [[ "$QUIET" -eq 1 ]] || printf '  %s\n' "$*"; }
warn(){ printf '  ! %s\n' "$*" >&2; }
die() {
  printf 'install-oddbeaker-tts: %s\n' "$*" >&2
  exit 1
}
soft_fail() {
  warn "$*"
  if [[ "$REQUIRE" -eq 1 ]]; then
    die "$*"
  fi
  warn "Console TTS stays optional (browser speechSynthesis fallback). Re-run: scripts/install-oddbeaker-tts.sh"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --voice) VOICE="${2:-}"; shift 2 ;;
    --prompt-voice) PROMPT_VOICE=1; shift ;;
    --force-voice) FORCE_VOICE=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --require) REQUIRE=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

if [[ -n "${BIZAGENT_SKIP_TTS:-}" ]]; then
  ok "skipping oddbeaker-tts (BIZAGENT_SKIP_TTS set)"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$HUB" ]]; then
  HUB="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  HUB="$(cd "$HUB" && pwd)"
fi

TTS_URL="$(printf '%s' "${BIZAGENT_TTS_URL:-$DEFAULT_TTS_URL}" | sed 's:/*$::')"
TTS_DIR="${BIZAGENT_TTS_DIR:-$HOME/.bizagent/oddbeaker-tts}"
ENV_FILE="$HUB/.bizagent/env"
PORT="9201"
if [[ "$TTS_URL" =~ :([0-9]+)$ ]]; then
  PORT="${BASH_REMATCH[1]}"
fi

have() { command -v "$1" >/dev/null 2>&1; }

tts_health_ok() {
  local body
  body="$(curl -fsS --max-time 2 "$TTS_URL/health" 2>/dev/null)" || return 1
  printf '%s' "$body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' 2>/dev/null
}

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

persist_voice() {
  local voice="$1"
  [[ -n "$voice" ]] || return 0
  local existing=""
  existing="$(env_get BIZAGENT_TTS_VOICE 2>/dev/null || true)"
  if [[ -n "$existing" && "$FORCE_VOICE" -ne 1 ]]; then
    ok "keeping existing BIZAGENT_TTS_VOICE=$existing (use --force-voice to replace)"
    VOICE="$existing"
    return 0
  fi
  env_set BIZAGENT_TTS_VOICE "$voice"
  # Ensure URL is recorded when we manage the service
  local url_existing=""
  url_existing="$(env_get BIZAGENT_TTS_URL 2>/dev/null || true)"
  if [[ -z "$url_existing" ]]; then
    env_set BIZAGENT_TTS_URL "$TTS_URL"
  fi
  ok "wrote BIZAGENT_TTS_VOICE=$voice → $ENV_FILE"
}

# --- voice catalog ---

list_voices_from_api() {
  local json
  json="$(curl -fsS --max-time 3 "$TTS_URL/voices" 2>/dev/null)" || return 1
  python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(1)
voices=d.get("voices") or []
if not voices:
    sys.exit(1)
for v in voices:
    vid=v.get("id") or ""
    if not vid: continue
    label=v.get("label") or vid
    gender=v.get("gender") or ""
    accent=v.get("accent") or ""
    print(f"{vid}|{label}|{gender}|{accent}")
' <<<"$json" 2>/dev/null
}

list_voices_from_tree() {
  local root="$1"
  local cfg=""
  for cfg in "$root/etc/tts.json" "$root/src/oddbeaker_tts/data/tts.json"; do
    [[ -f "$cfg" ]] || continue
    python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
for v in d.get("voices") or []:
    vid=v.get("id") or ""
    if not vid: continue
    label=v.get("label") or vid
    gender=v.get("gender") or ""
    accent=v.get("accent") or ""
    print(f"{vid}|{label}|{gender}|{accent}")
' "$cfg" 2>/dev/null && return 0
  done
  return 1
}

list_voices_builtin() {
  local row
  for row in "${BUILTIN_VOICES[@]}"; do
    printf '%s\n' "$row"
  done
}

collect_voices() {
  list_voices_from_api 2>/dev/null && return 0
  if [[ -d "$TTS_DIR" ]]; then
    list_voices_from_tree "$TTS_DIR" 2>/dev/null && return 0
  fi
  if [[ -n "$SOURCE" && -d "$SOURCE" ]]; then
    list_voices_from_tree "$SOURCE" 2>/dev/null && return 0
  fi
  list_voices_builtin
}

prompt_voice_choice() {
  local existing=""
  existing="$(env_get BIZAGENT_TTS_VOICE 2>/dev/null || true)"
  if [[ -n "$existing" && "$FORCE_VOICE" -ne 1 ]]; then
    VOICE="$existing"
    ok "TTS voice already set: $existing"
    return 0
  fi
  if [[ -n "$VOICE" ]]; then
    ok "TTS voice from flag/env: $VOICE"
    return 0
  fi

  # --prompt-voice forces a menu when a TTY exists even if --yes was passed
  # (install.sh uses --yes so other confirms are skipped, but still wants voice pick).
  local interactive=0
  if [[ -r /dev/tty ]] && [[ -z "${BIZAGENT_NONINTERACTIVE:-}" ]]; then
    if [[ "$PROMPT_VOICE" -eq 1 || "$YES" -ne 1 ]]; then
      interactive=1
    fi
  fi

  if [[ "$interactive" -ne 1 ]]; then
    VOICE="${VOICE:-$DEFAULT_VOICE}"
    ok "TTS voice: $VOICE (non-interactive default)"
    return 0
  fi

  local -a rows=()
  mapfile -t rows < <(collect_voices)
  [[ ${#rows[@]} -gt 0 ]] || rows=("${BUILTIN_VOICES[@]}")

  printf '\n'
  log "==> Console TTS voice (Kokoro / oddbeaker-tts)"
  note "Spoken hub replies use this voice when the TTS toggle is on (default off)."
  note "Service: $TTS_URL"
  printf '\n'
  local i=1
  local row id label gender accent
  for row in "${rows[@]}"; do
    IFS='|' read -r id label gender accent <<<"$row"
    printf '  %2d) %-14s  %s' "$i" "$id" "$label"
    if [[ -n "$gender" || -n "$accent" ]]; then
      printf '  (%s%s%s)' "$gender" "${gender:+, }" "$accent"
    fi
    if [[ "$id" == "$DEFAULT_VOICE" ]]; then
      printf '  [default]'
    fi
    printf '\n'
    i=$((i + 1))
  done
  printf '\n'
  local choice=""
  while true; do
    read -r -p "  Choose voice number or id [default $DEFAULT_VOICE]: " choice </dev/tty || choice=""
    choice="${choice// /}"
    if [[ -z "$choice" ]]; then
      VOICE="$DEFAULT_VOICE"
      break
    fi
    if [[ "$choice" =~ ^[0-9]+$ ]]; then
      if (( choice >= 1 && choice <= ${#rows[@]} )); then
        IFS='|' read -r VOICE _ <<<"${rows[$((choice - 1))]}"
        break
      fi
      warn "Enter a number 1-${#rows[@]} or a voice id"
      continue
    fi
    # Accept raw id if it matches catalog, else accept anyway (forward-compat)
    local found=0
    for row in "${rows[@]}"; do
      IFS='|' read -r id _ <<<"$row"
      if [[ "$choice" == "$id" ]]; then
        VOICE="$id"
        found=1
        break
      fi
    done
    if [[ "$found" -eq 1 ]]; then
      break
    fi
    VOICE="$choice"
    warn "Unknown catalog id — will still store '$VOICE' (service may reject if invalid)"
    break
  done
  ok "TTS voice selected: $VOICE"
}

# --- discover / install tree ---

is_tts_tree() {
  local d="$1"
  [[ -d "$d" ]] || return 1
  [[ -f "$d/pyproject.toml" ]] || return 1
  grep -q 'name[[:space:]]*=[[:space:]]*"oddbeaker-tts"' "$d/pyproject.toml" 2>/dev/null \
    || grep -q 'oddbeaker-tts' "$d/pyproject.toml" 2>/dev/null
}

discover_source() {
  local c
  if [[ -n "$SOURCE" ]]; then
    printf '%s\n' "$SOURCE"
    return 0
  fi
  for c in \
    "$TTS_DIR" \
    "$HUB/../oddbeaker-tts" \
    "$HUB/../../dev/oddbeaker-tts" \
    "$HOME/dev/oddbeaker-tts" \
    "$HOME/oddbeaker-tts" \
    "/opt/oddbeaker-tts"
  do
    if is_tts_tree "$c"; then
      (cd "$c" && pwd)
      return 0
    fi
  done
  # Prefer SSH (public HTTPS currently 404 / private)
  if have git; then
    if git ls-remote --heads "$DEFAULT_GIT_SSH" >/dev/null 2>&1; then
      printf '%s\n' "$DEFAULT_GIT_SSH"
      return 0
    fi
    if git ls-remote --heads "$DEFAULT_GIT_SCP" >/dev/null 2>&1; then
      printf '%s\n' "$DEFAULT_GIT_SCP"
      return 0
    fi
  fi
  return 1
}

ensure_python() {
  have python3 || soft_fail "python3 required to install oddbeaker-tts"
  if ! python3 -m venv --help >/dev/null 2>&1; then
    soft_fail "python3 venv module missing (install python3-venv) — cannot install oddbeaker-tts"
  fi
}

clone_or_link_source() {
  local src="$1"
  if is_tts_tree "$src"; then
    # Reuse existing tree in place when it is already the install dir, else copy path via symlink/clone-local
    if [[ "$(cd "$src" && pwd)" == "$(mkdir -p "$(dirname "$TTS_DIR")" && cd "$(dirname "$TTS_DIR")" && pwd)/$(basename "$TTS_DIR")" ]] \
      || [[ "$(cd "$src" && pwd)" == "$TTS_DIR" ]]; then
      ok "using existing oddbeaker-tts tree at $TTS_DIR"
      return 0
    fi
    # Prefer working against the discovered tree directly when writable and not a bare URL
    TTS_DIR="$(cd "$src" && pwd)"
    ok "using oddbeaker-tts source tree: $TTS_DIR"
    return 0
  fi

  # Git URL → clone into TTS_DIR
  mkdir -p "$(dirname "$TTS_DIR")"
  if [[ -d "$TTS_DIR/.git" ]] && is_tts_tree "$TTS_DIR"; then
    ok "oddbeaker-tts already cloned at $TTS_DIR"
    # best-effort fetch
    git -C "$TTS_DIR" fetch --quiet origin 2>/dev/null || true
    git -C "$TTS_DIR" checkout --quiet "$TTS_REF" 2>/dev/null \
      || git -C "$TTS_DIR" checkout --quiet master 2>/dev/null \
      || git -C "$TTS_DIR" checkout --quiet main 2>/dev/null \
      || true
    return 0
  fi
  if [[ -e "$TTS_DIR" && ! -d "$TTS_DIR/.git" ]]; then
    soft_fail "TTS install path exists but is not a git checkout: $TTS_DIR (set BIZAGENT_TTS_DIR or BIZAGENT_TTS_SOURCE)"
  fi
  note "cloning oddbeaker-tts → $TTS_DIR ..."
  if ! git clone --quiet --branch "$TTS_REF" -- "$src" "$TTS_DIR" 2>/dev/null; then
    rm -rf "$TTS_DIR" 2>/dev/null || true
    if ! git clone --quiet -- "$src" "$TTS_DIR" 2>/dev/null; then
      rm -rf "$TTS_DIR" 2>/dev/null || true
      soft_fail "failed to clone oddbeaker-tts from $src (need SSH access to OddbeakerLLC/oddbeaker-tts or a local BIZAGENT_TTS_SOURCE)"
    fi
  fi
  ok "cloned oddbeaker-tts"
}

pip_install_runtime() {
  local venv="$TTS_DIR/.venv"
  note "creating venv + installing oddbeaker-tts [runtime] (may take several minutes for torch)..."
  if [[ ! -x "$venv/bin/python" ]]; then
    python3 -m venv "$venv" || soft_fail "python3 -m venv failed in $TTS_DIR"
  fi
  # shellcheck disable=SC1091
  # Upgrade pip quietly; tolerate failure
  "$venv/bin/pip" install --upgrade pip setuptools wheel >/dev/null 2>&1 || true

  # Prefer CPU torch wheels when no NVIDIA device (faster/more reliable on CPU hosts)
  local has_gpu=0
  if have nvidia-smi && nvidia-smi >/dev/null 2>&1; then
    has_gpu=1
  fi

  if [[ "$has_gpu" -eq 0 ]]; then
    "$venv/bin/pip" install --quiet torch --index-url https://download.pytorch.org/whl/cpu \
      || warn "CPU torch pre-install failed — continuing with default pip resolver"
  fi

  if ! "$venv/bin/pip" install --quiet -e "$TTS_DIR[runtime]"; then
    # Fallback: deps without heavy runtime so API can still boot with --no-preload (engine may fail synthesize)
    warn "pip install -e '.[runtime]' failed — trying base package only"
    "$venv/bin/pip" install --quiet -e "$TTS_DIR" \
      || soft_fail "pip install oddbeaker-tts failed (network or build tools missing)"
  fi

  # spaCy model used by Kokoro phonemizer path (best-effort)
  "$venv/bin/python" -m spacy download en_core_web_sm >/dev/null 2>&1 || true

  if [[ ! -x "$venv/bin/oddbeaker-tts" ]]; then
    soft_fail "oddbeaker-tts entrypoint missing after pip install"
  fi
  ok "oddbeaker-tts package installed ($venv)"
}

write_user_unit() {
  local venv="$TTS_DIR/.venv"
  local unitdir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local unit="$unitdir/oddbeaker-tts.service"
  local cache="${ODDBEAKER_TTS_CACHE_DIR:-$HOME/.cache/oddbeaker-tts}"
  local cfg=""
  if [[ -f "$TTS_DIR/etc/tts.json" ]]; then
    cfg="$TTS_DIR/etc/tts.json"
  fi
  mkdir -p "$unitdir" "$cache"

  cat >"$unit" <<EOF
[Unit]
Description=Oddbeaker TTS Service (Kokoro) — BizAgent shared
After=network.target
# Do not fight another host product already bound to :$PORT

[Service]
Type=simple
WorkingDirectory=$TTS_DIR
ExecStart=$venv/bin/oddbeaker-tts --host 127.0.0.1 --port $PORT${cfg:+ --config $cfg} --cache-dir $cache
Restart=on-failure
RestartSec=5
Environment=HOME=$HOME
Environment=PATH=$venv/bin:/usr/local/bin:/usr/bin:/bin
Environment=PYTHONUNBUFFERED=1
Environment=LANG=C.UTF-8
Environment=ODDBEAKER_TTS_CACHE_DIR=$cache
${cfg:+Environment=ODDBEAKER_TTS_CONFIG=$cfg}

[Install]
WantedBy=default.target
EOF
  ok "wrote user unit $unit"

  # Try enable --now when user bus is available
  if have systemctl && [[ -n "${XDG_RUNTIME_DIR:-}" || -S "/run/user/$(id -u)/bus" ]]; then
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
    systemctl --user daemon-reload 2>/dev/null || true
    if systemctl --user enable --now oddbeaker-tts.service 2>/dev/null; then
      ok "systemctl --user enable --now oddbeaker-tts.service"
      return 0
    fi
    warn "systemctl --user start failed — will try foreground nohup fallback"
  else
    note "no user systemd bus — using nohup fallback for oddbeaker-tts"
  fi
  return 1
}

start_daemon_nohup() {
  local venv="$TTS_DIR/.venv"
  local cache="${ODDBEAKER_TTS_CACHE_DIR:-$HOME/.cache/oddbeaker-tts}"
  local logdir="$HOME/.bizagent/logs"
  local pidfile="$HOME/.bizagent/oddbeaker-tts.pid"
  local logfile="$logdir/oddbeaker-tts.log"
  local cfg_args=()
  mkdir -p "$cache" "$logdir"
  if [[ -f "$TTS_DIR/etc/tts.json" ]]; then
    cfg_args+=(--config "$TTS_DIR/etc/tts.json")
  fi
  if [[ -f "$pidfile" ]]; then
    local old
    old="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
      ok "oddbeaker-tts already running (pid $old)"
      return 0
    fi
  fi
  note "starting oddbeaker-tts on 127.0.0.1:$PORT (nohup)..."
  nohup "$venv/bin/oddbeaker-tts" \
    --host 127.0.0.1 --port "$PORT" \
    "${cfg_args[@]}" \
    --cache-dir "$cache" \
    >>"$logfile" 2>&1 &
  echo $! >"$pidfile"
  ok "started pid $(cat "$pidfile") — log $logfile"
}

wait_health() {
  local i=0
  while (( i < 30 )); do
    if tts_health_ok; then
      ok "oddbeaker-tts healthy at $TTS_URL/health"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  warn "oddbeaker-tts did not become healthy within 30s (model may still be loading)"
  note "check: curl -sS $TTS_URL/health"
  return 1
}

port_in_use() {
  if have ss; then
    ss -ltn 2>/dev/null | grep -qE ":${PORT}\\s" && return 0
  fi
  if (echo >/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then
    return 0
  fi
  return 1
}

start_service() {
  [[ "$NO_START" -eq 1 ]] && { note "--no-start: not launching daemon"; return 0; }

  if tts_health_ok; then
    ok "oddbeaker-tts already healthy at $TTS_URL"
    return 0
  fi

  if port_in_use && ! tts_health_ok; then
    warn "port $PORT is in use but /health failed — not starting a second daemon"
    note "fix the listener or set BIZAGENT_TTS_URL to the correct base URL"
    return 1
  fi

  if ! write_user_unit; then
    start_daemon_nohup || return 1
  fi
  wait_health || true
}

# --- main flow ---

main() {
  log "install-oddbeaker-tts: hub=$HUB"
  log "install-oddbeaker-tts: url=$TTS_URL dir=$TTS_DIR"

  # Voice first when service already up (upgrade / re-run path)
  if tts_health_ok; then
    ok "oddbeaker-tts already running"
    prompt_voice_choice
    persist_voice "${VOICE:-$DEFAULT_VOICE}"
    env_set BIZAGENT_TTS_URL "$TTS_URL"
    exit 0
  fi

  # Offer skip on interactive upgrade-style runs when --yes not set and nothing installed
  if [[ "$YES" -ne 1 && -r /dev/tty && -z "${BIZAGENT_NONINTERACTIVE:-}" && "$PROMPT_VOICE" -eq 1 ]]; then
    :
  fi

  ensure_python

  local src=""
  if ! src="$(discover_source)"; then
    soft_fail "could not find oddbeaker-tts source (set BIZAGENT_TTS_SOURCE to a local checkout or git URL with access)"
  fi
  note "source: $src"
  clone_or_link_source "$src"
  pip_install_runtime
  start_service

  prompt_voice_choice
  persist_voice "${VOICE:-$DEFAULT_VOICE}"
  env_set BIZAGENT_TTS_URL "$TTS_URL"

  if tts_health_ok; then
    ok "oddbeaker-tts ready"
    note "verify: curl -sS $TTS_URL/health && curl -sS $TTS_URL/voices"
  else
    warn "install finished but service not healthy yet — console TTS will use browser fallback until it is"
    note "manual start: $TTS_DIR/.venv/bin/oddbeaker-tts --host 127.0.0.1 --port $PORT"
  fi
}

main "$@"
