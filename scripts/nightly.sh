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
elif [ -d "$HUB/.git" ]; then
  echo "hub: no git remote — local-only (set a private origin for nightly backup; see scripts/detach-framework-remote.sh)"
fi

# --- 0b. reconcile deferred wakes (overdue fire / dead timers) ------------
if [ -x "$HUB/scripts/defer.sh" ]; then
  echo "nightly: reconciling deferred wakes..."
  bash "$HUB/scripts/defer.sh" --reconcile --hub "$HUB" \
    || echo "nightly: defer reconcile failed (continuing)"
else
  echo "nightly: defer.sh missing — skip reconcile"
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

# --- 4. optional: commit + push (subcommand) -----------------------------
# Usage: scripts/nightly.sh push
# Called at the *end* of NIGHTLY.md after journals/sitemaps so product repos
# and the hub ops repo are backed up. Never points at the public framework.
if [ "${1:-}" = "push" ]; then
  # Only the public framework repo — private remotes named bizagent-ops etc. are fine.
  is_public_framework_url() {
    local url
    url="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
    case "$url" in
      *github.com[/:]oddbeakerllc/bizagent.git*|*github.com[/:]oddbeakerllc/bizagent)
        return 0 ;;
    esac
    return 1
  }

  commit_and_push() {
    local dir="$1" label="$2"
    [ -d "$dir/.git" ] || return 0
    # Refuse to push to a public framework URL if that is the only remote.
    local bad=0 r url
    while read -r r; do
      [[ -z "$r" ]] && continue
      url="$(git -C "$dir" remote get-url "$r" 2>/dev/null || true)"
      if is_public_framework_url "$url"; then
        echo "push refused ($label): remote $r points at public framework ($url)"
        bad=1
      fi
    done < <(git -C "$dir" remote)
    if [ "$bad" -eq 1 ]; then
      return 0
    fi
    (
      cd "$dir" || exit 0
      git add -A 2>/dev/null || true
      if git status --porcelain 2>/dev/null | grep -q .; then
        git commit -m "nightly: ${label} $(date -u +%Y-%m-%d)" 2>&1 \
          || echo "commit skipped ($label)"
      else
        echo "clean: $label"
      fi
      if git remote 2>/dev/null | grep -q .; then
        git push 2>&1 && echo "pushed: $label" \
          || echo "push skipped ($label)"
      else
        echo "no remote: $label (local commit only, if any)"
      fi
    )
  }

  echo "nightly: commit + push product projects and hub..."
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    expanded="${rel/#\~/$HOME}"
    [[ "$expanded" != /* ]] && expanded="$HUB/$expanded"
    expanded="$(cd "$expanded" 2>/dev/null && pwd)" || continue
    commit_and_push "$expanded" "$rel"
  done < <(pull_project_paths)

  # Ensure hub.remote from registry is wired if present and hub has no remote.
  if [ -d "$HUB/.git" ] && ! git -C "$HUB" remote | grep -q .; then
    hub_remote="$(python3 - <<'PY' 2>/dev/null || true
import json
try:
    print((json.load(open("registry.json")).get("hub") or {}).get("remote") or "")
except Exception:
    pass
PY
)"
    if [ -n "$hub_remote" ]; then
      git -C "$HUB" remote add origin "$hub_remote" 2>/dev/null \
        && echo "hub: added origin from registry hub.remote" \
        || true
    fi
  fi
  commit_and_push "$HUB" "hub"

  if [ -d "$HUB/.git" ] && ! git -C "$HUB" remote | grep -q .; then
    echo "hub: still no private remote — journals/KS stay local only"
    echo "  tip: git remote add origin <private-url>  OR set hub.remote in registry.json"
  fi
fi
