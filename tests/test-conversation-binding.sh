#!/usr/bin/env bash
# test-conversation-binding.sh — chat-product binding (2026-11-08 hub dispatch).
# Covers: one shared resolver for route-time stamping and turn-time choice,
# answer-in-the-asking-chat vs proactive report → bound chat + pointer, product
# cap 3, pinned General landing chat, explicit no-product (chat-only) chats,
# stale bindings on product deletion, per-chat session files written only on
# mutation, and backfill inference.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

CONV="$ROOT/control-plane/lib/conversations.js"
MAIL="$ROOT/control-plane/lib/mail.js"
HUBMEM="$ROOT/control-plane/lib/hub-memory.js"
DISP="$ROOT/control-plane/lib/dispatcher.js"
APP="$ROOT/control-plane/public/app.js"
BACKFILL="$ROOT/scripts/backfill-conversation-products.js"

[ -f "$CONV" ] || fail "conversations module missing"
[ -f "$BACKFILL" ] || fail "backfill script missing"
[ -x "$BACKFILL" ] || fail "backfill script is not executable"
node --check "$BACKFILL" || fail "backfill script syntax check failed"

# One resolver, used by both paths (they must never disagree).
grep -q "function resolveConversationForMail" "$CONV" || fail "shared resolver missing"
grep -q "resolveConversationForMail" "$MAIL" || fail "router does not use the shared resolver"
grep -q "resolveConversationForMail" "$HUBMEM" || fail "turn-time choice does not use the shared resolver"
grep -q "resolveConversationForMail" "$DISP" || fail "agent-error routing does not use the shared resolver"
grep -q "getStampConversationId" "$CONV" || fail "stamp helper must be a thin wrapper over the resolver"

# Operator rule (a): answers stay in the asking chat; proactive reports go to
# the bound chat + a status-role pointer in the chat the operator is viewing.
grep -q "kind: 'pointer'" "$MAIL" || fail "router does not record a status pointer for proactive reports"
grep -q "destination_conversation_id" "$CONV" || fail "pointer destination not stored on cross-chat alerts"
grep -q "crossChatAlertVisibleFor" "$APP" || fail "UI missing pointer visibility rule"
grep -q "no product" "$APP" || fail "UI missing explicit no-product state"
grep -q "chatProductsModal" "$ROOT/control-plane/public/index.html" || fail "UI missing product picker dialog"
grep -q "conversation-products-line" "$ROOT/control-plane/public/index.html" || fail "UI missing product line below the conversation dropdown"
grep -q "updateConversationProducts" "$ROOT/control-plane/server.js" || fail "server missing product-binding route"
grep -q "chat-only" "$HUBMEM" || fail "hub prompt missing chat-only rule for unassigned chats"
grep -q "syncStaleBindings" "$CONV" || fail "stale-binding helper missing"

if ! command -v node >/dev/null 2>&1; then
  echo "  ok: chat-product binding (node checks skipped)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

node - "$ROOT" "$TMP" <<'NODE' || fail "chat-product binding unit failed"
const fs = require('fs');
const path = require('path');
const os = require('os');
const root = process.argv[2];
const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-test-'));
const conv = require(path.join(root, 'control-plane/lib/conversations'));
const { appDir } = require(path.join(root, 'control-plane/lib/config'));

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
};

// Registry: two products.
const writeRegistry = (slugs) => fs.writeFileSync(
  path.join(hub, 'registry.json'),
  JSON.stringify({ settings: {}, products: slugs.map((s) => ({ slug: s, name: s })) }),
);
writeRegistry(['alpha', 'beta']);

const alphaChat = conv.createConversation(hub, 'Alpha work');
conv.updateConversationProducts(hub, alphaChat.id, ['alpha']);
const betaChat = conv.createConversation(hub, 'Beta work');
conv.updateConversationProducts(hub, betaChat.id, ['beta']);
const general = conv.ensureGeneralConversation(hub);
assert(general && general.pinned && conv.conversationKind(general) === 'general', 'pinned General created for configured hub');
assert(general.unassigned === true, 'General is an explicit no-product chat');

// 1. Explicit conversation_id always wins.
const explicit = conv.createConversation(hub, 'Explicit');
let r = conv.resolveConversationForMail(hub, { from: 'alpha', to: 'hub', conversationId: explicit.id });
assert(r.conversationId === explicit.id && r.reason === 'explicit', 'explicit conversation_id must win');

// 2. An answer to a question asked in a chat stays in that chat, even when the
//    chat is not bound to the sender product (operator rule, overrides the
//    bound-chat recommendation).
const asking = conv.createConversation(hub, 'Asking chat');
conv.recordPendingAgentWork(hub, 'alpha', asking.id);
r = conv.resolveConversationForMail(hub, { from: 'alpha', to: 'hub' });
assert(r.conversationId === asking.id && r.reason === 'origin', 'answer stays in the chat the operator asked in');
assert(!r.pointerConversationId, 'no pointer when the answer lands where the question was asked');

// 3. Unsolicited report (no operator input pending) → chat bound to the sender
//    product, plus a status pointer in the chat the operator is viewing.
conv.clearPendingAgentWorkForConversation(hub, asking.id);
conv.setActiveConversation(hub, asking.id);
r = conv.resolveConversationForMail(hub, { from: 'alpha', to: 'hub' });
assert(r.proactive === true && r.conversationId === alphaChat.id && r.reason === 'bound', 'proactive report goes to the bound chat');
assert(r.pointerConversationId === asking.id, 'pointer recorded in the chat the operator is viewing');
conv.recordCrossChatAlert(hub, r.pointerConversationId, 'alpha', 'report', {
  kind: 'pointer',
  destination_conversation_id: r.conversationId,
});
const alerts = conv.listCrossChatAlerts(hub);
const pointer = alerts.find((a) => a.kind === 'pointer');
assert(pointer && pointer.destination_conversation_id === alphaChat.id, 'pointer alert stored with destination');
assert(alerts.some((a) => (a.kind || 'error') === 'error') === false, 'pointer does not overwrite error alerts shape (kind kept distinct)');

// 4. Multi-product chats allowed, cap 3.
const capped = conv.createConversation(hub, 'Three products');
const bound = conv.updateConversationProducts(hub, capped.id, ['alpha', 'beta', 'alpha']);
assert(bound.products.length === 2 && bound.products.includes('alpha'), 'dedupe within the cap');
const over = conv.updateConversationProducts(hub, capped.id, ['alpha', 'beta', 'gamma', 'delta']);
assert(over.products.length === conv.MAX_BOUND_PRODUCTS && over.products.length === 3, 'cap 3 products per chat enforced');
assert(over.products_inferred === false, 'manual override clears the inferred flag');

// 5. Explicit no-product chat: chat-only, persisted, never guessed.
const scratch = conv.createConversation(hub, 'Nothing in particular', { unassigned: true });
assert(scratch.unassigned === true && conv.conversationKind(scratch) === 'general', 'unassigned chat is explicit, not inferred');
const onDisk = JSON.parse(fs.readFileSync(path.join(appDir(hub), 'conversations', `${scratch.id}.json`), 'utf8'));
assert(onDisk.unassigned === true && Array.isArray(onDisk.products) && onDisk.products.length === 0,
  'no-product association persists in the conversation JSON across restarts');
assert(conv.listConversations(hub).find((c) => c.id === scratch.id).unassigned === true,
  'list exposes the explicit no-product state');
// Chat-only: no product-agent work is attributed to it.
assert(conv.recordPendingAgentWork(hub, 'alpha', scratch.id) === false, 'unassigned chat cannot own product-agent work');
// A proactive report never lands in an unassigned chat (bound chat or General wins).
conv.clearPendingAgentWorkForConversation(hub, scratch.id);
conv.setActiveConversation(hub, scratch.id);
r = conv.resolveConversationForMail(hub, { from: 'alpha', to: 'hub' });
assert(r.proactive === true && r.reason === 'bound', 'proactive report resolves to a bound chat');
assert(r.conversationId === capped.id, 'most recently active bound chat wins (alpha is bound to two chats)');
assert(r.conversationId !== scratch.id && r.pointerConversationId === scratch.id,
  'unassigned chat gets a pointer, not the report');
// An answer to a question asked in the scratch chat still lands there (hub answers directly).
const pendingTurns = path.join(appDir(hub), 'pending-hub-turns.json');
fs.mkdirSync(appDir(hub), { recursive: true });
fs.writeFileSync(pendingTurns, JSON.stringify({ turns: [{ conversationId: scratch.id, startedAt: new Date().toISOString(), logByteOffset: 0 }] }));
r = conv.resolveConversationForMail(hub, { from: 'hub', to: 'user' });
assert(r.conversationId === scratch.id && r.reason === 'origin', 'hub answers directly in the chat the operator asked in');
fs.unlinkSync(pendingTurns);

// 6. Product deletion marks bindings stale — never prunes them.
writeRegistry(['beta']);
const marked = conv.syncStaleBindings(hub);
assert(marked >= 1, 'dangling bindings marked stale');
const alphaAfter = conv.getConversation(hub, alphaChat.id);
assert(alphaAfter.binding_stale === true && alphaAfter.products.includes('alpha'),
  'stale binding is marked, not pruned (operator may re-add the slug)');
assert(conv.listConversations(hub).find((c) => c.id === alphaChat.id).products_stale.includes('alpha'),
  'list reports stale slugs');
writeRegistry(['alpha', 'beta']);

// 7. "new conversation X" inherits the current chat's products (and its
//    no-product state), and the trigger itself stays intact.
assert(conv.shouldStartNewConversation('new topic Alpha follow-up'), 'new-topic trigger unchanged');
const child = conv.createConversation(hub, 'Alpha follow-up', { products: alphaAfter.products });
assert(child.products.includes('alpha') && conv.conversationKind(child) === 'product', 'new chat inherits the bound products');
const childScratch = conv.createConversation(hub, 'Scratch child', { products: [], unassigned: true });
assert(childScratch.unassigned === true && childScratch.products.length === 0, 'new chat from an unassigned chat stays chat-only');

// 8. Per-chat session files, written only on mutation (not on poll).
conv.appendMessage(hub, alphaChat.id, 'hub', 'reply in bound chat');
const sessionFile = path.join(appDir(hub), 'sessions', `${alphaChat.id}.md`);
assert(fs.existsSync(sessionFile), 'per-chat session file written on mutation');
assert(fs.readFileSync(sessionFile, 'utf8').includes('Bound products: alpha'), 'session header names the bound products');
assert(!fs.existsSync(path.join(appDir(hub), 'sessions', `${scratch.id}.md`)) ||
       fs.readFileSync(path.join(appDir(hub), 'sessions', `${scratch.id}.md`), 'utf8').includes('none'),
  'unassigned chat session shows no bound products');
const before = fs.statSync(sessionFile).mtimeMs;
conv.getConversation(hub, alphaChat.id);   // read path (WS/SSE poll)
assert(fs.statSync(sessionFile).mtimeMs === before, 'read path must not rewrite the session file on every poll');

fs.rmSync(hub, { recursive: true, force: true });
console.log('  ok: chat-product binding unit');
NODE

# Backfill: name → slug, then message attribution; inferred flag, no history rewrite.
TMP2="$(mktemp -d)"
trap 'rm -rf "$TMP" "$TMP2"' EXIT
mkdir -p "$TMP2/.bizagent/conversations"
printf '%s\n' '{"settings":{},"products":[{"slug":"widgets","name":"Widgets"},{"slug":"beakernet","name":"BeakerBoard"}]}' > "$TMP2/registry.json"
cat > "$TMP2/.bizagent/conversations/2026-11-08-widgets-aaaaaa.json" <<'JSON'
{"id":"2026-11-08-widgets-aaaaaa","name":"Widgets","created_at":"2026-11-08T00:00:00.000Z","updated_at":"2026-11-08T00:00:00.000Z","summary":"","messages":[]}
JSON
cat > "$TMP2/.bizagent/conversations/2026-11-08-scratch-bbbbbb.json" <<'JSON'
{"id":"2026-11-08-scratch-bbbbbb","name":"Nothing in particular","created_at":"2026-11-08T00:00:00.000Z","updated_at":"2026-11-08T00:00:00.000Z","summary":"","messages":[{"role":"status","kind":"agent-completion","content":"Agent beakernet finished — summarizing…","created_at":"2026-11-08T00:01:00.000Z"}]}
JSON
cat > "$TMP2/.bizagent/conversations/2026-11-08-general-cccccc.json" <<'JSON'
{"id":"2026-11-08-general-cccccc","name":"General","created_at":"2026-11-08T00:00:00.000Z","updated_at":"2026-11-08T00:00:00.000Z","summary":"","messages":[],"products":[],"kind":"general","pinned":true,"unassigned":true}
JSON

node "$ROOT/scripts/backfill-conversation-products.js" --hub "$TMP2" --dry-run | grep -q 'Widgets → widgets' \
  || fail "backfill dry-run did not infer name → slug"
node "$ROOT/scripts/backfill-conversation-products.js" --hub "$TMP2" >/dev/null || fail "backfill run failed"
node - "$TMP2" <<'NODE' || fail "backfill results wrong"
const fs = require('fs');
const path = require('path');
const dir = path.join(process.argv[2], '.bizagent', 'conversations');
const read = (id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
const widgets = read('2026-11-08-widgets-aaaaaa');
if (!(widgets.products || []).includes('widgets') || widgets.products_inferred !== true) process.exit(1);
const scratch = read('2026-11-08-scratch-bbbbbb');
if (!(scratch.products || []).includes('beakernet') || scratch.products_inferred !== true) process.exit(2);
if (scratch.messages.length !== 1) process.exit(3);   // message history untouched
const general = read('2026-11-08-general-cccccc');
if ((general.products || []).length !== 0 || general.unassigned !== true) process.exit(4); // no evidence → stays unbound
process.exit(0);
NODE

echo "  ok: chat-product binding"
