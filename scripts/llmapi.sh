#!/usr/bin/env bash
# llmapi.sh — start/stop/status/restart the BizAgent llmapi REST API.
#
# Mirrors control-plane.sh: discovers the live process by PID file, /proc
# cmdline scan, and (when present) the systemd user unit for this hub, so
# stop/restart work no matter how the service was started. Falls back to a
# plain nohup node process when no systemd user session is available.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB="${BIZAGENT_HUB:-$ROOT}"

load_env() {
  if [ -f "$HUB/.bizagent/env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$HUB/.bizagent/env" 2>/dev/null || true
    set +a
  fi
}

usage() {
  echo "usage: scripts/llmapi.sh {start|stop|status|restart} [hub-path]" >&2
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
# Exported so a nohup-started child carries BIZAGENT_HUB in its environ —
# find_pids matches children by cwd OR this env var, so stop/status/restart
# find the process even when run from a different working directory.
export BIZAGENT_HUB="$HUB"

PID_FILE="$HUB/.bizagent/llmapi.pid"
LOG_FILE="$HUB/logs/llmapi.log"
UNITDIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

# --- discovery -------------------------------------------------------------

find_pids() {
  local dir pid hub_val hub_norm i
  local proc_cwd proc_hub proc_hub_norm
  local -a args
  for dir in /proc/[0-9]*; do
    pid="${dir#/proc/}"
    [ -r "$dir/cmdline" ] || continue
    args=()
    while IFS= read -r -d '' arg; do
      args+=("$arg")
    done < "$dir/cmdline" 2>/dev/null || true
    [ "${#args[@]}" -gt 0 ] || continue

    local is_llmapi=0
    for arg in "${args[@]}"; do
      case "$arg" in
        */llmapi.js|llmapi.js) is_llmapi=1; break ;;
      esac
    done
    [ "$is_llmapi" -eq 1 ] || continue

    hub_val=""
    for ((i = 0; i < ${#args[@]}; i++)); do
      if [ "${args[i]}" = "--hub" ] && [ $((i + 1)) -lt ${#args[@]} ]; then
        hub_val="${args[i + 1]}"
      fi
    done
    hub_norm=""
    if [ -n "$hub_val" ]; then
      hub_norm="$(normalize_path "$hub_val" 2>/dev/null || printf '%s\n' "$hub_val")"
      if [ "$hub_norm" = "$HUB" ] || [ "$hub_val" = "$HUB" ]; then
        printf '%s\n' "$pid"
        continue
      fi
    fi
    # llmapi.js takes no --hub flag: match by process cwd or BIZAGENT_HUB env.
    proc_cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    proc_hub="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null \
      | sed -n 's/^BIZAGENT_HUB=//p' | head -n 1)"
    proc_hub_norm=""
    [ -z "$proc_hub" ] || proc_hub_norm="$(normalize_path "$proc_hub" 2>/dev/null || printf '%s\n' "$proc_hub")"
    if [ "$proc_cwd" = "$HUB" ] || [ "$proc_hub" = "$HUB" ] || [ "$proc_hub_norm" = "$HUB" ]; then
      printf '%s\n' "$pid"
    fi
  done
}

find_systemd_unit() {
  local f
  [ -d "$UNITDIR" ] || return 1
  shopt -s nullglob
  for f in "$UNITDIR"/bizagent-llmapi-*.service; do
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

write_pid_file() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  mkdir -p "$(dirname "$PID_FILE")"
  printf '%s\n' "$pid" > "$PID_FILE"
}

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
  if [ -n "$unit" ] && systemd_active "$unit"; then
    via="systemd:$unit"
  fi
  if [ -n "$pid" ]; then
    write_pid_file "$pid"
    echo "llmapi running: pid $pid ($via)"
    return 0
  fi
  echo "llmapi is not running"
  return 1
}

# --- actions ---------------------------------------------------------------

# Real port/host come from the environment loaded via load_env (LLMAPI_PORT /
# LLMAPI_HOST in .bizagent/env), matching llmapi.js defaults.
llmapi_port() { printf '%s\n' "${LLMAPI_PORT:-8788}"; }
llmapi_host() { printf '%s\n' "${LLMAPI_HOST:-127.0.0.1}"; }

# port_ready — true only when /health answers on the configured host:port.
port_ready() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "fetch('http://'+process.argv[1]+':'+process.argv[2]+'/health',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    "$(llmapi_host)" "$(llmapi_port)" 2>/dev/null
}

wait_for_port() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if port_ready; then return 0; fi
    sleep 0.3
  done
  return 1
}

start_server() {
  local pid unit systemctl_err
  load_env

  if pid="$(primary_pid 2>/dev/null)"; then
    write_pid_file "$pid"
    if port_ready; then
      echo "llmapi already running: pid $pid"
      return 0
    fi
    echo "llmapi process $pid exists but port $(llmapi_port) is not accepting connections — see $LOG_FILE" >&2
    return 1
  fi

  REQUIRE_NODE="$ROOT/scripts/lib/require-node.sh"
  if [[ -f "$REQUIRE_NODE" ]]; then
    # shellcheck disable=SC1090
    source "$REQUIRE_NODE"
    bizagent_require_node || {
      echo "llmapi: Node.js v${BIZAGENT_MIN_NODE_MAJOR:-22}+ required" >&2
      exit 1
    }
  else
    command -v node >/dev/null 2>&1 || {
      echo "node is required to start llmapi" >&2
      exit 1
    }
  fi
  [ -f "$ROOT/llmapi.js" ] || {
    echo "llmapi: $ROOT/llmapi.js not found" >&2
    exit 1
  }
  mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

  unit="$(find_systemd_unit 2>/dev/null || true)"
  if [ -n "$unit" ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl_err="$(systemctl --user start "$unit" 2>&1)"; then
      local i
      for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
        if pid="$(primary_pid 2>/dev/null)"; then
          write_pid_file "$pid"
          if wait_for_port; then
            echo "llmapi started via systemd ($unit): pid $pid, port $(llmapi_port) accepting connections, log $LOG_FILE"
            return 0
          fi
          echo "llmapi: systemd unit $unit is running (pid $pid) but port $(llmapi_port) is not accepting connections" >&2
          echo "  check: systemctl --user status $unit · journalctl --user -u $unit · log: $LOG_FILE" >&2
          return 1
        fi
        sleep 0.3
      done
      echo "llmapi: systemctl start $unit returned but no llmapi process appeared" >&2
      echo "  check: systemctl --user status $unit · journalctl --user -u $unit" >&2
      return 1
    else
      # No usable systemd user session (fresh host without lingering, WSL,
      # containers): say why, then fall through to the nohup fallback instead
      # of dying with the unit path.
      echo "llmapi: systemctl --user start $unit failed ($(printf '%s' "$systemctl_err" | head -n 1)) — falling back to nohup" >&2
    fi
  fi

  nohup node "$ROOT/llmapi.js" >>"$LOG_FILE" 2>&1 &
  pid=$!
  write_pid_file "$pid"
  sleep 0.2
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "llmapi failed to start (process exited immediately) — recent log output:" >&2
    tail -n 5 "$LOG_FILE" 2>/dev/null | sed 's/^/  /' >&2 || true
    echo "  full log: $LOG_FILE" >&2
    return 1
  fi
  if wait_for_port; then
    echo "llmapi started: pid $pid, port $(llmapi_port) accepting connections, log $LOG_FILE"
  else
    echo "llmapi process $pid is running but port $(llmapi_port) is not accepting connections — see $LOG_FILE" >&2
    return 1
  fi
}

stop_server() {
  local pid unit pids
  unit="$(find_systemd_unit 2>/dev/null || true)"

  if [ -n "$unit" ] && systemd_active "$unit"; then
    systemctl --user stop "$unit" 2>/dev/null || true
    pids="$(find_pids | sort -n -u || true)"
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null || true
      sleep 0.3
      pids="$(find_pids | sort -n -u || true)"
      if [ -n "$pids" ]; then
        kill -9 $pids 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
    echo "llmapi stopped via systemd ($unit)"
    return 0
  fi

  pids="$(find_pids | sort -n -u || true)"
  if [ -z "$pids" ]; then
    rm -f "$PID_FILE"
    echo "llmapi is not running"
    return 0
  fi

  local stopped="$pids"
  kill $pids 2>/dev/null || true
  sleep 0.3
  pids="$(find_pids | sort -n -u || true)"
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "llmapi stopped: pid(s) $(printf '%s' "$stopped" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  return 0
}

case "${1:-}" in
  start) start_server ;;
  stop) stop_server ;;
  status)
    if describe_running; then
      exit 0
    fi
    rm -f "$PID_FILE"
    exit 1
    ;;
  restart)
    stop_server
    start_server
    ;;
  *) usage ;;
esac
