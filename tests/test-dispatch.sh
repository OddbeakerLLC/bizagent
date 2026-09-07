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

echo "  ok: bizagent-dispatch.sh"
