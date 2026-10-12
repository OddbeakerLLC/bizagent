#!/usr/bin/env bash
# test-cross-chat-alerts.sh — agent errors route to the originating conversation
# (pending-agent-work), other conversations only get a lightweight waiting
# indicator; indicator clears when the operator opens the originating chat.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

TEST_ROOT="$ROOT" node -e '
const fs = require("fs");
const path = require("path");
const os = require("os");
const ROOT = process.env.TEST_ROOT;

const hub = fs.mkdtempSync(path.join(os.tmpdir(), "cross-chat-test-"));
fs.mkdirSync(path.join(hub, "agents", "bizagent"), { recursive: true });

const conv = require(path.join(ROOT, "control-plane/lib/conversations"));
const dispatcher = require(path.join(ROOT, "control-plane/lib/dispatcher"));

const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };
const resetDedup = () => fs.rmSync(path.join(hub, ".bizagent", "last-agent-error.json"), { force: true });

// Two conversations: A = originating (owns the agent run), B = operator active chat
const a = conv.createConversation(hub, "Origin");
const b = conv.createConversation(hub, "Other");
conv.recordPendingAgentWork(hub, "bizagent", a.id);
conv.setActiveConversation(hub, b.id);

// Agent run errors with no explicit conversation id → lands in A, not B.
dispatcher.recordAgentError(hub, "bizagent", 1, "provider refused: credits exhausted", null);
const convA = conv.getConversation(hub, a.id);
const convB = conv.getConversation(hub, b.id);
assert((convA.messages || []).some((m) => m.role === "status"), "error posted to originating conversation A");
assert(!(convB.messages || []).some((m) => m.role === "status"), "no error dump in operator chat B");

// Cross-chat waiting indicator recorded for A (operator was in B)
let alerts = conv.listCrossChatAlerts(hub);
assert(alerts.length === 1 && alerts[0].conversationId === a.id && alerts[0].slug === "bizagent",
  "cross-chat alert recorded for A");

// Operator opens A → indicator clears
conv.clearCrossChatAlerts(hub, a.id);
assert(conv.listCrossChatAlerts(hub).length === 0, "alert cleared after operator opens A");

// Explicit conversation id still wins over pending-agent-work
resetDedup();
const c = conv.createConversation(hub, "Explicit");
dispatcher.recordAgentError(hub, "bizagent", 1, "boom", c.id);
assert((conv.getConversation(hub, c.id).messages || []).some((m) => m.role === "status"),
  "explicit conversation id still honored");

// Deleted originating conversation falls back to active chat
resetDedup();
conv.recordPendingAgentWork(hub, "bizagent", a.id);
conv.deleteConversation(hub, a.id);
dispatcher.recordAgentError(hub, "bizagent", 1, "boom again", null);
assert((conv.getConversation(hub, b.id).messages || []).some((m) => m.role === "status"),
  "falls back to active chat when origin gone");

fs.rmSync(hub, { recursive: true, force: true });
console.log("  ok: cross-chat-alerts");
' || fail "cross-chat-alerts node test"
