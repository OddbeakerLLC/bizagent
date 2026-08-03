#!/usr/bin/env bash
# check-hub-ready.sh — verify the hub can launch bizagent-agent
# (provider, model, API key, runtime binary/deps).
#
# Exit 0 = ready. Exit 1 = not ready.
# Usage: scripts/check-hub-ready.sh [hub-path]
set -uo pipefail

HUB="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/..}" && pwd)"
FAIL=0
ok() { printf "  ✓ %s\n" "$1"; }
bad() { printf "  ✗ %s\n" "$1"; FAIL=1; }
note() { printf "    %s\n" "$1"; }

printf "Hub ready check: %s\n" "$HUB"

if [[ ! -f "$HUB/registry.json" ]]; then
  bad "registry.json missing"
  PROVIDER=""
  MODEL=""
else
  PROVIDER="$(node -e 'const r=require(process.argv[1]);const ha=(r.settings&&r.settings.hub_agent)||{};process.stdout.write(String(ha.provider||ha.cliName||ha.cli||"").trim())' "$HUB/registry.json" 2>/dev/null || true)"
  MODEL="$(node -e 'const r=require(process.argv[1]);const ha=(r.settings&&r.settings.hub_agent)||{};const m=ha.model||(r.settings&&r.settings.models&&r.settings.models.orchestrator)||"";process.stdout.write(String(m).trim())' "$HUB/registry.json" 2>/dev/null || true)"
  if [[ -z "$PROVIDER" ]]; then
    bad "hub_agent.provider not set in registry.json"
    note "Set settings.hub_agent.provider (e.g. grok, chatgpt, claude, gemini)"
  else
    ok "provider=$PROVIDER"
  fi
  if [[ -z "$MODEL" ]]; then
    bad "hub_agent.model not set in registry.json"
    note "Set settings.hub_agent.model to a model id for that provider"
  else
    ok "model=$MODEL"
  fi
fi

if [[ ! -f "$HUB/cli.json" ]]; then
  bad "cli.json missing (copy from cli.json.example)"
else
  ok "cli.json present"
fi

if [[ ! -x "$HUB/scripts/bizagent-agent" ]]; then
  bad "scripts/bizagent-agent missing or not executable"
else
  ok "scripts/bizagent-agent executable"
fi
if [[ ! -x "$HUB/agent-runtime/bin/bizagent-agent" ]]; then
  bad "agent-runtime/bin/bizagent-agent missing or not executable"
else
  ok "agent-runtime binary present"
fi
if [[ ! -d "$HUB/agent-runtime/node_modules/openai" ]]; then
  bad "agent-runtime deps missing (run: cd agent-runtime && npm install)"
else
  ok "agent-runtime npm deps installed"
fi

if command -v node >/dev/null 2>&1 && [[ -f "$HUB/registry.json" && -f "$HUB/cli.json" && -n "$PROVIDER" ]]; then
  EVAL_FILE="$(mktemp)"
  if ! BIZAGENT_CHECK_HUB="$HUB" BIZAGENT_CHECK_PROVIDER="$PROVIDER" BIZAGENT_CHECK_MODEL="$MODEL" \
    node >"$EVAL_FILE" 2>/dev/null <<'NODE'
const path = require("path");
const hub = process.env.BIZAGENT_CHECK_HUB;
const providerArg = process.env.BIZAGENT_CHECK_PROVIDER || "";
const modelArg = process.env.BIZAGENT_CHECK_MODEL || "";
try {
  const { loadRuntimeConfig } = require(path.join(hub, "control-plane/lib/config"));
  const { getCliSettings } = require(path.join(hub, "control-plane/lib/cli-config"));
  const config = loadRuntimeConfig(hub);
  const provider = providerArg || config.hubProvider || config.hubCliName || "";
  const model = modelArg || config.hubModel || "";
  if (!provider) {
    console.log(JSON.stringify({ ok: false, error: "no provider" }));
    process.exit(0);
  }
  const s = getCliSettings(hub, config._cliJson, config, provider, model);
  const entry = (config._cliJson && config._cliJson[s.provider]) || {};
  console.log(JSON.stringify({
    ok: true,
    provider: s.provider,
    model: model || null,
    keyEnv: entry.keyEnv || s.keyEnv || "",
    extraArgs: s.extraArgs || "",
  }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message }));
}
NODE
  then
    echo '{"ok":false,"error":"node failed"}' >"$EVAL_FILE"
  fi
  EVAL="$(cat "$EVAL_FILE" 2>/dev/null || true)"
  rm -f "$EVAL_FILE"
  READY_OK="$(node -e 'try{const j=JSON.parse(process.argv[1]);process.stdout.write(j.ok?"1":"0")}catch(e){process.stdout.write("0")}' "$EVAL" 2>/dev/null || echo 0)"
  if [[ "$READY_OK" != "1" ]]; then
    ERR="$(node -e 'try{const j=JSON.parse(process.argv[1]);process.stdout.write(j.error||"unknown")}catch(e){process.stdout.write("parse error")}' "$EVAL" 2>/dev/null || echo unknown)"
    bad "launch resolve failed: $ERR"
  else
    KEY_ENV="$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(j.keyEnv||"")' "$EVAL")"
    EXTRA="$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(j.extraArgs||"")' "$EVAL")"
    ok "launch resolves (${EXTRA})"

    if [[ -f "$HUB/.bizagent/env" ]]; then
      set -a
      # shellcheck disable=SC1091
      # shellcheck source=/dev/null
      source "$HUB/.bizagent/env" 2>/dev/null || true
      set +a
      ok ".bizagent/env present"
    else
      bad ".bizagent/env missing"
      note "Create it with the key for your provider (see .bizagent/env.example)"
    fi

    if [[ -n "$KEY_ENV" ]]; then
      if [[ -n "${!KEY_ENV:-}" ]]; then
        ok "$KEY_ENV is set (value hidden)"
      else
        bad "$KEY_ENV is empty — hub turns will fail at API auth"
        note "Add $KEY_ENV=... to .bizagent/env then: scripts/control-plane.sh restart"
      fi
    fi
  fi
fi

echo
if [[ "$FAIL" -ne 0 ]]; then
  printf "NOT READY — fix the items above before expecting first-run / hub turns.\n"
  exit 1
fi
printf "READY — hub can launch bizagent-agent for turns (including first-run).\n"
exit 0
