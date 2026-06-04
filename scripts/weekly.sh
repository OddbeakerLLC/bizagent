#!/usr/bin/env bash
# weekly.sh
#
# The mechanical half of the weekly Knowledge Stack refresh:
#   1. enablement check (exit cleanly if disabled)
#   2. cleanup of orphaned slug files in knowledge-stack/
#
# Synthesis, agent messaging, URL fetching, manifest writing are agent
# tasks driven by WEEKLY.md — deliberately NOT done here.
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HUB"

# --- 1. enablement check ---------------------------------------------------
ENABLED="$(python3 -c '
import json
try:
    cfg = json.load(open("registry.json"))
    print("true" if cfg.get("knowledge_stack", {}).get("enabled") else "false")
except Exception:
    print("false")
' 2>/dev/null || echo false)"

if [ "$ENABLED" != "true" ]; then
  echo "weekly: knowledge_stack disabled, exiting"
  exit 0
fi

# --- 2. orphan cleanup -----------------------------------------------------
STACK="$HUB/knowledge-stack"
if [ ! -d "$STACK" ]; then
  echo "weekly: knowledge-stack/ missing, nothing to clean"
  exit 0
fi

SLUGS="$(python3 -c '
import json
print("\n".join(p["slug"] for p in json.load(open("registry.json")).get("products", [])))
' 2>/dev/null)"

removed=0
for f in "$STACK"/*; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  case "$base" in
    MANIFEST.md|00-company-*) continue ;;
  esac
  matched=false
  while IFS= read -r slug; do
    [ -z "$slug" ] && continue
    if [[ "$base" == "${slug}-"* ]]; then
      matched=true
      break
    fi
  done <<< "$SLUGS"
  if ! $matched; then
    rm "$f"
    echo "weekly: removed orphan $base (no matching slug in registry)"
    removed=$((removed + 1))
  fi
done

echo "weekly: $removed orphan file(s) removed"
