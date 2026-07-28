#!/usr/bin/env bash
# run-cli.sh <prompt>
#
# Invokes the hub CLI using registry.json + cli.json (same resolution as the
# control plane). Cron should call this instead of hardcoding the CLI.
# Legacy .cli is migration-only for hub name if hub_agent.cliName is unset.
set -u
HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$HUB/scripts/run-agent.sh" "$@"
