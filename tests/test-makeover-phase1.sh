#!/usr/bin/env bash
# test-makeover-phase1.sh — public makeover Phase 0/1 structural checks
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }
ok() { echo "  ok: $1"; }

# Files
[ -f "$ROOT/control-plane/lib/structured-log.js" ] || fail "structured-log.js missing"
[ -f "$ROOT/control-plane/lib/config.js" ] || fail "config.js missing"
grep -q "loadHubEnv" "$ROOT/control-plane/lib/config.js" || fail "loadHubEnv missing from config.js"
[ -x "$ROOT/scripts/prune-archives.sh" ] || fail "prune-archives.sh missing or not executable"
[ -f "$ROOT/scripts/migrate-from-legacy.js" ] || fail "migrate-from-legacy.js missing"
[ -f "$ROOT/scripts/hub-daemon.js" ] || fail "hub-daemon.js missing"
[ -x "$ROOT/scripts/hub-daemon.sh" ] || fail "hub-daemon.sh missing or not executable"
[ -f "$ROOT/.bizagent/env.example" ] || fail ".bizagent/env.example missing"
[ -f "$ROOT/cli.json" ] || fail "cli.json (public catalog) missing"

# prune wired into nightly
grep -q "prune-archives.sh" "$ROOT/scripts/nightly.sh" || fail "nightly.sh does not call prune-archives.sh"
grep -qi "prune" "$ROOT/NIGHTLY.md" || fail "NIGHTLY.md does not mention prune"

# env load in dispatcher spawn path
grep -q "loadHubEnv" "$ROOT/control-plane/lib/dispatcher.js" || fail "dispatcher does not call loadHubEnv"
grep -q "requestWarmHubTurn" "$ROOT/control-plane/lib/dispatcher.js" || fail "dispatcher missing warm hub client"
grep -q "hub_warm_fallback" "$ROOT/control-plane/lib/dispatcher.js" || fail "dispatcher missing cold fallback path"

# Product mental model in hub prompt
grep -q "gather → build → distribute" "$ROOT/control-plane/lib/hub-memory.js" \
  || fail "hub runtime prompt missing Product Mental Model"

# Safety messages surface real auth errors
grep -q "Hub CLI authentication failed" "$ROOT/control-plane/lib/hub-turn-safety.js" \
  || fail "hardFailMessage does not surface auth failures clearly"

# systemd template has EnvironmentFile for .bizagent/env
grep -q "EnvironmentFile=.*\.bizagent/env" "$ROOT/install/bizagent-control-plane.service" \
  || fail "systemd template missing EnvironmentFile for .bizagent/env"

# registry tuning schema — example only (registry.json is operator-local / gitignored)
node -e '
const r = require(process.argv[1]);
const t = r.settings && r.settings.tuning;
if (!t || !t.archive || t.archive.retention_days == null) {
  console.error("registry.settings.tuning.archive.retention_days missing");
  process.exit(1);
}
if (Number(t.archive.retention_days) < 1) process.exit(1);
' "$ROOT/registry.example.json" || fail "registry.example.json missing settings.tuning.archive"

# loadHubEnv unit behavior
node -e '
const fs = require("fs");
const path = require("path");
const os = require("os");
const { loadHubEnv } = require("./control-plane/lib/config");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bizagent-env-"));
fs.mkdirSync(path.join(tmp, ".bizagent"));
fs.writeFileSync(path.join(tmp, ".bizagent", "env"), "TEST_BIZAGENT_ENV_KEY=hello_from_test\n");
delete process.env.TEST_BIZAGENT_ENV_KEY;
const r = loadHubEnv(tmp);
if (!r.found || process.env.TEST_BIZAGENT_ENV_KEY !== "hello_from_test") {
  console.error("loadHubEnv failed", r, process.env.TEST_BIZAGENT_ENV_KEY);
  process.exit(1);
}
// should not override existing
process.env.TEST_BIZAGENT_ENV_KEY = "keep";
fs.writeFileSync(path.join(tmp, ".bizagent", "env"), "TEST_BIZAGENT_ENV_KEY=overwrite\n");
loadHubEnv(tmp);
if (process.env.TEST_BIZAGENT_ENV_KEY !== "keep") {
  console.error("loadHubEnv overrode existing env");
  process.exit(1);
}
fs.rmSync(tmp, { recursive: true, force: true });
' || fail "loadHubEnv unit check failed"

# prune dry-run exits 0
bash "$ROOT/scripts/prune-archives.sh" --dry-run "$ROOT" >/dev/null \
  || fail "prune-archives.sh --dry-run failed"

# observability API route exists
grep -q "/api/observability" "$ROOT/control-plane/server.js" || fail "observability API missing"

# hub-daemon module loads
node -e '
const fs = require("fs");
const src = fs.readFileSync("scripts/hub-daemon.js","utf8");
if (!src.includes("hub.sock")) process.exit(1);
if (!src.includes("type === '\''turn'\''") && !src.includes("type === \"turn\"")) process.exit(1);
' || fail "hub-daemon.js missing expected protocol bits"

ok "makeover-phase1"
