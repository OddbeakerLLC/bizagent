#!/usr/bin/env bash
# form-answer.sh — claim a submitted DGen form response (print + delete).
#
# Usage:
#   scripts/form-answer.sh <form-id>
#
# Prints the response JSON ({ form_id, agent, button, fields }) to stdout and
# deletes the response file in the same step, so sensitive values do not
# outlive the requesting agent's use of them. Unclaimed files are auto-deleted
# after 24 hours.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HUB="$(cd "$SCRIPT_DIR/.." && pwd)"
HUB="${BIZAGENT_HUB:-$DEFAULT_HUB}"
CLI="$SCRIPT_DIR/bizagent-control-plane.js"

if [ -z "${1:-}" ]; then
  echo "usage: scripts/form-answer.sh <form-id>" >&2
  exit 2
fi

exec node "$CLI" form-answer --hub "$HUB" "$@"
