#!/usr/bin/env bash
# test-upgrade.sh — structural + dry-run / sandbox checks for scripts/upgrade.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

SCRIPT="$ROOT/scripts/upgrade.sh"
[ -x "$SCRIPT" ] || fail "scripts/upgrade.sh missing or not executable"

bash -n "$SCRIPT" || fail "upgrade.sh bash -n failed"
bash -n "$ROOT/scripts/factory-reset.sh" || fail "factory-reset.sh bash -n failed"

grep -q 'factory-reset' "$SCRIPT" || fail "upgrade should delegate to factory-reset"
grep -q 'dry-run\|DRY_RUN' "$SCRIPT" || fail "upgrade missing dry-run mode"
grep -q 'cli.json' "$SCRIPT" || fail "upgrade should mention preserving cli.json"
grep -q 'OddbeakerLLC/bizagent' "$SCRIPT" || fail "upgrade should reference public OddbeakerLLC/bizagent"
grep -q 'auto_update' "$ROOT/scripts/nightly.sh" || fail "nightly.sh must honor settings.auto_update"
grep -q 'upgrade.sh' "$ROOT/scripts/nightly.sh" || fail "nightly.sh must call upgrade.sh when auto_update"
grep -q 'auto_update' "$ROOT/registry.example.json" || fail "registry.example.json missing auto_update"
grep -q 'prompt_auto_update\|BIZAGENT_AUTO_UPDATE\|auto_update' "$ROOT/install.sh" \
  || fail "install.sh missing auto-update preference"
grep -q 'upgrade.sh' "$ROOT/README.md" || fail "README missing upgrade docs"

# Dry-run against a minimal fake hub (no network, no writes to framework)
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ba-upgrade-test-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/hub/agents/alpha" "$TMP/hub/scripts" "$TMP/hub/.bizagent" "$TMP/hub/logs"
echo '{"org":"Test","settings":{"auto_update":false},"products":[]}' >"$TMP/hub/registry.json"
echo 'KEEP_CLI' >"$TMP/hub/cli.json"
echo 'agent' >"$TMP/hub/agents/alpha/agent.md"
cp "$ROOT/scripts/upgrade.sh" "$TMP/hub/scripts/upgrade.sh"
cp "$ROOT/scripts/factory-reset.sh" "$TMP/hub/scripts/factory-reset.sh"
chmod +x "$TMP/hub/scripts/"*.sh

out="$(bash "$TMP/hub/scripts/upgrade.sh" --hub "$TMP/hub" --source "$ROOT" --dry-run -v 2>&1)" \
  || fail "dry-run failed: $out"
echo "$out" | grep -qi 'DRY-RUN' || fail "dry-run output missing DRY-RUN marker: $out"
echo "$out" | grep -qi 'preserve\|would keep\|registry' \
  || fail "dry-run should mention preserve/keep: $out"
# Dry-run must not clobber cli.json
grep -q 'KEEP_CLI' "$TMP/hub/cli.json" || fail "dry-run clobbered cli.json"

# Apply via local source (this repo) with --no-restart
mkdir -p "$TMP/hub/control-plane/public"
echo 'OLD_CP' >"$TMP/hub/control-plane/public/app.js"
cat >"$TMP/hub/scripts/control-plane.sh" <<'STUB'
#!/usr/bin/env bash
echo "stub control-plane $*"
exit 0
STUB
chmod +x "$TMP/hub/scripts/control-plane.sh"

# Need factory-reset on hub path after upgrade copies scripts from source —
# apply uses current hub's factory-reset first.
bash "$TMP/hub/scripts/upgrade.sh" --hub "$TMP/hub" --source "$ROOT" --yes --no-restart \
  || fail "upgrade apply failed"

grep -q 'KEEP_CLI' "$TMP/hub/cli.json" || fail "upgrade clobbered cli.json"
grep -q 'agent' "$TMP/hub/agents/alpha/agent.md" || fail "upgrade clobbered agents/"
# control-plane should have been restored from ROOT
[[ -f "$TMP/hub/control-plane/public/app.js" ]] \
  || fail "upgrade did not restore control-plane"
# Must not leave a framework cli.json if source had one — live keep wins
grep -q 'KEEP_CLI' "$TMP/hub/cli.json" || fail "cli.json lost after upgrade"
[[ -d "$TMP/hub/.bizagent/backups" ]] || fail "upgrade/repair did not create backups"
# registry auto_update still false
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["settings"].get("auto_update") is False' \
  "$TMP/hub/registry.json" || fail "registry settings.auto_update changed unexpectedly"

# Nightly skips upgrade when auto_update false
mkdir -p "$TMP/nightly/scripts" "$TMP/nightly/inbox" "$TMP/nightly/outbox" "$TMP/nightly/agents"
cp "$ROOT/scripts/nightly.sh" "$TMP/nightly/scripts/"
cat >"$TMP/nightly/scripts/router.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/nightly/scripts/router.sh"
# upgrade.sh that fails if invoked
cat >"$TMP/nightly/scripts/upgrade.sh" <<'EOF'
#!/usr/bin/env bash
echo "UPGRADE_RAN" >&2
exit 99
EOF
chmod +x "$TMP/nightly/scripts/upgrade.sh"
echo '{"settings":{"auto_update":false,"archive_after_days":30},"products":[]}' \
  >"$TMP/nightly/registry.json"
nout="$(bash "$TMP/nightly/scripts/nightly.sh" 2>&1)" || true
echo "$nout" | grep -q 'UPGRADE_RAN' && fail "nightly ran upgrade when auto_update=false"
echo "$nout" | grep -qi 'auto_update off\|manual-only\|skip framework' \
  || fail "nightly should log skip when auto_update off: $nout"

# Nightly runs upgrade when auto_update true
echo '{"settings":{"auto_update":true,"archive_after_days":30},"products":[]}' \
  >"$TMP/nightly/registry.json"
cat >"$TMP/nightly/scripts/upgrade.sh" <<'EOF'
#!/usr/bin/env bash
echo "UPGRADE_RAN_OK"
exit 0
EOF
chmod +x "$TMP/nightly/scripts/upgrade.sh"
nout2="$(bash "$TMP/nightly/scripts/nightly.sh" 2>&1)" || true
echo "$nout2" | grep -q 'UPGRADE_RAN_OK' \
  || fail "nightly did not run upgrade when auto_update=true: $nout2"

echo "  ok: upgrade"

# oddbeaker-tts on upgrade path
grep -q 'install-oddbeaker-tts\|ensure_tts_on_upgrade\|with-tts' "$SCRIPT" \
  || fail "upgrade.sh missing oddbeaker-tts ensure step"
grep -q 'BIZAGENT_TTS_VOICE' "$ROOT/scripts/install-oddbeaker-tts.sh" \
  || fail "install-oddbeaker-tts missing voice persistence"

