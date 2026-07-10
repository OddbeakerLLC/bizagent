#!/usr/bin/env bash
# Compatibility wrapper. Use the Node control-plane service installer.
set -u
HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "install-dispatch.sh is deprecated; installing the Node control plane instead." >&2

args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    cron|systemd|print|--allow-autonomous)
      echo "install-dispatch.sh: ignoring legacy install option $1; use install-control-plane.sh options for new installs." >&2
      shift
      ;;
    ''|*[!0-9]*)
      args+=("$1")
      shift
      ;;
    *)
      echo "install-dispatch.sh: ignoring legacy install interval $1." >&2
      shift
      ;;
  esac
done

exec "$HUB/scripts/install-control-plane.sh" "${args[@]}"
