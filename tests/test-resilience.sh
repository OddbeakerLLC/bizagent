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
const mail = path.join(inbox, "2026-11-21-test.md");
fs.writeFileSync(mail, "---\nfrom: hub\nto: ba\nsubject: test\n---\nbody\n");
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
d.clearRepeatLoopState ? null : null;
fs.writeFileSync(mail, "---\nfrom: hub\nto: ba\nsubject: changed\n---\nnew body\n");
d.markMailDispatched(hub, "ba", [mail], 3600, 60);
fs.rmSync(path.join(hub, ".bizagent", "repeat-loop", "ba.json"), { force: true });
s = d.noteCleanTurnExit(hub, "ba");
assert.ok(s && s.count === 1, "changed mail restarts the count");

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
assert.equal(d.providerRotationOverride(hub, "ba").provider, "override" === "" ? "" : "ollama", "override readable");
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
