#!/usr/bin/env bash
# scripts/prune-archives.sh
#
# Prune old files from inbox/outbox archive directories.
# Default retention: 15 days (settings.tuning.archive.retention_days in registry.json).
#
# Usage:
#   scripts/prune-archives.sh [--days N] [--dry-run] [--verbose] [hub-path]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB="$ROOT"
DAYS=""
DRY_RUN=0
VERBOSE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--days N] [--dry-run] [--verbose] [hub-path]

Prunes *.md files older than N days from:
  inbox/archive/
  outbox/archive/          (if present)
  agents/*/inbox/archive/
  agents/*/outbox/archive/
  user/inbox/archive/
  user/*/inbox/archive/    (enterprise seats)

Default N comes from registry.json settings.tuning.archive.retention_days (15).
Always keeps the newest keep_min_files_per_dir files in each directory (default 5).
EOF
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days) DAYS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    -h|--help) usage ;;
    *)
      if [[ -d "$1" ]]; then HUB="$(cd "$1" && pwd)"; shift
      else echo "Unknown option: $1" >&2; usage; fi
      ;;
  esac
done

# Read defaults from registry.json
read_tuning() {
  python3 - "$HUB" <<'PY'
import json, os, sys
hub = sys.argv[1]
days, keep = 15, 5
try:
    reg = json.load(open(os.path.join(hub, "registry.json")))
    arch = ((reg.get("settings") or {}).get("tuning") or {}).get("archive") or {}
    if arch.get("retention_days") is not None:
        days = int(arch["retention_days"])
    if arch.get("keep_min_files_per_dir") is not None:
        keep = int(arch["keep_min_files_per_dir"])
except Exception:
    pass
print(f"{days} {keep}")
PY
}

TUNING="$(read_tuning)"
DEFAULT_DAYS="${TUNING%% *}"
KEEP_MIN="${TUNING##* }"
DAYS="${DAYS:-$DEFAULT_DAYS}"

if ! [[ "$DAYS" =~ ^[0-9]+$ ]] || [ "$DAYS" -lt 1 ]; then
  echo "Error: --days must be a positive integer" >&2
  exit 1
fi
if ! [[ "$KEEP_MIN" =~ ^[0-9]+$ ]]; then
  KEEP_MIN=5
fi

CUTOFF_EPOCH=$(date -d "$DAYS days ago" +%s 2>/dev/null || date -v-"${DAYS}d" +%s 2>/dev/null)
echo "Pruning archives older than ${DAYS} days (keep newest ${KEEP_MIN} per dir)"
[ "$DRY_RUN" -eq 1 ] && echo "DRY RUN — no files will be deleted"

TOTAL=0

prune_dir() {
  local dir="$1"
  local count=0
  [ -d "$dir" ] || return 0

  # List md files by mtime ascending (oldest first)
  local -a files=()
  while IFS= read -r -d '' f; do
    files+=("$f")
  done < <(find "$dir" -maxdepth 1 -type f -name '*.md' -print0 2>/dev/null | sort -z)

  local n=${#files[@]}
  [ "$n" -eq 0 ] && return 0

  # Index of first file we are allowed to delete (protect newest KEEP_MIN)
  local protect_from=$(( n > KEEP_MIN ? n - KEEP_MIN : 0 ))

  local i=0
  for file in "${files[@]}"; do
    if [ "$i" -ge "$protect_from" ]; then
      ((i++)) || true
      continue
    fi
    local mtime
    mtime=$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null || echo 0)
    if [ "$mtime" -lt "$CUTOFF_EPOCH" ]; then
      local ds
      ds=$(date -d "@$mtime" +%Y-%m-%d 2>/dev/null || date -r "$mtime" +%Y-%m-%d 2>/dev/null || echo unknown)
      if [ "$DRY_RUN" -eq 1 ]; then
        echo "Would delete: $file ($ds)"
      else
        rm -f "$file"
        [ "$VERBOSE" -eq 1 ] && echo "Deleted: $file ($ds)"
      fi
      count=$((count + 1))
    fi
    i=$((i + 1))
  done

  if [ "$count" -gt 0 ] || [ "$VERBOSE" -eq 1 ]; then
    echo "  $dir — pruned $count file(s) (had $n)"
  fi
  TOTAL=$((TOTAL + count))
}

# Collect archive dirs
prune_dir "$HUB/inbox/archive"
prune_dir "$HUB/outbox/archive"
prune_dir "$HUB/user/inbox/archive"

shopt -s nullglob
for d in "$HUB/agents"/*/inbox/archive "$HUB/agents"/*/outbox/archive; do
  prune_dir "$d"
done
for d in "$HUB/user"/*/inbox/archive; do
  # skip the top-level user/inbox/archive already handled
  case "$d" in
    "$HUB/user/inbox/archive") continue ;;
  esac
  prune_dir "$d"
done
shopt -u nullglob

echo "Archive pruning done. Total pruned: $TOTAL (retention ${DAYS}d, dry_run=$DRY_RUN)"

# Structured log (best-effort)
if command -v node >/dev/null 2>&1; then
  node -e '
    try {
      const { logEvent } = require("./control-plane/lib/log");
      logEvent(process.argv[1], {
        event: "archive_prune",
        retention_days: Number(process.argv[2]),
        dry_run: process.argv[3] === "1",
        pruned: Number(process.argv[4]),
        status: "completed"
      });
    } catch (e) {}
  ' "$HUB" "$DAYS" "$DRY_RUN" "$TOTAL" 2>/dev/null || true
fi
