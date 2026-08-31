#!/usr/bin/env bash
# run-agent.sh — invoke the hub agent (bizagent-agent + provider from registry).
# Usage: scripts/run-agent.sh "prompt text" [extra CLI args...]
#
# Used by nightly/weekly cron. Must work with a minimal cron environment:
#   - source .bizagent/env for API keys
#   - resolve node if installed via nvm
#   - write prompt to a temp file when runtime expects -f/--prompt-file
#   - timestamp every line (cron logs have no other clock)
#
# Source of truth:
#   registry.json settings.hub_agent.provider → LLM provider key in cli.json
#   cli.json _runtime + provider entry       → executable, flags, baseURL
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HUB" || { echo "run-agent.sh: cannot cd to $HUB" >&2; exit 1; }

# shellcheck source=lib/log-ts.sh
. "$HUB/scripts/lib/log-ts.sh"

# Cron often has a tiny PATH. Prefer login-shell node locations.
export PATH="${HOME}/.local/bin:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | tail -1)/bin:${PATH:-/usr/bin:/bin}"

# API keys for bizagent-agent (never log values)
if [[ -f "$HUB/.bizagent/env" ]]; then
  set -a
  # shellcheck disable=SC1091
  # shellcheck source=/dev/null
  . "$HUB/.bizagent/env" 2>/dev/null || true
  set +a
fi

if ! command -v node >/dev/null 2>&1; then
  # Last-ditch: common nvm current symlink
  if [[ -x "${HOME}/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    . "${HOME}/.nvm/nvm.sh" 2>/dev/null || true
  fi
fi

ts_err() { printf '%s %s\n' "$(bizagent_ts)" "$*" >&2; }
ts_out() { printf '%s %s\n' "$(bizagent_ts)" "$*"; }

if ! command -v node >/dev/null 2>&1; then
  ts_err "run-agent.sh: node is required (not on PATH for this environment)"
  exit 1
fi

if [[ $# -lt 1 ]]; then
  ts_err "usage: scripts/run-agent.sh \"prompt\" [extra args...]"
  exit 2
fi

PROMPT="$1"
shift

ts_out "run-agent: start"

SETTINGS="$(node -e '
const { loadRuntimeConfig } = require("./control-plane/lib/config");
const { getCliSettings } = require("./control-plane/lib/cli-config");
const hub = process.cwd();
const config = loadRuntimeConfig(hub);
const name = config.hubProvider || config.hubCliName || config.cli || "";
if (!name) {
  console.error("run-agent.sh: no hub provider — set settings.hub_agent.provider in registry.json");
  process.exit(1);
}
const model = config.hubModel || "";
const s = getCliSettings(hub, config._cliJson, config, name, model);
process.stdout.write(JSON.stringify(s));
')" || {
  ts_err "run-agent: failed to resolve CLI settings"
  exit 1
}

CLI="$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(s.cli||"")' "$SETTINGS")"
PFLAG="$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(s.promptFlag||"")' "$SETTINGS")"
EXTRA="$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(s.extraArgs||"")' "$SETTINGS")"

[ -n "$CLI" ] || { ts_err "run-agent.sh: empty executable from cli.json"; exit 1; }
[ -n "$PFLAG" ] || { ts_err "run-agent.sh: empty promptFlag from cli.json"; exit 1; }

# Relative executables (scripts/bizagent-agent) must resolve from hub cwd.
if [[ "$CLI" != /* && "$CLI" == */* ]]; then
  if [[ ! -x "$HUB/$CLI" && -x "$CLI" ]]; then
    :
  elif [[ -x "$HUB/$CLI" ]]; then
    CLI="$HUB/$CLI"
  fi
fi

# bizagent-agent (and grok) take a *file* via -f / --prompt-file, not inline text.
PROMPT_ARG="$PROMPT"
TMP_PROMPT=""
cleanup() {
  if [[ -n "${TMP_PROMPT}" && -f "${TMP_PROMPT}" ]]; then
    rm -f "${TMP_PROMPT}"
  fi
}
trap cleanup EXIT

case "$PFLAG" in
  -f|--prompt-file|--prompt-file=*)
    TMP_PROMPT="$(mktemp "${TMPDIR:-/tmp}/bizagent-run-agent.XXXXXX.md")"
    printf '%s\n' "$PROMPT" >"$TMP_PROMPT"
    PROMPT_ARG="$TMP_PROMPT"
    ;;
esac

ts_out "run-agent: launch cli=$CLI flag=$PFLAG extra=$EXTRA"

# Hub root for agent-runtime MCP config (registry.json settings.mcp).
export BIZAGENT_HUB="${BIZAGENT_HUB:-$HUB}"

# Timestamp every stdout/stderr line so nightly.log / weekly.log are navigable.
# shellcheck disable=SC2086
set +e
"$CLI" "$PFLAG" "$PROMPT_ARG" $EXTRA "$@" \
  > >(bizagent_ts_prefix) \
  2> >(bizagent_ts_prefix >&2)
code=$?
set -e

ts_out "run-agent: exit code=$code"
exit "$code"
