#!/usr/bin/env bash
# defer.sh — schedule a one-shot deferred wake mail (no heartbeat daemon).
#
# Schedule:
#   scripts/defer.sh --to <slug|hub> --from <slug|hub> --in <duration> \
#     --subject "..." --body "..." | --body-file PATH
#     [--id ID] [--conversation-id ID] [--once-key KEY] [--hub PATH]
#
# Cancel / list / reconcile:
#   scripts/defer.sh --cancel <defer_id>
#   scripts/defer.sh --list [--to slug]
#   scripts/defer.sh --reconcile
#
# See docs/DEFERRED-WAKE.md
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HUB="$(cd "$SCRIPT_DIR/.." && pwd)"
HUB="${BIZAGENT_HUB:-$DEFAULT_HUB}"
FIRE_SH="$SCRIPT_DIR/lib/defer-fire.sh"

# shellcheck source=lib/log-ts.sh
. "$SCRIPT_DIR/lib/log-ts.sh"

MIN_DELAY=60
MAX_DELAY=$((7 * 24 * 3600))
MAX_PENDING_PER_TO=20
MAX_BODY=32768
MAX_SUBJECT=120

log() {
  mkdir -p "$HUB/logs"
  printf '%s %s\n' "$(bizagent_ts)" "$1" | tee -a "$HUB/logs/defer.log" >/dev/null
}

die() {
  echo "defer.sh: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF' >&2
usage:
  scripts/defer.sh --to SLUG --from SLUG --in DURATION --subject TEXT \
      (--body TEXT | --body-file PATH) [--id ID] [--conversation-id ID] \
      [--once-key KEY] [--hub PATH]
  scripts/defer.sh --cancel DEFER_ID [--hub PATH]
  scripts/defer.sh --list [--to SLUG] [--hub PATH]
  scripts/defer.sh --reconcile [--hub PATH]

DURATION: Nm|Nmin|Nh|Nhr|Nd or integer seconds (min 60s, max 7d)
EOF
  exit 2
}

# --- parse args ---
MODE="schedule"
TO=""
FROM=""
IN_RAW=""
SUBJECT=""
BODY=""
BODY_FILE=""
DEFER_ID=""
CID=""
ONCE_KEY=""
CANCEL_ID=""
LIST_TO=""

while [ $# -gt 0 ]; do
  case "$1" in
    --hub)
      [ $# -ge 2 ] || usage
      HUB="$(cd "$2" && pwd)"
      shift 2
      ;;
    --to)
      [ $# -ge 2 ] || usage
      TO="$2"
      shift 2
      ;;
    --from)
      [ $# -ge 2 ] || usage
      FROM="$2"
      shift 2
      ;;
    --in)
      [ $# -ge 2 ] || usage
      IN_RAW="$2"
      shift 2
      ;;
    --subject)
      [ $# -ge 2 ] || usage
      SUBJECT="$2"
      shift 2
      ;;
    --body)
      [ $# -ge 2 ] || usage
      BODY="$2"
      shift 2
      ;;
    --body-file)
      [ $# -ge 2 ] || usage
      BODY_FILE="$2"
      shift 2
      ;;
    --id)
      [ $# -ge 2 ] || usage
      DEFER_ID="$2"
      shift 2
      ;;
    --conversation-id)
      [ $# -ge 2 ] || usage
      CID="$2"
      shift 2
      ;;
    --once-key)
      [ $# -ge 2 ] || usage
      ONCE_KEY="$2"
      shift 2
      ;;
    --cancel)
      [ $# -ge 2 ] || usage
      MODE="cancel"
      CANCEL_ID="$2"
      shift 2
      ;;
    --list)
      MODE="list"
      shift
      ;;
    --reconcile)
      MODE="reconcile"
      shift
      ;;
    -h|--help) usage ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

PENDING_DIR="$HUB/.bizagent/defer/pending"
FIRED_DIR="$HUB/.bizagent/defer/fired"
CANCELLED_DIR="$HUB/.bizagent/defer/cancelled"
LOCKS_DIR="$HUB/.bizagent/defer/locks"
mkdir -p "$PENDING_DIR" "$FIRED_DIR" "$CANCELLED_DIR" "$LOCKS_DIR" "$HUB/logs"

valid_slug() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_-]+$'
}

# Returns 0 if slug is hub or a registry product
known_recipient() {
  local slug="$1"
  [ "$slug" = "hub" ] && return 0
  python3 - "$HUB" "$slug" <<'PY'
import json, sys
hub, slug = sys.argv[1], sys.argv[2]
reg = json.load(open(f"{hub}/registry.json", encoding="utf-8"))
slugs = {p.get("slug") for p in reg.get("products", []) if p.get("slug")}
sys.exit(0 if slug in slugs else 1)
PY
}

parse_duration() {
  # prints seconds to stdout
  local raw="$1"
  python3 - "$raw" "$MIN_DELAY" "$MAX_DELAY" <<'PY'
import re, sys
raw, min_d, max_d = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
raw = raw.strip().lower()
secs = None
if re.fullmatch(r"\d+", raw):
    secs = int(raw)
else:
    m = re.fullmatch(r"(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours|d|day|days)", raw)
    if not m:
        print(f"invalid duration: {raw}", file=sys.stderr)
        sys.exit(1)
    n = int(m.group(1))
    unit = m.group(2)
    if unit in ("s", "sec", "secs", "seconds"):
        secs = n
    elif unit in ("m", "min", "mins", "minutes"):
        secs = n * 60
    elif unit in ("h", "hr", "hrs", "hours"):
        secs = n * 3600
    else:
        secs = n * 86400
if secs < min_d:
    print(f"duration {secs}s below minimum {min_d}s", file=sys.stderr)
    sys.exit(1)
if secs > max_d:
    print(f"duration {secs}s above maximum {max_d}s", file=sys.stderr)
    sys.exit(1)
print(secs)
PY
}

gen_id() {
  local to="$1"
  local ts hex
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  hex="$(openssl rand -hex 3 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(3))')"
  # keep unit-name safe
  to_safe="$(printf '%s' "$to" | tr -c 'A-Za-z0-9_-' '-' | cut -c1-40)"
  echo "${ts}-${to_safe}-${hex}"
}

count_pending_for() {
  local to="$1"
  python3 - "$PENDING_DIR" "$to" <<'PY'
import json, os, sys
d, to = sys.argv[1], sys.argv[2]
n = 0
for name in os.listdir(d):
    if not name.endswith(".json"):
        continue
    try:
        meta = json.load(open(os.path.join(d, name), encoding="utf-8"))
    except Exception:
        continue
    if meta.get("status") == "pending" and meta.get("to") == to:
        n += 1
print(n)
PY
}

find_once_key() {
  local to="$1" key="$2"
  python3 - "$PENDING_DIR" "$to" "$key" <<'PY'
import json, os, sys
d, to, key = sys.argv[1], sys.argv[2], sys.argv[3]
if not key:
    sys.exit(0)
for name in os.listdir(d):
    if not name.endswith(".json"):
        continue
    path = os.path.join(d, name)
    try:
        meta = json.load(open(path, encoding="utf-8"))
    except Exception:
        continue
    if meta.get("status") == "pending" and meta.get("to") == to and meta.get("once_key") == key:
        print(meta.get("id") or name[:-5])
        sys.exit(0)
PY
}

stop_timer() {
  local backend="$1" ref="$2" id="$3"
  case "$backend" in
    systemd-run)
      local unit="${ref:-bizagent-defer-${id}}"
      unit="${unit%.service}"
      unit="${unit%.timer}"
      systemctl --user stop "${unit}.timer" 2>/dev/null || true
      systemctl --user stop "${unit}.service" 2>/dev/null || true
      systemctl --user reset-failed "${unit}.service" 2>/dev/null || true
      systemctl --user reset-failed "${unit}.timer" 2>/dev/null || true
      ;;
    at)
      [ -n "$ref" ] && atrm "$ref" 2>/dev/null || true
      ;;
    sleep)
      if [ -n "$ref" ] && printf '%s' "$ref" | grep -Eq '^[0-9]+$'; then
        kill "$ref" 2>/dev/null || true
      fi
      ;;
  esac
}

cancel_one() {
  local id="$1"
  local json="$PENDING_DIR/${id}.json"
  local body="$PENDING_DIR/${id}.body.md"
  if [ ! -f "$json" ]; then
    # already fired?
    if [ -f "$FIRED_DIR/${id}.json" ]; then
      die "defer $id already fired — cannot cancel delivered mail"
    fi
    if [ -f "$CANCELLED_DIR/${id}.json" ]; then
      echo "defer.sh: $id already cancelled"
      return 0
    fi
    die "unknown defer_id: $id"
  fi
  local backend ref status
  backend="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("timer_backend",""))' "$json")"
  ref="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("timer_ref","") or "")' "$json")"
  status="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$json")"
  if [ "$status" = "firing" ]; then
    # Allow cancel if the fire lock is free (stuck after kill/crash); else refuse.
    lock="$LOCKS_DIR/${id}.lock"
    if [ -f "$lock" ]; then
      if flock -n 8 8<"$lock" 2>/dev/null; then
        : # lock free — treat as stuck firing, allow cancel
      else
        die "defer $id is currently firing — cannot cancel"
      fi
    fi
  fi
  stop_timer "$backend" "$ref" "$id"
  python3 - "$json" "$body" "$CANCELLED_DIR" "$id" <<'PY'
import json, os, sys, shutil
from datetime import datetime, timezone
jp, bp, cdir, did = sys.argv[1:5]
with open(jp, encoding="utf-8") as f:
    meta = json.load(f)
meta["status"] = "cancelled"
meta["cancelled_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
os.makedirs(cdir, exist_ok=True)
dest = os.path.join(cdir, f"{did}.json")
tmp = dest + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, dest)
if os.path.isfile(bp):
    shutil.move(bp, os.path.join(cdir, f"{did}.body.md"))
os.unlink(jp)
PY
  log "defer: cancelled $id"
  echo "cancelled $id"
}

# --- schedule timer backends ---
schedule_timer() {
  local id="$1" secs="$2"
  local cmd
  # absolute paths for timer context
  cmd="$(printf '%q' "$FIRE_SH") $(printf '%q' "$id") --hub $(printf '%q' "$HUB")"

  # 1) systemd-run --user
  if command -v systemd-run >/dev/null 2>&1; then
    local unit="bizagent-defer-${id}"
    # unit names max ~256; truncate if needed
    if [ "${#unit}" -gt 180 ]; then
      unit="bizagent-defer-$(printf '%s' "$id" | tail -c 120)"
    fi
    # stop any leftover with same name
    systemctl --user stop "${unit}.timer" 2>/dev/null || true
    systemctl --user stop "${unit}.service" 2>/dev/null || true
    if systemd-run --user --collect \
        --on-active="${secs}s" \
        --unit="$unit" \
        bash -c "$cmd" >/dev/null 2>&1; then
      echo "systemd-run ${unit}"
      return 0
    fi
  fi

  # 2) at
  if command -v at >/dev/null 2>&1; then
    local mins=$(( (secs + 59) / 60 ))
    [ "$mins" -lt 1 ] && mins=1
    local out job
    if out=$(echo "bash -c $(printf '%q' "$cmd")" | at "now + ${mins} minutes" 2>&1); then
      job="$(printf '%s\n' "$out" | sed -n 's/.*job[[:space:]]\+\([0-9]\+\).*/\1/p' | head -1)"
      if [ -n "$job" ]; then
        echo "at ${job}"
        return 0
      fi
    fi
  fi

  # 3) sleep child
  nohup bash -c "sleep $(printf '%q' "$secs"); exec $cmd" >/dev/null 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "sleep ${pid}"
  return 0
}

do_list() {
  python3 - "$PENDING_DIR" "$LIST_TO" <<'PY'
import json, os, sys
d, only = sys.argv[1], sys.argv[2]
rows = []
if not os.path.isdir(d):
    print("(no pending defers)")
    sys.exit(0)
for name in sorted(os.listdir(d)):
    if not name.endswith(".json"):
        continue
    try:
        meta = json.load(open(os.path.join(d, name), encoding="utf-8"))
    except Exception:
        continue
    if meta.get("status") not in (None, "pending", "firing", "error"):
        continue
    if only and meta.get("to") != only:
        continue
    rows.append(meta)
if not rows:
    print("(no pending defers)")
    sys.exit(0)
print(f"{'ID':<42} {'TO':<16} {'FIRE_AT':<22} {'BACKEND':<12} SUBJECT")
for m in sorted(rows, key=lambda x: x.get("fire_at") or ""):
    print(f"{str(m.get('id','')):<42} {str(m.get('to','')):<16} {str(m.get('fire_at','')):<22} {str(m.get('timer_backend','')):<12} {str(m.get('subject',''))[:40]}")
    if m.get("once_key"):
        print(f"  once_key={m.get('once_key')}")
PY
}

do_reconcile() {
  python3 - "$PENDING_DIR" <<'PY' | while IFS=$'\t' read -r action id rest; do
import json, os, sys, time
from datetime import datetime, timezone
d = sys.argv[1]
now = time.time()
if not os.path.isdir(d):
    sys.exit(0)
for name in sorted(os.listdir(d)):
    if not name.endswith(".json"):
        continue
    path = os.path.join(d, name)
    try:
        meta = json.load(open(path, encoding="utf-8"))
    except Exception:
        continue
    status = meta.get("status")
    did = meta.get("id") or name[:-5]
    if status == "error":
        print(f"fire\t{did}\tretry_error")
        continue
    if status != "pending":
        continue
    fire_at = meta.get("fire_at") or ""
    # parse ISO Z
    try:
        if fire_at.endswith("Z"):
            fire_at_p = fire_at[:-1] + "+00:00"
        else:
            fire_at_p = fire_at
        ft = datetime.fromisoformat(fire_at_p).timestamp()
    except Exception:
        ft = 0
    if ft <= now:
        print(f"fire\t{did}\toverdue")
        continue
    backend = meta.get("timer_backend") or ""
    ref = str(meta.get("timer_ref") or "")
    alive = True
    if backend == "sleep":
        alive = False
        if ref.isdigit():
            try:
                os.kill(int(ref), 0)
                alive = True
            except OSError:
                alive = False
    elif backend == "systemd-run":
        unit = ref or f"bizagent-defer-{did}"
        unit = unit.replace(".service", "").replace(".timer", "")
        # check timer or service
        rc = os.system(f"systemctl --user is-active --quiet {unit}.timer 2>/dev/null || systemctl --user is-active --quiet {unit}.service 2>/dev/null")
        alive = (rc == 0)
    elif backend == "at":
        # if job id still in atq
        if ref:
            rc = os.system(f"atq 2>/dev/null | awk '{{print $1}}' | grep -qx {ref}")
            alive = (rc == 0)
        else:
            alive = False
    else:
        alive = False
    if not alive:
        remaining = max(int(ft - now), 1)
        print(f"reschedule\t{did}\t{remaining}")
PY
    case "$action" in
      fire)
        log "defer reconcile: firing $id ($rest)"
        bash "$FIRE_SH" "$id" --hub "$HUB" || log "defer reconcile: fire failed $id"
        ;;
      reschedule)
        local secs="$rest"
        log "defer reconcile: reschedule $id in ${secs}s"
        local result backend ref
        result="$(schedule_timer "$id" "$secs")"
        backend="${result%% *}"
        ref="${result#* }"
        python3 - "$PENDING_DIR/${id}.json" "$backend" "$ref" "$secs" <<'PY'
import json, os, sys
from datetime import datetime, timezone, timedelta
path, backend, ref, secs = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
with open(path, encoding="utf-8") as f:
    meta = json.load(f)
meta["timer_backend"] = backend
meta["timer_ref"] = ref
meta["delay_seconds"] = secs
meta["fire_at"] = (datetime.now(timezone.utc) + timedelta(seconds=secs)).strftime("%Y-%m-%dT%H:%M:%SZ")
meta["reconciled_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, path)
PY
        echo "rescheduled $id backend=$backend ref=$ref"
        ;;
    esac
  done
  # prune fired older than 7 days
  python3 - "$FIRED_DIR" <<'PY'
import os, sys, time
d = sys.argv[1]
if not os.path.isdir(d):
    sys.exit(0)
cutoff = time.time() - 7 * 86400
for name in os.listdir(d):
    path = os.path.join(d, name)
    try:
        if os.path.getmtime(path) < cutoff:
            os.unlink(path)
    except OSError:
        pass
PY
  log "defer: reconcile complete"
  echo "reconcile complete"
}

# --- modes ---
case "$MODE" in
  cancel)
    [ -n "$CANCEL_ID" ] || usage
    cancel_one "$CANCEL_ID"
    exit 0
    ;;
  list)
    do_list
    exit 0
    ;;
  reconcile)
    do_reconcile
    exit 0
    ;;
esac

# --- schedule mode ---
[ -n "$TO" ] || die "--to is required"
[ -n "$FROM" ] || die "--from is required"
[ -n "$IN_RAW" ] || die "--in is required"
[ -n "$SUBJECT" ] || die "--subject is required"

valid_slug "$TO" || die "invalid --to slug"
valid_slug "$FROM" || die "invalid --from slug"
known_recipient "$TO" || die "unknown --to recipient: $TO (not hub or registry product)"
known_recipient "$FROM" || die "unknown --from sender: $FROM"

# Authorization: product agents may only wake self or hub; hub may wake anyone
if [ "$FROM" != "hub" ]; then
  if [ "$TO" != "$FROM" ] && [ "$TO" != "hub" ]; then
    die "product agent $FROM may only --to self or hub (got --to $TO)"
  fi
fi

if [ -n "$BODY_FILE" ]; then
  [ -f "$BODY_FILE" ] || die "body file not found: $BODY_FILE"
  BODY="$(cat "$BODY_FILE")"
fi
[ -n "$BODY" ] || die "--body or --body-file is required"

BODY_LEN="$(printf '%s' "$BODY" | wc -c)"
if [ "$BODY_LEN" -gt "$MAX_BODY" ]; then
  die "body exceeds ${MAX_BODY} bytes"
fi
if [ "${#SUBJECT}" -gt "$MAX_SUBJECT" ]; then
  die "subject exceeds ${MAX_SUBJECT} chars"
fi

SECS="$(parse_duration "$IN_RAW")" || exit 1

# once_key replace
if [ -n "$ONCE_KEY" ]; then
  OLD_ID="$(find_once_key "$TO" "$ONCE_KEY" || true)"
  if [ -n "${OLD_ID:-}" ]; then
    log "defer: once-key replace $OLD_ID -> new"
    cancel_one "$OLD_ID" >/dev/null || true
  fi
fi

PENDING_N="$(count_pending_for "$TO")"
if [ "$PENDING_N" -ge "$MAX_PENDING_PER_TO" ]; then
  die "too many pending defers for $TO (max $MAX_PENDING_PER_TO)"
fi

if [ -z "$DEFER_ID" ]; then
  DEFER_ID="$(gen_id "$TO")"
else
  printf '%s' "$DEFER_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || die "invalid --id"
  [ ! -f "$PENDING_DIR/${DEFER_ID}.json" ] || die "defer_id already pending: $DEFER_ID"
fi

FIRE_AT="$(python3 - "$SECS" <<'PY'
from datetime import datetime, timezone, timedelta
import sys
secs = int(sys.argv[1])
print((datetime.now(timezone.utc) + timedelta(seconds=secs)).strftime("%Y-%m-%dT%H:%M:%SZ"))
PY
)"
CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Write body first
printf '%s\n' "$BODY" > "$PENDING_DIR/${DEFER_ID}.body.md"

# Schedule timer
RESULT="$(schedule_timer "$DEFER_ID" "$SECS")"
BACKEND="${RESULT%% *}"
REF="${RESULT#* }"

# Write metadata
python3 - "$PENDING_DIR/${DEFER_ID}.json" \
  "$DEFER_ID" "$TO" "$FROM" "$SUBJECT" "$CREATED" "$FIRE_AT" "$SECS" \
  "$CID" "$ONCE_KEY" "$BACKEND" "$REF" "$HUB" <<'PY'
import json, os, sys
path = sys.argv[1]
meta = {
    "id": sys.argv[2],
    "to": sys.argv[3],
    "from": sys.argv[4],
    "subject": sys.argv[5],
    "created_at": sys.argv[6],
    "fire_at": sys.argv[7],
    "delay_seconds": int(sys.argv[8]),
    "conversation_id": sys.argv[9] or None,
    "once_key": sys.argv[10] or None,
    "status": "pending",
    "timer_backend": sys.argv[11],
    "timer_ref": sys.argv[12],
    "hub_root": sys.argv[13],
}
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, path)
PY

log "defer: scheduled id=$DEFER_ID to=$TO in=${SECS}s backend=$BACKEND ref=$REF"
echo "scheduled id=$DEFER_ID to=$TO fire_at=$FIRE_AT backend=$BACKEND"
exit 0
