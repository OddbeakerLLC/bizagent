#!/usr/bin/env bash
# test-router.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "  FAIL: $1"; exit 1; }

# minimal hub layout
mkdir -p "$TMP/scripts" "$TMP/inbox" "$TMP/outbox"
mkdir -p "$TMP/agents/alpha/inbox" "$TMP/agents/alpha/outbox"
mkdir -p "$TMP/agents/beta/inbox"  "$TMP/agents/beta/outbox"
cp "$SCRIPT_DIR/../scripts/router.sh" "$TMP/scripts/router.sh"
echo '{"products":[]}' > "$TMP/registry.json"

# alpha -> beta
cat > "$TMP/agents/alpha/outbox/2026-05-16-alpha-test.md" <<'EOF'
---
from: alpha
to: beta
date: 2026-05-16
subject: test
---
hello beta
EOF

# hub -> alpha
cat > "$TMP/outbox/2026-05-16-hub-ping.md" <<'EOF'
---
from: hub
to: alpha
date: 2026-05-16
subject: ping
---
ping
EOF

bash "$TMP/scripts/router.sh" >/dev/null

[ -f "$TMP/agents/beta/inbox/2026-05-16-alpha-test.md" ] || fail "alpha->beta not delivered"
[ -f "$TMP/agents/alpha/inbox/2026-05-16-hub-ping.md" ]  || fail "hub->alpha not delivered"
[ -z "$(ls -A "$TMP/agents/alpha/outbox")" ] || fail "sender outbox not cleared"

# unknown recipient: message stays put
cat > "$TMP/outbox/2026-05-16-hub-bad.md" <<'EOF'
---
from: hub
to: ghost
date: 2026-05-16
subject: bad
---
EOF
bash "$TMP/scripts/router.sh" >/dev/null 2>&1
[ -f "$TMP/outbox/2026-05-16-hub-bad.md" ] || fail "msg to unknown recipient should stay"

echo "  ok: router.sh"
