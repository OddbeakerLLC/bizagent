#!/usr/bin/env bash
# Compatibility wrapper. The Node control plane replaces the inotify watcher.
set -u
HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "install-watch.sh is deprecated; installing the Node control plane instead." >&2

args=()
UNINSTALL=0
run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@" 2>/dev/null || true
  elif command -v sudo >/dev/null 2>&1; then
    sudo -n "$@" 2>/dev/null || true
  fi
}

remove_legacy_watch_service() {
  [ "$UNINSTALL" -eq 1 ] || return
  echo "install-watch.sh: removing legacy bizagent-watch.service if present." >&2
  run_root systemctl stop bizagent-watch
  run_root systemctl disable bizagent-watch
  run_root rm -f /etc/systemd/system/bizagent-watch.service
  run_root systemctl daemon-reload
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --uninstall)
      UNINSTALL=1
      args+=("$1")
      shift
      ;;
    --daemon|--foreground|--allow-autonomous|cron|systemd|print)
      echo "install-watch.sh: ignoring legacy install option $1; use install-control-plane.sh options for new installs." >&2
      shift
      ;;
    --slugs)
      echo "install-watch.sh: ignoring legacy install option --slugs; the control plane reads registry.json." >&2
      shift
      [ -n "${1:-}" ] && shift
      ;;
    ''|*[!0-9]*)
      args+=("$1")
      shift
      ;;
    *)
      echo "install-watch.sh: ignoring legacy install interval $1." >&2
      shift
      ;;
  esac
done

remove_legacy_watch_service
exec "$HUB/scripts/install-control-plane.sh" "${args[@]}"
