#!/usr/bin/env bash
# test-factory-reset.sh — structural + dry sandbox checks for factory-reset.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

SCRIPT="$ROOT/scripts/factory-reset.sh"
[ -x "$SCRIPT" ] || fail "scripts/factory-reset.sh missing or not executable"

bash -n "$SCRIPT" || fail "factory-reset.sh bash -n failed"

grep -q "repair" "$SCRIPT" || fail "missing repair mode"
grep -q "restore-ops" "$SCRIPT" || fail "missing restore-ops mode"
grep -q "nuke" "$SCRIPT" || fail "missing nuke mode"
grep -q "control-plane" "$SCRIPT" || fail "repair should mention control-plane"
grep -q "registry.json" "$SCRIPT" || fail "should preserve/mention registry.json"
grep -q "BACKUPS\|backups" "$SCRIPT" || fail "should create backups under .bizagent/backups"

# Hub prompt fence (companion policy)
grep -q "user-gated" "$ROOT/control-plane/lib/hub-memory.js" \
  || fail "hub runtime prompt missing user-gated hub-mod fence"
grep -q "factory-reset" "$ROOT/control-plane/lib/hub-memory.js" \
  || fail "hub runtime prompt missing factory-reset pointer"

# Sandbox repair using local public-ish tree as --source (this repo's control-plane)
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ba-factory-test-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Minimal fake hub with ops data we must keep
mkdir -p "$TMP/hub/agents/alpha/inbox" "$TMP/hub/journal" "$TMP/hub/.bizagent" "$TMP/hub/logs"
echo '{"org":"Test","products":[{"slug":"alpha","name":"Alpha","agent_name":"Agent A","projects":[]}]}' \
  >"$TMP/hub/registry.json"
echo 'KEEP_ME_CLI' >"$TMP/hub/cli.json"
echo 'ops-journal' >"$TMP/hub/journal/keep.md"
echo 'agent-standing' >"$TMP/hub/agents/alpha/agent.md"
# Deliberately broken/old control-plane marker
mkdir -p "$TMP/hub/control-plane/public" "$TMP/hub/scripts" "$TMP/hub/templates"
echo 'BROKEN_CP' >"$TMP/hub/control-plane/public/app.js"
echo 'old' >"$TMP/hub/scripts/old-only.sh"

# Framework source: subset of real hub
mkdir -p "$TMP/fw/control-plane/public" "$TMP/fw/scripts" "$TMP/fw/templates" "$TMP/fw/tests"
echo 'GOOD_CP' >"$TMP/fw/control-plane/public/app.js"
echo '#!/bin/bash' >"$TMP/fw/scripts/factory-reset.sh"
cp "$ROOT/scripts/factory-reset.sh" "$TMP/fw/scripts/factory-reset.sh"
chmod +x "$TMP/fw/scripts/"*.sh 2>/dev/null || true
echo 'dispatch {{slug}}' >"$TMP/fw/templates/dispatch.md.template"
# Provide hub-memory so regen can load if node path exists — optional
mkdir -p "$TMP/fw/control-plane/lib"
# Minimal stub so require doesn't crash badly if called — copy real if small enough
cp "$ROOT/control-plane/lib/hub-memory.js" "$TMP/fw/control-plane/lib/hub-memory.js"
cp "$ROOT/control-plane/lib/config.js" "$TMP/fw/control-plane/lib/config.js" 2>/dev/null || true
cp "$ROOT/control-plane/lib/log.js" "$TMP/fw/control-plane/lib/log.js" 2>/dev/null || true

# Point hub scripts at copy of factory-reset that uses --source
cp "$ROOT/scripts/factory-reset.sh" "$TMP/hub/scripts/factory-reset.sh"
chmod +x "$TMP/hub/scripts/factory-reset.sh"
# Stub control-plane.sh so stop/start no-op
cat >"$TMP/hub/scripts/control-plane.sh" <<'STUB'
#!/usr/bin/env bash
echo "stub control-plane $*"
exit 0
STUB
chmod +x "$TMP/hub/scripts/control-plane.sh"

bash "$TMP/hub/scripts/factory-reset.sh" repair \
  --hub "$TMP/hub" \
  --source "$TMP/fw" \
  --yes \
  --no-restart \
  || fail "repair failed in sandbox"

grep -q 'GOOD_CP' "$TMP/hub/control-plane/public/app.js" \
  || fail "repair did not restore control-plane app.js"
grep -q 'KEEP_ME_CLI' "$TMP/hub/cli.json" \
  || fail "repair clobbered cli.json"
grep -q 'ops-journal' "$TMP/hub/journal/keep.md" \
  || fail "repair clobbered journal"
grep -q 'agent-standing' "$TMP/hub/agents/alpha/agent.md" \
  || fail "repair clobbered agent.md"
[[ -d "$TMP/hub/.bizagent/backups" ]] \
  || fail "repair did not create .bizagent/backups"
ls "$TMP/hub/.bizagent/backups"/factory-reset-repair-* >/dev/null 2>&1 \
  || fail "no repair backup directory"

echo "  ok: factory-reset"
