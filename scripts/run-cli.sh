#!/usr/bin/env bash
# run-cli.sh <prompt>
#
# Invokes the configured CLI agent (claude, etc.) using .cli as the single
# source of truth for the command, prompt flag, and extra args (e.g.
# --dangerously-skip-permissions). Cron entries call this instead of
# hardcoding the CLI invocation, so changing .cli doesn't require editing
# crontab too.
set -u
HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HUB"

CLI_CMD=claude
CLI_PROMPT_FLAG=-p
CLI_EXTRA_ARGS=""
[ -f "$HUB/.cli" ] && source "$HUB/.cli"

exec "$CLI_CMD" "$CLI_PROMPT_FLAG" "$1" $CLI_EXTRA_ARGS
