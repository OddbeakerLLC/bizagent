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

grep -q 'write_cli_json' "$ROOT/install.sh" \
  || fail "install.sh missing write_cli_json (seed cli.json + ensure selected CLI)"
grep -q 'hub_agent.cliName' "$ROOT/install.sh" \
  || fail "install.sh does not set registry hub_agent.cliName"
grep -q 'cli.json has entry' "$ROOT/install.sh" \
  || fail "install.sh does not ensure hub CLI is listed in cli.json"
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
grep -q 'api_key_var_for_cli' "$ROOT/install/install.sh" \
  || fail "install/install.sh missing API key → .bizagent/env step"
grep -q '\.bizagent/env' "$ROOT/install/install.sh" \
  || fail "install/install.sh does not write .bizagent/env"
grep -q 'prompts for that CLI' "$ROOT/README.md" \
  || fail "README does not document installer API key prompt"

echo "  ok: installer source override"
