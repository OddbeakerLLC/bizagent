#!/usr/bin/env bash
# test-onboard.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ONBOARD="$SCRIPT_DIR/../scripts/onboard.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "  FAIL: $1"; exit 1; }

mkdir -p "$TMP/myproject/src"
bash "$ONBOARD" "$TMP/myproject" >/dev/null || fail "onboard exited non-zero"

[ -d "$TMP/myproject/.agent/journal" ] || fail ".agent/journal not created"
[ -f "$TMP/myproject/sitemap.md" ]     || fail "sitemap.md not created"
grep -q "myproject" "$TMP/myproject/sitemap.md" || fail "sitemap missing project name"

# idempotency: a second run must not error and must not clobber edits
echo "HUMAN EDIT" >> "$TMP/myproject/sitemap.md"
bash "$ONBOARD" "$TMP/myproject" >/dev/null || fail "second run errored"
grep -q "HUMAN EDIT" "$TMP/myproject/sitemap.md" || fail "second run clobbered sitemap"

# a missing path is a non-fatal skip
bash "$ONBOARD" "$TMP/nope" >/dev/null 2>&1 || fail "missing path should exit 0"

# no argument is a usage error
bash "$ONBOARD" >/dev/null 2>&1 && fail "missing argument should exit non-zero"

echo "  ok: onboard.sh"
