#!/usr/bin/env bash
# test-dispatch.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

grep -q "bizagent-control-plane.js.*dispatch-once" "$ROOT/scripts/bizagent-dispatch.sh" \
  || fail "bizagent-dispatch.sh does not delegate to the Node control plane"
grep -q "install-control-plane.sh" "$ROOT/scripts/install-dispatch.sh" \
  || fail "install-dispatch.sh does not delegate to install-control-plane.sh"
grep -q "resolveHubCliName\|hub_agent" "$ROOT/control-plane/lib/config.js" \
  || fail "control plane does not resolve hub CLI name from registry"
grep -q "BIZAGENT_CLI_EXTRA_ARGS" "$ROOT/control-plane/lib/cli-config.js" \
  || fail "cli-config does not honor BIZAGENT_CLI_EXTRA_ARGS env override"
grep -q "maxConcurrency\|agentSlots\|agent_slots" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher does not enforce concurrency tiers"
grep -q "hubSlots\|hub_slots\|liveHubCount" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher missing hub/agent slot tiers"
grep -q "allowConcurrency\|serialBusy" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher missing allow_concurrency serial gate"
grep -q "tryLock" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher missing per-agent lock"
grep -q "buildAgentTurnPrompt" "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher missing product-agent turn injection"

if ! command -v node >/dev/null 2>&1; then
  echo "  ok: bizagent-dispatch.sh wrapper (live dispatch skipped; node not installed)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/agents/alpha/inbox/archive" "$TMP/agents/alpha/outbox" "$TMP/outbox" "$TMP/inbox" "$TMP/logs" "$TMP/templates"
cat > "$TMP/registry.json" <<'JSON'
{
  "settings": {
    "dispatch": { "max_concurrency": 1, "lock_lease_secs": 60 },
    "hub_agent": { "provider": "grok", "cliName": "grok", "model": "grok-4.5" }
  },
  "products": [{ "slug": "alpha", "name": "Alpha", "agent_name": "Agent A", "provider": "grok", "cliName": "grok", "projects": [] }]
}
JSON
cat > "$TMP/cli.json" <<'JSON'
{
  "_runtime": {
    "executable": "scripts/bizagent-agent",
    "promptFlag": "-f",
    "flags": { "extra": "-y" }
  },
  "grok": {
    "baseURL": "https://api.x.ai/v1",
    "keyEnv": "XAI_API_KEY",
    "models": ["grok-4.5"]
  }
}
JSON
cp "$ROOT/templates/dispatch.md.template" "$TMP/templates/dispatch.md.template"
cat > "$TMP/agents/alpha/inbox/2026-07-09-test.md" <<'MSG'
---
from: hub
to: alpha
date: 2026-07-09
subject: test
---
body
MSG
BIZAGENT_DRY_RUN=1 node "$ROOT/scripts/bizagent-control-plane.js" dispatch-once --hub "$TMP" >/dev/null
[ -f "$TMP/agents/alpha/.dispatch.md" ] || fail "dispatch prompt not generated"
[ ! -d "$TMP/agents/alpha/.lock" ] || fail "dry-run dispatch left a lock"

# --- 30-min lock-lease double-dispatch fix (2026-09-07) ---
# (a) live pid + age>lease must NOT steal; (b) dead pid may reclaim;
# (c) same mail not re-dispatched while running; (d) stop kills without lock;
# (e) isAgentActive follows pid, not lease.
if ! node - "$ROOT" "$TMP" <<'NODE'
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const root = process.argv[2];
const tmp = process.argv[3];
const {
  tryLock,
  isAgentActive,
  pendingUndispatchedMail,
  markMailDispatched,
  clearDispatchState,
  findAgentCliPid,
  stopAgentTurn,
} = require(path.join(root, 'control-plane/lib/dispatcher'));

const hub = path.join(tmp, 'lockhub');
fs.mkdirSync(path.join(hub, 'agents', 'alpha', 'inbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents', 'alpha', 'outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { max_concurrency: 1, lock_lease_secs: 60 } },
  products: [{ slug: 'alpha', name: 'Alpha', agent_name: 'Agent A', provider: 'grok', cliName: 'grok', projects: [] }],
}));

const lock = path.join(hub, 'agents', 'alpha', '.lock');
const fail = (code, msg) => { console.error(msg); process.exit(code); };

(async () => {
  // (e) isAgentActive follows the pid, not the lease age.
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'pid'), String(sleeper.pid));
  fs.writeFileSync(path.join(lock, 'start'), String(Math.floor(Date.now() / 1000) - 99999)); // age >> lease
  if (!isAgentActive(hub, 'alpha', 60)) fail(1, 'isAgentActive must be true for live pid past lease');

  // (a) live pid + age>lease must NOT steal.
  if (tryLock(hub, 'alpha', 60)) fail(2, 'tryLock stole a live lock past lease');
  const kept = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim();
  if (kept !== String(sleeper.pid)) fail(3, 'tryLock clobbered the live lock');

  // (c) same mail not re-dispatched while running (marker holds past retry window).
  const inbox = path.join(hub, 'agents', 'alpha', 'inbox');
  const mail = path.join(inbox, '2026-09-07-same-mail.md');
  fs.writeFileSync(mail, '---\nfrom: hub\nto: alpha\ndate: 2026-09-07\nsubject: same\n---\nbody\n');
  markMailDispatched(hub, 'alpha', [mail], 60);
  const stateFile = path.join(hub, '.bizagent', 'dispatch-state', 'alpha.json');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  st.handled.forEach((h) => { h.dispatchedAt = Math.floor(Date.now() / 1000) - 99999; });
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
  const fresh = pendingUndispatchedMail(hub, 'alpha', 60, 60);
  if (fresh.some((f) => path.basename(f) === path.basename(mail))) {
    fail(4, 'marked mail must not be pending again while slug is running');
  }

  // (d) stop kills without lock: leftover bizagent-agent child scan + kill.
  const fake = spawn(
    process.execPath,
    ['-e', 'setTimeout(()=>{},60000)', 'src/index.js', 'agent-alpha-123.md'],
    { stdio: 'ignore', detached: true },
  );
  const found = findAgentCliPid(hub, 'alpha');
  if (found !== String(fake.pid)) fail(5, `findAgentCliPid missed leftover child (${found})`);
  fs.rmSync(lock, { recursive: true, force: true }); // simulate stolen/expired lock
  const killed = await stopAgentTurn(hub, 'alpha');
  if (!killed) fail(6, 'stopAgentTurn must kill leftover child without lock');
  const t0 = Date.now();
  let alive = true;
  while (Date.now() - t0 < 5000) {
    try { process.kill(fake.pid, 0); alive = true; } catch (_e) { alive = false; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (alive) fail(7, 'leftover child still alive after stop');
  if (isAgentActive(hub, 'alpha', 60)) fail(8, 'isAgentActive must be false after kill');

  // (b) dead pid may reclaim.
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise((r) => dead.on('exit', r));
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'pid'), String(dead.pid));
  fs.writeFileSync(path.join(lock, 'start'), String(Math.floor(Date.now() / 1000) - 99999));
  if (!tryLock(hub, 'alpha', 60)) fail(9, 'dead lock must be reclaimed');
  const newPid = fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim();
  if (newPid !== String(process.pid)) fail(10, `reclaimed lock must hold CP pid (${newPid})`);

  // Cleanup
  try { process.kill(sleeper.pid, 'SIGKILL'); } catch (_e) { /* gone */ }
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  clearDispatchState(hub, 'alpha');
})().catch((err) => { console.error('unexpected throw:', err); process.exit(99); });
NODE
then
  fail "lock-lease live-owner / leftover-kill unit checks failed"
fi

# allow_concurrency=false serializes hub + product agents (at most one live turn).
if ! node - "$ROOT" <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = process.argv[2];
const { loadRuntimeConfig } = require(path.join(root, 'control-plane/lib/config'));
const { dispatchPendingAgents } = require(path.join(root, 'control-plane/lib/dispatcher'));

const prevEnv = process.env.BIZAGENT_ALLOW_CONCURRENCY;
delete process.env.BIZAGENT_ALLOW_CONCURRENCY;
const prevDry = process.env.BIZAGENT_DRY_RUN;
process.env.BIZAGENT_DRY_RUN = '1';

function writeMail(dir, name, to, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), [
    '---',
    'from: hub',
    `to: ${to}`,
    'date: 2026-10-20',
    'subject: status',
    '---',
    '',
    body,
  ].join('\n'));
}

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'bizagent-serial-dispatch-'));
fs.mkdirSync(path.join(hub, 'inbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
fs.mkdirSync(path.join(hub, 'templates'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents/alpha/inbox/archive'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents/alpha/outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents/beta/inbox/archive'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents/beta/outbox'), { recursive: true });
fs.writeFileSync(path.join(hub, 'templates/dispatch.md.template'), "You are '{{slug}}'.\n");
fs.writeFileSync(path.join(hub, 'agents/alpha/agent.md'), '# Alpha\n');
fs.writeFileSync(path.join(hub, 'agents/beta/agent.md'), '# Beta\n');
fs.writeFileSync(path.join(hub, 'cli.json'), JSON.stringify({
  _runtime: { executable: 'scripts/bizagent-agent', promptFlag: '-f', flags: { extra: '-y' } },
  grok: { baseURL: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', models: ['grok-4.5'] },
}));
writeMail(path.join(hub, 'agents/alpha/inbox'), '2026-10-20-alpha.md', 'alpha', 'alpha please');
writeMail(path.join(hub, 'agents/beta/inbox'), '2026-10-20-beta.md', 'beta', 'beta please');
writeMail(path.join(hub, 'inbox'), '2026-10-20-hub.md', 'hub', 'hub please');

fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: {
    dispatch: {
      max_concurrency: 8,
      agent_slots: 8,
      hub_slots: 1,
      lock_lease_secs: 60,
      allow_concurrency: false,
    },
    hub_agent: { provider: 'grok', cliName: 'grok', model: 'grok-4.5' },
  },
  products: [
    { slug: 'alpha', name: 'Alpha', agent_name: 'Agent A', provider: 'grok', cliName: 'grok', projects: [] },
    { slug: 'beta', name: 'Beta', agent_name: 'Agent B', provider: 'grok', cliName: 'grok', projects: [] },
  ],
}));

const serial = dispatchPendingAgents(loadRuntimeConfig(hub));
if (serial.launched !== 1) fail(1, `serial flag should launch 1, got ${JSON.stringify(serial)}`);
if (serial.skippedCap < 1) fail(2, `serial flag should skip remaining, got ${JSON.stringify(serial)}`);
if (serial.allowConcurrency !== false) fail(3, `result.allowConcurrency should be false, got ${JSON.stringify(serial)}`);

// Env=0 forces serial even when registry allows concurrency.
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: {
    dispatch: {
      max_concurrency: 8,
      agent_slots: 8,
      hub_slots: 1,
      lock_lease_secs: 60,
      allow_concurrency: true,
    },
    hub_agent: { provider: 'grok', cliName: 'grok', model: 'grok-4.5' },
  },
  products: [
    { slug: 'alpha', name: 'Alpha', agent_name: 'Agent A', provider: 'grok', cliName: 'grok', projects: [] },
    { slug: 'beta', name: 'Beta', agent_name: 'Agent B', provider: 'grok', cliName: 'grok', projects: [] },
  ],
}));
process.env.BIZAGENT_ALLOW_CONCURRENCY = '0';
const forced = dispatchPendingAgents(loadRuntimeConfig(hub));
if (forced.allowConcurrency !== false) fail(4, `env=0 should force allowConcurrency false, got ${JSON.stringify(forced)}`);
if (forced.launched !== 1) fail(5, `env=0 should still serialize, got ${JSON.stringify(forced)}`);

delete process.env.BIZAGENT_ALLOW_CONCURRENCY;
fs.rmSync(hub, { recursive: true, force: true });
if (prevEnv === undefined) delete process.env.BIZAGENT_ALLOW_CONCURRENCY;
else process.env.BIZAGENT_ALLOW_CONCURRENCY = prevEnv;
if (prevDry === undefined) delete process.env.BIZAGENT_DRY_RUN;
else process.env.BIZAGENT_DRY_RUN = prevDry;
NODE
then
  fail "allow_concurrency serial dispatch checks failed"
fi

# Fleet-wide rate-limit cooldown (operator request 2026-10-21): a 429 pauses
# every launch until the window expires; each new 429 extends it.
if ! node - "$ROOT" <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = process.argv[2];
const { loadRuntimeConfig } = require(path.join(root, 'control-plane/lib/config'));
const dispatcher = require(path.join(root, 'control-plane/lib/dispatcher'));

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

const prevDry = process.env.BIZAGENT_DRY_RUN;
process.env.BIZAGENT_DRY_RUN = '1';

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'bizagent-rate-limit-cooldown-'));
fs.mkdirSync(path.join(hub, 'inbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
fs.mkdirSync(path.join(hub, 'templates'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents/alpha/inbox/archive'), { recursive: true });
fs.mkdirSync(path.join(hub, 'agents/alpha/outbox'), { recursive: true });
fs.writeFileSync(path.join(hub, 'templates/dispatch.md.template'), "You are '{{slug}}'.\n");
fs.writeFileSync(path.join(hub, 'agents/alpha/agent.md'), '# Alpha\n');
fs.writeFileSync(path.join(hub, 'cli.json'), JSON.stringify({
  _runtime: { executable: 'scripts/bizagent-agent', promptFlag: '-f', flags: { extra: '-y' } },
  grok: { baseURL: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', models: ['grok-4.5'] },
}));
fs.writeFileSync(path.join(hub, 'agents/alpha/inbox/2026-10-21-alpha.md'), [
  '---', 'from: hub', 'to: alpha', 'date: 2026-10-21', 'subject: status', '---', '', 'alpha please', '',
].join('\n'));
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: {
    dispatch: { max_concurrency: 8, agent_slots: 8, hub_slots: 1, lock_lease_secs: 60 },
    hub_agent: { provider: 'grok', cliName: 'grok', model: 'grok-4.5' },
  },
  products: [{ slug: 'alpha', name: 'Alpha', agent_name: 'Agent A', provider: 'grok', cliName: 'grok', projects: [] }],
}));

// Cooldown secs: default 120, clamped to [30, 3600].
if (dispatcher.rateLimitCooldownSecs(undefined) !== 120) fail(1, 'cooldown secs default must be 120');
if (dispatcher.rateLimitCooldownSecs({ settings: { dispatch: { rate_limit_cooldown_secs: 5 } } }) !== 30) fail(2, 'cooldown secs must clamp to min 30');
if (dispatcher.rateLimitCooldownSecs({ settings: { dispatch: { rate_limit_cooldown_secs: 99999 } } }) !== 3600) fail(3, 'cooldown secs must clamp to max 3600');

// No cooldown file -> remaining 0, dispatch proceeds.
if (dispatcher.rateLimitCooldownRemaining(hub) !== 0) fail(4, 'remaining must be 0 with no cooldown file');
const before = dispatcher.dispatchPendingAgents(loadRuntimeConfig(hub));
if (before.launched !== 1) fail(5, `dispatch should launch without cooldown, got ${JSON.stringify(before)}`);

// Marking a cooldown gates every launch and reports the window.
const waited = dispatcher.markRateLimitCooldown(hub, 120);
if (waited !== 120) fail(6, `markRateLimitCooldown should wait 120s, got ${waited}`);
if (dispatcher.rateLimitCooldownRemaining(hub) <= 0) fail(7, 'remaining must be > 0 during cooldown');
const gated = dispatcher.dispatchPendingAgents(loadRuntimeConfig(hub));
if (gated.launched !== 0) fail(8, `cooldown must gate launches, got ${JSON.stringify(gated)}`);
if (!gated.rateLimitCooldownSecs) fail(9, `cooldown result should report the window, got ${JSON.stringify(gated)}`);

// A new 429 extends (never shortens) the window.
const extended = dispatcher.markRateLimitCooldown(hub, 120);
if (extended < 120) fail(10, `new 429 must extend the window, got ${extended}`);

// Expired window clears the gate.
const file = path.join(hub, '.bizagent', 'rate-limit-cooldown.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
data.until = Math.floor(Date.now() / 1000) - 1;
fs.writeFileSync(file, JSON.stringify(data));
if (dispatcher.rateLimitCooldownRemaining(hub) !== 0) fail(11, 'expired cooldown must report 0 remaining');

fs.rmSync(hub, { recursive: true, force: true });
if (prevDry === undefined) delete process.env.BIZAGENT_DRY_RUN;
else process.env.BIZAGENT_DRY_RUN = prevDry;
NODE
then
  fail "rate-limit cooldown dispatch checks failed"
fi

# Per-provider rate-limit cooldowns + slot buckets (2026-10-22): a 429 on one
# provider freezes only that provider's bucket; other providers keep running.
if ! node - "$ROOT" <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = process.argv[2];
const { loadRuntimeConfig } = require(path.join(root, 'control-plane/lib/config'));
const dispatcher = require(path.join(root, 'control-plane/lib/dispatcher'));

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

const prevDry = process.env.BIZAGENT_DRY_RUN;
process.env.BIZAGENT_DRY_RUN = '1';

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'bizagent-provider-buckets-'));
fs.mkdirSync(path.join(hub, 'inbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
fs.mkdirSync(path.join(hub, 'templates'), { recursive: true });
for (const slug of ['alpha', 'beta', 'gamma']) {
  fs.mkdirSync(path.join(hub, `agents/${slug}/inbox/archive`), { recursive: true });
  fs.mkdirSync(path.join(hub, `agents/${slug}/outbox`), { recursive: true });
  fs.writeFileSync(path.join(hub, `agents/${slug}/agent.md`), `# ${slug}\n`);
  fs.writeFileSync(path.join(hub, `agents/${slug}/inbox/2026-10-22-${slug}.md`), [
    '---', 'from: hub', 'to: ' + slug, 'date: 2026-10-22', 'subject: status', '---', '', slug + ' please', '',
  ].join('\n'));
}
fs.writeFileSync(path.join(hub, 'templates/dispatch.md.template'), "You are '{{slug}}'.\n");
fs.writeFileSync(path.join(hub, 'cli.json'), JSON.stringify({
  _runtime: { executable: 'scripts/bizagent-agent', promptFlag: '-f', flags: { extra: '-y' } },
  venice: { baseURL: 'https://api.venice.ai/api/v1', keyEnv: 'VENICE_API_KEY', models: ['venice-model'] },
  grok: { baseURL: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', models: ['grok-4.5'] },
}));
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: {
    dispatch: { agent_slots: { venice: 2, grok: 1 }, hub_slots: 1, lock_lease_secs: 60 },
    hub_agent: { provider: 'venice', model: 'venice-model' },
  },
  products: [
    { slug: 'alpha', name: 'Alpha', provider: 'venice', projects: [] },
    { slug: 'beta', name: 'Beta', provider: 'venice', projects: [] },
    { slug: 'gamma', name: 'Gamma', provider: 'grok', projects: [] },
  ],
}));

// Provider resolution from registry fields.
const registry = JSON.parse(fs.readFileSync(path.join(hub, 'registry.json'), 'utf8'));
if (dispatcher.agentProvider(registry, 'alpha') !== 'venice') fail(1, 'alpha provider must resolve to venice');
if (dispatcher.agentProvider(registry, 'gamma') !== 'grok') fail(1, 'gamma provider must resolve to grok');
if (dispatcher.agentProvider(registry, 'hub') !== 'venice') fail(2, 'hub provider must resolve from hub_agent');
if (dispatcher.agentProvider(registry, 'ghost') !== '') fail(3, 'unknown slug provider must be empty');

// Per-provider slot caps from the agent_slots map: venice cap 2 launches
// alpha+beta; grok cap 1 launches gamma. No global pool starving either.
const first = dispatcher.dispatchPendingAgents(loadRuntimeConfig(hub));
if (first.launched !== 3) fail(4, `per-provider caps should launch all three, got ${JSON.stringify(first)}`);
if (first.runningByProvider.venice !== 2 || first.runningByProvider.grok !== 1) {
  fail(5, `running counts must be per provider, got ${JSON.stringify(first.runningByProvider)}`);
}

// A Venice 429 freezes only the venice bucket: hub (venice) and alpha/beta
// are gated, gamma (grok) still launches.
const waited = dispatcher.markRateLimitCooldown(hub, 120, 'venice');
if (waited !== 120) fail(6, `venice cooldown should wait 120s, got ${waited}`);
if (dispatcher.rateLimitCooldownRemaining(hub, 'venice') <= 0) fail(7, 'venice remaining must be > 0');
if (dispatcher.rateLimitCooldownRemaining(hub, 'grok') !== 0) fail(8, 'grok must be unaffected');
// Fresh pending mail for the next round.
for (const slug of ['alpha', 'beta', 'gamma']) {
  fs.writeFileSync(path.join(hub, `agents/${slug}/inbox/2026-10-22-${slug}-2.md`), [
    '---', 'from: hub', 'to: ' + slug, 'date: 2026-10-22', 'subject: retry', '---', '', slug + ' again', '',
  ].join('\n'));
}
const gated = dispatcher.dispatchPendingAgents(loadRuntimeConfig(hub));
if (gated.launched !== 1) fail(9, `only grok should launch during venice cooldown, got ${JSON.stringify(gated)}`);
if (!gated.rateLimitCooldownSecs) fail(10, 'result should report the max cooldown window');
if (gated.rateLimitCooldownSecs !== dispatcher.maxRateLimitCooldownRemaining(hub)) {
  fail(11, 'reported window must match max across provider files');
}

// Fleet-wide fallback (unnamed provider) gates every bucket.
dispatcher.markRateLimitCooldown(hub, 60, '');
fs.writeFileSync(path.join(hub, 'agents/gamma/inbox/2026-10-22-gamma-3.md'), [
  '---', 'from: hub', 'to: gamma', 'date: 2026-10-22', 'subject: retry', '---', '', 'gamma again', '',
].join('\n'));
const fleetGated = dispatcher.dispatchPendingAgents(loadRuntimeConfig(hub));
if (fleetGated.launched !== 0) fail(12, `fleet-wide cooldown must gate all launches, got ${JSON.stringify(fleetGated)}`);

// Expire both windows; everything dispatches again.
for (const name of ['rate-limit-cooldown-venice.json', 'rate-limit-cooldown.json']) {
  const file = path.join(hub, '.bizagent', name);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.until = Math.floor(Date.now() / 1000) - 1;
  fs.writeFileSync(file, JSON.stringify(data));
}
if (dispatcher.maxRateLimitCooldownRemaining(hub) !== 0) fail(13, 'all cooldowns expired must report 0');

fs.rmSync(hub, { recursive: true, force: true });
if (prevDry === undefined) delete process.env.BIZAGENT_DRY_RUN;
else process.env.BIZAGENT_DRY_RUN = prevDry;
NODE
then
  fail "per-provider cooldown/slot bucket checks failed"
fi

echo "  ok: bizagent-dispatch.sh"
