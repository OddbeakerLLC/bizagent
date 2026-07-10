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
grep -q "ai-trainer" "$ROOT/README.md" \
  || fail "README does not document the ai-trainer staging flow"
grep -q "curl -fsSL https://raw.githubusercontent.com/OddbeakerLLC/bizagent/main/install.sh | BIZAGENT_SOURCE=ssh://git@example.com/staging/bizagent.git" "$ROOT/README.md" \
  || fail "README alternate repo example does not show how to run the installer"

echo "  ok: installer source override"
