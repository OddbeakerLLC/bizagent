#!/usr/bin/env bash
# test-vision-mail.sh — clipboard image paste → mail attachments → runtime vision
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.."; pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

[ -f "$ROOT/control-plane/lib/hub-memory.js" ] || fail "hub-memory.js missing"
[ -f "$ROOT/agent-runtime/src/vision.js" ] || fail "agent-runtime/src/vision.js missing"

# --- Console wiring: paste handler, thumbnail chips, cache-bust ---
grep -q "bindComposerPaste" "$ROOT/control-plane/public/app.js" \
  || fail "app.js missing composer paste handler"
grep -q "clipboardImageFiles" "$ROOT/control-plane/public/app.js" \
  || fail "app.js missing clipboard image extraction"
grep -q "attach-chip-thumb" "$ROOT/control-plane/public/styles.css" \
  || fail "styles.css missing attach chip thumbnail"
grep -q "conv-switching" "$ROOT/control-plane/public/styles.css" \
  || fail "styles.css missing conversation-switch animation"
grep -q "prefers-reduced-motion" "$ROOT/control-plane/public/styles.css" \
  || fail "styles.css missing prefers-reduced-motion guard"
grep -q "v=20260904-paste-vision" "$ROOT/control-plane/public/index.html" \
  || fail "index.html missing paste-vision cache-bust"

# --- Runtime wiring: vision module used by the agent runtime ---
grep -q "require('./vision')" "$ROOT/agent-runtime/src/index.js" \
  || fail "runtime index.js does not require vision"
grep -q "buildUserContent" "$ROOT/agent-runtime/src/index.js" \
  || fail "runtime index.js does not build vision user content"
grep -q "looksImageRelated" "$ROOT/agent-runtime/src/index.js" \
  || fail "runtime index.js missing image soft-fail"
grep -q "sanitizeContent" "$ROOT/agent-runtime/src/client.js" \
  || fail "runtime client.js missing content block sanitizer"

# --- Transport: mail Attachments block → vision turn prompt marker ---
node - "$ROOT" <<'NODE' || exit 1
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = process.argv[2];
const hubMemory = require(path.join(root, "control-plane/lib/hub-memory"));

function assert(cond, msg) {
  if (!cond) { console.error("  FAIL: " + msg); process.exit(1); }
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const hub = fs.mkdtempSync(path.join(os.tmpdir(), "bizagent-vm-"));
const up = (rel) => path.join(hub, rel);
fs.mkdirSync(up(".bizagent/uploads/hub/2026-09-04-chat-abc123"), { recursive: true });
fs.writeFileSync(up(".bizagent/uploads/hub/2026-09-04-chat-abc123/2026-09-04T1815-pasted.png"), PNG_1PX);
fs.writeFileSync(up(".bizagent/uploads/hub/2026-09-04-chat-abc123/report.pdf"), Buffer.from("%PDF-1.4 fake"));
fs.mkdirSync(up("company/uploads"), { recursive: true });
fs.writeFileSync(up("company/uploads/shot.jpg"), PNG_1PX);

// --- attachmentPathsFromMailBody: only the Attachments block counts ---
const mailBody = [
  "---",
  "from: operator",
  "to: hub",
  "subject: console message",
  "---",
  "",
  "What is in this screenshot? I mentioned `.bizagent/uploads/hub/2026-09-04-chat-abc123/2026-09-04T1815-pasted.png` in prose too.",
  "",
  "Attachments:",
  "- `.bizagent/uploads/hub/2026-09-04-chat-abc123/2026-09-04T1815-pasted.png` (pasted-20260904-181532.png)",
  "- `.bizagent/uploads/hub/2026-09-04-chat-abc123/report.pdf` (report.pdf)",
  "- `company/uploads/shot.jpg` (shot.jpg)",
  "- `.bizagent/uploads/hub/2026-09-04-chat-abc123/missing.png` (missing.png)",
  "- `../../etc/passwd` (evil.txt)",
  "",
  "Thanks!",
].join("\n");

const paths = hubMemory.attachmentPathsFromMailBody(mailBody);
assert(paths.length === 5, `expected 5 attachment paths, got ${paths.length}`);
assert(paths[0].endsWith("2026-09-04T1815-pasted.png"), "first attachment path wrong");
assert(hubMemory.attachmentPathsFromMailBody("no attachments here").length === 0,
  "prose without a block must yield no paths");

// --- collectVisionImages: existing images only, safe roots only ---
const mailFile = path.join(hub, "2026-09-04-operator-console-message-20260904T181532000-aa1.md");
fs.writeFileSync(mailFile, mailBody + "\n");
const vision = hubMemory.collectVisionImages(hub, [mailFile]);
assert(vision.length === 2, `expected 2 vision images, got ${JSON.stringify(vision)}`);
assert(vision[0] === ".bizagent/uploads/hub/2026-09-04-chat-abc123/2026-09-04T1815-pasted.png",
  "png not collected first");
assert(vision[1] === "company/uploads/shot.jpg", "company jpg not collected");
assert(hubMemory.collectVisionImages(hub, []).length === 0, "no files → no images");

// Duplicate mail → deduped
const dup = hubMemory.collectVisionImages(hub, [mailFile, mailFile]);
assert(dup.length === 2, "duplicate mail must dedupe images");

// --- buildAgentTurnPrompt: vision marker reaches the product-agent prompt ---
const agentInbox = path.join(hub, "agents", "demoagent", "inbox");
fs.mkdirSync(agentInbox, { recursive: true });
fs.writeFileSync(path.join(agentInbox, "2026-09-04-hub-do-the-thing.md"), mailBody + "\n");
const turnFile = hubMemory.buildAgentTurnPrompt(hub, "demoagent");
const turnText = fs.readFileSync(turnFile, "utf8");
assert(turnText.includes("<!-- bizagent-vision"), "turn prompt missing bizagent-vision marker");
assert(turnText.includes(".bizagent/uploads/hub/2026-09-04-chat-abc123/2026-09-04T1815-pasted.png"),
  "turn prompt missing image path");
assert(turnText.includes("Images attached to this turn"), "turn prompt missing vision heading");
// Non-image / unsafe attachments must not be in the MARKER (mail body may mention them).
const agentMarker = turnText.match(/<!-- bizagent-vision\s*\n([\s\S]*?)-->/);
assert(agentMarker, "agent turn prompt missing vision marker");
assert(!agentMarker[1].includes("report.pdf"), "non-image attachment leaked into vision marker");
assert(!agentMarker[1].includes("missing.png"), "missing file leaked into vision marker");
assert(!agentMarker[1].includes("passwd"), "escaping path leaked into vision marker");
assert(agentMarker[1].includes("2026-09-04T1815-pasted.png"), "png missing from vision marker");

// Mail without images → no marker block
const plainInbox = path.join(hub, "agents", "plainagent", "inbox");
fs.mkdirSync(plainInbox, { recursive: true });
fs.writeFileSync(path.join(plainInbox, "2026-09-04-hub-status.md"),
  "---\nfrom: hub\nto: plainagent\nsubject: status\n---\n\nJust checking in.\n");
const plainTurn = hubMemory.buildAgentTurnPrompt(hub, "plainagent");
const plainText = fs.readFileSync(plainTurn, "utf8");
assert(!plainText.includes("bizagent-vision"), "no-image mail must not produce a vision marker");

// --- Cap: at most 8 images per turn ---
const manyInbox = path.join(hub, "agents", "manyagent", "inbox");
fs.mkdirSync(manyInbox, { recursive: true });
const lines = [];
for (let i = 0; i < 12; i += 1) {
  const rel = `company/uploads/shot-${i}.png`;
  fs.writeFileSync(path.join(hub, rel), PNG_1PX);
  lines.push(`- \`${rel}\` (shot-${i}.png)`);
}
fs.writeFileSync(path.join(manyInbox, "2026-09-04-hub-many.md"),
  `---\nfrom: hub\nto: manyagent\nsubject: many\n---\n\nSee these.\n\nAttachments:\n${lines.join("\n")}\n`);
const manyTurn = hubMemory.buildAgentTurnPrompt(hub, "manyagent");
const manyText = fs.readFileSync(manyTurn, "utf8");
const marker = manyText.match(/<!-- bizagent-vision\s*\n([\s\S]*?)-->/);
assert(marker, "many-image prompt missing marker");
const marked = marker[1].trim().split(/\r?\n/).filter(Boolean);
assert(marked.length === 8, `expected 8 capped images, got ${marked.length}`);

fs.rmSync(hub, { recursive: true, force: true });
console.log("vision-mail: ok");
NODE

(cd "$ROOT/agent-runtime" && npm test --silent >/dev/null) || fail "agent-runtime unit tests failed"

echo "vision-mail: all checks passed"
