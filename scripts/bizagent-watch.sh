#!/usr/bin/env bash
# bizagent-watch.sh
#
# Real-time agent dispatcher using inotifywait. Watches agent inboxes and hub
# inbox for new files; immediately launches agents on .md file arrival, with
# concurrency cap and lock-based deduplication. Coexists with cron dispatcher.
#
# Usage:
#   scripts/bizagent-watch.sh                   # run in foreground
#   scripts/bizagent-watch.sh --daemon          # daemonize
#   scripts/bizagent-watch.sh --slugs a,b,c     # watch only specific slugs
#
# Config (env overrides, registry.json fallbacks):
#   BIZAGENT_MAX_CONCURRENCY       global cap on concurrent agent runs   (default 4)
#   BIZAGENT_LOCK_LEASE_SECS       max lock age before reclaim, seconds  (default 1800)
#   BIZAGENT_CLI                   CLI command to launch an agent        (default from .cli, else "claude")
#   BIZAGENT_CLI_PROMPT_FLAG       non-interactive prompt flag           (default from .cli, else "-p")
#   BIZAGENT_CLI_EXTRA_ARGS        pre-prompt CLI options (place BEFORE prompt) (default from .cli, else empty)
#   BIZAGENT_DRY_RUN               1 = print launch command, don't run   (default 0)
#   BIZAGENT_NO_ROUTE              1 = skip the router step              (default 0)
#
# Exit status is 0 on clean exit (SIGTERM caught).
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HUB" || exit 2

LOGDIR="$HUB/logs"
mkdir -p "$LOGDIR"

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { echo "$(ts) watch: $*" | tee -a "$LOGDIR/dispatch-watch.log"; }

# --- config resolution: env > registry.json settings.dispatch > default -------
reg_setting() {
  python3 - "$1" "$2" <<'PY' 2>/dev/null || echo "$2"
import json, sys
key, default = sys.argv[1], sys.argv[2]
try:
    cfg = json.load(open("registry.json"))
except Exception:
    print(default); sys.exit(0)
cur = cfg
for part in key.split("."):
    if isinstance(cur, dict) and part in cur:
        cur = cur[part]
    else:
        print(default); sys.exit(0)
print(cur)
PY
}

MAX_CONCURRENCY="${BIZAGENT_MAX_CONCURRENCY:-$(reg_setting settings.dispatch.max_concurrency 4)}"
LOCK_LEASE_SECS="${BIZAGENT_LOCK_LEASE_SECS:-$(reg_setting settings.dispatch.lock_lease_secs 1800)}"
DRY_RUN="${BIZAGENT_DRY_RUN:-0}"
NO_ROUTE="${BIZAGENT_NO_ROUTE:-0}"

# CLI command config (same as dispatch.sh)
CLI_DEFAULT="claude"
CLI_PROMPT_FLAG_DEFAULT="-p"
CLI_EXTRA_ARGS_DEFAULT=""
if [ -f "$HUB/.cli" ]; then
  # shellcheck disable=SC1091
  . "$HUB/.cli" 2>/dev/null || true
fi
CLI="${BIZAGENT_CLI:-${CLI:-$CLI_DEFAULT}}"
CLI_PROMPT_FLAG="${BIZAGENT_CLI_PROMPT_FLAG:-${CLI_PROMPT_FLAG:-$CLI_PROMPT_FLAG_DEFAULT}}"
CLI_EXTRA_ARGS="${BIZAGENT_CLI_EXTRA_ARGS:-${CLI_EXTRA_ARGS:-$CLI_EXTRA_ARGS_DEFAULT}}"

# Parse CLI args
DAEMON=0
WATCH_SLUGS=""  # empty = all slugs
while [ $# -gt 0 ]; do
  case "$1" in
    --daemon)
      DAEMON=1
      shift
      ;;
    --slugs)
      if [ $# -lt 2 ]; then
        log "ERROR: --slugs requires an argument (comma-separated list of agent slugs)"
        exit 1
      fi
      WATCH_SLUGS="$2"
      shift 2
      ;;
    *)
      log "unknown option: $1"
      exit 1
      ;;
  esac
done

# Check if inotifywait is available
if ! command -v inotifywait >/dev/null 2>&1; then
  log "ERROR: inotifywait not found. Install inotify-tools: apt install inotify-tools"
  exit 1
fi

# Hub agent config: optional, only if present in registry.json
HUB_AGENT_PROMPT=""
HUB_AGENT_MODEL=""
hub_config() {
  python3 - <<'PY' 2>/dev/null || echo ""
import json
try:
    cfg = json.load(open("registry.json"))
    hub_agent = cfg.get("settings", {}).get("hub_agent", {})
    print(hub_agent.get("prompt", ""))
except Exception:
    pass
PY
}
hub_model_config() {
  python3 - <<'PY' 2>/dev/null || echo ""
import json
try:
    cfg = json.load(open("registry.json"))
    hub_agent = cfg.get("settings", {}).get("hub_agent", {})
    print(hub_agent.get("model", ""))
except Exception:
    pass
PY
}
HUB_AGENT_PROMPT="$(hub_config)"
HUB_AGENT_MODEL="$(hub_model_config)"

# --- helpers (same as dispatch.sh) ---

pid_alive() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  case "$pid" in (*[!0-9]*) return 1;; esac
  kill -0 "$pid" 2>/dev/null
}

lock_age_secs() {
  local lockdir="$1" start now
  now="$(date +%s)"
  if [ -f "$lockdir/start" ]; then
    start="$(cat "$lockdir/start" 2>/dev/null)"
  fi
  case "${start:-}" in (''|*[!0-9]*) start="";; esac
  if [ -z "${start:-}" ]; then
    start="$(stat -c %Y "$lockdir" 2>/dev/null || stat -f %m "$lockdir" 2>/dev/null || echo "$now")"
  fi
  echo $(( now - start ))
}

try_lock() {
  local slug="$1"
  local lockdir="$HUB/agents/$slug/.lock"

  if mkdir "$lockdir" 2>/dev/null; then
    printf '%s\n' "$$" > "$lockdir/pid"
    date +%s > "$lockdir/start"
    return 0
  fi

  local pid age
  pid="$(cat "$lockdir/pid" 2>/dev/null || echo '')"
  age="$(lock_age_secs "$lockdir")"

  if pid_alive "$pid" && [ "$age" -lt "$LOCK_LEASE_SECS" ]; then
    return 1
  fi

  log "reclaiming stale lock for '$slug' (pid=${pid:-none} age=${age}s lease=${LOCK_LEASE_SECS}s)"
  rm -rf "$lockdir" 2>/dev/null
  if mkdir "$lockdir" 2>/dev/null; then
    printf '%s\n' "$$" > "$lockdir/pid"
    date +%s > "$lockdir/start"
    return 0
  fi
  return 1
}

live_run_count() {
  local n=0 lockdir pid age
  for lockdir in "$HUB"/agents/*/.lock; do
    [ -d "$lockdir" ] || continue
    pid="$(cat "$lockdir/pid" 2>/dev/null || echo '')"
    age="$(lock_age_secs "$lockdir")"
    if pid_alive "$pid" && [ "$age" -lt "$LOCK_LEASE_SECS" ]; then
      n=$((n + 1))
    fi
  done
  echo "$n"
}

pending_count() {
  local ib="$1"
  [ -d "$ib" ] || { echo 0; return; }
  find "$ib" -maxdepth 1 -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' '
}

launch_agent() {
  local slug="$1"
  local lockdir="$HUB/agents/$slug/.lock"
  local agentlog="$LOGDIR/dispatch-$slug.log"

  local prompt
  prompt="You are the '$slug' agent. Read agents/$slug/agent.md for your role, \
scope, and projects. Before making any change to a project: read that \
project's sitemap.md (especially Active Work and Known Issues) and the most \
recent 1-2 entries in its .agent/journal/, so you know current state, what \
changed recently, and anything already flagged as fragile or in-progress — \
you run with no memory of prior dispatches, so this is the only way to pick \
up context that isn't in this message. In particular: before testing \
anything end-to-end, identify which paths/URLs/files are live production \
versus test/staging, and never exercise a write/deploy/publish action \
against a production target just to verify it works. Process EVERY message \
in agents/$slug/inbox/ (ignore archive/): do the work, write replies to \
agents/$slug/outbox/, and move each handled message to \
agents/$slug/inbox/archive/ as you complete it (archive each message \
immediately after acting on it). Journal per your config."

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN launch '$slug': setsid $CLI $CLI_PROMPT_FLAG $CLI_EXTRA_ARGS <prompt>"
    rm -rf "$lockdir" 2>/dev/null
    return 0
  fi

  local inbox_pending
  inbox_pending="$(pending_count "$HUB/agents/$slug/inbox")"
  log "launching '$slug' (pending=$inbox_pending)"

  setsid bash -c '
    HUB="$1"; slug="$2"; cli="$3"; pflag="$4"; extra="$5"; prompt="$6"; agentlog="$7"
    lockdir="$HUB/agents/$slug/.lock"
    printf "%s\n" "$$" > "$lockdir/pid" 2>/dev/null
    date +%s > "$lockdir/start" 2>/dev/null
    trap "rm -rf \"$lockdir\"" EXIT
    cd "$HUB" || exit 1
    # shellcheck disable=SC2086
    "$cli" $pflag $extra "$prompt" >> "$agentlog" 2>&1
    run_status=$?
    remaining=$(find "$HUB/agents/$slug/inbox" -maxdepth 1 -name "*.md" 2>/dev/null | wc -l)
    notify_msg="$slug dispatch finished (exit $run_status, $remaining inbox msg(s) left) - check inbox/outbox."
    notify_prompt="Call the PushNotification tool exactly once with status=proactive and message=\"$notify_msg\". Do nothing else."
    # shellcheck disable=SC2086
    "$cli" $pflag --allowedTools PushNotification "$notify_prompt" >> "$agentlog" 2>&1
  ' _ "$HUB" "$slug" "$CLI" "$CLI_PROMPT_FLAG" "$CLI_EXTRA_ARGS" "$prompt" "$agentlog" \
    >> "$agentlog" 2>&1 &
  disown 2>/dev/null || true
}

launch_hub_agent() {
  local agentlog="$LOGDIR/dispatch-hub.log"
  local prompt="$HUB_AGENT_PROMPT"
  local model="$HUB_AGENT_MODEL"

  if [ -z "$prompt" ]; then
    return
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN launch hub agent"
    return 0
  fi

  log "launching hub agent"

  local extra_args="$CLI_EXTRA_ARGS"
  if [ -n "$model" ]; then
    extra_args="$extra_args --model $model"
  fi

  setsid bash -c '
    HUB="$1"; cli="$2"; pflag="$3"; extra="$4"; prompt="$5"; agentlog="$6"
    cd "$HUB" || exit 1
    # shellcheck disable=SC2086
    "$cli" $pflag $extra "$prompt" >> "$agentlog" 2>&1
    run_status=$?
    hub_msgs=$(find "$HUB/inbox" -maxdepth 1 -name "*.md" 2>/dev/null | wc -l)
    notify_msg="hub agent dispatch finished (exit $run_status, $hub_msgs inbox msg(s) left)"
    notify_prompt="Call the PushNotification tool exactly once with status=proactive and message=\"$notify_msg\". Do nothing else."
    # shellcheck disable=SC2086
    "$cli" $pflag --allowedTools PushNotification "$notify_prompt" >> "$agentlog" 2>&1
  ' _ "$HUB" "$CLI" "$CLI_PROMPT_FLAG" "$extra_args" "$prompt" "$agentlog" \
    >> "$agentlog" 2>&1 &
  disown 2>/dev/null || true
}

# --- main watcher loop ---

log "starting event-driven dispatcher (max_concurrency=$MAX_CONCURRENCY, lock_lease_secs=$LOCK_LEASE_SECS)"

# Daemonize if requested
if [ "$DAEMON" = "1" ]; then
  # Remove --daemon from args before re-invoking (to avoid infinite recursion)
  daemon_args=()
  for arg in "$@"; do
    [ "$arg" != "--daemon" ] && daemon_args+=("$arg")
  done
  nohup bash "$0" "${daemon_args[@]}" 2>&1 | tee -a "$LOGDIR/dispatch-watch.log" &
  disown
  exit 0
fi

# Build watch paths
watch_paths=()
if [ -n "$WATCH_SLUGS" ]; then
  # Watch only specified slugs
  for slug in $(echo "$WATCH_SLUGS" | tr ',' '\n'); do
    watch_paths+=("$HUB/agents/$slug/inbox")
  done
else
  # Watch all agent inboxes
  if [ -d "$HUB/agents" ]; then
    for agentdir in "$HUB"/agents/*/; do
      [ -d "$agentdir" ] || continue
      watch_paths+=("$agentdir/inbox")
    done
  fi
fi

# Add hub inbox if hub agent is configured
if [ -n "$HUB_AGENT_PROMPT" ]; then
  watch_paths+=("$HUB/inbox")
fi

if [ ${#watch_paths[@]} -eq 0 ]; then
  log "ERROR: no inboxes to watch"
  exit 1
fi

log "watching: ${watch_paths[*]}"

# Route outbox -> inbox once at startup
if [ "$NO_ROUTE" != "1" ] && [ -x "$HUB/scripts/router.sh" ]; then
  "$HUB/scripts/router.sh" >> "$LOGDIR/dispatch.log" 2>&1 || \
    log "router.sh returned non-zero (continuing)"
fi

# Cleanup on exit
cleanup() {
  log "received SIGTERM, terminating inotifywait and waiting for agents to finish..."
  # Kill inotifywait if it's still running
  pkill -P $$ inotifywait 2>/dev/null || true
  # Wait a bit for any launched agents to finish
  wait 2>/dev/null || true
  log "exiting"
  exit 0
}
trap cleanup SIGTERM

# Main event loop: inotifywait -m runs forever until SIGTERM
# Events: close_write (file closed after write), moved_to (router.sh mv)
inotifywait -m -e close_write,moved_to "${watch_paths[@]}" \
  2>/dev/null | while read -r watched_path event filename; do

  # Ignore non-.md files (close_write can fire for any file)
  [[ "$filename" != *.md ]] && continue

  # Determine if this is a hub inbox or agent inbox
  if [[ "$watched_path" == "$HUB/inbox" ]]; then
    # Hub inbox event
    if [ -z "$HUB_AGENT_PROMPT" ]; then
      continue  # hub agent not configured, skip
    fi
    # Wait for router to process if it's being called
    sleep 0.1
    running="$(live_run_count)"
    if [ "$running" -lt "$MAX_CONCURRENCY" ]; then
      launch_hub_agent
    fi
  else
    # Agent inbox event: extract slug from path like .../agents/jobe-ai/inbox
    slug="$(echo "$watched_path" | sed -n 's|.*/agents/\([^/]*\)/inbox|\1|p')"
    [ -z "$slug" ] && continue

    # Wait a moment for the file to be fully closed
    sleep 0.05

    # Try to acquire lock
    if ! try_lock "$slug"; then
      log "lock held for '$slug', skipping (concurrent dispatch)"
      continue
    fi

    # Check concurrency cap
    running="$(live_run_count)"
    if [ "$running" -ge "$MAX_CONCURRENCY" ]; then
      log "at concurrency cap ($MAX_CONCURRENCY); deferring '$slug'"
      rm -rf "$HUB/agents/$slug/.lock" 2>/dev/null
      continue
    fi

    launch_agent "$slug"
  fi

done
