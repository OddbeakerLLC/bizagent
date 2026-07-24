#!/usr/bin/env bash
# control-plane.sh — start/stop/status/restart the BizAgent control plane.
#
# Discovers the live process by PID file, /proc cmdline scan, and (when
# present) the systemd user unit for this hub. status/stop/restart work
# whether the server was started by this script, systemd, or a bare node
# invoke — no manual PID hunting after restart.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB="${BIZAGENT_HUB:-$ROOT}"

usage() {
  echo "usage: scripts/control-plane.sh {start|stop|status|restart} [hub-path]" >&2
  exit 2
}

normalize_path() {
  local p="$1"
  if [ -d "$p" ]; then
    (cd "$p" && pwd -P)
    return
  fi
  printf '%s\n' "$p"
}

hub_arg="${2:-}"
[ -z "$hub_arg" ] || HUB="$(cd "$hub_arg" && pwd)"
HUB="$(normalize_path "$HUB")"

PID_FILE="$HUB/.bizagent/control-plane.pid"
LOG_FILE="$HUB/logs/control-plane-server.log"
UNITDIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

# --- discovery -------------------------------------------------------------

# PIDs of node processes serving this exact hub (one per line).
find_pids() {
  local dir pid hub_val hub_norm i has_serve
  local -a args
  for dir in /proc/[0-9]*; do
    pid="${dir#/proc/}"
    [ -r "$dir/cmdline" ] || continue
    args=()
    # Read NUL-separated cmdline into array.
    while IFS= read -r -d '' arg; do
      args+=("$arg")
    done < "$dir/cmdline" 2>/dev/null || true
    [ "${#args[@]}" -gt 0 ] || continue

    # Must be the control-plane CLI (path may vary; match basename fragment).
    local is_cp=0
    for arg in "${args[@]}"; do
      case "$arg" in
        *bizagent-control-plane.js) is_cp=1; break ;;
      esac
    done
    [ "$is_cp" -eq 1 ] || continue

    has_serve=0
    hub_val=""
    for ((i = 0; i < ${#args[@]}; i++)); do
      if [ "${args[i]}" = "serve" ]; then
        has_serve=1
      fi
      if [ "${args[i]}" = "--hub" ] && [ $((i + 1)) -lt ${#args[@]} ]; then
        hub_val="${args[i + 1]}"
      fi
    done
    [ "$has_serve" -eq 1 ] || continue
    [ -n "$hub_val" ] || continue

    hub_norm="$(normalize_path "$hub_val" 2>/dev/null || printf '%s\n' "$hub_val")"
    if [ "$hub_norm" = "$HUB" ] || [ "$hub_val" = "$HUB" ]; then
      printf '%s\n' "$pid"
    fi
  done
}

# systemd user unit file basename for this hub, if installed.
find_systemd_unit() {
  local f
  [ -d "$UNITDIR" ] || return 1
  shopt -s nullglob
  for f in "$UNITDIR"/bizagent-control-plane-*.service; do
    # Unit embeds the hub path in WorkingDirectory / ExecStart --hub.
    if grep -Fq -- "$HUB" "$f" 2>/dev/null; then
      basename "$f"
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  return 1
}

systemd_active() {
  local unit="${1:-}"
  [ -n "$unit" ] || return 1
  systemctl --user is-active --quiet "$unit" 2>/dev/null
}

# Write PID file from a live discovered pid (best-effort).
write_pid_file() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  mkdir -p "$(dirname "$PID_FILE")"
  printf '%s\n' "$pid" > "$PID_FILE"
}

# Prefer a single primary PID: pidfile if it still matches a live CP, else first scan hit.
primary_pid() {
  local pids file_pid
  pids="$(find_pids | sort -n -u || true)"
  if [ -f "$PID_FILE" ]; then
    file_pid="$(tr -d ' \n\r\t' < "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$file_pid" ] && printf '%s\n' "$pids" | grep -qx "$file_pid"; then
      printf '%s\n' "$file_pid"
      return 0
    fi
  fi
  if [ -n "$pids" ]; then
    printf '%s\n' "$pids" | head -n 1
    return 0
  fi
  return 1
}

is_running() {
  primary_pid >/dev/null 2>&1
}

describe_running() {
  local pid unit via
  pid="$(primary_pid 2>/dev/null || true)"
  unit="$(find_systemd_unit 2>/dev/null || true)"
  via="process"
  if [ -f "$PID_FILE" ]; then
    local file_pid
    file_pid="$(tr -d ' \n\r\t' < "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && [ "$file_pid" = "$pid" ]; then
      via="pidfile"
    fi
  fi
  if [ -n "$unit" ] && systemd_active "$unit"; then
    via="systemd:$unit"
  fi
  if [ -n "$pid" ]; then
    # Keep pidfile honest whenever we can see the process.
    write_pid_file "$pid"
    echo "bizagent-control-plane running: pid $pid ($via)"
    return 0
  fi
  echo "bizagent-control-plane is not running"
  return 1
}

# --- actions ---------------------------------------------------------------

start_server() {
  local pid unit
  if pid="$(primary_pid 2>/dev/null)"; then
    write_pid_file "$pid"
    echo "bizagent-control-plane already running: pid $pid"
    return 0
  fi

  command -v node >/dev/null 2>&1 || {
    echo "node is required to start the BizAgent control plane" >&2
    exit 1
  }
  mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

  unit="$(find_systemd_unit 2>/dev/null || true)"
  if [ -n "$unit" ] && command -v systemctl >/dev/null 2>&1; then
    # Prefer the installed unit so Restart=on-failure stays in effect.
    if systemctl --user start "$unit" 2>/dev/null; then
      # Wait briefly for the process to appear.
      local i
      for i in 1 2 3 4 5 6 7 8 9 10; do
        if pid="$(primary_pid 2>/dev/null)"; then
          write_pid_file "$pid"
          echo "bizagent-control-plane started via systemd ($unit): pid $pid, log $LOG_FILE"
          return 0
        fi
        sleep 0.2
      done
      echo "bizagent-control-plane: systemctl start $unit returned but process not found yet" >&2
      echo "  check: systemctl --user status $unit" >&2
      return 1
    fi
    # Unit start failed (e.g. user bus unavailable) — fall through to nohup.
  fi

  nohup node "$ROOT/scripts/bizagent-control-plane.js" serve --hub "$HUB" >>"$LOG_FILE" 2>&1 &
  pid=$!
  write_pid_file "$pid"
  # Give Node a moment to replace/confirm the pidfile itself.
  sleep 0.2
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "bizagent-control-plane failed to start; see $LOG_FILE" >&2
    return 1
  fi
  echo "bizagent-control-plane started: pid $pid, log $LOG_FILE"
}

stop_server() {
  local pid unit pids
  unit="$(find_systemd_unit 2>/dev/null || true)"

  # If systemd owns a live unit, stop through it (raw kill races Restart=on-failure).
  if [ -n "$unit" ] && systemd_active "$unit"; then
    systemctl --user stop "$unit" 2>/dev/null || true
    # Also reap any orphan still matching this hub (leftover from a prior nohup).
    pids="$(find_pids | sort -n -u || true)"
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
      sleep 0.3
      pids="$(find_pids | sort -n -u || true)"
      if [ -n "$pids" ]; then
        # shellcheck disable=SC2086
        kill -9 $pids 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
    echo "bizagent-control-plane stopped via systemd ($unit)"
    return 0
  fi

  pids="$(find_pids | sort -n -u || true)"
  if [ -z "$pids" ]; then
    # Stale pidfile only.
    rm -f "$PID_FILE"
    echo "bizagent-control-plane is not running"
    return 0
  fi

  local stopped="$pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 0.3
  pids="$(find_pids | sort -n -u || true)"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "bizagent-control-plane stopped: pid(s) $(printf '%s' "$stopped" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  return 0
}

case "${1:-}" in
  start) start_server ;;
  stop) stop_server ;;
  status)
    if describe_running; then
      exit 0
    fi
    # Clean obviously stale pidfile when nothing is live.
    rm -f "$PID_FILE"
    exit 0
    ;;
  restart)
    stop_server
    start_server
    ;;
  *) usage ;;
esac
