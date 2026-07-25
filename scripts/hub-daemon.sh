#!/usr/bin/env bash
# hub-daemon.sh — start/stop/status/restart the warm hub turn worker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB="${BIZAGENT_HUB:-$ROOT}"
PID_FILE="$HUB/.bizagent/hub-daemon.pid"
SOCK="$HUB/.bizagent/hub.sock"
LOG_FILE="$HUB/logs/hub-daemon.log"

usage() {
  echo "usage: scripts/hub-daemon.sh {start|stop|status|restart|ping}" >&2
  exit 2
}

load_env() {
  if [ -f "$HUB/.bizagent/env" ]; then
    # shellcheck disable=SC1091
    set -a
    . "$HUB/.bizagent/env" 2>/dev/null || true
    set +a
  fi
}

is_running() {
  local pid
  if [ -f "$PID_FILE" ]; then
    pid="$(tr -d ' \n\r\t' < "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      # confirm it looks like hub-daemon
      if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'hub-daemon.js'; then
        echo "$pid"
        return 0
      fi
    fi
  fi
  # socket + scan fallback
  if [ -S "$SOCK" ]; then
    local p
    p="$(pgrep -f 'hub-daemon.js' 2>/dev/null | head -n1 || true)"
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      echo "$p"
      return 0
    fi
  fi
  return 1
}

do_ping() {
  if [ ! -S "$SOCK" ]; then
    echo "hub-daemon: no socket at $SOCK"
    return 1
  fi
  if command -v node >/dev/null 2>&1; then
    node -e '
      const net=require("net");
      const s=net.createConnection(process.argv[1]);
      let buf="";
      const t=setTimeout(()=>{console.error("timeout");process.exit(1)},2000);
      s.on("connect",()=>s.write(JSON.stringify({type:"ping"})+"\n"));
      s.on("data",d=>{buf+=d; if(buf.includes("\n")){clearTimeout(t); process.stdout.write(buf); s.end(); process.exit(0);}});
      s.on("error",e=>{console.error(e.message);process.exit(1);});
    ' "$SOCK"
  else
    echo "node required for ping" >&2
    return 1
  fi
}

start_daemon() {
  local pid
  if pid="$(is_running)"; then
    echo "hub-daemon already running: pid $pid"
    return 0
  fi
  load_env
  command -v node >/dev/null 2>&1 || { echo "node required" >&2; exit 1; }
  mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"
  rm -f "$SOCK"
  nohup node "$ROOT/scripts/hub-daemon.js" --hub "$HUB" >>"$LOG_FILE" 2>&1 &
  pid=$!
  # hub-daemon writes its own pidfile; wait briefly for socket
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if [ -S "$SOCK" ] && kill -0 "$pid" 2>/dev/null; then
      echo "hub-daemon started: pid $pid sock $SOCK log $LOG_FILE"
      return 0
    fi
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "hub-daemon process $pid up but socket not ready yet; see $LOG_FILE"
    return 0
  fi
  echo "hub-daemon failed to start; see $LOG_FILE" >&2
  return 1
}

stop_daemon() {
  local pid
  if pid="$(is_running)"; then
    kill "$pid" 2>/dev/null || true
    sleep 0.3
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  fi
  # any stragglers
  pgrep -f 'hub-daemon.js' 2>/dev/null | while read -r p; do
    kill "$p" 2>/dev/null || true
  done
  rm -f "$PID_FILE" "$SOCK"
  echo "hub-daemon stopped"
}

case "${1:-}" in
  start) start_daemon ;;
  stop) stop_daemon ;;
  status)
    if pid="$(is_running)"; then
      echo "hub-daemon running: pid $pid sock=$SOCK"
      do_ping || true
      exit 0
    fi
    echo "hub-daemon is not running"
    exit 0
    ;;
  restart) stop_daemon; start_daemon ;;
  ping) do_ping ;;
  *) usage ;;
esac
