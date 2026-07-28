#!/usr/bin/env bash
# run-agent.sh — invoke the hub CLI resolved from registry + cli.json.
# Usage: scripts/run-agent.sh "prompt text" [extra CLI args...]
#
# Source of truth:
#   registry.json settings.hub_agent.cliName  → which engine
#   cli.json[name]                           → executable, promptFlag, extras
# Legacy .cli is migration-only (name fallback if hub_agent.cliName is empty).
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HUB" || { echo "run-agent.sh: cannot cd to $HUB" >&2; exit 1; }

if ! command -v node >/dev/null 2>&1; then
  echo "run-agent.sh: node is required" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "usage: scripts/run-agent.sh \"prompt\" [extra args...]" >&2
  exit 2
fi

PROMPT="$1"
shift

SETTINGS="$(node -e '
const { loadRuntimeConfig } = require("./control-plane/lib/config");
const { getCliSettings } = require("./control-plane/lib/cli-config");
const hub = process.cwd();
const config = loadRuntimeConfig(hub);
const name = config.hubCliName || config.cli || "";
if (!name) {
  console.error("run-agent.sh: no hub CLI name — set settings.hub_agent.cliName in registry.json");
  process.exit(1);
}
const s = getCliSettings(hub, config._cliJson, config, name, "");
process.stdout.write(JSON.stringify(s));
')" || exit 1

CLI="$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(s.cli||"")' "$SETTINGS")"
PFLAG="$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(s.promptFlag||"")' "$SETTINGS")"
EXTRA="$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(s.extraArgs||"")' "$SETTINGS")"

[ -n "$CLI" ] || { echo "run-agent.sh: empty executable from cli.json" >&2; exit 1; }
[ -n "$PFLAG" ] || { echo "run-agent.sh: empty promptFlag from cli.json" >&2; exit 1; }

# Word-split EXTRA intentionally — may contain multiple flags
# shellcheck disable=SC2086
exec "$CLI" $EXTRA "$PFLAG" "$PROMPT" "$@"
