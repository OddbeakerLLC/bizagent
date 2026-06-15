#!/usr/bin/env bash
# bizagent-dispatch.sh
#
# Event-driven agent dispatcher. Run on a short interval (every 1-2 min via cron
# or a systemd timer). Each tick it:
#   1. routes outbox -> inbox (calls router.sh) so freshly-written replies land,
#   2. scans agents/<slug>/inbox/*.md (excluding archive/) for pending mail,
#   3. for each agent with mail, acquires a per-agent lock (mutual exclusion),
#   4. respects a global concurrency cap,
#   5. launches the agent DETACHED (setsid) to drain its whole inbox,
#   6. the launched agent archives each message as it finishes it.
#
# The filesystem is the single source of truth:
#   pending = a .md file in agents/<slug>/inbox/   (write-once, unique filename)
#   done    = the same file moved to inbox/archive/ (atomic mv)
# There is NO checksum/seen ledger. At-least-once delivery: a crashed agent
# leaves its unfinished messages in the inbox, so the next tick retries them;
# its stale lock is reclaimed once the PID is dead or the lease expires.
#
# Cheap when idle: an idle tick is just `ls` + lock checks and spends ~zero
# tokens — it only launches the CLI when an agent actually has mail.
#
# Config (env overrides, with registry.json fallbacks via settings.dispatch.*):
#   BIZAGENT_MAX_CONCURRENCY   global cap on concurrent agent runs   (default 4)
#   BIZAGENT_LOCK_LEASE_SECS   max lock age before reclaim, seconds  (default 1800)
#   BIZAGENT_CLI               CLI command to launch an agent        (default from .cli, else "claude")
#   BIZAGENT_CLI_PROMPT_FLAG   non-interactive prompt flag           (default from .cli, else "-p")
#   BIZAGENT_CLI_EXTRA_ARGS    extra args (e.g. permission flag)     (default from .cli, else empty)
#
# Permission mode is SAFE-BY-DEFAULT: no permission flag is baked in. Unattended
# cron-driven agents run unsandboxed with whatever permissions the CLI grants, so
# autonomy is opt-in at install time (see install-dispatch.sh --allow-autonomous)
# or via BIZAGENT_CLI_EXTRA_ARGS / the .cli file. With no extra args, an
# interactive CLI may simply prompt-and-wait (and never act) under cron — that is
# intentional: the operator must choose a permission mode deliberately.
#   BIZAGENT_DRY_RUN           1 = print launch command, don't run   (default 0)
#   BIZAGENT_NO_ROUTE          1 = skip the router step              (default 0)
#
# Exit status is 0 on a normal tick (including "nothing to do").
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HUB" || exit 2

LOGDIR="$HUB/logs"
mkdir -p "$LOGDIR"

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { echo "$(ts) dispatch: $*"; }

# --- config resolution: env > registry.json settings.dispatch > default -------
reg_setting() {
  # reg_setting <dotted.key> <default>
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

# CLI command: env > .cli file > default. The .cli file (if present) is sourced
# for CLI / CLI_PROMPT_FLAG / CLI_EXTRA_ARGS, matching the install convention.
# NOTE: install-dispatch.sh writes CLI= as an ABSOLUTE path on purpose — under
# cron's minimal PATH a bare "claude" would not resolve. The bare-name default
# below is only a last resort for a hand-run tick in an interactive shell.
CLI_DEFAULT="claude"
CLI_PROMPT_FLAG_DEFAULT="-p"
# Safe-by-default: no permission flag baked in. Autonomy is opt-in (see the
# header note and install-dispatch.sh --allow-autonomous).
CLI_EXTRA_ARGS_DEFAULT=""
if [ -f "$HUB/.cli" ]; then
  # shellcheck disable=SC1091
  . "$HUB/.cli" 2>/dev/null || true
fi
CLI="${BIZAGENT_CLI:-${CLI:-$CLI_DEFAULT}}"
CLI_PROMPT_FLAG="${BIZAGENT_CLI_PROMPT_FLAG:-${CLI_PROMPT_FLAG:-$CLI_PROMPT_FLAG_DEFAULT}}"
CLI_EXTRA_ARGS="${BIZAGENT_CLI_EXTRA_ARGS:-${CLI_EXTRA_ARGS:-$CLI_EXTRA_ARGS_DEFAULT}}"

# --- helpers ------------------------------------------------------------------

# pending_count <slug> : number of *.md files directly in the agent inbox
pending_count() {
  local ib="$HUB/agents/$1/inbox"
  [ -d "$ib" ] || { echo 0; return; }
  find "$ib" -maxdepth 1 -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' '
}

# pid_alive <pid> : 0 if the process exists
pid_alive() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  case "$pid" in (*[!0-9]*) return 1;; esac
  kill -0 "$pid" 2>/dev/null
}

# lock_age_secs <lockdir> : seconds since the lock's start-epoch (or mtime)
lock_age_secs() {
  local lockdir="$1" start now
  now="$(date +%s)"
  if [ -f "$lockdir/start" ]; then
    start="$(cat "$lockdir/start" 2>/dev/null)"
  fi
  case "${start:-}" in (''|*[!0-9]*) start="";; esac
  if [ -z "${start:-}" ]; then
    # fall back to directory mtime if start-epoch is missing/corrupt
    start="$(stat -c %Y "$lockdir" 2>/dev/null || stat -f %m "$lockdir" 2>/dev/null || echo "$now")"
  fi
  echo $(( now - start ))
}

# try_lock <slug> : create agents/<slug>/.lock atomically. Returns 0 if held by
# us (created fresh OR reclaimed a stale lock), 1 if a live lock blocks us.
try_lock() {
  local slug="$1"
  local lockdir="$HUB/agents/$slug/.lock"

  if mkdir "$lockdir" 2>/dev/null; then
    printf '%s\n' "$$" > "$lockdir/pid"
    date +%s > "$lockdir/start"
    return 0
  fi

  # Lock exists. Reclaim only if the holder is dead OR the lease has expired.
  local pid age
  pid="$(cat "$lockdir/pid" 2>/dev/null || echo '')"
  age="$(lock_age_secs "$lockdir")"

  if pid_alive "$pid" && [ "$age" -lt "$LOCK_LEASE_SECS" ]; then
    return 1   # still working; do not double-launch
  fi

  # Stale: holder dead, or lease exceeded. Reclaim by replacing atomically.
  log "reclaiming stale lock for '$slug' (pid=${pid:-none} age=${age}s lease=${LOCK_LEASE_SECS}s)"
  rm -rf "$lockdir" 2>/dev/null
  if mkdir "$lockdir" 2>/dev/null; then
    printf '%s\n' "$$" > "$lockdir/pid"
    date +%s > "$lockdir/start"
    return 0
  fi
  return 1   # lost a race to another dispatcher tick; let it run
}

# count current live agent runs (locks held by an alive PID within lease)
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

# launch_agent <slug> : start the agent detached to drain its inbox, then
# release its lock on exit. The lock dir is created by try_lock BEFORE this is
# called; we hand the launched run ownership and it removes the lock when done.
launch_agent() {
  local slug="$1"
  local lockdir="$HUB/agents/$slug/.lock"
  local agentlog="$LOGDIR/dispatch-$slug.log"

  local prompt
  prompt="You are the '$slug' agent. Read agents/$slug/agent.md for your role, \
scope, and projects. Process EVERY message in agents/$slug/inbox/ (ignore \
archive/): do the work, write replies to agents/$slug/outbox/, and move each \
handled message to agents/$slug/inbox/archive/ as you complete it (archive each \
message immediately after acting on it). Journal per your config."

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN launch '$slug': setsid $CLI $CLI_PROMPT_FLAG <prompt> $CLI_EXTRA_ARGS"
    # In dry-run the agent never runs, so release the lock now to stay tidy.
    rm -rf "$lockdir" 2>/dev/null
    return 0
  fi

  log "launching '$slug' (pending=$(pending_count "$slug"))"

  # Detached wrapper: run the CLI, then ALWAYS remove the lock dir. The launched
  # subshell records its own PID into the lock so a long run is recognized as
  # live by later ticks (the dispatcher process itself exits each tick).
  setsid bash -c '
    HUB="$1"; slug="$2"; cli="$3"; pflag="$4"; extra="$5"; prompt="$6"; agentlog="$7"
    lockdir="$HUB/agents/$slug/.lock"
    printf "%s\n" "$$" > "$lockdir/pid" 2>/dev/null
    date +%s > "$lockdir/start" 2>/dev/null
    trap "rm -rf \"$lockdir\"" EXIT
    cd "$HUB" || exit 1
    # shellcheck disable=SC2086
    "$cli" $pflag "$prompt" $extra >> "$agentlog" 2>&1
  ' _ "$HUB" "$slug" "$CLI" "$CLI_PROMPT_FLAG" "$CLI_EXTRA_ARGS" "$prompt" "$agentlog" \
    >> "$agentlog" 2>&1 &
  disown 2>/dev/null || true
}

# --- tick ---------------------------------------------------------------------

# 1. Route outbox -> inbox so replies reach recipients before we scan.
if [ "$NO_ROUTE" != "1" ] && [ -x "$HUB/scripts/router.sh" ]; then
  "$HUB/scripts/router.sh" >> "$LOGDIR/dispatch.log" 2>&1 || \
    log "router.sh returned non-zero (continuing)"
fi

# 2. Scan + 3/4/5 gate-and-launch.
launched=0
skipped_locked=0
skipped_cap=0
running="$(live_run_count)"

shopt -s nullglob
for agentdir in "$HUB"/agents/*/; do
  slug="$(basename "$agentdir")"
  [ "$slug" = "*" ] && continue

  pend="$(pending_count "$slug")"
  [ "$pend" -gt 0 ] || continue   # no mail -> nothing to do (idle is cheap)

  # global concurrency cap
  if [ "$running" -ge "$MAX_CONCURRENCY" ]; then
    log "at concurrency cap ($MAX_CONCURRENCY); deferring '$slug' ($pend pending)"
    skipped_cap=$((skipped_cap + 1))
    continue
  fi

  if try_lock "$slug"; then
    launch_agent "$slug"
    launched=$((launched + 1))
    running=$((running + 1))
  else
    skipped_locked=$((skipped_locked + 1))
  fi
done
shopt -u nullglob

if [ "$launched" -gt 0 ] || [ "$skipped_locked" -gt 0 ] || [ "$skipped_cap" -gt 0 ]; then
  log "tick: launched=$launched skipped(locked)=$skipped_locked skipped(cap)=$skipped_cap running~=$running"
fi
exit 0
