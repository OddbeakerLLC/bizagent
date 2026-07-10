#!/usr/bin/env bash
# Compatibility wrapper. The Node control-plane server now polls inboxes every
# 6 seconds, routes mail, and dispatches agents; inotify is no longer primary.
set -u
HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --daemon|--foreground)
      echo "bizagent-watch.sh: ignoring legacy watch option $1; the control plane owns polling." >&2
      shift
      ;;
    --slugs)
      echo "bizagent-watch.sh: ignoring legacy watch option --slugs; the control plane reads registry.json." >&2
      shift
      [ -n "${1:-}" ] && shift
      ;;
    --help|-h)
      echo "usage: bizagent-watch.sh [legacy watch options ignored]"
      exit 0
      ;;
    *)
      echo "bizagent-watch.sh: unknown option $1" >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "bizagent-watch.sh: Node.js is required; run install.sh or install node, then retry." >&2
  exit 127
fi
exec node "$HUB/scripts/bizagent-control-plane.js" serve --hub "$HUB"
