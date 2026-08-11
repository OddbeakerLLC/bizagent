#!/usr/bin/env bash
# viewlog.sh — follow BizAgent control-plane / hub runtime logs.
#
# Usage:
#   scripts/viewlog.sh              # follow the usual human-readable set
#   scripts/viewlog.sh hub          # hub daemon + dispatch-hub.*
#   scripts/viewlog.sh agent SLUG   # dispatch-<slug>.log + .stderr (e.g. bizagent)
#   scripts/viewlog.sh cron         # nightly.log + weekly.log
#   scripts/viewlog.sh all          # every non-empty *.log / *.stderr (skips structured.log)
#   scripts/viewlog.sh -n 200       # last N lines then follow (default 50)
#
# Hub root: BIZAGENT_HUB or parent of this script.
#
# Log clocks (after timestamping work):
#   control-plane.log / structured.log — always ISO ts
#   control-plane-server.log / hub-daemon.log — ISO on process messages
#   dispatch-*.log — ISO turn start/end banners (stdout body is agent text)
#   dispatch-*.stderr — ISO per line + turn banners
#   nightly.log / weekly.log — ISO per line via run-agent.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB="${BIZAGENT_HUB:-$ROOT}"
LOG_DIR="${HUB}/logs"
LINES=50
MODE="default"

usage() {
  cat <<'EOF' >&2
usage: scripts/viewlog.sh [mode] [-n LINES]

  mode     default | hub | cp | cron | agent | all
  -n N     show last N lines before following (default 50)

  default  control-plane.log, control-plane-server.log,
           hub-daemon.log, dispatch-hub.log, dispatch-hub.stderr,
           nightly.log, weekly.log (when present)
  hub      hub-daemon.log + dispatch-hub.*
  cp       control-plane.log + control-plane-server.log
  cron     nightly.log + weekly.log
  agent S  dispatch-S.log + dispatch-S.stderr  (product slug, e.g. bizagent)
  all      every non-empty *.log / *.stderr under logs/ (never structured.log)

  Tip: product agents do NOT write to dispatch-hub.log — use:
    scripts/viewlog.sh agent bizagent
EOF
  exit 2
}

AGENT_SLUG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    -n)
      LINES="${2:-}"
      [[ "$LINES" =~ ^[0-9]+$ ]] || { echo "viewlog: -n requires a number" >&2; exit 2; }
      shift 2
      ;;
    default|hub|cp|cron|all)
      MODE="$1"
      shift
      ;;
    agent)
      MODE="agent"
      AGENT_SLUG="${2:-}"
      if [[ -z "$AGENT_SLUG" || "$AGENT_SLUG" == -* ]]; then
        echo "viewlog: agent mode requires a slug (e.g. bizagent)" >&2
        exit 2
      fi
      shift 2
      ;;
    *)
      echo "viewlog: unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ ! -d "$LOG_DIR" ]]; then
  echo "viewlog: no logs directory at $LOG_DIR" >&2
  echo "  Is the control plane running? Start with: scripts/control-plane.sh start" >&2
  exit 1
fi

pick_existing() {
  local f
  for f in "$@"; do
    [[ -f "$f" ]] && printf '%s\n' "$f"
  done
}

FILES=()
case "$MODE" in
  default)
    mapfile -t FILES < <(pick_existing \
      "$LOG_DIR/control-plane.log" \
      "$LOG_DIR/control-plane-server.log" \
      "$LOG_DIR/hub-daemon.log" \
      "$LOG_DIR/dispatch-hub.log" \
      "$LOG_DIR/dispatch-hub.stderr" \
      "$LOG_DIR/nightly.log" \
      "$LOG_DIR/weekly.log")
    ;;
  hub)
    mapfile -t FILES < <(pick_existing \
      "$LOG_DIR/hub-daemon.log" \
      "$LOG_DIR/dispatch-hub.log" \
      "$LOG_DIR/dispatch-hub.stderr")
    ;;
  cp)
    mapfile -t FILES < <(pick_existing \
      "$LOG_DIR/control-plane.log" \
      "$LOG_DIR/control-plane-server.log")
    ;;
  cron)
    mapfile -t FILES < <(pick_existing \
      "$LOG_DIR/nightly.log" \
      "$LOG_DIR/weekly.log")
    ;;
  agent)
    # Sanitize slug for filename
    if [[ ! "$AGENT_SLUG" =~ ^[a-zA-Z0-9._-]+$ ]]; then
      echo "viewlog: invalid agent slug: $AGENT_SLUG" >&2
      exit 2
    fi
    mapfile -t FILES < <(pick_existing \
      "$LOG_DIR/dispatch-${AGENT_SLUG}.log" \
      "$LOG_DIR/dispatch-${AGENT_SLUG}.stderr")
    ;;
  all)
    # Human-readable logs only — structured.log is JSON for tooling/APIs.
    mapfile -t FILES < <(
      find "$LOG_DIR" -maxdepth 1 -type f \( -name '*.log' -o -name '*.stderr' \) \
        ! -name 'structured.log' ! -size 0 2>/dev/null | sort
    )
    ;;
esac

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "viewlog: no log files found for mode '$MODE' under $LOG_DIR" >&2
  ls -la "$LOG_DIR" >&2 || true
  exit 1
fi

echo "viewlog: following ${#FILES[@]} file(s) in $LOG_DIR (mode=$MODE, -n $LINES)"
printf '  %s\n' "${FILES[@]#"$LOG_DIR"/}"
echo "----"

exec tail -n "$LINES" -F "${FILES[@]}"
