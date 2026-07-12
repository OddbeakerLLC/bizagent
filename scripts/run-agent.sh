#!/usr/bin/env bash
# run-agent.sh — invoke the configured AI CLI, reading settings from .cli
# Usage: scripts/run-agent.sh "prompt text"
# The hub directory is inferred from the script's location.
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_FILE="$HUB/.cli"

[ -f "$CLI_FILE" ] || { echo "run-agent.sh: .cli not found at $CLI_FILE" >&2; exit 1; }

# Source .cli — variables: CLI_CMD (preferred), CLI (legacy), CLI_PROMPT_FLAG, CLI_EXTRA_ARGS, CLI_YOLO_FLAG (legacy)
CLI_CMD=""
CLI=""
CLI_PROMPT_FLAG="-p"
CLI_EXTRA_ARGS=""
CLI_YOLO_FLAG=""
. "$CLI_FILE"

CMD="${CLI_CMD:-${CLI:-}}"
EXTRA="${CLI_EXTRA_ARGS:-${CLI_YOLO_FLAG:-}}"

[ -n "$CMD" ] || { echo "run-agent.sh: CLI_CMD not set in .cli" >&2; exit 1; }

cd "$HUB" || { echo "run-agent.sh: cannot cd to $HUB" >&2; exit 1; }
# Word-split EXTRA intentionally — it may contain multiple flags
# shellcheck disable=SC2086
exec "$CMD" "$CLI_PROMPT_FLAG" ${EXTRA} "$@"
