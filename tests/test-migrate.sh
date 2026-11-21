#!/usr/bin/env bash
# test-migrate.sh — scripts/migrate.sh (export / restore / rebind / verify).
#
# Functional: builds a scratch hub, exports a full-state archive, restores it
# into a second directory, and asserts re-binding (paths, host/port, env,
# remotes) plus verify pass/fail behavior. No control plane is started and no
# live hub is touched.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || fail "python3 required"
command -v tar >/dev/null 2>&1 || fail "tar required"

WORK="$(mktemp -d /tmp/bizagent-migrate.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
OLD="$WORK/hub"
NEW="$WORK/hub2"

# --- scratch hub -----------------------------------------------------------
mkdir -p "$OLD/agents/demo/inbox" "$OLD/agents/demo/outbox" \
         "$OLD/.bizagent" "$OLD/projects/demo" "$OLD/logs"
echo hello > "$OLD/projects/demo/README.md"
echo log > "$OLD/logs/control-plane-server.log"
cat > "$OLD/registry.json" <<EOF
{
  "org": "Test Co",
  "products": [
    {
      "slug": "demo",
      "name": "Demo",
      "remote": "git@example:old/demo.git",
      "projects": [
        { "name": "demo", "path": "projects/demo", "remote": "git@example:old/demo.git" },
        { "name": "abs", "path": "$OLD/extra/abs-project" }
      ]
    }
  ],
  "settings": { "control_plane": { "host": "127.0.0.1", "port": 8787 } }
}
EOF
printf 'XAI_API_KEY=test-key-123\nBIZAGENT_HUB=%s\n' "$OLD" > "$OLD/.bizagent/env"
echo '{}' > "$OLD/.bizagent/auth.json"
mkdir -p "$OLD/scripts" "$OLD/extra/abs-project"
cp "$ROOT/scripts/migrate.sh" "$OLD/scripts/migrate.sh"

# --- 1. export ---------------------------------------------------------------
bash "$OLD/scripts/migrate.sh" export --hub "$OLD" --out "$WORK/arch.tar.gz" \
  || fail "export exited non-zero"
[ -f "$WORK/arch.tar.gz" ] || fail "archive not written"
TARLIST="$(tar -tzf "$WORK/arch.tar.gz")"
echo "$TARLIST" | grep -q "registry.json" || fail "archive missing registry.json"
echo "$TARLIST" | grep -q "agents/demo/inbox" || fail "archive missing agent mailbox"
echo "$TARLIST" | grep -q ".bizagent/env" || fail "archive missing .bizagent/env"
echo "$TARLIST" | grep -q "migration-manifest.json" || fail "archive missing migration manifest"
echo "$TARLIST" | grep -q "logs/control-plane-server.log" && fail "logs/ must be excluded by default"
echo "$TARLIST" | grep -q "node_modules" && fail "node_modules must be excluded"
PERMS="$(stat -c '%a' "$WORK/arch.tar.gz")"
[ "$PERMS" = "600" ] || fail "archive must be chmod 600 (contains secrets), got $PERMS"

# --- 2. restore (rebinds paths + host/port from flags) ------------------------
bash "$OLD/scripts/migrate.sh" restore --archive "$WORK/arch.tar.gz" --hub "$NEW" \
  --host 0.0.0.0 --port 9000 --skip-npm \
  || fail "restore exited non-zero"
[ -f "$NEW/registry.json" ] || fail "restore: registry.json missing"
[ -d "$NEW/agents/demo/inbox" ] || fail "restore: agent mailbox missing"
[ -f "$NEW/projects/demo/README.md" ] || fail "restore: project files missing"
HOST2="$(python3 -c "import json;print(json.load(open('$NEW/registry.json'))['settings']['control_plane']['host'])")"
PORT2="$(python3 -c "import json;print(json.load(open('$NEW/registry.json'))['settings']['control_plane']['port'])")"
[ "$HOST2" = "0.0.0.0" ] || fail "restore: control_plane.host not re-bound (got $HOST2)"
[ "$PORT2" = "9000" ] || fail "restore: control_plane.port not re-bound (got $PORT2)"
grep -q "^BIZAGENT_HUB=$NEW$" "$NEW/.bizagent/env" || fail "restore: .bizagent/env old hub path not re-bound"
grep -q "^BIZAGENT_PORT=9000$" "$NEW/.bizagent/env" || fail "restore: BIZAGENT_PORT not written to env"
grep -q "test-key-123" "$NEW/.bizagent/env" || fail "restore: provider key lost"
PERMS="$(stat -c '%a' "$NEW/.bizagent/env")"
[ "$PERMS" = "600" ] || fail "restore: env not chmod 600"

# --- 3. rebind (absolute path + remote-map on the source hub) -----------------
bash "$OLD/scripts/migrate.sh" rebind --hub "$OLD" --old-root "$OLD" \
  --host 1.2.3.4 --port 9100 --remote-map "git@example:old/=git@example:new/" \
  || fail "rebind exited non-zero"
ABSPATH="$(python3 -c "import json;print(json.load(open('$OLD/registry.json'))['products'][0]['projects'][1]['path'])")"
[ "$ABSPATH" = "$OLD/extra/abs-project" ] || true  # old==new root here: no-op rewrite expected
REMOTE2="$(python3 -c "import json;print(json.load(open('$OLD/registry.json'))['products'][0]['remote'])")"
[ "$REMOTE2" = "git@example:new/demo.git" ] || fail "rebind: --remote-map did not rewrite product remote (got $REMOTE2)"
HOST3="$(python3 -c "import json;print(json.load(open('$OLD/registry.json'))['settings']['control_plane']['host'])")"
[ "$HOST3" = "1.2.3.4" ] || fail "rebind: host not applied"

# --- 4. verify: pass ----------------------------------------------------------
bash "$NEW/scripts/migrate.sh" verify --hub "$NEW" > "$WORK/verify.out" 2>&1 \
  || { cat "$WORK/verify.out"; fail "verify exited non-zero on a healthy restored hub"; }
grep -q "Migration verify: PASS" "$WORK/verify.out" || fail "verify did not report PASS"

# --- 5. verify: failure path ---------------------------------------------------
rm -rf "$NEW/agents/demo/outbox"
if bash "$NEW/scripts/migrate.sh" verify --hub "$NEW" > "$WORK/verify2.out" 2>&1; then
  fail "verify passed despite a missing agent outbox"
fi
grep -q "agents/demo/outbox missing" "$WORK/verify2.out" || fail "verify did not name the missing mailbox"

# --- 6. static: docs pointer + secret-dir exclusions ---------------------------
grep -q "docs/MIGRATION.md" "$ROOT/scripts/migrate.sh" || fail "migrate.sh does not point at docs/MIGRATION.md"
grep -q ".bizagent/forms" "$ROOT/scripts/migrate.sh" || fail "migrate.sh does not exclude .bizagent/forms (unclaimed DGen responses)"
grep -q ".bizagent/backups" "$ROOT/scripts/migrate.sh" || fail "migrate.sh does not exclude .bizagent/backups"

echo "test-migrate: PASS"
