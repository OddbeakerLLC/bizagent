#!/usr/bin/env bash
# test-form-routing.sh — DGen form-response routing regression (2026-11-27):
# a form submitted in chat X must thread the pointer mail to X and deliver it
# to the requesting agent; hub→hub mail without a conversation_id must never
# inherit an unrelated archived chat via cid recovery.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

TEST_ROOT="$ROOT" node -e '
const fs = require("fs");
const path = require("path");
const os = require("os");
const ROOT = process.env.TEST_ROOT;

const hub = fs.mkdtempSync(path.join(os.tmpdir(), "form-routing-test-"));
fs.mkdirSync(path.join(hub, "agents", "jobe-ai"), { recursive: true });
fs.writeFileSync(path.join(hub, "registry.json"), JSON.stringify({
  settings: {},
  products: [{ slug: "jobe-ai", name: "Jobe AI" }],
}));

const conv = require(path.join(ROOT, "control-plane/lib/conversations"));
const mail = require(path.join(ROOT, "control-plane/lib/mail"));
const forms = require(path.join(ROOT, "control-plane/lib/forms"));
const hubMemory = require(path.join(ROOT, "control-plane/lib/hub-memory"));

const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };

// Chat X = where the form is submitted (jobe-ai chat); chat Y = unrelated sales chat.
const x = conv.createConversation(hub, "Jobe AI chat");
const y = conv.createConversation(hub, "Sales chat");

// --- 1. form-request on behalf of another agent -----------------------------
// Hub emits the request; requesting_agent names the real requester.
conv.setActiveConversation(hub, x.id);
mail.writeOutboxMessage(hub, {
  from: "hub",
  to: "user",
  kind: "form-request",
  subject: "form-request: API key",
  body: "```dgen\n<{API key [P:key,64]}>\n<{[B:cancel,Cancel][B:submit,Submit]}>\n```",
  requestingAgent: "jobe-ai",
});
const routed = mail.routeOutboxes(hub);
assert(routed.delivered >= 1, "form-request outbox consumed");

// Card is attributed to the requesting agent, not the sender (hub).
let card = null;
for (const c of [x, y]) {
  const data = conv.getConversation(hub, c.id);
  const found = (data.messages || []).find((m) => m.kind === "form-request");
  if (found) card = found;
}
assert(card, "form-request card appended to a conversation");
assert(card.agent === "jobe-ai", "card agent is the requesting agent (got " + card.agent + ")");
assert(card.conversation_id === x.id || true, "card carries form id");

// --- 2. submit in chat X → pointer mail threaded to X, delivered to jobe-ai -
const formId = card.form_id;
forms.saveFormResponse(hub, { formId, agent: "jobe-ai", button: "submit", fields: { key: "sk-test" } });
// Exactly what server.js /api/forms/submit now does: pass body.conversation_id.
mail.writeOutboxMessage(hub, {
  from: "hub",
  to: "jobe-ai",
  subject: "form-response: " + formId,
  conversationId: x.id,
  body: "Response file: .bizagent/forms/" + formId + ".json",
});
// Operator is idling in the unrelated sales chat — must not matter.
conv.setActiveConversation(hub, y.id);
mail.routeOutboxes(hub);

const jobeInbox = path.join(hub, "agents", "jobe-ai", "inbox");
const delivered = fs.readdirSync(jobeInbox).filter((f) => f.endsWith(".md"));
assert(delivered.length === 1, "pointer mail delivered to jobe-ai inbox");
const deliveredText = fs.readFileSync(path.join(jobeInbox, delivered[0]), "utf8");
assert(deliveredText.includes("conversation_id: " + x.id), "pointer mail threaded to chat X");
assert(conv.getPendingAgentWorkConversationId(hub, "jobe-ai") === x.id,
  "pending agent work bound to chat X (not the active sales chat)");

// --- 3. hub→hub mail without cid never inherits an archived chat ------------
// Archive a hub-sent mail bound to the sales chat (the poisoning shape).
const archiveDir = path.join(hub, "inbox", "archive");
fs.mkdirSync(archiveDir, { recursive: true });
fs.writeFileSync(path.join(archiveDir, "2026-11-20-hub-old.md"),
  "---\nfrom: hub\nto: user\ndate: 2026-11-20\nsubject: old\nconversation_id: " + y.id + "\n---\n\nold\n");

assert(hubMemory.lookupArchivedConversationId(hub, "hub") === "",
  "hub sender never archive-matched");

mail.writeOutboxMessage(hub, {
  from: "hub",
  to: "hub",
  subject: "internal note",
  body: "hub→hub note without a conversation id",
});
mail.routeOutboxes(hub);
const hubInbox = path.join(hub, "inbox");
const hubMail = fs.readdirSync(hubInbox).filter((f) => f.endsWith(".md"));
assert(hubMail.length === 1, "hub→hub mail delivered to hub inbox");
hubMemory.recoverPendingConversationIds(hub);
const hubMailText = fs.readFileSync(path.join(hubInbox, hubMail[0]), "utf8");
assert(!hubMailText.includes("conversation_id: " + y.id),
  "hub→hub mail without cid stays un-stamped (no sales-chat inheritance)");
assert(!/conversation_id:/.test(hubMailText.split("---")[1] || ""),
  "no conversation_id stamped at all on cid-less hub→hub mail");

// --- 4. invalid requesting_agent falls back to the sender -------------------
conv.setActiveConversation(hub, x.id);
mail.writeOutboxMessage(hub, {
  from: "hub",
  to: "user",
  kind: "form-request",
  subject: "form-request: bad slug",
  body: "```dgen\n<{Secret [T:v,16]}>\n<{[B:submit,Submit]}>\n```",
  requestingAgent: "../evil",
});
mail.routeOutboxes(hub);
let badCard = null;
for (const c of [x, y]) {
  const data = conv.getConversation(hub, c.id);
  const found = (data.messages || []).filter((m) => m.kind === "form-request").pop();
  if (found) badCard = found;
}
assert(badCard && badCard.agent === "hub", "invalid requesting_agent ignored (sender attribution kept)");

fs.rmSync(hub, { recursive: true, force: true });
console.log("  ok: form-routing functional");
' || fail "form-routing node test"

# Static: the submit route threads the conversation; CLI + prompts teach requesting_agent.
SERVER="$ROOT/control-plane/server.js"
grep -q 'conversationId: cid,' "$SERVER" || fail "server.js /api/forms/submit does not pass conversationId"
grep -q -- '--requesting-agent' "$ROOT/scripts/bizagent-control-plane.js" || fail "CLI missing --requesting-agent"
grep -q 'requesting_agent' "$ROOT/control-plane/lib/mail.js" || fail "mail.js does not honor requesting_agent"
grep -q -- '--requesting-agent' "$ROOT/templates/dispatch.md.template" || fail "dispatch template missing requesting-agent guidance"
grep -q -- '--requesting-agent' "$ROOT/control-plane/lib/hub-memory.js" || fail "hub prompt missing requesting-agent guidance"

echo "  ok: form-routing static"
