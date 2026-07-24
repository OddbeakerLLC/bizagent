#!/usr/bin/env bash
# write-message.sh — write a correctly named outbox .md with YAML frontmatter.
#
# Usage (from hub root, or any cwd with --hub):
#   scripts/write-message.sh --to user --subject "short subject" --from hub \
#     [--conversation-id ID] [--body-file PATH | --body TEXT]
#   echo "body" | scripts/write-message.sh --to hub --from bizagent-oss --subject "done"
#
# Env:
#   BIZAGENT_HUB   default hub root when --hub is omitted (else parent of scripts/)
#   BIZAGENT_FROM  default --from when omitted (else hub) — honored by the Node CLI
#
# Notes:
#   - CLI binary is always this scripts/ tree (framework or installed hub copy).
#   - --hub / BIZAGENT_HUB selects the operational hub whose outbox is written.
#   - Never invents conversation_id; only stamps what you pass.
#   - Product agents should not invent console conversation_ids.
#   - Writes to hub/outbox when --from hub, else agents/<from>/outbox.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HUB="$(cd "$SCRIPT_DIR/.." && pwd)"
HUB="${BIZAGENT_HUB:-$DEFAULT_HUB}"
CLI="$SCRIPT_DIR/bizagent-control-plane.js"

if ! command -v node >/dev/null 2>&1; then
  echo "write-message.sh: Node.js is required" >&2
  exit 127
fi
if [ ! -f "$CLI" ]; then
  echo "write-message.sh: missing $CLI" >&2
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
  exec node "$CLI" write-message "$@"
fi
exec node "$CLI" write-message --hub "$HUB" "$@"
