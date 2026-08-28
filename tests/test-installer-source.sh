#!/usr/bin/env bash
# test-installer-source.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

grep -q 'BIZAGENT_SOURCE=' "$ROOT/install.sh" \
  || fail "installer does not expose BIZAGENT_SOURCE"
grep -q 'https://github.com/OddbeakerLLC/bizagent.git' "$ROOT/install.sh" \
  || fail "installer default source is not the public GitHub repo"
grep -q 'validate_source' "$ROOT/install.sh" \
  || fail "installer does not validate BIZAGENT_SOURCE shape"
grep -q 'git clone --quiet -- "$BIZAGENT_SOURCE" "$INSTALL_DIR"' "$ROOT/install.sh" \
  || fail "installer clone step does not protect option-like sources with --"
grep -q 'BIZAGENT_SOURCE_EXPLICIT' "$ROOT/install.sh" \
  || fail "installer does not track explicit source overrides"
grep -q 'BIZAGENT_SOURCE is set' "$ROOT/install.sh" \
  || fail "installer does not prevent stale clone reuse when source is overridden"
if grep -q 'from \$BIZAGENT_SOURCE' "$ROOT/install.sh"; then
  fail "installer prints the raw source URL"
fi
grep -q "BIZAGENT_SOURCE" "$ROOT/README.md" \
  || fail "README does not document the source override"
grep -q "BIZAGENT_DIR" "$ROOT/README.md" \
  || fail "README does not document the BIZAGENT_DIR install-dir override"
grep -q "staging" "$ROOT/README.md" \
  || fail "README does not include a staging-source section"

# Bug fixes: DEFAULT_DIR, clone cleanup, and clone detection marker
grep -q 'DEFAULT_DIR="\$HOME/bizagent"' "$ROOT/install.sh" \
  || fail "installer DEFAULT_DIR does not use \$HOME (must not use \$PWD)"
grep -q 'rm -rf "\$INSTALL_DIR"' "$ROOT/install.sh" \
  || fail "installer clone_repo does not clean up partial directory on failure"
grep -q 'AGENT\.md' "$ROOT/install.sh" \
  || fail "installer clone detection does not use AGENT.md as stable marker"
grep -q 'grep -qi "bizagent"' "$ROOT/install.sh" \
  || fail "installer clone detection does not verify AGENT.md is a bizagent clone (not just any AGENT.md)"
grep -q 'pkill -f "bizagent-control-plane"' "$ROOT/install.sh" \
  || fail "installer choose_dir does not kill stale control plane before clearing install dir"
grep -q 'pgrep -f "bizagent-control-plane"' "$ROOT/install.sh" \
  || fail "installer choose_dir does not check for running control plane"
grep -q "pkill -f bizagent-control-plane" "$ROOT/install.sh" \
  || fail "installer fallback die message does not hint at control-plane kill"
grep -q "rm -rf '\\\$INSTALL_DIR'" "$ROOT/install.sh" \
  || fail "installer die message does not single-quote path in suggested rm command (space-in-path safety)"

# Operator registry.json must not be the public tracked source of truth.
grep -qE '^registry\.json$' "$ROOT/.gitignore" \
  || fail ".gitignore must ignore operator registry.json"
! git -C "$ROOT" ls-files --error-unmatch registry.json >/dev/null 2>&1 \
  || fail "registry.json is still tracked — remove it from the public repo index"
grep -q 'write_registry_seed' "$ROOT/install.sh" \
  || fail "install.sh missing write_registry_seed (empty products seed)"

grep -q 'detach_framework_remote\|detach-framework-remote' "$ROOT/install.sh" \
  || fail "install.sh missing detach public framework remote step"
grep -q 'write_cli_json' "$ROOT/install.sh" \
  || fail "install.sh missing write_cli_json (seed cli.json + ensure selected CLI)"
grep -q 'hub_agent.provider\|hub_agent\["provider"\]\|provider' "$ROOT/install.sh" \
  || fail "install.sh does not set registry hub_agent.provider"
grep -q 'select_default_provider\|bizagent-agent' "$ROOT/install.sh" \
  || fail "install.sh does not use bizagent-agent / select_default_provider"
grep -q 'cli.json has provider\|_runtime' "$ROOT/install.sh" \
  || fail "install.sh does not seed provider catalog"
# New installs must not treat .cli as the live flag source.
! grep -q 'CLI config written (.cli)' "$ROOT/install.sh" \
  || fail "install.sh still writes .cli as primary CLI config"

# API key prompt → .bizagent/env (hub turns need provider keys; bare CLI select is not enough)
grep -q 'prompt_api_key' "$ROOT/install.sh" \
  || fail "install.sh missing prompt_api_key"
grep -q 'write_env_file' "$ROOT/install.sh" \
  || fail "install.sh missing write_env_file"
grep -q 'api_key_var_for_cli' "$ROOT/install.sh" \
  || fail "install.sh missing api_key_var_for_cli"
grep -q 'XAI_API_KEY' "$ROOT/install.sh" \
  || fail "install.sh does not map grok → XAI_API_KEY"
grep -q 'ANTHROPIC_API_KEY' "$ROOT/install.sh" \
  || fail "install.sh does not map claude → ANTHROPIC_API_KEY"
grep -q 'BIZAGENT_API_KEY' "$ROOT/install.sh" \
  || fail "install.sh missing non-interactive BIZAGENT_API_KEY support"
# API key is required (non-empty) at the CLI-choice step, with a clear warning.
grep -q 'incorrectly entered API key will prevent completing the installation' "$ROOT/install.sh" \
  || fail "install.sh does not warn about an incorrect API key"
grep -q '\[\[ -z "\$key" \]\]' "$ROOT/install.sh" \
  || fail "install.sh does not require a non-empty API key"
grep -q 'incorrectly entered API key will prevent completing the installation' "$ROOT/install/install.sh" \
  || fail "install/install.sh does not warn about an incorrect API key"
grep -q '\[\[ -z "\$typed_key" \]\]' "$ROOT/install/install.sh" \
  || fail "install/install.sh does not require a non-empty API key"
# API key is validated with a tiny 'hello' prompt before proceeding (re-prompt on failure).
grep -q 'validate_api_key' "$ROOT/install.sh" \
  || fail "install.sh missing API key validation helper"
grep -q 'chat/completions' "$ROOT/install.sh" \
  || fail "install.sh validation does not send a hello prompt to the LLM"
grep -q 'rejected by the provider' "$ROOT/install.sh" \
  || fail "install.sh does not re-prompt after a failed API key validation"
grep -q 'validate_api_key' "$ROOT/install/install.sh" \
  || fail "install/install.sh missing API key validation helper"
grep -q 'chat/completions' "$ROOT/install/install.sh" \
  || fail "install/install.sh validation does not send a hello prompt to the LLM"
grep -q 'rejected by the provider' "$ROOT/install/install.sh" \
  || fail "install/install.sh does not re-prompt after a failed API key validation"
grep -qE 'api_key_var_for_provider|api_key_var_for_cli' "$ROOT/install/install.sh" \
  || fail "install/install.sh missing API key → .bizagent/env step"
grep -q 'seed-first-run\|check-hub-ready' "$ROOT/install/install.sh" \
  || fail "install/install.sh missing first-run readiness / seed"
grep -q 'seed-first-run' "$ROOT/install.sh" \
  || fail "root install.sh missing seed-first-run handoff"
[ -x "$ROOT/scripts/seed-first-run.sh" ] \
  || fail "scripts/seed-first-run.sh missing or not executable"
grep -q '\.bizagent/env' "$ROOT/install/install.sh" \
  || fail "install/install.sh does not write .bizagent/env"
grep -qE 'bizagent-agent|LLM provider|check-hub-ready' "$ROOT/README.md" \
  || fail "README does not document installer API key prompt"


# LLM provider choice during install (root install.sh + install/install.sh)
grep -q 'Choose an LLM provider' "$ROOT/install.sh" \
  || fail "install.sh does not prompt the user to choose an LLM provider"
grep -q 'Choose an LLM provider' "$ROOT/install/install.sh" \
  || fail "install/install.sh does not prompt the user to choose an LLM provider"
grep -q 'BIZAGENT_PROVIDER' "$ROOT/install/install.sh" \
  || fail "install/install.sh does not respect BIZAGENT_PROVIDER override"


echo "  ok: installer source override"

# oddbeaker-tts dependency + voice prompt (console TTS)
grep -q 'ensure_oddbeaker_tts' "$ROOT/install.sh" \
  || fail "install.sh missing ensure_oddbeaker_tts"
grep -q 'install-oddbeaker-tts' "$ROOT/install.sh" \
  || fail "install.sh does not call install-oddbeaker-tts"
[ -x "$ROOT/scripts/install-oddbeaker-tts.sh" ] \
  || fail "scripts/install-oddbeaker-tts.sh missing or not executable"
bash -n "$ROOT/scripts/install-oddbeaker-tts.sh" \
  || fail "install-oddbeaker-tts.sh bash -n failed"
grep -q 'BIZAGENT_TTS_VOICE' "$ROOT/scripts/install-oddbeaker-tts.sh" \
  || fail "install-oddbeaker-tts.sh does not persist BIZAGENT_TTS_VOICE"
grep -q 'BIZAGENT_SKIP_TTS' "$ROOT/install.sh" \
  || fail "install.sh missing BIZAGENT_SKIP_TTS"
grep -q 'BIZAGENT_TTS_VOICE' "$ROOT/.bizagent/env.example" \
  || fail "env.example missing BIZAGENT_TTS_VOICE"
grep -q 'install-oddbeaker-tts' "$ROOT/README.md" \
  || fail "README missing install-oddbeaker-tts docs"

