#!/usr/bin/env bash
# test-health.sh — survival instinct: health classification, tripwires,
# log-cap/refuse-write, safe-mode gate, Ollama fallback trigger.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }
TMP="$(mktemp -d)"
HTMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$HTMP"' EXIT

NODE_EVAL() { node -e "$1" "$ROOT"; }

# ---------------------------------------------------------------------------
# 1. Health classification (pure evaluator, synthetic samples)
# ---------------------------------------------------------------------------
NODE_EVAL '
const { evaluateChecks, THRESHOLDS } = require("./control-plane/lib/health.js");
const GB = 1024 * 1024 * 1024;
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };

// Healthy hub
let r = evaluateChecks({
  disk: { freeBytes: 100 * GB, totalBytes: 200 * GB },
  inodes: { free: 1000, total: 1000 },
  logsBytes: 10 * 1024 * 1024,
  ram: { availableBytes: 8 * GB, totalBytes: 16 * GB },
  load1: 0.5, cpus: 8,
  heartbeatAgeMs: 5000,
  files: { registry: "ok", cli: "ok", env: "ok", auth: "ok" },
  providerKeyPresent: true,
});
assert(r.level === "ok", "healthy hub should be ok, got " + r.level);

// Disk warn: <15% or <10GB
r = evaluateChecks({ disk: { freeBytes: 25 * GB, totalBytes: 200 * GB } });
assert(r.level === "warn", "25GB/200GB (12.5%) should warn, got " + r.level);
r = evaluateChecks({ disk: { freeBytes: 9 * GB, totalBytes: 80 * GB } });
assert(r.level === "warn", "9GB free (11.25%) should warn via GB line, got " + r.level);

// Disk critical: <10% or <3GB
r = evaluateChecks({ disk: { freeBytes: 15 * GB, totalBytes: 200 * GB } });
assert(r.level === "critical", "7.5% free should be critical, got " + r.level);
r = evaluateChecks({ disk: { freeBytes: 2 * GB, totalBytes: 40 * GB } });
assert(r.level === "critical", "2GB free (5%) should be critical via GB line, got " + r.level);

// Disk emergency: <5% or <1GB
r = evaluateChecks({ disk: { freeBytes: 8 * GB, totalBytes: 200 * GB } });
assert(r.level === "emergency", "4% free should be emergency, got " + r.level);
r = evaluateChecks({ disk: { freeBytes: 0.5 * GB, totalBytes: 200 * GB } });
assert(r.level === "emergency", "0.5GB free should be emergency, got " + r.level);

// Inodes: >80 warn, >90 crit, >95 emerg
r = evaluateChecks({ inodes: { free: 150, total: 1000 } });
assert(r.level === "warn", "85% inodes should warn, got " + r.level);
r = evaluateChecks({ inodes: { free: 50, total: 1000 } });
assert(r.level === "critical", "95%... 91% inodes should be critical, got " + r.level);
r = evaluateChecks({ inodes: { free: 30, total: 1000 } });
assert(r.level === "emergency", "97% inodes should be emergency, got " + r.level);

// Logs size: >200MB warn, >1GB crit, growth >50MB/h emerg
r = evaluateChecks({ logsBytes: 300 * 1024 * 1024 });
assert(r.level === "warn", "300MB logs should warn, got " + r.level);
r = evaluateChecks({ logsBytes: 1.5 * GB });
assert(r.level === "critical", "1.5GB logs should be critical, got " + r.level);
r = evaluateChecks({ logsBytes: 300 * 1024 * 1024, logsGrowthBytesPerHour: 60 * 1024 * 1024 });
assert(r.level === "emergency", "logs growing 60MB/h should be emergency, got " + r.level);

// Volume growth rate heading to 100%
r = evaluateChecks({ disk: { freeBytes: 100 * GB, totalBytes: 200 * GB }, growthBytesPerHour: 3 * GB });
assert(r.level === "warn", "3GB/h (33h to full) should warn, got " + r.level);
r = evaluateChecks({ disk: { freeBytes: 100 * GB, totalBytes: 200 * GB }, growthBytesPerHour: 12 * GB });
assert(r.level === "emergency", "12GB/h should be emergency, got " + r.level);

// RAM: <15% warn, <8% crit, OOM emerg
r = evaluateChecks({ ram: { availableBytes: 2 * GB, totalBytes: 16 * GB } });
assert(r.level === "warn", "12.5% RAM should warn, got " + r.level);
r = evaluateChecks({ ram: { availableBytes: 1 * GB, totalBytes: 16 * GB } });
assert(r.level === "critical", "6% RAM should be critical, got " + r.level);
r = evaluateChecks({ ram: { availableBytes: 8 * GB, totalBytes: 16 * GB }, oomLastHour: true });
assert(r.level === "emergency", "OOM in last hour should be emergency, got " + r.level);

// FDs near limit
r = evaluateChecks({ openFds: 92, fdLimit: 100 });
assert(r.level === "critical", "92% fds should be critical, got " + r.level);
r = evaluateChecks({ openFds: 80, fdLimit: 100 });
assert(r.level === "warn", "80% fds should warn, got " + r.level);
r = evaluateChecks({ openFds: 1024, fdLimit: 1024 });
assert(r.level === "emergency", "fds at limit (fork/EMFILE) should be emergency, got " + r.level);

// Heartbeat: 1min warn, 3min crit, 10min emerg
r = evaluateChecks({ heartbeatAgeMs: 70 * 1000 });
assert(r.level === "warn", "70s heartbeat should warn, got " + r.level);
r = evaluateChecks({ heartbeatAgeMs: 200 * 1000 });
assert(r.level === "critical", "200s heartbeat should be critical, got " + r.level);
r = evaluateChecks({ heartbeatAgeMs: 11 * 60 * 1000 });
assert(r.level === "emergency", "11min heartbeat should be emergency, got " + r.level);

// Corrupt registry / missing provider key / read-only fs
r = evaluateChecks({ files: { registry: "corrupt" } });
assert(r.level === "critical", "corrupt registry.json should be critical, got " + r.level);
r = evaluateChecks({ providerKeyPresent: false });
assert(r.level === "critical", "missing provider key should be critical, got " + r.level);
r = evaluateChecks({ fsReadOnly: true });
assert(r.level === "emergency", "read-only fs should be emergency, got " + r.level);

// Worst level wins across checks
r = evaluateChecks({
  disk: { freeBytes: 0.5 * GB, totalBytes: 200 * GB },
  inodes: { free: 10, total: 1000 },
});
assert(r.level === "emergency", "worst check wins, got " + r.level);
console.log("  ok: health classification");
' || fail "health classification"

# ---------------------------------------------------------------------------
# 1b. Provider key check: keyless (Ollama) skipped, paid provider still critical
# ---------------------------------------------------------------------------
NODE_EVAL '
const health = require("./control-plane/lib/health.js");
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };

const hub = fs.mkdtempSync(path.join(os.tmpdir(), "health-key-"));
fs.mkdirSync(path.join(hub, ".bizagent"), { recursive: true });
delete process.env.OLLAMA_API_KEY;
delete process.env.XAI_API_KEY;

// Ollama (keyless) with no OLLAMA_API_KEY → check skipped (null), not critical.
fs.writeFileSync(path.join(hub, "registry.json"), JSON.stringify({
  settings: { hub_agent: { provider: "ollama", model: "qwen3:4b" } },
}));
fs.writeFileSync(path.join(hub, "cli.json"), JSON.stringify({
  ollama: { label: "Ollama (local)", baseURL: "http://127.0.0.1:11434/v1", keyEnv: "OLLAMA_API_KEY", optionalKey: true, models: ["llama3.2"] },
}));
assert(health.providerKeyPresent(hub) === null, "keyless ollama with no key should skip the check (null)");
let r = health.evaluateChecks({ providerKeyPresent: health.providerKeyPresent(hub) });
assert(!r.checks.some((c) => c.name === "provider_key"), "no provider_key check for keyless ollama");
assert(r.level !== "critical", "keyless ollama with no key must not be critical, got " + r.level);

// Paid provider (grok) with no key → still false → critical.
fs.writeFileSync(path.join(hub, "registry.json"), JSON.stringify({
  settings: { hub_agent: { provider: "grok", model: "grok-4.5" } },
}));
fs.writeFileSync(path.join(hub, "cli.json"), JSON.stringify({
  grok: { label: "Grok (xAI)", baseURL: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY", models: ["grok-4.5"] },
}));
assert(health.providerKeyPresent(hub) === false, "paid provider with no key should be false");
r = health.evaluateChecks({ providerKeyPresent: health.providerKeyPresent(hub) });
assert(r.checks.some((c) => c.name === "provider_key" && c.level === "critical"), "missing paid-provider key stays critical");

fs.rmSync(hub, { recursive: true, force: true });
console.log("  ok: provider key keyless/paid");
' || fail "provider key keyless/paid"

# ---------------------------------------------------------------------------
# 2. Log caps: refuse bulky writes near the reserve; truncate to tail
# ---------------------------------------------------------------------------
NODE_EVAL '
const fs = require("fs");
const path = require("path");
const os = require("os");
const logCaps = require("./control-plane/lib/log-caps.js");
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };

const hub = fs.mkdtempSync(path.join(os.tmpdir(), "health-caps-"));
// Small writes always pass.
assert(logCaps.assertBulkyWriteAllowed(hub, 1024).ok, "small write should pass");
// Huge reservation → any bulky write refused (proves the guard trips before 100%).
process.env.BIZAGENT_RESERVED_FREE_BYTES = String(1024 * 1024 * 1024 * 1024); // 1 TB
const verdict = logCaps.assertBulkyWriteAllowed(hub, 10 * 1024 * 1024);
assert(!verdict.ok, "bulky write must be refused when reserve exceeds free space");
assert(/refusing/.test(verdict.reason), "refusal should explain itself");
delete process.env.BIZAGENT_RESERVED_FREE_BYTES;

// truncateToTail keeps only the tail.
const f = path.join(hub, "big.log");
fs.writeFileSync(f, ("x".repeat(1024) + "\n").repeat(2048)); // 2 MB
const removed = logCaps.truncateToTail(f, 512 * 1024);
assert(removed > 1024 * 1024, "truncateToTail should remove the head, removed " + removed);
assert(fs.statSync(f).size <= 512 * 1024, "file should now be <= keepBytes");

// capLogs walks logs/ and caps every .log/.stderr/.jsonl
fs.mkdirSync(path.join(hub, "logs"));
fs.writeFileSync(path.join(hub, "logs", "dispatch-hub.log"), "y".repeat(2 * 1024 * 1024));
fs.writeFileSync(path.join(hub, "logs", "dispatch-hub.stderr"), "y".repeat(2 * 1024 * 1024));
const capped = logCaps.capLogs(hub, { keepBytes: 256 * 1024 });
assert(capped.files >= 1, "capLogs should cap at least one file");
assert(logCaps.logsDirBytes(hub) <= 512 * 1024 + 1024, "logs dir should be capped");
fs.rmSync(hub, { recursive: true, force: true });
console.log("  ok: log caps / refuse-write");
' || fail "log caps"

# ---------------------------------------------------------------------------
# 3. Safe-mode gate
# ---------------------------------------------------------------------------
NODE_EVAL '
const fs = require("fs");
const path = require("path");
const os = require("os");
const safeMode = require("./control-plane/lib/safe-mode.js");
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };
const hub = fs.mkdtempSync(path.join(os.tmpdir(), "health-safe-"));
assert(!safeMode.isSafeMode(hub), "fresh hub is not safe mode");
assert(safeMode.enterSafeMode(hub, "test"), "enterSafeMode should write the flag");
assert(safeMode.isSafeMode(hub), "safe mode should be active after enter");
assert(safeMode.readFlag(hub).reason === "test", "flag should carry the reason");
assert(safeMode.routeAllowedInSafeMode("/api/login"), "login allowed in safe mode");
assert(safeMode.routeAllowedInSafeMode("/api/health"), "health allowed in safe mode");
assert(!safeMode.routeAllowedInSafeMode("/api/state"), "state API blocked in safe mode");
assert(safeMode.exitSafeMode(hub), "exitSafeMode should clear the flag");
assert(!safeMode.isSafeMode(hub), "safe mode should be off after exit");
fs.rmSync(hub, { recursive: true, force: true });
console.log("  ok: safe-mode gate");
' || fail "safe-mode gate"

# ---------------------------------------------------------------------------
# 4. Ollama fallback trigger: credits/auth/model yes — network/rate-limit no
# ---------------------------------------------------------------------------
NODE_EVAL '
// Pin Ollama to an unreachable port BEFORE requiring the module so the test
// never depends on (or pulls models from) a real local Ollama.
process.env.BIZAGENT_OLLAMA_URL = "http://127.0.0.1:1";
const { classifyProviderError } = require("./control-plane/lib/provider-errors.js");
const { shouldFallback, hubLaunchOverride, clearFallback } = require("./control-plane/lib/ollama-fallback.js");
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };

assert(shouldFallback(classifyProviderError("402 Payment Required: usage balance exhausted")), "credits → fallback");
assert(shouldFallback(classifyProviderError("401 Unauthorized: invalid api key")), "auth → fallback");
assert(shouldFallback(classifyProviderError("unknown model foo-bar")), "model rejected → fallback");
assert(!shouldFallback(classifyProviderError("ECONNREFUSED fetch failed")), "network outage → NO fallback");
assert(shouldFallback(classifyProviderError("429 too many requests")) === false, "rate limit → NO fallback");
assert(shouldFallback(classifyProviderError("SyntaxError: bad prompt")) === false, "unclassified → NO fallback");

// Launch override flag lifecycle (registry.json/cli.json never touched).
const hub = fs.mkdtempSync(path.join(os.tmpdir(), "health-fb-"));
assert(hubLaunchOverride(hub) === null, "no override when flag absent");
const { activateFallback } = require("./control-plane/lib/ollama-fallback.js");
// Ollama not running in CI → activation must fail cleanly (no silent death).
activateFallback(hub, { classified: { kind: "credits", title: "credits" } }).then((res) => {
  assert(res.ok === false && res.reason === "ollama_not_running", "activation without Ollama fails cleanly, got " + JSON.stringify(res));
  assert(hubLaunchOverride(hub) === null, "no override when activation failed");
  // Manual flag → override active, then clearable.
  fs.mkdirSync(path.join(hub, ".bizagent"), { recursive: true });
  fs.writeFileSync(path.join(hub, ".bizagent", "ollama-fallback.json"),
    JSON.stringify({ active: true, provider: "ollama", model: "qwen3:4b", kind: "credits", ts: new Date().toISOString() }));
  const ov = hubLaunchOverride(hub);
  assert(ov && ov.provider === "ollama" && ov.model === "qwen3:4b", "override should use flag provider/model");
  assert(clearFallback(hub, "probe_ok") === true, "clearFallback removes an active flag");
  assert(hubLaunchOverride(hub) === null, "override gone after clear");
  fs.rmSync(hub, { recursive: true, force: true });
  console.log("  ok: ollama fallback trigger");
}).catch((e) => { console.error("FAIL: " + e.message); process.exit(1); });
' || fail "ollama fallback trigger"

# ---------------------------------------------------------------------------
# 5. Out-of-process probe end-to-end on a synthetic hub
# ---------------------------------------------------------------------------
mkdir -p "$TMP/hub/logs" "$TMP/hub/.bizagent"
bash "$ROOT/scripts/health-probe.sh" "$TMP/hub" >"$TMP/probe.out" 2>"$TMP/probe.err"
PROBE_RC=$?
[ -f "$TMP/hub/logs/health.json" ] || fail "probe should write logs/health.json"
[ -f "$TMP/hub/logs/health.status" ] || fail "probe should write logs/health.status"
STATUS_LINE="$(head -1 "$TMP/hub/logs/health.status")"
case "$STATUS_LINE" in
  ok*|warn*) : ;;
  *) fail "unexpected health.status on healthy synthetic hub: $STATUS_LINE" ;;
esac
grep -q '"level"' "$TMP/hub/logs/health.json" || fail "health.json should carry a level"
# Emergency classification must exit 2 (drive OnFailure=) — verify via the
# probe's own exit mapping using a hub whose health.json we cannot fake; the
# mapping itself is covered by the classification tests above. Probe on a
# healthy hub must exit 0 or 1 (warn allowed on the test machine).
[ "$PROBE_RC" -le 1 ] || fail "probe exit code on healthy hub should be 0/1, got $PROBE_RC"
echo "  ok: out-of-process probe (status: $STATUS_LINE)"

# ---------------------------------------------------------------------------
# 6. Growth-rate sampling reads prev samples (reports nest them under .samples)
# ---------------------------------------------------------------------------
NODE_EVAL '
const health = require("./control-plane/lib/health.js");
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };
const hub = fs.mkdtempSync(path.join(os.tmpdir(), "health-growth-"));
fs.mkdirSync(path.join(hub, "logs"), { recursive: true });
const GB = 1024 * 1024 * 1024;
// Previous report written the way runHealthCheck writes it (samples nested).
fs.writeFileSync(path.join(hub, "logs", "health.json"), JSON.stringify({
  level: "ok", ts: new Date(Date.now() - 3600 * 1000).toISOString(),
  samples: { disk: { freeBytes: 100 * GB, totalBytes: 200 * GB }, logsBytes: 10 * 1024 * 1024 },
}));
const s = health.sample(hub);
assert(s.growthBytesPerHour != null, "growth rate should be computed from prev samples, got null");
assert(s.logsGrowthBytesPerHour != null, "logs growth rate should be computed from prev samples, got null");
fs.rmSync(hub, { recursive: true, force: true });
console.log("  ok: growth-rate sampling");
' || fail "growth-rate sampling"

# ---------------------------------------------------------------------------
# 7. HEALTH-ALERT.md lifecycle: written on critical, removed when green
# ---------------------------------------------------------------------------
NODE_EVAL '
const health = require("./control-plane/lib/health.js");
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };
const hub = fs.mkdtempSync(path.join(os.tmpdir(), "health-alert-"));
health.updateHealthAlertFile(hub, { level: "critical", ts: new Date().toISOString(), checks: [{ name: "disk_free", level: "critical", detail: "2% free" }] });
assert(fs.existsSync(path.join(hub, "HEALTH-ALERT.md")), "HEALTH-ALERT.md written on critical");
health.updateHealthAlertFile(hub, { level: "ok", ts: new Date().toISOString(), checks: [] });
assert(!fs.existsSync(path.join(hub, "HEALTH-ALERT.md")), "HEALTH-ALERT.md removed when green");
fs.rmSync(hub, { recursive: true, force: true });
console.log("  ok: HEALTH-ALERT.md lifecycle");
' || fail "HEALTH-ALERT lifecycle"

echo "  ok: test-health"
