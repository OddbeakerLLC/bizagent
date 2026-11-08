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

# --- Chat-product binding (2026-11-08): route-time stamping uses the shared resolver ---
# Unsolicited alpha report with no operator question pending → the chat bound to
# alpha, plus a status pointer in the chat the operator is viewing.
node - "$ROOT" "$TMP" <<'NODE' || fail "binding setup failed"
const fs = require('fs'); const path = require('path');
const ROOT = process.argv[2], hub = process.argv[3];
const conv = require(path.join(ROOT, 'control-plane/lib/conversations'));
const err = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const bound = conv.createConversation(hub, 'Alpha work');
conv.updateConversationProducts(hub, bound.id, ['alpha']);
const viewing = conv.createConversation(hub, 'Nothing in particular', { unassigned: true });
conv.setActiveConversation(hub, viewing.id);
fs.writeFileSync(path.join(hub, 'agents/alpha/outbox/2026-11-08-alpha-report.md'), [
  '---', 'from: alpha', 'to: hub', 'date: 2026-11-08', 'subject: nightly report', '---', '',
  'unsolicited report; no operator question is pending',
].join('\n'));
fs.writeFileSync(path.join(hub, '.bizagent/test-expected.json'), JSON.stringify({ bound: bound.id, viewing: viewing.id }));
process.exit(0);
NODE

bash "$TMP/scripts/router.sh" >/dev/null
node - "$ROOT" "$TMP" <<'NODE' || fail "router stamping (bound chat + pointer) failed"
const fs = require('fs'); const path = require('path');
const ROOT = process.argv[2], hub = process.argv[3];
const conv = require(path.join(ROOT, 'control-plane/lib/conversations'));
const err = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const expected = JSON.parse(fs.readFileSync(path.join(hub, '.bizagent', 'test-expected.json'), 'utf8'));
const delivered = path.join(hub, 'inbox', '2026-11-08-alpha-report.md');
if (!fs.existsSync(delivered)) err('report not delivered to the hub inbox');
const text = fs.readFileSync(delivered, 'utf8');
const stamped = text.split('\n').find((line) => line.startsWith('conversation_id:')) || '';
if (stamped !== `conversation_id: ${expected.bound}`) err('proactive report must stamp the bound chat, got: ' + stamped);
const alerts = conv.listCrossChatAlerts(hub);
const pointer = alerts.find((a) => a.kind === 'pointer');
if (!pointer) err('no status pointer recorded for the proactive report');
if (pointer.conversationId !== expected.viewing) err('pointer must live in the chat the operator is viewing');
if (pointer.destination_conversation_id !== expected.bound) err('pointer destination wrong');
process.exit(0);
NODE

echo "  ok: router.sh"
