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
# Health-timer ensure is skipped here so the sandbox apply never touches the
# real user crontab; the skip path itself is asserted below.
apply_out="$(BIZAGENT_SKIP_HEALTH_TIMER=1 bash "$TMP/hub/scripts/upgrade.sh" --hub "$TMP/hub" --source "$ROOT" --yes --no-restart 2>&1)" \
  || fail "upgrade apply failed: $apply_out"
echo "$apply_out" | grep -qi 'skipping health-timer' \
  || fail "upgrade should honor BIZAGENT_SKIP_HEALTH_TIMER: $apply_out"

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

# --- Restart verification (upgrade must not report success over a hub whose
# control plane kept running old code or did not come back up) -------------

# Stub control-plane.sh behaviors are injected via the SOURCE scripts/ dir,
# because repair restores scripts/ (including control-plane.sh) from source
# before it stops/starts anything.

make_source_fixture() {
  # $1 = fixture dir; $2 = stub control-plane.sh body
  local src="$1" stub="$2"
  rm -rf "$src"
  mkdir -p "$src/control-plane/public" "$src/scripts" "$src/agent-runtime/bin" "$src/agent-runtime/src"
  echo 'cp-marker' >"$src/control-plane/public/app.js"
  cat >"$src/scripts/control-plane.sh" <<STUB
#!/usr/bin/env bash
$2
STUB
  chmod +x "$src/scripts/control-plane.sh"
  echo '{"name":"bizagent-agent"}' >"$src/agent-runtime/package.json"
  echo 'console.log("runtime")' >"$src/agent-runtime/src/index.js"
  echo '#!/usr/bin/env bash' >"$src/agent-runtime/bin/bizagent-agent"
  chmod +x "$src/agent-runtime/bin/bizagent-agent"
}

make_sandbox_hub() {
  local hub="$1"
  mkdir -p "$hub/agents/alpha" "$hub/scripts" "$hub/.bizagent" "$hub/logs" \
    "$hub/agent-runtime/node_modules/keepme"
  echo '{"org":"Test","settings":{"auto_update":false},"products":[]}' >"$hub/registry.json"
  echo 'KEEP_CLI' >"$hub/cli.json"
  echo 'agent' >"$hub/agents/alpha/agent.md"
  cp "$ROOT/scripts/upgrade.sh" "$hub/scripts/upgrade.sh"
  cp "$ROOT/scripts/factory-reset.sh" "$hub/scripts/factory-reset.sh"
  # "Old" control-plane.sh already on the hub: reports a running pid 4242,
  # stop is a no-op (the failure mode that leaves old code serving).
  cat >"$hub/scripts/control-plane.sh" <<'OLDSTUB'
#!/usr/bin/env bash
case "${1:-}" in
  status) echo "bizagent-control-plane running: pid 4242 (process)"; exit 0 ;;
  stop)   echo "bizagent-control-plane stopped (old stub)" ;;
  start)  echo "bizagent-control-plane already running: pid 4242" ;;
  restart) echo "old stub restart" ;;
esac
exit 0
OLDSTUB
  chmod +x "$hub/scripts/"*.sh
  echo 'preserve-me' >"$hub/agent-runtime/node_modules/keepme/dep.js"
}

# Fake npm so sandbox applies never touch the network.
FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKEBIN/npm"
chmod +x "$FAKEBIN/npm"

# (a) Old control plane survives the "restart" (stop no-op, start says
# "already running" with the SAME pid) → upgrade must FAIL, not report done.
SRC_A="$TMP/src-a"
make_source_fixture "$SRC_A" '
case "${1:-}" in
  status) echo "bizagent-control-plane running: pid 4242 (process)"; exit 0 ;;
  stop)   echo "bizagent-control-plane stopped (stub)" ;;
  start)  echo "bizagent-control-plane already running: pid 4242" ;;
  restart) echo "stub restart" ;;
esac
exit 0'
HUB_A="$TMP/hub-a"
make_sandbox_hub "$HUB_A"
out="$(PATH="$FAKEBIN:$PATH" bash "$HUB_A/scripts/upgrade.sh" --hub "$HUB_A" --source "$SRC_A" --yes 2>&1)" \
  && fail "upgrade reported success although the old control plane (pid 4242) was never restarted: $out"
echo "$out" | grep -q "NOT restarted\|not running new code" \
  || fail "upgrade failure should explain the control-plane restart problem: $out"

# (b) Healthy restart (pid changes 4242 → 777) → upgrade succeeds and verifies.
SRC_B="$TMP/src-b"
make_source_fixture "$SRC_B" '
hub="${2:-.}"
pf="$hub/.bizagent/test-cp-pid"
case "${1:-}" in
  status) if [ -f "$pf" ]; then echo "bizagent-control-plane running: pid $(cat "$pf") (process)"; exit 0; else echo "bizagent-control-plane is not running"; exit 1; fi ;;
  stop)   rm -f "$pf"; echo "stopped (stub)" ;;
  start)  echo 777 > "$pf"; echo "started: pid 777" ;;
  restart) rm -f "$pf"; echo 777 > "$pf"; echo "restarted (stub)" ;;
esac
exit 0'
HUB_B="$TMP/hub-b"
make_sandbox_hub "$HUB_B"
out="$(PATH="$FAKEBIN:$PATH" bash "$HUB_B/scripts/upgrade.sh" --hub "$HUB_B" --source "$SRC_B" --yes 2>&1)" \
  || fail "upgrade should succeed when the control plane restarts onto a new pid: $out"
echo "$out" | grep -qi "verified running" \
  || fail "upgrade should verify the restarted control plane: $out"
grep -q 'KEEP_CLI' "$HUB_B/cli.json" || fail "upgrade clobbered cli.json"
[[ -f "$HUB_B/agent-runtime/node_modules/keepme/dep.js" ]] \
  || fail "upgrade wiped agent-runtime/node_modules (turn-loop risk when npm install fails)"

# (c) control-plane.sh status exits non-zero when the CP is down (verification
# depends on it).
mkdir -p "$TMP/hub-c/scripts"
cp "$ROOT/scripts/control-plane.sh" "$TMP/hub-c/scripts/"
if bash "$TMP/hub-c/scripts/control-plane.sh" status "$TMP/hub-c" >/dev/null 2>&1; then
  fail "control-plane.sh status should exit non-zero when the control plane is down"
fi

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

# health survival timer wired into install + upgrade
grep -q 'install-health-timer' "$SCRIPT" \
  || fail "upgrade.sh missing health-timer ensure step"
grep -q 'install-health-timer' "$ROOT/install.sh" \
  || fail "install.sh missing health-timer step"
grep -q 'install-health-timer' "$ROOT/install/install.sh" \
  || fail "install/install.sh missing health-timer step"
for f in scripts/health-probe.sh scripts/health-alert-failure.sh \
         scripts/install-health-timer.sh docs/HEALTH-SURVIVAL.md \
         control-plane/lib/health.js; do
  [[ -e "$ROOT/$f" ]] || fail "health survival file missing: $f"
done
echo "$out" | grep -qi 'health' \
  || fail "upgrade dry-run should mention the health-timer step: $out"

