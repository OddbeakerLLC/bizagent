#!/usr/bin/env bash
# defer-fire.sh — internal one-shot: deliver a pending deferred wake to an inbox.
# Not for casual agent use. Invoked by systemd-run / at / sleep backends.
#
# Usage: scripts/lib/defer-fire.sh <defer_id> [--hub PATH]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_HUB="$(cd "$SCRIPTS_DIR/.." && pwd)"
HUB="${BIZAGENT_HUB:-$DEFAULT_HUB}"

# shellcheck source=log-ts.sh
. "$SCRIPT_DIR/log-ts.sh"

log() {
  local msg="$1"
  mkdir -p "$HUB/logs"
  printf '%s %s\n' "$(bizagent_ts)" "$msg" | tee -a "$HUB/logs/defer.log" >/dev/null
  # also echo for timer journal
  printf '%s %s\n' "$(bizagent_ts)" "$msg" >&2
}

usage() {
  echo "usage: defer-fire.sh <defer_id> [--hub PATH]" >&2
  exit 2
}

DEFER_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hub)
      [ $# -ge 2 ] || usage
      HUB="$(cd "$2" && pwd)"
      shift 2
      ;;
    -h|--help) usage ;;
    -*)
      echo "defer-fire.sh: unknown option: $1" >&2
      usage
      ;;
    *)
      if [ -n "$DEFER_ID" ]; then usage; fi
      DEFER_ID="$1"
      shift
      ;;
  esac
done

[ -n "$DEFER_ID" ] || usage

# Sanitize id (no path tricks)
if ! printf '%s' "$DEFER_ID" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  log "defer-fire: invalid id rejected"
  exit 1
fi

PENDING_DIR="$HUB/.bizagent/defer/pending"
FIRED_DIR="$HUB/.bizagent/defer/fired"
JSON_PATH="$PENDING_DIR/${DEFER_ID}.json"
BODY_PATH="$PENDING_DIR/${DEFER_ID}.body.md"
LOCK_DIR="$HUB/.bizagent/defer/locks"

mkdir -p "$PENDING_DIR" "$FIRED_DIR" "$LOCK_DIR" "$HUB/logs"

# Acquire exclusive lock for this id
LOCK="$LOCK_DIR/${DEFER_ID}.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  log "defer-fire: $DEFER_ID already locked — exit 0"
  exit 0
fi

if [ ! -f "$JSON_PATH" ]; then
  log "defer-fire: $DEFER_ID missing pending json — noop"
  exit 0
fi

# Load + claim via python (atomic status transition pending -> firing).
# Write claimed fields to a small JSON sidecar; bash reads with python -c.
CLAIM_META="$(mktemp --suffix=.json)"
CLAIM_STATUS="$(python3 - "$JSON_PATH" "$CLAIM_META" <<'PY'
import json, sys, os
from datetime import datetime, timezone
path, out_path = sys.argv[1], sys.argv[2]
try:
    with open(path, "r", encoding="utf-8") as f:
        meta = json.load(f)
except Exception as e:
    json.dump({"error": str(e)}, open(out_path, "w"))
    print("ERROR")
    sys.exit(0)
status = str(meta.get("status") or "")
if status != "pending":
    json.dump({"prev": status}, open(out_path, "w"))
    print("SKIP")
    sys.exit(0)
meta["status"] = "firing"
meta["firing_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, path)
# fields needed for delivery
fields = {
    "to": meta.get("to") or "",
    "from": meta.get("from") or "",
    "subject": meta.get("subject") or "",
    "conversation_id": meta.get("conversation_id") or "",
    "once_key": meta.get("once_key") or "",
}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(fields, f)
print("OK")
PY
)"

if [ "$CLAIM_STATUS" = "SKIP" ]; then
  rm -f "$CLAIM_META"
  log "defer-fire: $DEFER_ID status not pending — noop"
  exit 0
fi
if [ "$CLAIM_STATUS" != "OK" ]; then
  err="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("error",""))' "$CLAIM_META" 2>/dev/null || true)"
  rm -f "$CLAIM_META"
  log "defer-fire: $DEFER_ID claim failed: $CLAIM_STATUS $err"
  exit 0
fi

TO="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("to",""))' "$CLAIM_META")"
FROM="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("from",""))' "$CLAIM_META")"
SUBJECT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("subject",""))' "$CLAIM_META")"
CID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("conversation_id","") or "")' "$CLAIM_META")"
ONCE_KEY="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("once_key","") or "")' "$CLAIM_META")"
rm -f "$CLAIM_META"

if [ ! -f "$BODY_PATH" ]; then
  log "defer-fire: $DEFER_ID missing body — mark error"
  python3 - "$JSON_PATH" "missing body.md" <<'PY'
import json, sys, os
path, err = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    meta = json.load(f)
meta["status"] = "error"
meta["last_error"] = err
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, path)
PY
  exit 1
fi

# Resolve inbox (Option A: direct write)
INBOX="$(python3 - "$HUB" "$TO" <<'PY'
import json, os, sys
hub, to = sys.argv[1], sys.argv[2]
if to == "hub":
    print(os.path.join(hub, "inbox"))
    sys.exit(0)
if to == "user":
    print("ERR\tuser recipient not allowed for defer-wake")
    sys.exit(1)
reg_path = os.path.join(hub, "registry.json")
try:
    reg = json.load(open(reg_path, encoding="utf-8"))
except Exception as e:
    print(f"ERR\tregistry: {e}")
    sys.exit(1)
slugs = {p.get("slug") for p in reg.get("products", []) if p.get("slug")}
if to not in slugs:
    print(f"ERR\tunknown recipient: {to}")
    sys.exit(1)
print(os.path.join(hub, "agents", to, "inbox"))
PY
)" || {
  log "defer-fire: $DEFER_ID inbox resolve failed: $INBOX"
  python3 - "$JSON_PATH" "inbox resolve failed" <<'PY'
import json, sys, os
path, err = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    meta = json.load(f)
meta["status"] = "error"
meta["last_error"] = err
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, path)
PY
  exit 1
}

if [[ "$INBOX" == ERR$'\t'* ]] || [[ "$INBOX" == ERR* ]]; then
  log "defer-fire: $DEFER_ID $INBOX"
  exit 1
fi

mkdir -p "$INBOX"

# Subject slug (match control-plane mail.js)
SUBJ_SLUG="$(python3 -c '
import re, sys
s = sys.argv[1].lower()
s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:48] or "message"
print(s)
' "$SUBJECT")"

DATE_UTC="$(date -u +%Y-%m-%d)"
BASENAME="${DATE_UTC}-${FROM}-${SUBJ_SLUG}.md"

# Build + unique-write message (body read from file — never via argv)
DELIVERED="$(python3 - "$INBOX" "$BASENAME" "$BODY_PATH" "$FROM" "$TO" "$DATE_UTC" "$SUBJECT" "$DEFER_ID" "$CID" <<'PY'
import os, sys, secrets
inbox, basename, body_path, from_s, to_s, date_s, subject, defer_id, cid = sys.argv[1:10]
with open(body_path, encoding="utf-8") as f:
    body = f.read().replace("\r\n", "\n").rstrip() + "\n"
lines = [
    "---",
    f"from: {from_s}",
    f"to: {to_s}",
    f"date: {date_s}",
    f"subject: {subject}",
]
if cid:
    lines.append(f"conversation_id: {cid}")
lines.append(f"defer_id: {defer_id}")
lines.append("kind: defer-wake")
lines.append("---")
lines.append("")
content = "\n".join(lines) + "\n" + body
stem, ext = os.path.splitext(basename)
os.makedirs(inbox, exist_ok=True)
for attempt in range(20):
    suffix = "" if attempt == 0 else f"-{secrets.token_hex(3)}"
    dest = os.path.join(inbox, f"{stem}{suffix}{ext}")
    try:
        fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        print(dest)
        sys.exit(0)
    except FileExistsError:
        continue
print("ERR\tcould not allocate unique filename", file=sys.stderr)
sys.exit(1)
PY
)" || {
  log "defer-fire: $DEFER_ID write failed"
  python3 - "$JSON_PATH" "inbox write failed" <<'PY'
import json, sys, os
path, err = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    meta = json.load(f)
meta["status"] = "error"
meta["last_error"] = err
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, path)
PY
  exit 1
}

# Move pending → fired
mkdir -p "$FIRED_DIR"
python3 - "$JSON_PATH" "$BODY_PATH" "$FIRED_DIR" "$DEFER_ID" "$DELIVERED" <<'PY'
import json, os, sys, shutil
from datetime import datetime, timezone
json_path, body_path, fired_dir, defer_id, delivered = sys.argv[1:6]
with open(json_path, encoding="utf-8") as f:
    meta = json.load(f)
meta["status"] = "fired"
meta["fired_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
meta["delivered_file"] = delivered
dest_json = os.path.join(fired_dir, f"{defer_id}.json")
dest_body = os.path.join(fired_dir, f"{defer_id}.body.md")
tmp = dest_json + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, dest_json)
if os.path.isfile(body_path):
    shutil.move(body_path, dest_body)
os.unlink(json_path)
PY

# Best-effort cancel leftover timer unit / pid
BACKEND="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("timer_backend",""))' "$FIRED_DIR/${DEFER_ID}.json" 2>/dev/null || true)"
TIMER_REF="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("timer_ref","") or "")' "$FIRED_DIR/${DEFER_ID}.json" 2>/dev/null || true)"
case "$BACKEND" in
  systemd-run)
    unit="${TIMER_REF:-bizagent-defer-${DEFER_ID}}"
    unit="${unit%.service}"
    unit="${unit%.timer}"
    systemctl --user stop "${unit}.timer" 2>/dev/null || true
    systemctl --user stop "${unit}.service" 2>/dev/null || true
    systemctl --user reset-failed "${unit}.service" 2>/dev/null || true
    systemctl --user reset-failed "${unit}.timer" 2>/dev/null || true
    ;;
  at)
    if [ -n "${TIMER_REF:-}" ]; then
      atrm "$TIMER_REF" 2>/dev/null || true
    fi
    ;;
  sleep)
    if [ -n "${TIMER_REF:-}" ] && printf '%s' "$TIMER_REF" | grep -Eq '^[0-9]+$'; then
      kill "$TIMER_REF" 2>/dev/null || true
    fi
    ;;
esac

log "defer-fire: $DEFER_ID delivered to=$TO file=$(basename "$DELIVERED")"
exit 0
