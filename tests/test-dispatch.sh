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
grep -q "CLI_EXTRA_ARGS" "$ROOT/control-plane/lib/config.js" \
  || fail "control plane does not read CLI_EXTRA_ARGS"
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
{"settings":{"dispatch":{"max_concurrency":1,"lock_lease_secs":60}},"products":[{"slug":"alpha","name":"Alpha","agent_name":"Agent A","projects":[]}]}
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

echo "  ok: bizagent-dispatch.sh"
