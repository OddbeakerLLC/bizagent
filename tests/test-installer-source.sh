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

echo "  ok: installer source override"
