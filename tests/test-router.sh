#!/usr/bin/env bash
# test-router.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

grep -q "bizagent-control-plane.js.*route-once" "$ROOT/scripts/router.sh" \
  || fail "router.sh does not delegate to the Node control plane"

if ! command -v node >/dev/null 2>&1; then
  echo "  ok: router.sh wrapper (live route skipped; node not installed)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/inbox" "$TMP/outbox"
mkdir -p "$TMP/agents/alpha/inbox/archive" "$TMP/agents/alpha/outbox"
mkdir -p "$TMP/agents/beta/inbox/archive" "$TMP/agents/beta/outbox"
cp "$ROOT/scripts/bizagent-control-plane.js" "$TMP/scripts/bizagent-control-plane.js"
cp "$ROOT/scripts/router.sh" "$TMP/scripts/router.sh"
cp -R "$ROOT/control-plane" "$TMP/control-plane"
cat > "$TMP/registry.json" <<'JSON'
{"settings":{},"products":[{"slug":"alpha","name":"Alpha","agent_name":"Agent A","projects":[]},{"slug":"beta","name":"Beta","agent_name":"Agent B","projects":[]}]}
JSON
cat > "$TMP/agents/alpha/outbox/2026-07-09-alpha-test.md" <<'MSG'
---
from: alpha
to: beta
date: 2026-07-09
subject: test
---
hello beta
MSG

bash "$TMP/scripts/router.sh" >/dev/null
[ -f "$TMP/agents/beta/inbox/2026-07-09-alpha-test.md" ] || fail "alpha->beta not delivered"

echo "  ok: router.sh"
