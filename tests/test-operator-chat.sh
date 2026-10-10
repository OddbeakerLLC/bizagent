#!/usr/bin/env bash
# test-operator-chat.sh — crude SSH console: list / send / inbox stamp
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -x "$ROOT/scripts/chat.sh" ] || fail "scripts/chat.sh missing or not executable"
[ -f "$ROOT/scripts/lib/operator-chat.js" ] || fail "scripts/lib/operator-chat.js missing"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/inbox" "$TMP/.bizagent"
printf '%s\n' '{"settings":{},"products":[]}' > "$TMP/registry.json"

ID="$(node - "$ROOT" "$TMP" <<'NODE'
const path = require('path');
const root = process.argv[2];
const hub = process.argv[3];
const { createConversation } = require(path.join(root, 'control-plane/lib/conversations'));
const a = createConversation(hub, 'Alpha');
const b = createConversation(hub, 'Beta');
process.stdout.write(a.id);
NODE
)"
[ -n "$ID" ] || fail "could not create test conversation"

list="$(bash "$ROOT/scripts/chat.sh" --hub "$TMP" --list)" || fail "list failed"
echo "$list" | grep -q 'Alpha' || fail "list missing Alpha: $list"
echo "$list" | grep -q 'Beta' || fail "list missing Beta: $list"

out="$(bash "$ROOT/scripts/chat.sh" --hub "$TMP" --conversation "$ID" --send "hello from ssh")" \
  || fail "send failed: $out"
echo "$out" | grep -q "sent to $ID" || fail "send output unexpected: $out"

inbox_n="$(find "$TMP/inbox" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')"
[ "$inbox_n" = "1" ] || fail "expected 1 inbox file, got $inbox_n"
mail="$(cat "$TMP/inbox"/*.md)"
echo "$mail" | grep -q 'from: operator' || fail "inbox missing from: operator"
echo "$mail" | grep -q "conversation_id: $ID" || fail "inbox missing conversation_id"
echo "$mail" | grep -q 'hello from ssh' || fail "inbox missing body"

node - "$ROOT" "$TMP" "$ID" <<'NODE' || fail "conversation json missing user message"
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const hub = process.argv[3];
const id = process.argv[4];
const { getConversation } = require(path.join(root, 'control-plane/lib/conversations'));
const conv = getConversation(hub, id);
const users = (conv.messages || []).filter((m) => m.role === 'user');
if (users.length !== 1 || users[0].content !== 'hello from ssh') {
  console.error(JSON.stringify(conv.messages, null, 2));
  process.exit(1);
}
const active = JSON.parse(fs.readFileSync(path.join(hub, '.bizagent', 'active-conversation.json'), 'utf8'));
if (active.id !== id) {
  console.error('active conversation not stamped', active);
  process.exit(1);
}
NODE

echo "  ok: operator-chat"
