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

// Allowed routes (method-aware): each allowed route with its verb(s).
assert(safeMode.routeAllowedInSafeMode("/api/login", "POST"), "login POST allowed in safe mode");
assert(safeMode.routeAllowedInSafeMode("/api/setup", "POST"), "setup POST allowed in safe mode");
assert(safeMode.routeAllowedInSafeMode("/api/logout", "POST"), "logout POST allowed in safe mode");
assert(safeMode.routeAllowedInSafeMode("/api/health", "GET"), "health GET allowed in safe mode");
assert(safeMode.routeAllowedInSafeMode("/api/state", "GET"), "state GET allowed in safe mode (chat stays available)");
assert(safeMode.routeAllowedInSafeMode("/api/conversations", "GET"), "conversations list GET allowed in safe mode");
assert(safeMode.routeAllowedInSafeMode("/api/conversations", "POST"), "conversation create POST allowed in safe mode");
assert(safeMode.routeAllowedInSafeMode("/api/conversations/2026-11-01-chat-abc123", "GET"), "conversation open GET allowed in safe mode");
assert(safeMode.routeAllowedInSafeMode("/api/conversations/2026-11-01-chat-abc123/messages", "POST"), "message POST allowed in safe mode");
assert(safeMode.routeAllowedInSafeMode("/api/thinking/stream", "GET"), "thinking stream GET allowed in safe mode");
assert(safeMode.routeAllowedInSafeMode("/api/thinking/stop", "POST"), "thinking stop POST allowed in safe mode");

// Method gating: right path, wrong verb must stay blocked.
assert(!safeMode.routeAllowedInSafeMode("/api/login", "GET"), "login GET blocked in safe mode");
assert(!safeMode.routeAllowedInSafeMode("/api/state", "POST"), "state POST blocked in safe mode");
assert(!safeMode.routeAllowedInSafeMode("/api/conversations", "DELETE"), "conversations DELETE blocked in safe mode");
assert(!safeMode.routeAllowedInSafeMode("/api/conversations/2026-11-01-chat-abc123", "DELETE"), "conversation DELETE blocked in safe mode");
assert(!safeMode.routeAllowedInSafeMode("/api/conversations/2026-11-01-chat-abc123", "POST"), "conversation PUT/POST on the id route blocked in safe mode");
assert(!safeMode.routeAllowedInSafeMode("/api/conversations/2026-11-01-chat-abc123/messages", "GET"), "messages GET blocked in safe mode");

// Still-blocked routes (any method): uploads, settings, library, enterprise,
// logs/stream, SSE fallbacks, and everything else.
for (const p of [
  "/api/uploads",
  "/api/settings/dispatch",
  "/api/profile",
  "/api/company/files",
  "/api/enterprise/status",
  "/api/logs/stream",
  "/api/state/stream",
  "/api/conversations/2026-11-01-chat-abc123/stream",
  "/api/provider-models",
  "/api/forms/submit",
  "/api/something-else",
]) {
  for (const m of ["GET", "POST", "DELETE", "PUT"]) {
    assert(!safeMode.routeAllowedInSafeMode(p, m), p + " " + m + " must stay blocked in safe mode");
  }
}
assert(!safeMode.routeAllowedInSafeMode("/api/conversations/2026-11-01-chat-abc123/messages/extra", "POST"),
  "deep paths under messages must stay blocked");

assert(safeMode.exitSafeMode(hub), "exitSafeMode should clear the flag");
assert(!safeMode.isSafeMode(hub), "safe mode should be off after exit");
fs.rmSync(hub, { recursive: true, force: true });
console.log("  ok: safe-mode gate");
' || fail "safe-mode gate"

# ---------------------------------------------------------------------------
# 3b. Bulky-write guard on conversation + hub-session saves
# ---------------------------------------------------------------------------
NODE_EVAL '
const fs = require("fs");
const path = require("path");
const os = require("os");
const conversations = require("./control-plane/lib/conversations.js");
const hubMemory = require("./control-plane/lib/hub-memory.js");
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };

const hub = fs.mkdtempSync(path.join(os.tmpdir(), "health-conv-guard-"));
fs.mkdirSync(path.join(hub, ".bizagent"), { recursive: true });

// Normal conditions: save works.
const conv = conversations.createConversation(hub, "guard test");
conv.messages.push({ role: "user", content: "hello", created_at: new Date().toISOString() });
conversations.saveConversation(hub, conv);
const convFile = conversations.safeConversationFile(hub, conv.id);
assert(fs.existsSync(convFile), "conversation file written under normal free space");
const sessionFile = hubMemory.compactHubSession(hub, conv);
assert(fs.existsSync(sessionFile), "hub session written under normal free space");

// Reserve exceeds free space → bulky writes refused, small ones still pass.
process.env.BIZAGENT_RESERVED_FREE_BYTES = String(1024 * 1024 * 1024 * 1024); // 1 TB
try {
  // Small conversation still saves (under the 256 KB bulky threshold).
  const small = conversations.createConversation(hub, "small");
  small.messages.push({ role: "user", content: "hi", created_at: new Date().toISOString() });
  conversations.saveConversation(hub, small);
  assert(fs.existsSync(conversations.safeConversationFile(hub, small.id)), "small conversation save must pass the guard");

  // Bulky conversation save is skipped, not thrown, and must not create/extend the file.
  const before = fs.existsSync(convFile) ? fs.readFileSync(convFile, "utf8") : "";
  const big = JSON.parse(JSON.stringify(conv));
  big.id = conv.id;
  big.messages.push({ role: "user", content: "x".repeat(512 * 1024), created_at: new Date().toISOString() });
  let threw = null;
  try { conversations.saveConversation(hub, big); } catch (e) { threw = e; }
  assert(!threw, "bulky conversation save must be refused quietly, not thrown: " + (threw && threw.message));
  const after = fs.readFileSync(convFile, "utf8");
  assert(after === before, "bulky conversation save must not touch the file when refused");

  // Bulky hub-session write is skipped too (read path must never throw).
  let sessionThrew = null;
  try { hubMemory.compactHubSession(hub, big); } catch (e) { sessionThrew = e; }
  assert(!sessionThrew, "bulky hub-session write must be refused quietly, not thrown");
} finally {
  delete process.env.BIZAGENT_RESERVED_FREE_BYTES;
}

// Guard lifted → saves work again.
conv.messages.push({ role: "hub", content: "back online", created_at: new Date().toISOString() });
conversations.saveConversation(hub, conv);
assert(/back online/.test(fs.readFileSync(convFile, "utf8")), "saves resume after the reserve is restored");
fs.rmSync(hub, { recursive: true, force: true });
console.log("  ok: bulky-write guard on conversation/session saves");
' || fail "bulky-write guard saves"

# ---------------------------------------------------------------------------
# 3c. Safe-mode chat integration: live server in a temp hub
#     login -> state 200 -> conversations 200 -> message POST enqueues hub
#     turn -> uploads 503 (safe_mode payload)
# ---------------------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
node - "$ROOT" <<'NODE' || fail "safe-mode chat integration"
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const root = process.argv[2];
const { createServer } = require(path.join(root, 'control-plane/server'));
const { loadRuntimeConfig } = require(path.join(root, 'control-plane/lib/config'));
const { initAuth } = require(path.join(root, 'control-plane/lib/auth'));
const safeMode = require(path.join(root, 'control-plane/lib/safe-mode'));

function assert(cond, msg) {
  if (!cond) { console.error('  FAIL: ' + msg); process.exit(1); }
}

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'bizagent-safe-chat-'));
fs.mkdirSync(path.join(hub, 'inbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
fs.mkdirSync(path.join(hub, '.bizagent'), { recursive: true });
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { poll_seconds: 2, max_concurrency: 8, lock_lease_secs: 60 } },
  products: [],
}));
fs.writeFileSync(path.join(hub, 'cli.json'), JSON.stringify({
  _runtime: { executable: 'scripts/bizagent-agent', promptFlag: '-f', flags: { extra: '-y' } },
  grok: { baseURL: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', models: ['grok-4.5'] },
}));

initAuth(hub, 'operator', 's3cret-pass');
// Health-emergency flag (as the watchdog writes it).
assert(safeMode.enterSafeMode(hub, 'health emergency: test'), 'enter safe mode');

function request(port, { method, pathname, cookie, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_e) { json = { raw: data }; }
        resolve({ status: res.statusCode, json, raw: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const config = loadRuntimeConfig(hub);
  const server = createServer(config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    // Blocked without login first (gate sits behind requireAuth).
    const preAuth = await request(port, { method: 'GET', pathname: '/api/state' });
    assert(preAuth.status === 401, `unauthenticated state should 401, got ${preAuth.status}`);

    // Login still works in safe mode.
    const login = await request(port, {
      method: 'POST',
      pathname: '/api/login',
      body: JSON.stringify({ username: 'operator', password: 's3cret-pass' }),
    });
    assert(login.status === 200, `login should 200 in safe mode, got ${login.status}`);
    const setCookie = login.headers['set-cookie'] && login.headers['set-cookie'][0];
    assert(setCookie, 'login should set a session cookie');
    const cookie = setCookie.split(';')[0];

    // Chat surface passes the gate.
    const state = await request(port, { method: 'GET', pathname: '/api/state', cookie });
    assert(state.status === 200, `GET /api/state should 200 in safe mode, got ${state.status}`);

    const convs = await request(port, { method: 'GET', pathname: '/api/conversations', cookie });
    assert(convs.status === 200, `GET /api/conversations should 200 in safe mode, got ${convs.status}`);

    const created = await request(port, {
      method: 'POST',
      pathname: '/api/conversations',
      cookie,
      body: JSON.stringify({ name: 'Safe chat' }),
    });
    assert(created.status === 200, `POST /api/conversations should 200 in safe mode, got ${created.status}`);
    const convId = created.json && created.json.id;
    assert(convId, 'conversation create should return an id');

    const opened = await request(port, { method: 'GET', pathname: `/api/conversations/${convId}`, cookie });
    assert(opened.status === 200, `GET /api/conversations/<id> should 200 in safe mode, got ${opened.status}`);

    const msg = await request(port, {
      method: 'POST',
      pathname: `/api/conversations/${convId}/messages`,
      cookie,
      body: JSON.stringify({ content: 'hello from safe mode' }),
    });
    assert(msg.status === 200, `message POST should 200 in safe mode, got ${msg.status}`);
    // Hub turn enqueued: the console message landed in hub/inbox for the dispatcher.
    const inboxFiles = fs.readdirSync(path.join(hub, 'inbox')).filter((n) => n.endsWith('.md'));
    assert(inboxFiles.length >= 1, 'message POST should enqueue a hub turn (hub inbox mail)');

    // Method gating over live HTTP: DELETE conversation stays blocked.
    const del = await request(port, { method: 'DELETE', pathname: `/api/conversations/${convId}`, cookie });
    assert(del.status === 503 && del.json && del.json.safe_mode, `DELETE conversation should 503 safe_mode, got ${del.status}`);

    // Non-chat surface stays blocked with the safe_mode payload.
    const uploads = await request(port, {
      method: 'POST',
      pathname: '/api/uploads',
      cookie,
      body: JSON.stringify({}),
    });
    assert(uploads.status === 503, `uploads should 503 in safe mode, got ${uploads.status}`);
    assert(uploads.json && uploads.json.safe_mode === true, '503 payload should carry safe_mode: true');

    const settings = await request(port, { method: 'GET', pathname: '/api/settings/dispatch', cookie });
    assert(settings.status === 503, `settings GET should 503 in safe mode, got ${settings.status}`);

    // Health JSON still served.
    const health = await request(port, { method: 'GET', pathname: '/api/health' });
    assert(health.status === 200, `health GET should 200 in safe mode, got ${health.status}`);
  } finally {
    server.close();
    safeMode.exitSafeMode(hub);
    fs.rmSync(hub, { recursive: true, force: true });
  }
  console.log('  ok: safe-mode chat integration');
})().catch((e) => { console.error('  FAIL: ' + (e && e.message || e)); process.exit(1); });
NODE
else
  echo "  ok: safe-mode chat integration (skipped; node not installed)"
fi

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

# ---------------------------------------------------------------------------
# 8. Safe-mode auto-exit: pure decision (reason gating + consecutive counting)
# ---------------------------------------------------------------------------
NODE_EVAL '
const safeMode = require("./control-plane/lib/safe-mode.js");
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };
const healthFlag = { active: true, reason: "health emergency: 2026-10-09T00:00:00.000Z" };
const opFlag = { active: true, reason: "operator: maintenance window" };

// Health-emergency flag: needs 2 consecutive ok runs by default.
let d = safeMode.autoExitDecision({ level: "ok", flag: healthFlag, okStreak: 0, requiredRuns: 2 });
assert(!d.exit && d.okStreak === 1, "first ok run should not exit, got " + JSON.stringify(d));
d = safeMode.autoExitDecision({ level: "ok", flag: healthFlag, okStreak: 1, requiredRuns: 2 });
assert(d.exit && d.okStreak === 2, "second consecutive ok run should exit, got " + JSON.stringify(d));

// Non-ok levels never count and reset the streak.
for (const level of ["warn", "critical", "emergency"]) {
  d = safeMode.autoExitDecision({ level, flag: healthFlag, okStreak: 1, requiredRuns: 2 });
  assert(!d.exit && d.okStreak === 0, level + " run should reset the streak, got " + JSON.stringify(d));
}

// Operator-set flags never auto-exit, even after many ok runs.
d = safeMode.autoExitDecision({ level: "ok", flag: opFlag, okStreak: 99, requiredRuns: 2 });
assert(!d.exit, "operator-set flag must stay manual");
d = safeMode.autoExitDecision({ level: "ok", flag: null, okStreak: 5, requiredRuns: 2 });
assert(!d.exit, "no flag → nothing to exit");

// Env override: BIZAGENT_SAFE_MODE_EXIT_RUNS=1 exits on the first ok run.
process.env.BIZAGENT_SAFE_MODE_EXIT_RUNS = "1";
d = safeMode.autoExitDecision({ level: "ok", flag: healthFlag, okStreak: 0 });
assert(d.exit && d.okStreak === 1, "env override 1 should exit on first ok run, got " + JSON.stringify(d));
assert(safeMode.autoExitRuns() === 1, "autoExitRuns should honor env override");
delete process.env.BIZAGENT_SAFE_MODE_EXIT_RUNS;
assert(safeMode.autoExitRuns() === 2, "autoExitRuns default should be 2");
process.env.BIZAGENT_SAFE_MODE_EXIT_RUNS = "0";
assert(safeMode.autoExitRuns() === 2, "invalid env override falls back to default 2");
delete process.env.BIZAGENT_SAFE_MODE_EXIT_RUNS;
console.log("  ok: safe-mode auto-exit decision");
' || fail "safe-mode auto-exit decision"

# ---------------------------------------------------------------------------
# 9. Safe-mode auto-exit: stateful exit via maybeAutoExitSafeMode
# ---------------------------------------------------------------------------
NODE_EVAL '
const health = require("./control-plane/lib/health.js");
const safeMode = require("./control-plane/lib/safe-mode.js");
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };
const hub = fs.mkdtempSync(path.join(os.tmpdir(), "health-autoexit-"));
const okReport = { level: "ok", ts: new Date().toISOString(), checks: [] };

// Health-emergency flag: exits on the 2nd consecutive ok run.
assert(safeMode.enterSafeMode(hub, "health emergency: 2026-10-09T00:00:00.000Z"), "enter safe mode");
assert(!health.maybeAutoExitSafeMode(hub, okReport), "1st ok run must not exit yet");
assert(safeMode.isSafeMode(hub), "flag still present after 1st ok run");
assert(health.maybeAutoExitSafeMode(hub, okReport), "2nd consecutive ok run must exit");
assert(!safeMode.isSafeMode(hub), "flag cleared after 2nd ok run");
assert(!health.maybeAutoExitSafeMode(hub, okReport), "idempotent: no exit when flag already gone");

// A warn run between ok runs resets the streak (no flapping).
assert(safeMode.enterSafeMode(hub, "health emergency: 2026-10-09T00:01:00.000Z"), "re-enter safe mode");
assert(!health.maybeAutoExitSafeMode(hub, okReport), "streak must not carry over from the prior incident");
assert(safeMode.isSafeMode(hub), "flag still present after re-enter + 1st ok run");
assert(!health.maybeAutoExitSafeMode(hub, { level: "warn", ts: new Date().toISOString(), checks: [] }), "warn run does not exit");
assert(safeMode.isSafeMode(hub), "flag still present after warn run");
assert(!health.maybeAutoExitSafeMode(hub, okReport), "streak was reset by the warn run: 1st ok run must not exit");
assert(safeMode.isSafeMode(hub), "flag still present after reset streak");
assert(health.maybeAutoExitSafeMode(hub, okReport), "2nd consecutive ok run after reset exits");
assert(!safeMode.isSafeMode(hub), "flag cleared");

// Operator-set flag stays manual even across many ok runs.
assert(safeMode.enterSafeMode(hub, "operator: maintenance window"), "operator flag");
for (let i = 0; i < 3; i++) assert(!health.maybeAutoExitSafeMode(hub, okReport), "operator flag never auto-exits");
assert(safeMode.isSafeMode(hub), "operator flag still present");
fs.rmSync(hub, { recursive: true, force: true });
console.log("  ok: safe-mode auto-exit stateful");
' || fail "safe-mode auto-exit stateful"

# ---------------------------------------------------------------------------
# 10. Health levels are banner-only: no chat post (operator rule 2026-11-08)
# ---------------------------------------------------------------------------
NODE_EVAL '
const health = require("./control-plane/lib/health.js");
const conversations = require("./control-plane/lib/conversations.js");
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };
const hub = fs.mkdtempSync(path.join(os.tmpdir(), "health-banner-only-"));
fs.mkdirSync(path.join(hub, "logs"), { recursive: true });
fs.mkdirSync(path.join(hub, ".bizagent"), { recursive: true });
fs.writeFileSync(path.join(hub, "registry.json"), JSON.stringify({ settings: {}, products: [] }));
// Force a non-ok level regardless of the test machine: sparse logs file past the warn line.
fs.writeFileSync(path.join(hub, "logs", "big.log"), "");
fs.truncateSync(path.join(hub, "logs", "big.log"), 201 * 1024 * 1024);

assert(typeof health.postHealthChatLine !== "function", "health must not expose a chat-posting path (banner-only rule)");

const conv = conversations.createConversation(hub, "Health Banner Only");
const report = health.runHealthCheck(hub, { mitigate: false });
assert(report.level !== "ok", "test hub should be non-ok, got " + report.level);
const saved = conversations.getConversation(hub, conv.id);
assert(saved.messages.length === 0, "health level must not post a chat message, got " + saved.messages.length);
assert(fs.existsSync(path.join(hub, "logs", "health.json")), "logs/health.json must still carry the health detail");
assert(fs.readFileSync(path.join(hub, "logs", "health.status"), "utf8").startsWith(report.level), "logs/health.status must still record the level");
assert(!fs.existsSync(path.join(hub, ".bizagent", "health-chat-stamp.json")), "no chat-dedupe stamp should be written");

// Chat stays the channel for session-scoped errors (model/API, dispatch, file-not-found).
conversations.appendMessage(hub, conv.id, "status", "beakernet failed (429)", { kind: "error" });
const after = conversations.getConversation(hub, conv.id).messages;
assert(after.length === 1 && after[0].kind === "error", "non-health session errors must still reach chat");
fs.rmSync(hub, { recursive: true, force: true });
console.log("  ok: health levels banner-only (no chat post)");
' || fail "health banner-only"

echo "  ok: test-health"
