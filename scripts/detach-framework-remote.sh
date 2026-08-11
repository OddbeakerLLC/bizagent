#!/usr/bin/env bash
# detach-framework-remote.sh — turn a fresh public-framework clone into an
# operational hub git repo that cannot accidentally push private data upstream.
#
# Usage:
#   scripts/detach-framework-remote.sh [hub-path]
#
# 1. Removes remotes that point at the public BizAgent framework (or any
#    github.com/*bizagent* public-style URL).
# 2. Rewrites .gitignore for *ops* mode: track registry.json, agent.md,
#    journal/, company/, knowledge-stack/ — still ignore secrets, mail, runtime.
# 3. Prints how to attach a *private* hub remote (recommended for nightly backup).
set -euo pipefail

HUB="$(cd "${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}" && pwd)"
cd "$HUB"

if [[ ! -d "$HUB/.git" ]]; then
  echo "detach-framework-remote: not a git repo: $HUB" >&2
  exit 1
fi

is_public_framework_url() {
  local url
  url="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
  # Public framework only — private remotes (e.g. you/bizagent-ops) must not match.
  case "$url" in
    *github.com[/:]oddbeakerllc/bizagent.git*|*github.com[/:]oddbeakerllc/bizagent)
      return 0 ;;
  esac
  return 1
}

removed=0
while read -r name; do
  [[ -z "$name" ]] && continue
  # Dual-use checkouts may keep the public repo as a remote named "framework"
  # for pushing framework fixes; only strip public URLs from origin/other names.
  if [[ "$name" == "framework" ]]; then
    echo "keeping remote '$name' (framework push remote)"
    continue
  fi
  url="$(git -C "$HUB" remote get-url "$name" 2>/dev/null || true)"
  if is_public_framework_url "$url"; then
    git -C "$HUB" remote remove "$name"
    echo "removed public framework remote: $name → $url"
    removed=$((removed + 1))
  fi
done < <(git -C "$HUB" remote)

if [[ "$removed" -eq 0 ]]; then
  if git -C "$HUB" remote | grep -q .; then
    echo "no public-framework remotes found (existing remotes left in place):"
    git -C "$HUB" remote -v
  else
    echo "no remotes configured (local-only hub)"
  fi
fi

# Ops .gitignore: track private operational source of truth; still block secrets/mail.
if [[ -f "$HUB/.gitignore" ]]; then
  if ! grep -q 'OPS_HUB_GITIGNORE' "$HUB/.gitignore" 2>/dev/null; then
    cat >> "$HUB/.gitignore" <<'EOF'

# --- OPS_HUB_GITIGNORE (appended by detach-framework-remote.sh) ---
# Operational hub tracks registry + agent standing docs + knowledge.
# Override framework rules that ignore them for the *public* repo.
!registry.json
!cli.json
!journal/
!journal/**
!company/
!company/**
!knowledge-stack/
!knowledge-stack/**
!library/
!library/**
!agents/
!agents/**
# Still never commit live mail or lock noise under agents/
agents/*/.lock/
agents/*/.dispatch.md
agents/*/inbox/
agents/*/outbox/
EOF
    echo "appended ops-hub .gitignore overrides (track registry/agents/knowledge; ignore mail)"
  else
    echo "ops-hub .gitignore overrides already present"
  fi
fi

# Prefer registry hub.remote when set and no remotes left
hub_remote="$(python3 - <<'PY' 2>/dev/null || true
import json
try:
    r = json.load(open("registry.json")).get("hub", {}).get("remote", "") or ""
    print(r.strip())
except Exception:
    pass
PY
)"
if [[ -n "$hub_remote" ]] && ! git -C "$HUB" remote | grep -q .; then
  git -C "$HUB" remote add origin "$hub_remote"
  echo "added origin from registry.json hub.remote: $hub_remote"
fi

cat <<EOF

========================================================================
  OPERATIONAL HUB — private git remote (recommended)
========================================================================
  This directory is no longer linked to the public BizAgent framework
  remote (if it was). Nightly maintenance should commit and *push* hub
  changes (registry, agents/*/agent.md, journal/, company/,
  knowledge-stack/, local code tweaks) to a remote *you* control.

  Options:
    1) Private Git hosting (GitHub private repo, Gitea, etc.):
         git remote add origin git@YOUR_HOST:YOU/bizagent-ops.git
         git push -u origin main

    2) Local bare backup on this machine:
         git init --bare ~/bizagent-ops.git
         git remote add origin ~/bizagent-ops.git
         git push -u origin main

    3) Local-only (no remote): nightly still commits locally; no off-box backup.

  Also set registry.json:
         "hub": { "name": "BizAgent", "remote": "<same URL as origin>" }

  Never point origin at the public framework repo again.
========================================================================
EOF
