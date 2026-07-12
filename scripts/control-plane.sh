#!/usr/bin/env bash
# control-plane.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB="${BIZAGENT_HUB:-$ROOT}"
PID_FILE="$HUB/.bizagent/control-plane.pid"
LOG_FILE="$HUB/logs/control-plane-server.log"

usage() {
  echo "usage: scripts/control-plane.sh {start|stop|status|restart} [hub-path]" >&2
  exit 2
}

hub_arg="${2:-}"
[ -z "$hub_arg" ] || HUB="$(cd "$hub_arg" && pwd)"
PID_FILE="$HUB/.bizagent/control-plane.pid"
LOG_FILE="$HUB/logs/control-plane-server.log"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1
}

start_server() {
  if is_running; then
    echo "bizagent-control-plane already running: pid $(cat "$PID_FILE")"
    return
  fi
  command -v node >/dev/null 2>&1 || {
    echo "node is required to start the BizAgent control plane" >&2
    exit 1
  }
  mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"
  nohup node "$ROOT/scripts/bizagent-control-plane.js" serve --hub "$HUB" >> "$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
  echo "bizagent-control-plane started: pid $(cat "$PID_FILE"), log $LOG_FILE"
}

stop_server() {
  if ! is_running; then
    rm -f "$PID_FILE"
    echo "bizagent-control-plane is not running"
    return
  fi
  pid="$(cat "$PID_FILE")"
  kill "$pid"
  rm -f "$PID_FILE"
  echo "bizagent-control-plane stopped: pid $pid"
}

case "${1:-}" in
  start) start_server ;;
  stop) stop_server ;;
  status)
    if is_running; then
      echo "bizagent-control-plane running: pid $(cat "$PID_FILE")"
    else
      echo "bizagent-control-plane is not running"
    fi
    ;;
  restart)
    stop_server
    start_server
    ;;
  *) usage ;;
esac
