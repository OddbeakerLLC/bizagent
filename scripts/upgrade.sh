#!/usr/bin/env bash
# upgrade.sh — safely upgrade a live hub's framework code from public BizAgent.
#
# Clones OddbeakerLLC/bizagent (or --source) into a temp dir, never copies
# operator/runtime state into the live hub, restarts the control plane, and
# removes the temp clone.
#
# Preserved (never overwritten by upgrade):
#   registry.json, cli.json, agents/, company/, knowledge-stack/, library/,
#   journal/, inbox/, outbox/, user/, logs/, .bizagent/ (auth, env, runtime),
#   .env / secrets, local git remotes / ops history
#
# Updated (framework machinery):
#   control-plane/, scripts/, templates/, tests/, install/, docs/,
#   agent-runtime/, package.json, package-lock.json, examples, AGENT.md,
#   NIGHTLY.md, WEEKLY.md, README.md, LICENSE, deploy.sh, viewlog.sh, …
#
# Usage:
#   scripts/upgrade.sh [--hub PATH] [--source PATH|URL] [--ref REF]
#                      [--dry-run] [-v|--verbose] [--yes|-y] [--no-restart]
#                      [--with-tts|--no-tts] [--no-health-timer]
#
# Env:
#   BIZAGENT_FRAMEWORK   Default framework path or git URL (same as factory-reset)
#   BIZAGENT_SKIP_TTS=1  Skip oddbeaker-tts offer/install on upgrade
#   BIZAGENT_TTS_*       See scripts/install-oddbeaker-tts.sh
#   BIZAGENT_SKIP_HEALTH_TIMER=1  Skip health probe timer ensure on upgrade
#
# Manual path (any time): run this script, or ask PTL to apply updates.
# Nightly auto path: only when registry.json settings.auto_update === true
# (default false — manual-only). See install.sh and README.
#
# Implementation note: apply mode delegates to factory-reset.sh repair so there
# is one restore engine; this script adds dry-run, npm install, and operator UX.
set -euo pipefail

HUB=""
SOURCE=""
REF=""
DRY_RUN=0
VERBOSE=0
YES=0
NO_RESTART=0
WITH_TTS=""   # empty=auto (offer if missing), 1=force try, 0=skip
WITH_HEALTH_TIMER=1  # 0=skip via --no-health-timer or BIZAGENT_SKIP_HEALTH_TIMER
DEFAULT_FRAMEWORK_URL="https://github.com/OddbeakerLLC/bizagent.git"

usage() {
  sed -n '2,38p' "$0" | sed 's/^# \?//'
  exit 2
}

log() { printf '%s\n' "$*"; }
vlog() { [[ "$VERBOSE" -eq 1 ]] && printf '  %s\n' "$*" || true; }
die() { printf 'upgrade: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -v|--verbose) VERBOSE=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --no-restart) NO_RESTART=1; shift ;;
    --with-tts) WITH_TTS=1; shift ;;
    --no-tts) WITH_TTS=0; shift ;;
    --no-health-timer) WITH_HEALTH_TIMER=0; shift ;;
    -h|--help) usage ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$HUB" ]]; then
  HUB="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  HUB="$(cd "$HUB" && pwd)"
fi

[[ -d "$HUB" ]] || die "hub not found: $HUB"
[[ -f "$HUB/registry.json" ]] || die "no registry.json at $HUB (is this a built hub?)"

# Keep in sync with factory-reset.sh FRAMEWORK_PATHS (+ agent-runtime extras).
FRAMEWORK_PATHS=(
  control-plane
  scripts
  templates
  tests
  install
  docs
  agent-runtime
  cli.json.example
  registry.example.json
  package.json
  package-lock.json
  NIGHTLY.md
  WEEKLY.md
  AGENT.md
  README.md
  LICENSE
  deploy.sh
  viewlog.sh
  bizagent.png
)

PRESERVE_PATHS=(
  registry.json
  cli.json
  agents
  company
  knowledge-stack
  library
  journal
  inbox
  outbox
  user
  logs
  .bizagent
  .env
  node_modules
)

resolve_source_label() {
  if [[ -n "$SOURCE" ]]; then
    printf '%s\n' "$SOURCE"
  elif [[ -n "${BIZAGENT_FRAMEWORK:-}" ]]; then
    printf '%s\n' "$BIZAGENT_FRAMEWORK"
  elif git -C "$HUB" remote get-url framework >/dev/null 2>&1; then
    git -C "$HUB" remote get-url framework
  else
    printf '%s\n' "$DEFAULT_FRAMEWORK_URL"
  fi
}

SOURCE_LABEL="$(resolve_source_label)"
REF_LABEL="${REF:-main (default clone HEAD)}"

log "upgrade: hub=$HUB"
log "upgrade: source=$SOURCE_LABEL"
log "upgrade: ref=$REF_LABEL"
log "upgrade: preserve=${PRESERVE_PATHS[*]}"
log "upgrade: framework paths=${FRAMEWORK_PATHS[*]}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "upgrade: DRY-RUN — no files will be changed, control plane will not restart"
  log "upgrade: would backup under $HUB/.bizagent/backups/factory-reset-repair-*"
  log "upgrade: would stop control plane, restore framework paths from source, npm install, restart"
  log "upgrade: would ensure ops .gitignore (OPS_HUB_GITIGNORE section) via factory-reset repair"
  log "upgrade: would ensure health probe timer (scripts/install-health-timer.sh — systemd user timer or cron)"
  if [[ -d "$SOURCE_LABEL" ]]; then
    for path in "${FRAMEWORK_PATHS[@]}"; do
      if [[ -e "$SOURCE_LABEL/$path" ]]; then
        if [[ -e "$HUB/$path" ]]; then
          vlog "would update: $path"
        else
          vlog "would add:    $path"
        fi
      else
        vlog "skip missing in source: $path"
      fi
    done
    # Explicitly confirm operator files would stay
    for path in registry.json cli.json agents company knowledge-stack library; do
      if [[ -e "$HUB/$path" ]]; then
        vlog "would keep:   $path"
      fi
    done
  else
    log "upgrade: source is remote — dry-run cannot diff; apply will clone then copy"
  fi
  log "upgrade: dry-run complete (exit 0)"
  exit 0
fi

REPAIR="$HUB/scripts/factory-reset.sh"
if [[ ! -x "$REPAIR" ]]; then
  # Fallback: script next to us (same tree during first bootstrap)
  REPAIR="$SCRIPT_DIR/factory-reset.sh"
fi
[[ -x "$REPAIR" ]] || die "factory-reset.sh not found/executable (needed for apply)"

if [[ "$YES" -ne 1 && -t 0 ]]; then
  printf 'Apply framework upgrade into %s from %s? [y/N] ' "$HUB" "$SOURCE_LABEL"
  read -r ans
  [[ "$ans" == "y" || "$ans" == "Y" || "$ans" == "yes" ]] || die "aborted"
fi

# factory-reset requires --yes in non-interactive shells; we already confirmed above.
args=(repair --hub "$HUB" --yes)
[[ -n "$SOURCE" ]] && args+=(--source "$SOURCE")
[[ -n "$REF" ]] && args+=(--ref "$REF")
[[ "$NO_RESTART" -eq 1 ]] && args+=(--no-restart)

# Fail before touching the live hub if Node is missing/too old (WSL footgun).
REQUIRE_NODE="$HUB/scripts/lib/require-node.sh"
if [[ ! -f "$REQUIRE_NODE" ]]; then
  REQUIRE_NODE="$SCRIPT_DIR/lib/require-node.sh"
fi
if [[ -f "$REQUIRE_NODE" ]]; then
  # shellcheck disable=SC1090
  source "$REQUIRE_NODE"
  bizagent_require_node || die "Node.js v${BIZAGENT_MIN_NODE_MAJOR:-18}+ required before upgrade"
else
  command -v node >/dev/null 2>&1 || die "node is required for upgrade"
fi

log "upgrade: invoking factory-reset.sh ${args[*]}"
# Pre-repair control-plane pid (empty when down) — used to verify a real
# restart happened when repair reports a problem.
OLD_CP_PID="$(bash "$HUB/scripts/control-plane.sh" status "$HUB" 2>/dev/null \
  | sed -n 's/.*running: pid \([0-9][0-9]*\).*/\1/p' | head -n 1)" || true
if ! bash "$REPAIR" "${args[@]}"; then
  # Repair hard-fails when the control plane did not restart cleanly. The
  # framework files are already restored at that point; the usual cause is a
  # boot crash on deps that arrived with the upgrade's package.json. Install
  # deps, restart, and re-verify before giving up — never report success over
  # a hub whose turns would loop.
  log "upgrade: repair reported a control-plane problem — installing npm deps and retrying the restart"
  if command -v npm >/dev/null 2>&1; then
    [[ -f "$HUB/package.json" ]] && (cd "$HUB" && npm install --silent) || true
    [[ -f "$HUB/agent-runtime/package.json" ]] && (cd "$HUB/agent-runtime" && npm install --silent) || true
  fi
  if [[ "$NO_RESTART" -eq 1 ]]; then
    log "ERROR: repair failed and --no-restart was set — framework files are restored but the control plane was not verified."
    log "  Restart manually:  bash $HUB/scripts/control-plane.sh restart $HUB"
    exit 1
  fi
  bash "$HUB/scripts/control-plane.sh" restart "$HUB" >>"$HUB/logs/upgrade-restart.log" 2>&1 || true
  sleep 2
  NEW_CP_PID="$(bash "$HUB/scripts/control-plane.sh" status "$HUB" 2>/dev/null \
    | sed -n 's/.*running: pid \([0-9][0-9]*\).*/\1/p' | head -n 1)" || true
  if [[ -n "$NEW_CP_PID" && -z "$OLD_CP_PID" || -n "$NEW_CP_PID" && "$NEW_CP_PID" != "$OLD_CP_PID" ]]; then
    log "upgrade: control plane recovered after npm install + restart (pid $NEW_CP_PID)"
  else
    log "ERROR: control plane is not running new code after upgrade — agent turns may loop or not dispatch."
    log "  Check: $HUB/logs/control-plane-server.log and $HUB/logs/factory-reset-*.log"
    log "  Restart manually:  bash $HUB/scripts/control-plane.sh restart $HUB"
    exit 1
  fi
fi

# Refresh npm deps when package.json landed (best-effort; do not fail upgrade).
if command -v npm >/dev/null 2>&1; then
  if [[ -f "$HUB/package.json" ]]; then
    log "upgrade: npm install (hub root)…"
    (cd "$HUB" && npm install --silent) \
      && log "upgrade: hub npm deps ok" \
      || log "upgrade: WARN hub npm install failed — run: cd $HUB && npm install"
  fi
  if [[ -f "$HUB/agent-runtime/package.json" ]]; then
    log "upgrade: npm install (agent-runtime)…"
    (cd "$HUB/agent-runtime" && npm install --silent) \
      && log "upgrade: agent-runtime npm deps ok" \
      || log "upgrade: WARN agent-runtime npm install failed"
  fi
  chmod +x "$HUB/scripts/"*.sh "$HUB/scripts/bizagent-agent" \
    "$HUB/agent-runtime/bin/bizagent-agent" 2>/dev/null || true
fi

# A hub whose agent runtime cannot load its deps fails every agent turn
# instantly; pending mail is then redispatched forever (turn loop). node_modules
# is preserved by the restore, so this should not happen — but if it does, say
# so loudly instead of printing a green "done".
if [[ -f "$HUB/agent-runtime/src/index.js" ]] && command -v node >/dev/null 2>&1; then
  if (cd "$HUB/agent-runtime" && node -e "require('openai'); require('commander')" >/dev/null 2>&1); then
    log "upgrade: agent runtime deps ok"
  else
    log "upgrade: ERROR — agent runtime deps missing; every agent turn would fail and redispatch forever."
    log "upgrade: fix before use:  cd $HUB/agent-runtime && npm install"
  fi
fi

# Optional: install oddbeaker-tts when missing (never clobber BIZAGENT_TTS_VOICE).
ensure_tts_on_upgrade() {
  if [[ -n "${BIZAGENT_SKIP_TTS:-}" || "$WITH_TTS" == "0" ]]; then
    log "upgrade: skipping oddbeaker-tts (BIZAGENT_SKIP_TTS or --no-tts)"
    return 0
  fi
  local helper="$HUB/scripts/install-oddbeaker-tts.sh"
  if [[ ! -x "$helper" ]]; then
    log "upgrade: install-oddbeaker-tts.sh not present — skip TTS"
    return 0
  fi
  local tts_url="${BIZAGENT_TTS_URL:-http://127.0.0.1:9201}"
  tts_url="${tts_url%/}"
  local healthy=0
  if curl -fsS --max-time 2 "$tts_url/health" >/dev/null 2>&1; then
    healthy=1
  fi
  local voice_set=0
  if [[ -f "$HUB/.bizagent/env" ]] && grep -qE '^(export[[:space:]]+)?BIZAGENT_TTS_VOICE=' "$HUB/.bizagent/env" 2>/dev/null; then
    voice_set=1
  fi
  # Already healthy + voice persisted → nothing to do
  if [[ "$healthy" -eq 1 && "$voice_set" -eq 1 && "$WITH_TTS" != "1" ]]; then
    log "upgrade: oddbeaker-tts already healthy; voice setting preserved"
    return 0
  fi
  # Auto path: only offer/install when missing
  if [[ "$healthy" -eq 1 && "$WITH_TTS" != "1" ]]; then
    # Service up but voice not in env — record default without clobber if later set
    log "upgrade: oddbeaker-tts up — ensuring BIZAGENT_TTS_VOICE in .bizagent/env (no clobber)"
    bash "$helper" --hub "$HUB" --yes --no-start || true
    return 0
  fi
  local args=(--hub "$HUB")
  if [[ "$YES" -eq 1 || ! -t 0 ]]; then
    args+=(--yes)
  else
    # Interactive: ask once
    printf 'oddbeaker-tts (console Kokoro TTS) is not healthy on this host. Install/start it now? [Y/n] '
    read -r ans || ans="y"
    ans="${ans:-y}"
    if [[ "$ans" != "y" && "$ans" != "Y" && "$ans" != "yes" ]]; then
      log "upgrade: skipped oddbeaker-tts install"
      return 0
    fi
    args+=(--yes --prompt-voice)
  fi
  [[ -n "${BIZAGENT_TTS_VOICE:-}" ]] && args+=(--voice "$BIZAGENT_TTS_VOICE")
  [[ -n "${BIZAGENT_TTS_SOURCE:-}" ]] && args+=(--source "$BIZAGENT_TTS_SOURCE")
  log "upgrade: ensuring oddbeaker-tts (soft-fail)…"
  bash "$helper" "${args[@]}" || log "upgrade: WARN oddbeaker-tts step failed — hub upgrade still ok"
}

ensure_tts_on_upgrade

# Health survival: make sure the out-of-process probe timer exists after an
# upgrade that ships it. Idempotent — hubs that already have the systemd user
# timer (or cron fallback) are left untouched.
ensure_health_timer_on_upgrade() {
  if [[ -n "${BIZAGENT_SKIP_HEALTH_TIMER:-}" || "$WITH_HEALTH_TIMER" == "0" ]]; then
    log "upgrade: skipping health-timer ensure (BIZAGENT_SKIP_HEALTH_TIMER or --no-health-timer)"
    return 0
  fi
  local helper="$HUB/scripts/install-health-timer.sh"
  if [[ ! -f "$helper" ]]; then
    log "upgrade: install-health-timer.sh not present — skip health timer"
    return 0
  fi
  if bash "$helper" --check "$HUB" >/dev/null 2>&1; then
    log "upgrade: health probe timer already installed"
    return 0
  fi
  log "upgrade: installing health probe timer (systemd user timer or cron)…"
  if bash "$helper" "$HUB"; then
    log "upgrade: health probe timer enabled"
  else
    log "upgrade: WARN could not enable the health probe timer automatically"
    log "upgrade: enable it with:  bash $HUB/scripts/install-health-timer.sh $HUB"
  fi
}

ensure_health_timer_on_upgrade

log "upgrade: done"
log "upgrade: operator data (registry, cli.json, agents, company, KS, library, mail, .bizagent) was not overwritten"
log "upgrade: if the UI looks stale, hard-reload the browser"
exit 0
