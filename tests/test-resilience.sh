#!/usr/bin/env bash
# test-resilience.sh — incident-driven resilience (2026-11-21 work order):
# hung-turn watchdog, repeat-loop detection, stale-lock surfacing, quarantine
# follow-ups, model preflight, provider rotation, incident digest, taxonomy.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

# --- Static wiring -----------------------------------------------------------

grep -q "function watchdogSweep" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher missing watchdogSweep"
grep -q "turn_timeout_secs" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher missing turn_timeout_secs setting"
grep -q "watchdogSweep(config)" "$ROOT/control-plane/server.js" \
  || fail "server tick does not run the watchdog sweep"
grep -q "runRecoverySweep(config" "$ROOT/control-plane/server.js" \
  || fail "server tick does not run the periodic recovery sweep"
grep -q "tickCount % 10" "$ROOT/control-plane/server.js" \
  || fail "periodic sweep is not gated to every ~10 ticks"
grep -q "control_plane_start_retry" "$ROOT/control-plane/server.js" \
  || fail "start-error taxonomy fix missing (retry status)"
grep -q "/api/dispatch/clear-stale-lock" "$ROOT/control-plane/server.js" \
  || fail "server missing clear-stale-lock endpoint"
grep -q "/api/dispatch/repeat-loop" "$ROOT/control-plane/server.js" \
  || fail "server missing repeat-loop endpoint"
grep -Eq 'agent.{0,25}/run' "$ROOT/control-plane/server.js" \
  || fail "server missing run-now endpoint"
grep -Eq 'agent.{0,25}/quarantine' "$ROOT/control-plane/server.js" \
  || fail "server missing quarantine follow-up endpoint"
grep -q "turn_age_secs" "$ROOT/control-plane/server.js" \
  || fail "roster state missing turn_age_secs"
grep -q "incident_digest" "$ROOT/control-plane/server.js" \
  || fail "health payload missing incident_digest"
grep -q "preflightGate" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatch does not gate launches on the model preflight"
grep -q "isNonTransientKind" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not skip the retry ladder for non-transient kinds"
grep -q "maybeArmProviderRotation" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher missing provider rotation arming"
grep -q "maybeEmitAuthFormRequest" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher missing auth form-request path"
grep -q "armContextOverflowRetry" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher missing context-overflow compact+retry"
grep -q "hub_turn_failed" "$ROOT/control-plane/lib/hub-turn-safety.js" \
  || fail "hub hard-fail does not raise a retryable card"
# Console cards + actions.
grep -q "health-banner-action" "$ROOT/control-plane/public/app.js" \
  || fail "console missing one-click banner action buttons"
grep -q 'data-action="repeat"' "$ROOT/control-plane/public/app.js" \
  || fail "console missing Skip/Retry/Leave repeat-loop buttons"
grep -q 'data-action="clear-lock"' "$ROOT/control-plane/public/app.js" \
  || fail "console missing Clear-lock button"
grep -q 'data-action="quarantine"' "$ROOT/control-plane/public/app.js" \
  || fail "console missing quarantine Re-dispatch/Discard buttons"
grep -q 'data-action="model"' "$ROOT/control-plane/public/app.js" \
  || fail "console missing Switch-model button"
grep -q "This week's incidents" "$ROOT/control-plane/public/app.js" \
  || fail "console missing weekly incident-digest card"
grep -q "turnAgeLabel" "$ROOT/control-plane/public/app.js" \
  || fail "console missing turn-age label on agent lights"
grep -q "e.detail" "$ROOT/control-plane/public/app.js" \
  || fail "console error cards do not render captured stderr detail"
grep -q "agent-run-now" "$ROOT/control-plane/public/app.js" \
  || fail "console missing Run-now button for idle agents"
grep -q "20261121-resilience-cards" "$ROOT/control-plane/public/index.html" \
  || fail "index.html missing cache-bust for the resilience UI"
grep -q "health-banner-action" "$ROOT/control-plane/public/styles.css" \
  || fail "styles missing health-banner-action"

if ! command -v node >/dev/null 2>&1; then
  echo "  ok: resilience static checks (node not installed; functional skipped)"
  exit 0
fi

# --- Functional ---------------------------------------------------------------

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HUB="$TMP/hub"
mkdir -p "$HUB/logs" "$HUB/agents/ba/inbox/archive" "$HUB/agents/ba/outbox" "$HUB/inbox" "$HUB/outbox" "$HUB/templates"
cat > "$HUB/registry.json" <<'EOF'
{"settings": {"dispatch": {}}, "products": [{"slug": "ba", "name": "BA", "provider": "venice", "projects": []}]}
EOF
cat > "$HUB/cli.json" <<'EOF'
{
  "venice": { "baseURL": "https://venice.example/v1", "keyEnv": "VENICE_KEY", "models": ["m-a", "m-b"] },
  "ollama": { "baseURL": "http://127.0.0.1:11434/v1", "optionalKey": true, "models": ["local"] }
}
EOF

DISPATCHER="$ROOT/control-plane/lib/dispatcher.js"

node - "$HUB" "$DISPATCHER" "$ROOT/control-plane/lib" <<'NODE' || fail "resilience functional checks failed"
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const hub = process.argv[2];
const d = require(process.argv[3]);
const libDir = process.argv[4];
const pe = require(path.join(libDir, "provider-errors.js"));
const preflight = require(path.join(libDir, "preflight.js"));
const digest = require(path.join(libDir, "incident-digest.js"));

// --- turnTimeoutSecs: default 45 min, clamp 60 s – 24 h ---------------------
assert.equal(d.turnTimeoutSecs({ settings: {} }), 45 * 60, "default watchdog timeout");
assert.equal(d.turnTimeoutSecs({ settings: { dispatch: { turn_timeout_secs: 5 } } }), 60, "lower clamp");
assert.equal(d.turnTimeoutSecs({ settings: { dispatch: { turn_timeout_secs: 999999 } } }), 24 * 3600, "upper clamp");
assert.equal(d.turnTimeoutSecs({ settings: { dispatch: { turn_timeout_secs: 600 } } }), 600, "explicit value honored");

// --- Repeat-loop detection ----------------------------------------------------
const inbox = path.join(hub, "agents", "ba", "inbox");
// Clean exits over mail younger than the 30-min grace window are exempt
// (multi-turn tasks / defer-wake), so age the fixture mail out of the grace
// window before counting no-op turns.
const ageMail = (f) => { const t = new Date(Date.now() - 2 * 3600 * 1000); fs.utimesSync(f, t, t); };
const mail = path.join(inbox, "2026-11-21-test.md");
fs.writeFileSync(mail, "---\nfrom: hub\nto: ba\nsubject: test\n---\nbody\n");
ageMail(mail);
d.markMailDispatched(hub, "ba", [mail], 3600, 60);
// Clean exit over still-pending, already-dispatched mail = a no-op turn.
let s = d.noteCleanTurnExit(hub, "ba");
assert.ok(s && s.count === 1 && !s.held, `first no-op turn counted (got ${JSON.stringify(s)})`);
s = d.noteCleanTurnExit(hub, "ba");
assert.ok(s && s.count === 2 && !s.held, "second no-op turn counted");
s = d.noteCleanTurnExit(hub, "ba");
assert.ok(s && s.held, "third identical no-op turn holds dispatch");
const holds = d.listRepeatLoopHolds(hub);
assert.ok(holds.some((h) => h.slug === "ba" && h.held), "hold listed for the banner");
// Fresh/changed mail resets the counter.
fs.writeFileSync(mail, "---\nfrom: hub\nto: ba\nsubject: changed\n---\nnew body\n");
ageMail(mail);
d.markMailDispatched(hub, "ba", [mail], 3600, 60);
fs.rmSync(path.join(hub, ".bizagent", "repeat-loop", "ba.json"), { force: true });
s = d.noteCleanTurnExit(hub, "ba");
assert.ok(s && s.count === 1, "changed mail restarts the count");

// --- Repeat-loop exemption (CR 2026-11-21): young mail + defer-wake -----------
// Supported flows deliberately leave mail pending across clean turns —
// multi-turn tasks and defer-wake reminders must not trip the hold. Run with
// only the exempt mail pending (the aged fixture mail steps out temporarily).
fs.rmSync(path.join(hub, ".bizagent", "repeat-loop", "ba.json"), { force: true });
fs.renameSync(mail, path.join(inbox, "archive", "2026-11-21-test.md"));
const youngMail = path.join(inbox, "2026-11-21-young.md");
fs.writeFileSync(youngMail, "---\nfrom: hub\nto: ba\nsubject: multi-turn task\n---\nbody\n");
d.markMailDispatched(hub, "ba", [youngMail], 3600, 60);
assert.equal(d.noteCleanTurnExit(hub, "ba"), null, "young pending mail is exempt from repeat counting");
assert.equal(d.noteCleanTurnExit(hub, "ba"), null, "still exempt on the next clean exit");
assert.equal(d.readRepeatLoopState(hub, "ba"), null, "no repeat state written for exempt mail");
// Grace expires: the same mail, now old, counts again.
ageMail(youngMail);
d.markMailDispatched(hub, "ba", [youngMail], 3600, 60);
s = d.noteCleanTurnExit(hub, "ba");
assert.ok(s && s.count === 1, "aged mail counts again after the grace window");
// Explicit defer marker: exempt even when old.
fs.rmSync(path.join(hub, ".bizagent", "repeat-loop", "ba.json"), { force: true });
fs.renameSync(youngMail, path.join(inbox, "archive", "2026-11-21-young.md"));
const wakeMail = path.join(inbox, "2026-11-21-wake.md");
fs.writeFileSync(wakeMail, "---\nfrom: bizagent\nto: ba\nkind: defer-wake\nsubject: wake\n---\nbody\n");
ageMail(wakeMail);
d.markMailDispatched(hub, "ba", [wakeMail], 3600, 60);
assert.equal(d.noteCleanTurnExit(hub, "ba"), null, "defer-wake mail is exempt even when old");
fs.renameSync(wakeMail, path.join(inbox, "archive", "2026-11-21-wake.md"));
fs.renameSync(path.join(inbox, "archive", "2026-11-21-test.md"), mail);
fs.rmSync(path.join(hub, ".bizagent", "repeat-loop", "ba.json"), { force: true });

// resolveRepeatLoop: skip archives the mail and clears the hold.
d.setRepeatLoopHold(hub, "ba", "repeat");
let r = d.resolveRepeatLoop(hub, "ba", "skip");
assert.ok(r.ok && r.moved === 1, "skip moves the pending mail");
assert.ok(!fs.existsSync(mail), "skip archived the inbox mail");
assert.ok(fs.existsSync(path.join(inbox, "archive", "2026-11-21-test.md")), "mail landed in archive");
assert.equal(d.readRepeatLoopState(hub, "ba"), null, "hold cleared after skip");

// resolveRepeatLoop: retry clears hold + markers so the mail re-dispatches.
fs.writeFileSync(mail, "---\nfrom: hub\nto: ba\nsubject: retry me\n---\nbody\n");
d.markMailDispatched(hub, "ba", [mail], 3600, 60);
d.setRepeatLoopHold(hub, "ba", "repeat");
r = d.resolveRepeatLoop(hub, "ba", "retry");
assert.ok(r.ok, "retry ok");
assert.equal(d.readRepeatLoopState(hub, "ba"), null, "hold cleared after retry");
assert.ok(d.pendingUndispatchedMail(hub, "ba", 3600, 60).length === 1, "retry re-queues the mail");

// resolveRepeatLoop: leave keeps the hold, acknowledged.
d.setRepeatLoopHold(hub, "ba", "repeat");
r = d.resolveRepeatLoop(hub, "ba", "leave");
assert.ok(r.ok && r.action === "leave", "leave ok");
const left = d.readRepeatLoopState(hub, "ba");
assert.ok(left && left.held && left.acknowledged, "leave keeps the hold acknowledged");

// --- Watchdog re-queue ---------------------------------------------------------
// Markers freshly dispatched → pendingUndispatchedMail empty; requeue shifts
// them so the mail runs again on the next tick.
d.markMailDispatched(hub, "ba", [mail], 3600, 60);
assert.equal(d.pendingUndispatchedMail(hub, "ba", 3600, 60).length, 0, "dispatched mail is quiet");
assert.equal(d.requeueDispatchMarkers(hub, "ba", 3600), true, "requeue shifted markers");
assert.ok(d.pendingUndispatchedMail(hub, "ba", 3600, 60).length === 1, "requeued mail re-dispatches");

// --- Watchdog sweep: no locks → no-op; old lock without a live owner → skip ---
assert.deepEqual(d.watchdogSweep({ hub, registry: { settings: {} }, lockLeaseSecs: 60 }), [], "no locks, no stops");
const lockDir = path.join(hub, "agents", "ba", ".lock");
fs.mkdirSync(lockDir, { recursive: true });
fs.writeFileSync(path.join(lockDir, "pid"), "999999999"); // dead pid
assert.equal(d.turnAgeSecs(hub, "ba") >= 0, true, "turnAgeSecs reads the lock");
// Dead-pid lock is the recovery sweep's domain, not the watchdog's.
const stopped = d.watchdogSweep({ hub, registry: { settings: {} }, lockLeaseSecs: 60 });
assert.ok(!stopped.some((x) => x.slug === "ba"), "watchdog does not kill dead-pid locks");
d.forceClearStaleLock(hub, "ba");
assert.ok(!fs.existsSync(lockDir), "forceClearStaleLock drops the lock");

// --- Stale-lock surfacing -------------------------------------------------------
// Live owner → not stale (watchdog's domain). Dead pid without a CLI child →
// plain stale (tryLock reclaims) → not listed either.
fs.mkdirSync(lockDir, { recursive: true });
fs.writeFileSync(path.join(lockDir, "pid"), "999999999");
assert.deepEqual(d.staleLockList(hub), [], "dead-pid lock without a CLI child is not card-stale");
fs.rmSync(lockDir, { recursive: true, force: true });

// --- Watchdog live-pid kill path (CR 2026-11-21 test gap) -----------------------
// A live process holding an over-age lock is SIGKILLed, the lock dropped and
// the pending mail re-queued (first strike — no hold yet).
const { spawn } = require("child_process");
const hung = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
fs.mkdirSync(lockDir, { recursive: true });
fs.writeFileSync(path.join(lockDir, "pid"), String(hung.pid));
fs.writeFileSync(path.join(lockDir, "start"), String(Math.floor(Date.now() / 1000) - 3600));
const liveStops = d.watchdogSweep({ hub, registry: { settings: { dispatch: { turn_timeout_secs: 60 } } }, lockLeaseSecs: 60 });
const liveStop = liveStops.find((x) => x.slug === "ba");
assert.ok(liveStop && liveStop.killed, "watchdog stops a live hung turn");
assert.equal(liveStop.requeued, true, "watchdog requeues the hung turn's mail");
let hungState = "gone";
try { hungState = fs.readFileSync(`/proc/${hung.pid}/stat`, "utf8").split(" ")[2] || ""; } catch (_err) { /* gone */ }
assert.ok(hungState === "gone" || hungState === "Z", `hung turn process was killed (state ${hungState})`);
assert.ok(!fs.existsSync(lockDir), "watchdog dropped the stopped turn's lock");

// --- Quarantined mail surfacing + follow-ups ------------------------------------
const quarantineDir = path.join(inbox, "quarantine");
fs.mkdirSync(quarantineDir, { recursive: true });
fs.writeFileSync(path.join(quarantineDir, "2026-11-21-stopped.md"), "---\nfrom: hub\nto: ba\nsubject: interrupted task\n---\nbody\n");
let q = d.quarantinedMailSummary(hub);
assert.ok(q.some((x) => x.slug === "ba" && x.count === 1 && /interrupted task/.test(x.newest_subject)), "quarantine summary");
r = d.resolveQuarantinedMail(hub, "ba", "redispatch");
assert.ok(r.ok && r.moved === 1, "redispatch moves mail back");
assert.ok(fs.existsSync(path.join(inbox, "2026-11-21-stopped.md")), "redispatched mail is back in the inbox");
assert.equal(d.quarantinedMailSummary(hub).length, 0, "quarantine empty after redispatch");
fs.mkdirSync(quarantineDir, { recursive: true });
fs.writeFileSync(path.join(quarantineDir, "2026-11-21-stopped2.md"), "---\nsubject: x\n---\nbody\n");
d.resolveQuarantinedMail(hub, "ba", "discard");
assert.ok(fs.existsSync(path.join(inbox, "archive", "2026-11-21-stopped2.md")), "discard archives quarantined mail");

// --- Run now ----------------------------------------------------------------------
const mail2 = path.join(inbox, "2026-11-21-stopped.md");
d.markMailDispatched(hub, "ba", [mail, mail2], 3600, 60);
assert.equal(d.pendingUndispatchedMail(hub, "ba", 3600, 60).length, 0, "quiet before run-now");
d.runAgentNow(hub, "ba");
assert.ok(d.pendingUndispatchedMail(hub, "ba", 3600, 60).length === 2, "run-now clears markers");

// --- Context-overflow retry: scoped marker clear (CR 2026-11-21 minor) ----------
// The retry must re-dispatch only the overflowed conversation's hub mail, not
// every pending hub mail (the old clearDispatchState(hub, 'hub') behavior).
const convs = require(path.join(libDir, "conversations.js"));
const conv = convs.createConversation(hub, "overflow retry test");
const hubMailA = path.join(hub, "inbox", "2026-11-21-overflow.md");
fs.writeFileSync(hubMailA, `---\nfrom: ba\nto: hub\nsubject: overflow\nconversation_id: ${conv.id}\n---\nbody\n`);
const hubMailB = path.join(hub, "inbox", "2026-11-21-other-conv.md");
fs.writeFileSync(hubMailB, "---\nfrom: ba\nto: hub\nsubject: other\nconversation_id: some-other-conv\n---\nbody\n");
d.markMailDispatched(hub, "hub", [hubMailA, hubMailB], 3600, 60);
assert.ok(d.armContextOverflowRetry(hub, conv.id), "first overflow arms a compact+retry");
assert.equal(d.armContextOverflowRetry(hub, conv.id), false, "retry is guarded for 1 h per conversation");
const hubPending = d.pendingUndispatchedMail(hub, "hub", 3600, 60).map((f) => path.basename(f));
assert.ok(hubPending.includes("2026-11-21-overflow.md"), "affected conversation's mail re-dispatches");
assert.ok(!hubPending.includes("2026-11-21-other-conv.md"), "other conversations' mail stays held");

// --- Model preflight ----------------------------------------------------------------
assert.equal(preflight.preflightGate(hub, "venice", "m-a").block, false, "no cache → fail open");
const cacheDir = path.join(hub, ".bizagent", "model-preflight");
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(path.join(cacheDir, "venice.json"), JSON.stringify({
  provider: "venice", source: "live", checkedAtMs: Date.now(), models: ["m-a"],
}));
assert.equal(preflight.preflightGate(hub, "venice", "m-a").block, false, "listed model passes");
assert.equal(preflight.preflightGate(hub, "venice", "m-gone").block, true, "missing model blocked");
fs.writeFileSync(path.join(cacheDir, "venice.json"), JSON.stringify({
  provider: "venice", source: "live", checkedAtMs: Date.now() - 25 * 3600 * 1000, models: [],
}));
assert.equal(preflight.preflightGate(hub, "venice", "m-gone").block, false, "stale verdict fails open");
fs.writeFileSync(path.join(cacheDir, "venice.json"), JSON.stringify({
  provider: "venice", source: "unavailable", checkedAtMs: Date.now(),
}));
assert.equal(preflight.preflightGate(hub, "venice", "m-gone").block, false, "unavailable source fails open");

// --- Provider rotation (transient flakiness) ------------------------------------------
assert.equal(d.providerRotationOverride(hub, "ba"), null, "no rotation by default");
// venice has keyEnv VENICE_KEY (unset here) → rotation skips it and lands on
// the keyless ollama entry.
const rot = d.maybeArmProviderRotation(hub, "ba", "venice", 2);
assert.ok(rot && rot.provider === "ollama", `rotation armed onto ollama (got ${JSON.stringify(rot)})`);
assert.equal(d.providerRotationOverride(hub, "ba").provider, "ollama", "override readable");
assert.equal(d.maybeArmProviderRotation(hub, "ba", "venice", 1), null, "single transient failure does not rotate");
d.clearProviderRotation(hub, "ba");
assert.equal(d.providerRotationOverride(hub, "ba"), null, "rotation cleared");

// --- Auth failure loop: form-request, debounced ----------------------------------------
fs.rmSync(path.join(hub, ".bizagent", "auth-form-request", "ba.json"), { force: true });
assert.equal(d.maybeEmitAuthFormRequest(hub, "ba", "venice"), true, "first auth failure requests a key");
const outboxDir = path.join(hub, "agents", "ba", "outbox");
const sent = fs.readdirSync(outboxDir).filter((f) => f.endsWith(".md"));
assert.equal(sent.length, 1, "one form-request mail written");
assert.equal(d.maybeEmitAuthFormRequest(hub, "ba", "venice"), false, "debounced within 24 h");

// --- Provider error classification (model-server failures) ------------------------------
assert.equal(pe.classifyProviderError("Error 404: model not found").kind, "model_missing", "404 → model_missing");
assert.equal(pe.classifyProviderError("503 failed to load model").kind, "model_load", "503 → model_load");
assert.equal(pe.classifyProviderError("400 maximum context length exceeded").kind, "context_overflow", "400 → context_overflow");
assert.equal(pe.classifyProviderError("parse error: unexpected token").kind, "parse", "parse errors are transient");
assert.ok(pe.isNonTransientKind("auth") && pe.isNonTransientKind("model_missing"), "non-transient set");
assert.ok(pe.isTransientKind("rate_limit") && pe.isTransientKind("parse"), "transient set");
assert.ok(!pe.isTransientKind("model_missing"), "model_missing is not retried");

// --- recordAgentError: dedupe returns the kind; escalateCard threshold ----------
const rlErr = "429 too many requests — rate limit exceeded";
fs.rmSync(path.join(hub, ".bizagent", "last-agent-error.json"), { force: true });
assert.equal(d.recordAgentError(hub, "ba", 1, rlErr, null), "rate_limit", "kind returned on first failure");
// Same failure double-fire (shell EXIT + Node exit) within the 45 s dedupe
// window: recording is suppressed but the kind must still come back so the
// caller's isNonTransientKind decision is correct (CR 2026-11-21 major 1).
assert.equal(d.recordAgentError(hub, "ba", 1, rlErr, null), "rate_limit", "deduped duplicate still returns the kind");
assert.equal(d.recordAgentError(hub, "ba", 2, rlErr, null), "rate_limit", "kind returned on second failure");
const recentFile = path.join(hub, ".bizagent", "recent-errors.json");
let recent = JSON.parse(fs.readFileSync(recentFile, "utf8"));
assert.ok(!recent.some((e) => e.kind === "rate_limit"), "transient failures below the threshold stay log-only");
assert.equal(d.recordAgentError(hub, "ba", 3, rlErr, null), "rate_limit", "kind returned on third failure");
recent = JSON.parse(fs.readFileSync(recentFile, "utf8"));
assert.ok(recent.some((e) => e.kind === "rate_limit"), "third consecutive transient failure escalates to a card");

// --- Incident digest taxonomy -------------------------------------------------------------
assert.equal(digest.categorize({ event: "provider_failure", status: "error", kind: "rate_limit" }), "rate_limit", "kind wins");
assert.equal(digest.categorize({ event: "provider_failure", status: "error" }), "provider_failure", "event fallback");
assert.equal(digest.categorize({ event: "control_plane_start", status: "error" }), null, "start noise excluded");
assert.equal(digest.categorize({ event: "control_plane_start_retry", status: "retry" }), null, "retry status excluded");
assert.equal(digest.categorize({ event: "x", status: "ok" }), null, "non-errors excluded");
const logLine = (obj) => JSON.stringify(obj) + "\n";
fs.writeFileSync(path.join(hub, "logs", "structured.log"),
  logLine({ ts: new Date().toISOString(), event: "provider_failure", status: "error", kind: "rate_limit" }) +
  logLine({ ts: new Date().toISOString(), event: "provider_failure", status: "error", kind: "rate_limit" }) +
  logLine({ ts: new Date().toISOString(), event: "agent_exit", status: "error" }) +
  logLine({ ts: "2020-01-01T00:00:00Z", event: "old", status: "error" }));
const dg = digest.computeDigest(hub);
assert.equal(dg.total, 3, "digest counts only in-window errors");
assert.deepEqual(dg.categories[0], { category: "rate_limit", count: 2 }, "bucketed by category with counts");
NODE

echo "ok: test-resilience"
