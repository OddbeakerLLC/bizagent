#!/usr/bin/env bash
# test-loop-guard.sh — iteration-cap notify (dispatcher) + loop guard wiring.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "  FAIL: $1"; exit 1; }

HUB="$TMP/hub"
mkdir -p "$HUB/logs" "$HUB/agents/ba"

cat > "$HUB/registry.json" <<'EOF'
{"products": [{"slug": "ba", "projects": []}]}
EOF

DISPATCHER="$SCRIPT_DIR/../control-plane/lib/dispatcher.js"

node - "$HUB" "$DISPATCHER" <<'NODE' || fail "cap-notify unit checks failed"
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const hub = process.argv[2];
const d = require(process.argv[3]);

// --- lastDistinctToolCalls -------------------------------------------------
const tail = [
  "2026-10-25T00:00:00Z === dispatch start slug=ba cli=x ===",
  "→ grep_search \"nightly\"",
  "→ grep_search \"nightly\"",
  "→ grep_search \"nightly\"",
  "some prose line",
  "→ read_file README.md",
  "→ grep_search \"nightly\"",
].join("\n");
assert.deepEqual(
  d.lastDistinctToolCalls(tail, 3),
  ['→ read_file README.md', '→ grep_search "nightly"'].length === 2
    ? ['→ read_file README.md', '→ grep_search "nightly"']
    : [],
);
// order: oldest of the last-3-distinct first
const got = d.lastDistinctToolCalls(tail, 3);
assert.equal(got.length, 2, `expected 2 distinct, got ${got.length}`);
assert.equal(got[0], '→ read_file README.md');
assert.equal(got[1], '→ grep_search "nightly"');
assert.deepEqual(d.lastDistinctToolCalls("no arrows here"), []);

// --- shouldNotifyIterationCap debounce ------------------------------------
assert.equal(d.shouldNotifyIterationCap(hub, "ba"), true, "first notify allowed");
assert.equal(d.shouldNotifyIterationCap(hub, "ba"), false, "second within window debounced");
const statePath = path.join(hub, ".bizagent", "iteration-cap-notify-ba.json");
assert.ok(fs.existsSync(statePath), "state file written");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
assert.equal(state.slug, "ba");
// age out the window -> allowed again
fs.writeFileSync(statePath, JSON.stringify({ slug: "ba", ts: Date.now() - 61 * 60 * 1000 }));
assert.equal(d.shouldNotifyIterationCap(hub, "ba"), true, "notify allowed after window");

// --- notifyIterationCap: no marker -> no mail ------------------------------
fs.writeFileSync(path.join(hub, "logs", "dispatch-ba.log"), "nothing to see\n");
fs.writeFileSync(path.join(hub, "logs", "dispatch-ba.stderr"), "");
assert.equal(d.notifyIterationCap(hub, "ba"), false, "no marker, no mail");
const hubInbox = path.join(hub, "inbox");
assert.equal((fs.existsSync(hubInbox) ? fs.readdirSync(hubInbox) : []).length, 0);

// --- notifyIterationCap: marker -> one mail to hub inbox -------------------
fs.rmSync(path.join(hub, ".bizagent", "iteration-cap-notify-ba.json"), { force: true });
fs.writeFileSync(
  path.join(hub, "logs", "dispatch-ba.log"),
  [
    "→ grep_search \"nightly\"",
    "→ grep_search \"nightly\"",
    "→ grep_search \"nightly\"",
    "Warning: stopped after 100 tool iterations (set BIZAGENT_AGENT_MAX_ITERATIONS to raise)",
    "Summary: could not finish.",
  ].join("\n"),
);
fs.writeFileSync(path.join(hub, "logs", "dispatch-ba.stderr"), "");
// pending inbox mail gives the task hint
fs.mkdirSync(path.join(hub, "agents", "ba", "inbox"), { recursive: true });
fs.writeFileSync(
  path.join(hub, "agents", "ba", "inbox", "2026-10-25-hub-task.md"),
  "---\nfrom: hub\nto: ba\ndate: 2026-10-25\nsubject: Fix the widget frobnicator\n---\n\nDo the thing.\n",
);
assert.equal(d.notifyIterationCap(hub, "ba"), true, "marker triggers mail");
// writeOutboxMessage writes to the agent's outbox; the router delivers to hub inbox.
const outbox = path.join(hub, "agents", "ba", "outbox");
fs.mkdirSync(hubInbox, { recursive: true });
const mails = fs.readdirSync(outbox).filter((f) => f.endsWith(".md"));
assert.equal(mails.length, 1, `expected 1 mail, got ${mails.length}`);
const mail = fs.readFileSync(path.join(outbox, mails[0]), "utf8");
assert.match(mail, /from: ba/);
assert.match(mail, /to: hub/);
assert.match(mail, /subject: iteration-cap hit: ba/);
assert.match(mail, /100 iterations/);
assert.match(mail, /Fix the widget frobnicator/);
assert.match(mail, /grep_search "nightly"/);

// --- debounce: second detection within the hour writes no second mail -----
assert.equal(d.notifyIterationCap(hub, "ba"), false, "debounced");
assert.equal(fs.readdirSync(outbox).filter((f) => f.endsWith(".md")).length, 1);

// --- different slug has its own debounce window ----------------------------
fs.mkdirSync(path.join(hub, "agents", "ptl"), { recursive: true });
fs.writeFileSync(path.join(hub, "logs", "dispatch-ptl.log"), "stopped after 100 tool iterations\n");
fs.writeFileSync(path.join(hub, "logs", "dispatch-ptl.stderr"), "");
assert.equal(d.notifyIterationCap(hub, "ptl"), true, "independent slug window");
console.log("cap-notify unit checks OK");
NODE

# --- loop guard wiring present in runtime ----------------------------------
grep -q 'BIZAGENT_AGENT_LOOP_NUDGE' "$SCRIPT_DIR/../agent-runtime/src/index.js" \
  || fail "runtime missing BIZAGENT_AGENT_LOOP_NUDGE"
grep -q 'BIZAGENT_AGENT_LOOP_STOP' "$SCRIPT_DIR/../agent-runtime/src/index.js" \
  || fail "runtime missing BIZAGENT_AGENT_LOOP_STOP"
grep -q 'Loop guard: identical tool call repeated' "$SCRIPT_DIR/../agent-runtime/src/index.js" \
  || fail "runtime missing loop-guard stdout lines"

echo "OK: loop-guard"
