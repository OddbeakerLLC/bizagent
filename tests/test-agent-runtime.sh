#!/usr/bin/env bash
# Built-in bizagent-agent runtime + provider catalog
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -x "$ROOT/scripts/bizagent-agent" ] || fail "scripts/bizagent-agent missing or not executable"
[ -x "$ROOT/agent-runtime/bin/bizagent-agent" ] || fail "agent-runtime/bin/bizagent-agent missing or not executable"
[ -f "$ROOT/agent-runtime/src/index.js" ] || fail "agent-runtime/src/index.js missing"
[ -f "$ROOT/agent-runtime/package.json" ] || fail "agent-runtime/package.json missing"

if [ ! -d "$ROOT/agent-runtime/node_modules/openai" ]; then
  (cd "$ROOT/agent-runtime" && npm install --silent) || fail "npm install in agent-runtime failed"
fi

(cd "$ROOT/agent-runtime" && npm test) || fail "agent-runtime unit tests failed"

out="$("$ROOT/scripts/bizagent-agent" --list-providers)" || fail "--list-providers failed"
echo "$out" | grep -q '^grok' || fail "providers list missing grok"
echo "$out" | grep -q '^chatgpt' || fail "providers list missing chatgpt"
echo "$out" | grep -q '^claude' || fail "providers list missing claude"
echo "$out" | grep -q '^gemini' || fail "providers list missing gemini"
echo "$out" | grep -q '^venice' || fail "providers list missing venice"

# cli.json is a provider catalog with fixed _runtime
grep -q '"_runtime"' "$ROOT/cli.json.example" || fail "cli.json.example missing _runtime"
grep -q '"baseURL"' "$ROOT/cli.json.example" || fail "cli.json.example missing provider baseURL"
grep -q '"grok"' "$ROOT/cli.json.example" || fail "cli.json.example missing grok provider"

# getCliSettings always launches bizagent-agent with --provider
node - "$ROOT" <<'NODE' || fail "getCliSettings provider launch failed"
const path = require('path');
const { getCliSettings, compileAgentCommand, providerEntries } = require(path.join(process.argv[2], 'control-plane/lib/cli-config'));
const catalog = {
  _runtime: {
    executable: 'scripts/bizagent-agent',
    promptFlag: '-f',
    flags: { extra: '-y' },
  },
  grok: {
    baseURL: 'https://api.x.ai/v1',
    keyEnv: 'XAI_API_KEY',
    models: ['grok-4.5'],
  },
  chatgpt: {
    baseURL: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    models: ['gpt-4o'],
  },
  claude: {
    baseURL: 'https://api.anthropic.com/v1/',
    keyEnv: 'ANTHROPIC_API_KEY',
    models: ['claude-sonnet-4-6'],
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyEnv: 'GEMINI_API_KEY',
    models: ['gemini-2.5-flash'],
  },
};
const s = getCliSettings(process.argv[2], catalog, { hubProvider: 'grok', hubCliName: 'grok' }, 'chatgpt', 'gpt-4o');
if (s.cli !== 'scripts/bizagent-agent') { console.error('cli', s); process.exit(1); }
if (s.promptFlag !== '-f') { console.error('flag', s); process.exit(2); }
if (!/--provider chatgpt/.test(s.extraArgs || '')) { console.error('provider', s); process.exit(3); }
if (!/--model gpt-4o/.test(s.extraArgs || '')) { console.error('model', s); process.exit(4); }
if (!/-y/.test(s.extraArgs || '')) { console.error('yes', s); process.exit(5); }
// Legacy cliName "claude" maps to openrouter when present, else throws — map via LEGACY
const s2 = getCliSettings(process.argv[2], catalog, { hubCliName: 'grok' }, 'grok', 'grok-4.5');
if (s2.provider !== 'grok') { console.error(s2); process.exit(6); }
const cmd = compileAgentCommand(s2, '/tmp/prompt.md');
if (!cmd.includes('-f') || !cmd.includes('/tmp/prompt.md')) { console.error(cmd); process.exit(7); }
const pe = providerEntries(catalog);
if (!pe.grok || pe._runtime) { console.error(pe); process.exit(8); }
NODE

# runtime-cwd symlink resolution
if [ -d "$ROOT/.bizagent/runtime-cwd" ]; then
  (cd "$ROOT/.bizagent/runtime-cwd" && scripts/bizagent-agent --list-providers >/dev/null) \
    || fail "launcher fails from runtime-cwd"
fi

echo "OK: agent-runtime"
