#!/usr/bin/env bash
# test-crash-resilience.sh — atomic state writes (tmp+fsync+rename with .bak),
# tolerant loads (corrupt file falls back to last-good .bak), and the startup
# recovery pass (stale locks/pidfiles cleared, interrupted dispatches re-queued,
# pending hub turns drained, control_plane_recovery event logged).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

TEST_ROOT="$ROOT" node -e '
const fs = require("fs");
const path = require("path");
const os = require("os");
const ROOT = process.env.TEST_ROOT;

const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };

const atomic = require(path.join(ROOT, "control-plane/lib/atomic-state"));

// --- 1. writeJsonAtomic + tolerant read ------------------------------------
const hub = fs.mkdtempSync(path.join(os.tmpdir(), "crash-test-"));
const file = path.join(hub, "state.json");

atomic.writeJsonAtomic(file, { n: 1 });
assert(JSON.parse(fs.readFileSync(file, "utf8")).n === 1, "writeJsonAtomic writes valid JSON");

atomic.writeJsonAtomic(file, { n: 2 });
assert(JSON.parse(fs.readFileSync(file, "utf8")).n === 2, "second write replaces content");
assert(JSON.parse(fs.readFileSync(file + ".bak", "utf8")).n === 1, ".bak holds previous good copy");

// Corrupt the main file — tolerant read must fall back to the .bak
// (which holds the previous good copy, n:1).
fs.writeFileSync(file, "{\"n\": 2"); // torn write
assert(atomic.readJsonState(file, null).n === 1, "corrupt main falls back to .bak");
assert(JSON.parse(fs.readFileSync(file, "utf8")).n === 1, "main file repaired from .bak");

// Corrupt both — fallback default returned.
fs.writeFileSync(file, "garbage");
fs.writeFileSync(file + ".bak", "also garbage");
assert(atomic.readJsonState(file, { d: true }).d === true, "corrupt main+bak returns fallback");

// --- 2. Pending hub turns survive a torn write ------------------------------
const safety = require(path.join(ROOT, "control-plane/lib/conversations"));
const turnsMod = require(path.join(ROOT, "control-plane/lib/hub-turn-safety"));
const conv = safety.createConversation(hub, "Crash test");
turnsMod.recordPendingHubTurn(hub, {
  conversationId: conv.id,
  startedAt: new Date().toISOString(),
});
// Second write snapshots the first good copy into .bak.
turnsMod.recordPendingHubTurn(hub, {
  conversationId: conv.id,
  startedAt: new Date().toISOString(),
});
const turnsFile = turnsMod.pendingHubTurnsFile(hub);
fs.writeFileSync(turnsFile, "{\"turns\": ["); // torn write
assert(turnsMod.readPendingHubTurns(hub).length === 1, "pending hub turns recovered from .bak");

// --- 3. Dispatcher state survives a torn write ------------------------------
const dispatcher = require(path.join(ROOT, "control-plane/lib/dispatcher"));
const mail = require(path.join(ROOT, "control-plane/lib/mail"));
fs.mkdirSync(path.join(hub, "agents", "tester", "inbox"), { recursive: true });
const mailFile = path.join(hub, "agents", "tester", "inbox", "m1.md");
fs.writeFileSync(mailFile, "---\nfrom: hub\nto: tester\nsubject: hi\n---\n\nbody\n");
dispatcher.markMailDispatched(hub, "tester", [mailFile], 1800, 1800);
// Second write snapshots the first good copy into .bak.
dispatcher.markMailDispatched(hub, "tester", [mailFile], 1800, 1800);
const stateFile = path.join(hub, ".bizagent", "dispatch-state", "tester.json");
fs.writeFileSync(stateFile, "{\"handled\": [{"); // torn write
const handled = atomic.readJsonState(stateFile, null).handled;
assert(handled.length === 1 && handled[0].file === "m1.md", "dispatch state recovered from .bak");

// --- 4. Startup recovery ----------------------------------------------------
fs.rmSync(path.join(hub, "logs"), { recursive: true, force: true });
// Stale product-agent lock (dead pid, no CLI child) + stale CP pidfile.
// (hub.lock is skipped here: findAgentCliPid scans /proc for the 'hub-'
// marker and a live hub on this machine would legitimately block the clear.)
fs.mkdirSync(path.join(hub, "agents", "tester", ".lock"), { recursive: true });
fs.writeFileSync(path.join(hub, "agents", "tester", ".lock", "pid"), "999999999\n");
fs.writeFileSync(path.join(hub, ".bizagent", "control-plane.pid"), "999999999\n");
// A pending hub turn with a reserved body, hub not running → must be drained.
turnsMod.prepareReservedReplyBody(hub, conv.id);
fs.writeFileSync(turnsMod.reservedReplyBodyPath(hub, conv.id), "Recovered operator reply.\n");
turnsMod.recordPendingHubTurn(hub, { conversationId: conv.id, startedAt: new Date().toISOString() });
// Unrouted outbox mail from an agent.
fs.mkdirSync(path.join(hub, "agents", "tester", "outbox"), { recursive: true });
fs.writeFileSync(path.join(hub, "agents", "tester", "outbox", "o1.md"),
  "---\nfrom: tester\nto: hub\nsubject: done\n---\n\nDone.\n");

const recovery = require(path.join(ROOT, "control-plane/lib/startup-recovery"));
const config = { hub, lockLeaseSecs: 1800 };
const summary = recovery.runStartupRecovery(config, dispatcher);

assert(!fs.existsSync(path.join(hub, "agents", "tester", ".lock")), "stale agent lock cleared");
assert(!fs.existsSync(path.join(hub, ".bizagent", "control-plane.pid")), "stale CP pidfile cleared");
assert((safety.getConversation(hub, conv.id).messages || []).some(
  (m) => m.role === "hub" && /Recovered operator reply/.test(m.content)),
  "orphaned pending hub turn drained: reserved body promoted");
assert(fs.existsSync(path.join(hub, "user", "inbox")), "recovered reply routed to user inbox");
const shifted = JSON.parse(fs.readFileSync(stateFile, "utf8")).handled
  .find((i) => i.file === "m1.md");
assert(shifted && Math.floor(Date.now() / 1000) - shifted.dispatchedAt >= 1800,
  "interrupted dispatch re-queued (markers relaxed past retry window)");
const logText = fs.readFileSync(path.join(hub, "logs", "structured.log"), "utf8");
assert(logText.includes("control_plane_recovery"), "control_plane_recovery event logged");
assert(summary.locks_cleared >= 1 && summary.dispatches_requeued >= 1, "recovery summary counts actions");

// Operator stop stamp must prevent requeue.
fs.mkdirSync(path.join(hub, ".bizagent", "operator-stop"), { recursive: true });
dispatcher.markMailDispatched(hub, "tester", [mailFile], 1800, 1800);
dispatcher.markOperatorStop(hub, "tester");
recovery.runStartupRecovery(config, dispatcher);
const kept = JSON.parse(fs.readFileSync(stateFile, "utf8")).handled
  .find((i) => i.file === "m1.md");
assert(Math.floor(Date.now() / 1000) - kept.dispatchedAt < 1800,
  "operator-stop markers are not re-queued");

// --- 5. Crash handlers: uncaughtException checkpoints then exits 1 ----------
const { execFileSync } = require("child_process");
const crashHub = fs.mkdtempSync(path.join(os.tmpdir(), "crash-handler-"));
let exitCode = 0;
try {
  execFileSync("node", ["-e",
    "const m=require(process.env.TEST_ROOT+\"/control-plane/lib/startup-recovery\");" +
    "m.registerCrashHandlers({hub: process.env.TEST_HUB});" +
    "setTimeout(()=>{ throw new Error(\"boom\"); }, 50);",
  ], { env: { ...process.env, TEST_ROOT: ROOT, TEST_HUB: crashHub }, stdio: "ignore" });
} catch (e) {
  exitCode = e.status;
}
assert(exitCode === 1, "uncaughtException exits with code 1");
const crashLog = fs.readFileSync(path.join(crashHub, "logs", "structured.log"), "utf8");
assert(crashLog.includes("control_plane_crash") && crashLog.includes("uncaughtException"),
  "crash checkpointed to structured log before exit");

console.log("crash-resilience: all assertions passed");
'