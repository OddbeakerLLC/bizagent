#!/usr/bin/env bash
# test-first-run-seed.sh — first-run welcome seed + install wiring
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SEED="$ROOT/scripts/seed-first-run.sh"
fail() { echo "  FAIL: $1"; exit 1; }

[ -x "$SEED" ] || fail "scripts/seed-first-run.sh missing or not executable"
bash -n "$SEED" || fail "seed-first-run.sh bash -n failed"

# Root install handoff must call the shared seeder (one-liner path).
grep -q 'seed-first-run' "$ROOT/install.sh" \
  || fail "root install.sh handoff does not call seed-first-run.sh"
grep -q 'seed-first-run' "$ROOT/install/install.sh" \
  || fail "install/install.sh does not call seed-first-run.sh"

# AGENT.md must distinguish minimal install seed from BUILT.
grep -q 'MINIMAL install seed' "$ROOT/AGENT.md" \
  || fail "AGENT.md missing MINIMAL install seed state"
grep -q 'zero-repo\|Zero-repo\|zero repos' "$ROOT/AGENT.md" \
  || fail "AGENT.md missing zero-repo path"
grep -q 'Peer messaging' "$ROOT/AGENT.md" \
  || fail "AGENT.md missing peer messaging beat"

# Runtime prompt must not hard-code BUILT for every launch.
grep -q 'classifyRegistryState' "$ROOT/control-plane/lib/hub-memory.js" \
  || fail "hub-memory missing classifyRegistryState"
grep -q 'MINIMAL install seed' "$ROOT/control-plane/lib/hub-memory.js" \
  || fail "hub-memory missing MINIMAL first-run guidance"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Minimal fake hub: empty org/products registry. Seed script loads CP libs from
# the real framework tree (SCRIPT_DIR/..) so we do not need a full control-plane copy.
mkdir -p "$TMP/hub/inbox/archive" "$TMP/hub/.bizagent" "$TMP/hub/scripts"
# Stub check-hub-ready as ready
cat > "$TMP/hub/scripts/check-hub-ready.sh" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$TMP/hub/scripts/check-hub-ready.sh"
printf '%s\n' '{"org":"","products":[],"settings":{"hub_agent":{"provider":"grok","model":"grok-4.5"}}}' \
  > "$TMP/hub/registry.json"

# Seed once
bash "$SEED" "$TMP/hub" >/dev/null || fail "seed-first-run exited non-zero on minimal hub"
SEED_COUNT=$(find "$TMP/hub/inbox" -maxdepth 1 -name '*-install-first-run.md' | wc -l)
[ "$SEED_COUNT" -eq 1 ] || fail "expected exactly one install-first-run seed, got $SEED_COUNT"
grep -q 'conversation_id:' "$TMP/hub/inbox/"*-install-first-run.md \
  || fail "seed missing conversation_id"
grep -q 'MINIMAL\|minimal\|UNBUILT\|first-run' "$TMP/hub/inbox/"*-install-first-run.md \
  || fail "minimal seed body missing first-run guidance"
[ -f "$TMP/hub/.bizagent/first-run-seeded" ] || fail "marker file not written"

# Welcome conversation + first bubble
CONV_N=$(find "$TMP/hub/.bizagent/conversations" -name '*.json' 2>/dev/null | wc -l)
[ "$CONV_N" -ge 1 ] || fail "Welcome conversation not created"
node - "$TMP/hub" <<'NODE' || fail "first hub bubble missing or wrong"
const fs = require('fs');
const path = require('path');
const dir = path.join(process.argv[2], '.bizagent', 'conversations');
const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
let ok = false;
for (const f of files) {
  const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const hubMsgs = (c.messages || []).filter((m) => m.role === 'hub');
  if (String(c.name || '').toLowerCase() === 'welcome' && hubMsgs.length >= 1) {
    const t = String(hubMsgs[0].content || '');
    if (/organization/i.test(t) && t.length < 280) { ok = true; break; }
  }
}
process.exit(ok ? 0 : 1);
NODE

# Idempotent second run
bash "$SEED" "$TMP/hub" >/dev/null || fail "second seed run failed"
SEED_COUNT2=$(find "$TMP/hub/inbox" -maxdepth 1 -name '*-install-first-run.md' | wc -l)
[ "$SEED_COUNT2" -eq 1 ] || fail "second run spawned extra seed ($SEED_COUNT2)"
CONV_N2=$(find "$TMP/hub/.bizagent/conversations" -name '*.json' 2>/dev/null | wc -l)
[ "$CONV_N2" -eq "$CONV_N" ] || fail "second run created extra conversation"

# Configured hub → non-destructive welcome only
TMP2="$(mktemp -d)"
trap 'rm -rf "$TMP" "$TMP2"' EXIT
mkdir -p "$TMP2/hub/inbox/archive" "$TMP2/hub/.bizagent" "$TMP2/hub/scripts"
cat > "$TMP2/hub/scripts/check-hub-ready.sh" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$TMP2/hub/scripts/check-hub-ready.sh"
printf '%s\n' '{"org":"Acme","products":[{"slug":"widgets","name":"Widgets"}],"settings":{"hub_agent":{"provider":"grok","model":"grok-4.5"}}}' \
  > "$TMP2/hub/registry.json"
bash "$SEED" "$TMP2/hub" >/dev/null || fail "seed on configured hub failed"
grep -qi 'already-configured\|already set up\|what do you want' "$TMP2/hub/inbox/"*-install-first-run.md \
  || fail "configured seed missing non-destructive guidance"
node - "$TMP2/hub" <<'NODE' || fail "configured welcome bubble wrong"
const fs = require('fs');
const path = require('path');
const dir = path.join(process.argv[2], '.bizagent', 'conversations');
const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
let ok = false;
for (const f of files) {
  const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const hubMsgs = (c.messages || []).filter((m) => m.role === 'hub');
  if (hubMsgs.length >= 1 && /what do you want to work on/i.test(hubMsgs[0].content || '')) {
    ok = true; break;
  }
}
process.exit(ok ? 0 : 1);
NODE

# classifyRegistryState unit
node - "$ROOT" <<'NODE' || fail "classifyRegistryState unit failed"
const path = require('path');
const fs = require('fs');
const os = require('os');
const { classifyRegistryState } = require(path.join(process.argv[2], 'control-plane/lib/hub-memory'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
fs.writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify({ org: '', products: [] }));
if (classifyRegistryState(tmp) !== 'minimal') process.exit(1);
fs.writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify({ org: 'X', products: [] }));
if (classifyRegistryState(tmp) !== 'configured') process.exit(2);
fs.writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify({ org: '', products: [{ slug: 'a', name: 'A' }] }));
if (classifyRegistryState(tmp) !== 'configured') process.exit(3);
const missing = path.join(tmp, 'nope');
fs.mkdirSync(missing);
if (classifyRegistryState(missing) !== 'missing') process.exit(4);
const prompt = require(path.join(process.argv[2], 'control-plane/lib/hub-memory')).deriveHubRuntimePrompt(tmp);
// tmp still has configured products from last write
if (!/BUILT|configured/i.test(prompt)) process.exit(5);
fs.writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify({ org: '', products: [] }));
const p2 = require(path.join(process.argv[2], 'control-plane/lib/hub-memory')).deriveHubRuntimePrompt(tmp);
if (!/MINIMAL/i.test(p2)) process.exit(6);
process.exit(0);
NODE

echo "  ok: first-run seed + install wiring"
