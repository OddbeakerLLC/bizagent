#!/usr/bin/env bash
# router.sh
#
# Deliver messages between agents. Scans the hub outbox and every product
# agent's outbox, reads each message's `to:` field, and moves the file into
# that recipient's inbox. Addressing is by agent slug:
#   to: hub          -> <hub>/inbox/
#   to: <slug>       -> <hub>/agents/<slug>/inbox/
#
# An unknown recipient or a missing `to:` field is a warning, not an error;
# the message is left in place for a human to look at.
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HUB"

inbox_for() {
  if [ "$1" = "hub" ]; then
    echo "$HUB/inbox"
  else
    echo "$HUB/agents/$1/inbox"
  fi
}

routed=0
warned=0

OUTBOXES=("$HUB/outbox")
for d in "$HUB"/agents/*/outbox; do
  [ -d "$d" ] && OUTBOXES+=("$d")
done

for ob in "${OUTBOXES[@]}"; do
  [ -d "$ob" ] || continue
  for msg in "$ob"/*.md; do
    [ -e "$msg" ] || continue
    to="$(grep -m1 -E '^to:[[:space:]]*' "$msg" 2>/dev/null \
          | sed -E 's/^to:[[:space:]]*//' | tr -d '[:space:]')"
    if [ -z "$to" ]; then
      echo "WARN: no 'to:' field in $(basename "$msg") — left in place" >&2
      warned=$((warned + 1))
      continue
    fi
    dest="$(inbox_for "$to")"
    if [ -d "$dest" ]; then
      mv "$msg" "$dest/"
      echo "routed: $(basename "$msg") -> $to"
      routed=$((routed + 1))
    else
      echo "WARN: unknown recipient '$to' in $(basename "$msg") — left in place" >&2
      warned=$((warned + 1))
    fi
  done
done

echo "router: $routed delivered, $warned warning(s)"
