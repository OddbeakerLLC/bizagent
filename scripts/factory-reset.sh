#!/usr/bin/env bash
# factory-reset.sh — recover a wrecked operational hub without losing your company.
#
# Modes:
#   repair       Restore framework machinery (control-plane, scripts, templates, …)
#                Keep registry, agents, journals, company, KS, auth, mail, conversations.
#   restore-ops  Restore ops paths from the hub's private git remote (origin) or a ref.
#   nuke         Dangerous full wipe of ops data + re-seed empty registry (requires confirm).
#
# Usage:
#   scripts/factory-reset.sh repair [--hub PATH] [--source PATH|URL] [--ref REF] [--yes] [--no-restart]
#   scripts/factory-reset.sh restore-ops [--hub PATH] [--ref REF] [--yes]
#   scripts/factory-reset.sh nuke --i-understand-this-deletes-ops [--hub PATH] [--yes]
#
# Framework source for repair (first match wins):
#   1. --source PATH or git URL
#   2. BIZAGENT_FRAMEWORK env (path or URL)
#   3. git remote named "framework" on the hub
#   4. Default public URL: https://github.com/OddbeakerLLC/bizagent.git
#
# Always creates a timestamped backup under <hub>/.bizagent/backups/ before changing files.
# Does not depend on a healthy control-plane UI — pure shell + git + rsync/cp.
set -euo pipefail

MODE="${1:-}"
shift || true

HUB=""
SOURCE=""
REF=""
YES=0
NO_RESTART=0
NUKE_OK=0
DEFAULT_FRAMEWORK_URL="https://github.com/OddbeakerLLC/bizagent.git"

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \?//'
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    --no-restart) NO_RESTART=1; shift ;;
    --i-understand-this-deletes-ops) NUKE_OK=1; shift ;;
    -h|--help) usage ;;
    *)
      echo "factory-reset: unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$MODE" ]] || usage
case "$MODE" in
  repair|restore-ops|nuke) ;;
  *) echo "factory-reset: mode must be repair|restore-ops|nuke" >&2; usage ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$HUB" ]]; then
  HUB="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  HUB="$(cd "$HUB" && pwd)"
fi

if [[ ! -d "$HUB" ]]; then
  echo "factory-reset: hub not found: $HUB" >&2
  exit 1
fi
if [[ ! -f "$HUB/registry.json" && "$MODE" != "nuke" ]]; then
  echo "factory-reset: no registry.json at $HUB (is this a built hub?)" >&2
  exit 1
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="$HUB/.bizagent/backups"
BACKUP_DIR="$BACKUP_ROOT/factory-reset-$MODE-$TS"
LOG_DIR="$HUB/logs"
LOG_FILE="$LOG_DIR/factory-reset-$TS.log"
mkdir -p "$BACKUP_ROOT" "$LOG_DIR"

log() { printf '%s\n' "$*" | tee -a "$LOG_FILE"; }
die() { log "ERROR: $*"; exit 1; }

confirm() {
  local prompt="$1"
  if [[ "$YES" -eq 1 ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    die "non-interactive shell requires --yes"
  fi
  printf '%s [y/N] ' "$prompt"
  local ans
  read -r ans
  [[ "$ans" == "y" || "$ans" == "Y" || "$ans" == "yes" ]] || die "aborted"
}

# Paths restored from framework on repair (relative to hub / source root).
FRAMEWORK_PATHS=(
  control-plane
  scripts
  templates
  tests
  install
  docs
  cli.json.example
  registry.example.json
  package.json
  NIGHTLY.md
  WEEKLY.md
)

# Ops paths never clobbered by repair; restored by restore-ops when requested.
OPS_PATHS=(
  registry.json
  cli.json
  agents
  journal
  company
  knowledge-stack
  inbox
  outbox
  user
)

backup_hub_snapshot() {
  log "Backup → $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
  # Snapshot critical trees; skip huge/ephemeral if missing.
  local p
  for p in \
    control-plane scripts templates tests install docs \
    registry.json cli.json agents journal company knowledge-stack \
    package.json NIGHTLY.md WEEKLY.md cli.json.example registry.example.json \
    AGENT.md; do
    if [[ -e "$HUB/$p" ]]; then
      mkdir -p "$BACKUP_DIR/$(dirname "$p")"
      cp -a "$HUB/$p" "$BACKUP_DIR/$p"
    fi
  done
  # Auth/env only (not full conversations dump — still copy .bizagent select files)
  mkdir -p "$BACKUP_DIR/.bizagent"
  for p in auth.json env profile.json; do
    if [[ -e "$HUB/.bizagent/$p" ]]; then
      cp -a "$HUB/.bizagent/$p" "$BACKUP_DIR/.bizagent/$p"
    fi
  done
  printf '%s\n' "$MODE" "$TS" "$HUB" >"$BACKUP_DIR/BACKUP_META.txt"
  log "Backup complete."
}

stop_control_plane() {
  if [[ -x "$HUB/scripts/control-plane.sh" ]]; then
    log "Stopping control plane (if running)…"
    bash "$HUB/scripts/control-plane.sh" stop "$HUB" >>"$LOG_FILE" 2>&1 || true
  fi
}

start_control_plane() {
  if [[ "$NO_RESTART" -eq 1 ]]; then
    log "Skipping control-plane restart (--no-restart)."
    return 0
  fi
  if [[ -x "$HUB/scripts/control-plane.sh" ]]; then
    log "Starting control plane…"
    bash "$HUB/scripts/control-plane.sh" start "$HUB" >>"$LOG_FILE" 2>&1 || {
      log "WARN: control-plane start failed — start manually: scripts/control-plane.sh start"
      return 0
    }
  fi
}

regenerate_hub_prompt() {
  if command -v node >/dev/null 2>&1 && [[ -f "$HUB/control-plane/lib/hub-memory.js" ]]; then
    log "Regenerating hub runtime prompt…"
    node -e "
      const { ensureHubRuntimePrompt } = require(process.argv[1]);
      ensureHubRuntimePrompt(process.argv[2]);
      console.log('hub.md ok');
    " "$HUB/control-plane/lib/hub-memory.js" "$HUB" >>"$LOG_FILE" 2>&1 || log "WARN: could not regen hub.md"
  fi
}

regenerate_dispatch_prompts() {
  local tpl="$HUB/templates/dispatch.md.template"
  [[ -f "$tpl" ]] || return 0
  local slug dir
  shopt -s nullglob
  for dir in "$HUB"/agents/*/; do
    slug="$(basename "$dir")"
    [[ -d "$dir" ]] || continue
    sed \
      -e "s/{{slug}}/$slug/g" \
      -e "s|{{agent_md}}|agents/$slug/agent.md|g" \
      -e "s|{{inbox}}|agents/$slug/inbox|g" \
      -e "s|{{outbox}}|agents/$slug/outbox|g" \
      "$tpl" >"$dir/.dispatch.md"
  done
  shopt -u nullglob
  log "Regenerated agents/*/.dispatch.md from template."
}

clone_framework_to_tmp() {
  # $1 = git URL
  local url="$1"
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/bizagent-framework-XXXXXX")"
  log "Cloning framework from $url …"
  if [[ -n "$REF" ]]; then
    if ! git clone --depth 1 --branch "$REF" "$url" "$tmp" >>"$LOG_FILE" 2>&1; then
      git clone "$url" "$tmp" >>"$LOG_FILE" 2>&1 || die "git clone failed: $url"
      git -C "$tmp" checkout "$REF" >>"$LOG_FILE" 2>&1 || die "git checkout $REF failed"
    fi
  else
    git clone --depth 1 "$url" "$tmp" >>"$LOG_FILE" 2>&1 || die "git clone failed: $url"
  fi
  FRAMEWORK_SRC="$tmp"
  CLEANUP_FRAMEWORK_SRC=1
}

resolve_framework_source() {
  # Sets FRAMEWORK_SRC to a local directory of clean framework files.
  if [[ -z "$SOURCE" && -n "${BIZAGENT_FRAMEWORK:-}" ]]; then
    SOURCE="$BIZAGENT_FRAMEWORK"
  fi

  if [[ -n "$SOURCE" ]]; then
    if [[ -d "$SOURCE" ]]; then
      FRAMEWORK_SRC="$(cd "$SOURCE" && pwd)"
      log "Framework source (path): $FRAMEWORK_SRC"
      return 0
    fi
    clone_framework_to_tmp "$SOURCE"
    return 0
  fi

  if git -C "$HUB" remote get-url framework >/dev/null 2>&1; then
    clone_framework_to_tmp "$(git -C "$HUB" remote get-url framework)"
    return 0
  fi

  clone_framework_to_tmp "$DEFAULT_FRAMEWORK_URL"
}

copy_tree() {
  local src="$1" dest="$2"
  if command -v rsync >/dev/null 2>&1; then
    mkdir -p "$(dirname "$dest")"
    rsync -a --delete "$src"/ "$dest"/
  else
    rm -rf "$dest"
    mkdir -p "$(dirname "$dest")"
    cp -a "$src" "$dest"
  fi
}

copy_file() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  cp -a "$src" "$dest"
}

do_repair() {
  log "=== factory-reset repair ==="
  log "Hub: $HUB"
  log "Keeps: registry, agents, journals, company, KS, auth, mail, conversations"
  log "Restores: control-plane, scripts, templates, tests, install, docs, examples…"
  confirm "Restore framework machinery into this hub (ops data kept)?"

  backup_hub_snapshot
  stop_control_plane

  CLEANUP_FRAMEWORK_SRC=0
  FRAMEWORK_SRC=""
  resolve_framework_source
  [[ -n "$FRAMEWORK_SRC" && -d "$FRAMEWORK_SRC" ]] || die "could not resolve framework source"
  [[ -d "$FRAMEWORK_SRC/control-plane" ]] || die "framework source missing control-plane/: $FRAMEWORK_SRC"

  local path
  for path in "${FRAMEWORK_PATHS[@]}"; do
    if [[ -d "$FRAMEWORK_SRC/$path" ]]; then
      log "  restore dir  $path/"
      copy_tree "$FRAMEWORK_SRC/$path" "$HUB/$path"
    elif [[ -f "$FRAMEWORK_SRC/$path" ]]; then
      log "  restore file $path"
      copy_file "$FRAMEWORK_SRC/$path" "$HUB/$path"
    else
      log "  skip missing $path (not in source)"
    fi
  done

  # Ensure factory-reset itself is executable after restore
  chmod +x "$HUB/scripts/"*.sh 2>/dev/null || true

  regenerate_hub_prompt
  regenerate_dispatch_prompts

  if [[ "${CLEANUP_FRAMEWORK_SRC:-0}" -eq 1 && -n "${FRAMEWORK_SRC:-}" ]]; then
    rm -rf "$FRAMEWORK_SRC"
  fi

  start_control_plane
  log "Repair finished."
  log "Backup: $BACKUP_DIR"
  log "Log:    $LOG_FILE"
  log "If UI is cached, hard-reload the browser. If CP failed to start: scripts/control-plane.sh start"
}

do_restore_ops() {
  log "=== factory-reset restore-ops ==="
  log "Hub: $HUB"
  if ! git -C "$HUB" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "hub is not a git repo — cannot restore-ops from remote"
  fi
  local remote_ref="${REF:-}"
  if [[ -z "$remote_ref" ]]; then
    if git -C "$HUB" rev-parse --verify origin/HEAD >/dev/null 2>&1; then
      remote_ref="origin/HEAD"
    elif git -C "$HUB" rev-parse --verify origin/main >/dev/null 2>&1; then
      remote_ref="origin/main"
    else
      die "no --ref and no origin/main — pass --ref origin/<branch> or a commit"
    fi
  fi
  log "Restoring ops paths from: $remote_ref"
  confirm "Overwrite registry/agents/journals/company/KS (and mail dirs if tracked) from $remote_ref?"

  backup_hub_snapshot
  stop_control_plane

  log "Fetching remotes…"
  git -C "$HUB" fetch --all --prune >>"$LOG_FILE" 2>&1 || log "WARN: git fetch failed; trying local ref only"

  local path
  for path in "${OPS_PATHS[@]}"; do
    if git -C "$HUB" cat-file -e "$remote_ref:$path" 2>/dev/null \
      || git -C "$HUB" ls-tree -r --name-only "$remote_ref" | grep -q "^${path}\(/\|$\)"; then
      log "  git restore $path"
      git -C "$HUB" checkout "$remote_ref" -- "$path" >>"$LOG_FILE" 2>&1 \
        || log "WARN: could not restore $path"
    else
      log "  skip $path (not in $remote_ref)"
    fi
  done

  regenerate_hub_prompt
  regenerate_dispatch_prompts
  start_control_plane
  log "restore-ops finished."
  log "Backup: $BACKUP_DIR"
  log "Log:    $LOG_FILE"
}

do_nuke() {
  log "=== factory-reset nuke ==="
  log "Hub: $HUB"
  if [[ "$NUKE_OK" -ne 1 ]]; then
    die "nuke requires --i-understand-this-deletes-ops"
  fi
  confirm "DELETE ops data (registry, agents mail, journals, company, KS) on $HUB?"

  backup_hub_snapshot
  stop_control_plane

  # Keep framework code; wipe ops identity
  local path
  for path in registry.json agents journal company knowledge-stack inbox outbox user; do
    if [[ -e "$HUB/$path" ]]; then
      log "  remove $path"
      rm -rf "$HUB/$path"
    fi
  done
  # Keep auth/env by default so login still works; wipe runtime noise
  rm -rf "$HUB/.bizagent/conversations" \
    "$HUB/.bizagent/prompts" \
    "$HUB/.bizagent/dispatch-state" \
    "$HUB/.bizagent/runtime-cwd" \
    "$HUB/.bizagent/pending-replies" \
    "$HUB/.bizagent/hub-session.md" \
    "$HUB/.bizagent/pending-hub-turns.json" \
    "$HUB/.bizagent/control-plane.pid" \
    "$HUB/.bizagent/hub-daemon.pid" 2>/dev/null || true

  if [[ -f "$HUB/registry.example.json" ]]; then
    cp -a "$HUB/registry.example.json" "$HUB/registry.json"
    log "Seeded registry.json from registry.example.json — re-run interview/setup for a real hub."
  else
    log "WARN: no registry.example.json — create registry.json manually."
  fi

  mkdir -p "$HUB/inbox/archive" "$HUB/outbox" "$HUB/user/inbox/archive" "$HUB/journal" "$HUB/logs" "$HUB/agents"
  regenerate_hub_prompt
  start_control_plane
  log "Nuke finished. Backup of previous ops: $BACKUP_DIR"
  log "Log: $LOG_FILE"
}

log "factory-reset mode=$MODE hub=$HUB ts=$TS"
case "$MODE" in
  repair) do_repair ;;
  restore-ops) do_restore_ops ;;
  nuke) do_nuke ;;
esac
