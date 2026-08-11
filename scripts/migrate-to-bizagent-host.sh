#!/usr/bin/env bash
# Migrate this live BizAgent hub + registry projects to host bizagent.
# Run on the SOURCE machine (current hub).
#
# Usage:
#   scripts/migrate-to-bizagent-host.sh --dry-run
#   scripts/migrate-to-bizagent-host.sh --apply
#   scripts/migrate-to-bizagent-host.sh --apply --target tmanso@bizagent
#
# Projects: git clone/fetch on the target when a remote is known (avoids
# node_modules and other bulky untracked trees). Rsync only for path-only
# projects with no remote.
#
# Does NOT stop the source control plane. Cut over manually after verify.
set -euo pipefail

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${MIGRATE_TARGET:-tmanso@bizagent}"
TARGET_HUB_REL="bizagent"
TARGET_DEV_REL="dev"
DRY_RUN=1
SKIP_PROJECTS=0
BOOTSTRAP=1
# Prefer Host alias "bizagent" (IdentityFile in ~/.ssh/config). Override via RSYNC_RSH / --target.
RSYNC_RSH="${RSYNC_RSH:-ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new}"

usage() {
  cat <<'EOF'
Usage: migrate-to-bizagent-host.sh [--dry-run|--apply] [options]

  --dry-run              plan only (default)
  --apply                perform copy/clone + remote bootstrap
  --target USER@HOST     default: tmanso@bizagent
  --skip-projects        hub runtime only
  --no-bootstrap         skip remote npm/install-control-plane
  -h, --help             this help

Projects with a git remote are cloned (or fetched) on the target.
Projects without a remote fall back to rsync (still excluding node_modules, models, etc.).
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --apply) DRY_RUN=0; shift ;;
    --target)
      [ -n "${2:-}" ] || { echo "ERROR: --target needs USER@HOST" >&2; exit 2; }
      TARGET="$2"; shift 2
      ;;
    --skip-projects) SKIP_PROJECTS=1; shift ;;
    --no-bootstrap) BOOTSTRAP=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

command -v rsync >/dev/null || die "rsync required"
command -v ssh >/dev/null || die "ssh required"
command -v python3 >/dev/null || die "python3 required"
[ -f "$HUB/registry.json" ] || die "no registry.json in $HUB"

RSYNC_FLAGS=(-az --human-readable --info=stats2,progress2)
if [ "$DRY_RUN" -eq 1 ]; then
  RSYNC_FLAGS+=(-n)
  log "MODE=dry-run (no changes on target)"
else
  log "MODE=apply → $TARGET"
fi

log "Checking SSH to $TARGET ..."
PUBKEY="$(cat "$HOME/.ssh/id_rsa.pub" 2>/dev/null || cat "$HOME/.ssh/id_ed25519.pub" 2>/dev/null || echo "(no default pubkey found)")"
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$TARGET" 'echo OK $(whoami)@$(hostname)' </dev/null; then
  cat <<EOF

SSH to $TARGET failed (BatchMode publickey).

On the bizagent host, authorize this source key for the target user
(and ensure ~/.ssh/config Host entry points at the right IdentityFile):

$PUBKEY

Then re-run:
  $0 --dry-run
  $0 --apply
EOF
  exit 3
fi

ssh "$TARGET" "mkdir -p ~/$TARGET_HUB_REL ~/$TARGET_DEV_REL" </dev/null

# --- Hub rsync ---
log "Rsync hub → $TARGET:~/$TARGET_HUB_REL"
# shellcheck disable=SC2086
rsync "${RSYNC_FLAGS[@]}" \
  -e "$RSYNC_RSH" \
  --delete-delay \
  --exclude '.git/objects/pack/tmp_*' \
  --exclude 'node_modules/' \
  --exclude 'agent-runtime/node_modules/' \
  --exclude 'logs/' \
  --exclude '.bizagent/runtime-cwd/' \
  --exclude '.bizagent/hub.sock' \
  --exclude '.bizagent/*.pid' \
  --exclude '.bizagent/control-plane.pid' \
  --exclude '.bizagent/hub-daemon.pid' \
  --exclude '.bizagent/hub.lock' \
  --exclude '.bizagent/prompts/turns/' \
  --exclude '.bizagent/pending-replies/*.body.md' \
  --exclude 'agents/*/.lock/' \
  "$HUB/" "$TARGET:~/$TARGET_HUB_REL/" </dev/null

# --- Projects (prefer git clone on target; rsync only when no remote) ---
if [ "$SKIP_PROJECTS" -eq 0 ]; then
  log "Seed registry projects on $TARGET:~/$TARGET_DEV_REL (clone-first)"
  PROJECT_LIST="$(mktemp)"
  python3 - "$HUB" >"$PROJECT_LIST" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

hub = Path(sys.argv[1])
dev = (hub / "../dev").resolve()
home = Path.home()
r = json.load(open(hub / "registry.json"))
seen = set()
for p in r.get("products", []):
    for proj in p.get("projects", []):
        path = (proj.get("path") or "").strip()
        name = proj.get("name") or ""
        remote = (proj.get("remote") or "").strip()
        if not path or not name:
            continue
        if path.startswith("~/"):
            ap = (home / path[2:]).resolve()
        else:
            ap = (hub / path).resolve()
        key = str(ap)
        if key in seen:
            continue
        seen.add(key)
        if not remote and ap.exists() and (ap / ".git").exists():
            try:
                remote = subprocess.check_output(
                    ["git", "-C", str(ap), "remote", "get-url", "origin"],
                    text=True,
                    stderr=subprocess.DEVNULL,
                ).strip()
            except Exception:
                remote = ""
        if not ap.exists() and not remote:
            print(f"MISSING\t{name}\t{ap}", file=sys.stderr)
            continue
        rel = None
        try:
            rel = str(ap.relative_to(dev))
        except ValueError:
            pass
        if rel is None:
            try:
                rel = str(ap.relative_to(home / "dev"))
            except ValueError:
                rel = name
        print(f"{name}\t{ap}\t{rel}\t{remote}")
PY

  # Use FD 3 for the project list so ssh/rsync cannot consume remaining lines on stdin.
  while IFS=$'\t' read -r name ap rel remote <&3; do
    [ -n "${name:-}" ] || continue
    log "  project $name → ~/dev/$rel (remote=${remote:-none})"
    ssh "$TARGET" "mkdir -p ~/${TARGET_DEV_REL}/$(dirname -- "$rel")" </dev/null

    if [ -n "${remote:-}" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        log "  [dry-run] would git clone/fetch $remote → ~/$TARGET_DEV_REL/$rel"
        continue
      fi
      if ! ssh "$TARGET" bash -s -- "$remote" "$TARGET_DEV_REL/$rel" <<'REMOTE_GIT'
set -euo pipefail
remote="$1"
rel="$2"
dest="$HOME/$rel"
if [ -d "$dest/.git" ]; then
  git -C "$dest" remote set-url origin "$remote" 2>/dev/null || true
  git -C "$dest" fetch --all --prune || true
  # Stay on current branch; do not force-reset (preserve any local target work)
  echo "FETCH_OK $dest"
  exit 0
fi
if [ -e "$dest" ] && [ ! -d "$dest/.git" ]; then
  echo "EXISTS_NOT_GIT $dest — leaving in place" >&2
  exit 0
fi
parent="$(dirname -- "$dest")"
mkdir -p "$parent"
git clone -- "$remote" "$dest"
echo "CLONE_OK $dest"
REMOTE_GIT
      then
        log "WARN: git clone/fetch failed for $name (continuing)"
      fi
      continue
    fi

    # No remote: fall back to rsync of source tree (still exclude bulky dirs)
    [ -d "$ap" ] || { log "SKIP missing $name ($ap) and no remote"; continue; }
    if ! rsync "${RSYNC_FLAGS[@]}" \
      -e "$RSYNC_RSH" \
      --exclude 'node_modules/' \
      --exclude '.venv/' \
      --exclude 'venv/' \
      --exclude '__pycache__/' \
      --exclude '.pytest_cache/' \
      --exclude 'artifacts/' \
      --exclude 'models/' \
      --exclude '*.gguf' \
      --exclude 'hf-cache/' \
      --exclude 'bitnet-2b4t/' \
      --exclude 'falcon3-1b-bitnet/' \
      --exclude 'qwen3-8b-bitnet/' \
      --exclude 'qwen3-8b-bitnet.ternary/' \
      --exclude 'tmp/' \
      --exclude 'logs/' \
      --exclude '.mypy_cache/' \
      "$ap/" "$TARGET:~/$TARGET_DEV_REL/$rel/" </dev/null; then
      rc=$?
      log "WARN: rsync exit $rc for project $name (continuing)"
    fi
  done 3<"$PROJECT_LIST"
  rm -f "$PROJECT_LIST"
else
  log "Skipping projects (--skip-projects)"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry-run complete. Re-run with --apply to copy and bootstrap."
  exit 0
fi

if [ "$BOOTSTRAP" -eq 1 ]; then
  log "Remote bootstrap on $TARGET"
  ssh "$TARGET" bash -s <<'REMOTE'
set -euo pipefail
HUB="$HOME/bizagent"
cd "$HUB"

if ! command -v node >/dev/null 2>&1; then
  echo "WARNING: node not in PATH. Install Node >= 20 (nvm or distro), then re-run bootstrap."
  echo "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  exit 4
fi
echo "node $(node -v) at $(command -v node)"

if [ -f package-lock.json ]; then
  npm ci --omit=dev 2>/dev/null || npm ci || npm install
else
  npm install
fi
if [ -f agent-runtime/package.json ]; then
  (cd agent-runtime && { [ -f package-lock.json ] && npm ci || npm install; })
fi

chmod 600 "$HUB/.bizagent/env" 2>/dev/null || true
chmod 600 "$HUB/.bizagent/auth.json" 2>/dev/null || true

if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$(whoami)" 2>/dev/null || true
fi

if [ -x "$HUB/scripts/install-control-plane.sh" ]; then
  BIZAGENT_HOST="${BIZAGENT_HOST:-0.0.0.0}"
  BIZAGENT_PORT="${BIZAGENT_PORT:-8787}"
  "$HUB/scripts/install-control-plane.sh" --host "$BIZAGENT_HOST" --port "$BIZAGENT_PORT" || true

  NODE_BIN="$(command -v node)"
  NODE_DIR="$(dirname "$NODE_BIN")"
  UNITDIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  UNIT="$(systemctl --user list-unit-files 'bizagent-control-plane-*.service' --no-legend 2>/dev/null | awk '{print $1}' | head -1 || true)"
  if [ -n "$UNIT" ]; then
    DROP="$UNITDIR/${UNIT}.d"
    mkdir -p "$DROP"
    cat > "$DROP/node-path.conf" <<EOF
[Service]
Environment=PATH=${NODE_DIR}:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT" || systemctl --user restart "$UNIT" || true
    sleep 2
    systemctl --user is-active "$UNIT" || true
  else
    echo "No control-plane unit found; starting serve in background..."
    mkdir -p "$HUB/logs" "$HUB/.bizagent"
    nohup node "$HUB/scripts/bizagent-control-plane.js" serve --hub "$HUB" \
      >"$HUB/logs/control-plane-server.log" 2>&1 &
    echo $! > "$HUB/.bizagent/control-plane.pid"
  fi
else
  echo "install-control-plane.sh missing"
fi

test -f "$HUB/registry.json" && echo "registry: OK"
test -f "$HUB/.bizagent/env" && echo "env: OK"
python3 - <<'PY'
import json
from pathlib import Path
hub = Path.home() / "bizagent"
r = json.load(open(hub / "registry.json"))
missing = []
for p in r.get("products", []):
    for proj in p.get("projects", []):
        path = proj["path"]
        if path.startswith("~/"):
            ap = Path.home() / path[2:]
        else:
            ap = (hub / path).resolve()
        if not ap.exists():
            missing.append(f"{proj['name']}: {ap}")
print(f"products={len(r.get('products',[]))} missing_paths={len(missing)}")
for m in missing[:20]:
    print(" MISSING", m)
PY

sleep 1
if command -v curl >/dev/null; then
  curl -sS -o /dev/null -w "http_probe:%{http_code}\n" --connect-timeout 3 "http://127.0.0.1:8787/" || echo "http_probe:fail"
fi

echo "REMOTE_BOOTSTRAP_DONE"
REMOTE
else
  log "Skipped bootstrap (--no-bootstrap)"
fi

log "Apply finished."
cat <<EOF

Next (operator):
  1. Open http://bizagent.lan:8787/ (or SSH tunnel) and log in.
  2. Confirm conversations + library present.
  3. Ping one product agent from the UI.
  4. Install cron on target (copy from source crontab).
  5. ONLY THEN stop source CP on $(hostname):
       systemctl --user stop 'bizagent-control-plane-*.service'
       systemctl --user disable 'bizagent-control-plane-*.service'

Source hub left RUNNING on purpose (avoid dual-write: use only target UI after cut).
EOF
