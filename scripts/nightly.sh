#!/usr/bin/env bash
# nightly.sh
#
# The mechanical half of the nightly maintenance pass:
#   1. route any queued messages
#   2. archive inbox messages left unactioned past the configured threshold
#
# Commit detection, sitemap refresh and journal writing are agent tasks
# driven by NIGHTLY.md — deliberately NOT done here.
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HUB"

# --- 1. route -------------------------------------------------------------
"$HUB/scripts/router.sh"

# --- 2. archive stale inbox messages -------------------------------------
DAYS="$(python3 -c '
import json
try:
    print(int(json.load(open("registry.json"))["settings"]["archive_after_days"]))
except Exception:
    print(30)
' 2>/dev/null || echo 30)"

archived=0
INBOXES=("$HUB/inbox")
for d in "$HUB"/agents/*/inbox; do
  [ -d "$d" ] && INBOXES+=("$d")
done

for ib in "${INBOXES[@]}"; do
  [ -d "$ib" ] || continue
  mkdir -p "$ib/archive"
  while IFS= read -r msg; do
    [ -e "$msg" ] || continue
    mv "$msg" "$ib/archive/"
    echo "archived (unactioned > ${DAYS}d): $(basename "$msg")"
    archived=$((archived + 1))
  done < <(find "$ib" -maxdepth 1 -type f -name '*.md' -mtime "+${DAYS}" 2>/dev/null)
done

echo "nightly: $archived stale message(s) archived"
