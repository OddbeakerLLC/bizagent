#!/usr/bin/env bash
# chat.sh — crude SSH operator console (pick a conversation, talk to the hub).
#
# For when you can SSH to the hub host but cannot reach the web UI.
# Posts through the same inbox path as the browser console.
#
# Usage (from hub root, or any cwd):
#   scripts/chat.sh
#   scripts/chat.sh --list
#   scripts/chat.sh --conversation ID
#   scripts/chat.sh --conversation ID --send "hello"
#
# Env: BIZAGENT_HUB  hub root when --hub is omitted
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HUB="$(cd "$SCRIPT_DIR/.." && pwd)"
HUB="${BIZAGENT_HUB:-$DEFAULT_HUB}"
CLI="$SCRIPT_DIR/lib/operator-chat.js"

if ! command -v node >/dev/null 2>&1; then
  echo "chat.sh: Node.js is required" >&2
  exit 127
fi
if [ ! -f "$CLI" ]; then
  echo "chat.sh: missing $CLI" >&2
  exit 1
fi

has_hub=0
for arg in "$@"; do
  if [ "$arg" = "--hub" ]; then
    has_hub=1
    break
  fi
done

if [ "$has_hub" -eq 1 ]; then
  exec node "$CLI" "$@"
fi
exec node "$CLI" --hub "$HUB" "$@"
