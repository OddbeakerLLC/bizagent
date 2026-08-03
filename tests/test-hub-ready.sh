#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }
[ -x "$ROOT/scripts/check-hub-ready.sh" ] || fail "check-hub-ready.sh missing"
# Live hub should pass if this is a dogfood install with keys
if [ -f "$ROOT/registry.json" ] && [ -f "$ROOT/.bizagent/env" ]; then
  bash "$ROOT/scripts/check-hub-ready.sh" "$ROOT" || fail "check-hub-ready failed on dogfood hub"
fi
# Synthetic: empty hub fails
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP"
if bash "$ROOT/scripts/check-hub-ready.sh" "$TMP" 2>/dev/null; then
  fail "expected failure on empty hub"
fi
echo "  ok: hub-ready"
