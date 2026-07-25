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

# --- 0. pull all project repos -----------------------------------------
pull_project_paths() {
  python3 - <<'PY'
import json, os, sys
try:
    reg = json.load(open("registry.json"))
    for p in reg.get("products", []):
        for proj in p.get("projects", []):
            path = proj.get("path", "").strip()
            if path:
                print(path)
except Exception as e:
    print(f"registry read error: {e}", file=sys.stderr)
PY
}

while IFS= read -r rel; do
  [ -z "$rel" ] && continue
  # expand ~ and resolve relative to HUB
  expanded="${rel/#\~/$HOME}"
  [[ "$expanded" != /* ]] && expanded="$HUB/$expanded"
  # normalize (resolve ../)
  expanded="$(cd "$expanded" 2>/dev/null && pwd)" || { echo "pull skipped (not found): $rel"; continue; }
  if [ -d "$expanded/.git" ]; then
    out=$(git -C "$expanded" pull --ff-only 2>&1) \
      && echo "pulled: $rel" \
      || echo "pull skipped ($rel): $out"
  fi
done < <(pull_project_paths)

# pull the hub itself if it is a git checkout with a remote
if [ -d "$HUB/.git" ] && git -C "$HUB" remote | grep -q .; then
  git -C "$HUB" pull --ff-only 2>&1 || echo "hub pull skipped (continuing)"
fi

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

# --- 3. prune old archive files (makeover: settings.tuning.archive) -----
# Deletes aged *.md under */archive/ dirs. Default retention 15 days.
# Controlled by registry.json settings.tuning.archive.prune_on_nightly (default true).
PRUNE_ON="$(python3 -c '
import json
try:
    arch = json.load(open("registry.json")).get("settings", {}).get("tuning", {}).get("archive", {})
    print("0" if arch.get("prune_on_nightly") is False else "1")
except Exception:
    print("1")
' 2>/dev/null || echo 1)"
if [ "$PRUNE_ON" = "1" ] && [ -x "$HUB/scripts/prune-archives.sh" ]; then
  echo "nightly: pruning archives..."
  bash "$HUB/scripts/prune-archives.sh" "$HUB" || echo "nightly: archive prune failed (continuing)"
else
  echo "nightly: archive prune skipped"
fi
