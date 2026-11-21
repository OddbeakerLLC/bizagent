#!/usr/bin/env bash
# test-enterprise-installer.sh — install/install-enterprise.sh.
#
# Static: the installer and its systemd system unit exist and wire the
# documented pieces (auth-init, TLS, health watchdog, check-hub-ready).
# Functional: a full non-interactive run against a scratch hub
# (--service none, --skip-npm, node_modules symlinked from this checkout)
# must apply the enterprise settings profile, init auth, enable TLS, write
# the log profile, start the control plane, and answer /api/health.
# The live hub (8787) is never touched — scratch hub + scratch port.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "node required"
command -v python3 >/dev/null 2>&1 || fail "python3 required"
command -v curl >/dev/null 2>&1 || fail "curl required"
command -v openssl >/dev/null 2>&1 || fail "openssl required (self-signed TLS path)"

# --- 1. static ---------------------------------------------------------------
[ -f "$ROOT/install/install-enterprise.sh" ] || fail "install-enterprise.sh missing"
[ -f "$ROOT/install/bizagent-control-plane-system.service" ] || fail "system unit template missing"
grep -q "User=__USER__" "$ROOT/install/bizagent-control-plane-system.service" || fail "unit template missing User placeholder"
grep -q "WantedBy=multi-user.target" "$ROOT/install/bizagent-control-plane-system.service" || fail "unit template not a system service (multi-user.target)"
grep -q "Restart=on-failure" "$ROOT/install/bizagent-control-plane-system.service" || fail "unit template missing Restart=on-failure"
grep -q "auth-init" "$ROOT/install/install-enterprise.sh" || fail "installer does not run auth-init"
grep -q "install-health-timer.sh" "$ROOT/install/install-enterprise.sh" || fail "installer does not install the health watchdog"
grep -q "check-hub-ready.sh" "$ROOT/install/install-enterprise.sh" || fail "installer does not run check-hub-ready"
grep -q "BIZAGENT_TLS_CERT" "$ROOT/install/install-enterprise.sh" || fail "installer does not support existing certs"
[ -f "$ROOT/docs/ENTERPRISE-INSTALL.md" ] || fail "docs/ENTERPRISE-INSTALL.md missing"
grep -q "factory-reset.sh" "$ROOT/docs/ENTERPRISE-INSTALL.md" || fail "docs do not state factory-reset compatibility"
grep -q "upgrade.sh" "$ROOT/docs/ENTERPRISE-INSTALL.md" || fail "docs do not state upgrade compatibility"

# --- 2. functional: full run on a scratch hub --------------------------------
WORK="$(mktemp -d /tmp/bizagent-enterprise.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
HUB="$WORK/hub"
mkdir -p "$HUB"
cp -a "$ROOT/control-plane" "$HUB/control-plane"
rm -rf "$HUB/control-plane/node_modules"
mkdir -p "$HUB/scripts"
cp "$ROOT/scripts/bizagent-control-plane.js" "$HUB/scripts/"
cp "$ROOT/scripts/control-plane.sh" "$HUB/scripts/"
cp "$ROOT/scripts/check-hub-ready.sh" "$HUB/scripts/"
chmod +x "$HUB/scripts/"*.sh "$HUB/scripts/"*.js 2>/dev/null || true
# Deps resolve through the real checkout's node_modules (no npm install).
ln -s "$ROOT/node_modules" "$HUB/node_modules"

cat > "$HUB/registry.json" <<'EOF'
{
  "org": "",
  "products": [],
  "settings": { "hub_agent": { "provider": "ollama", "cliName": "ollama", "model": "llama3.2" } }
}
EOF
cp "$ROOT/cli.json.example" "$HUB/cli.json" 2>/dev/null || true

pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
PORT="$(pick_port)"

BIZAGENT_ADMIN_USER=ops BIZAGENT_ADMIN_PASSWORD=test-pw-123 \
  bash "$ROOT/install/install-enterprise.sh" \
  --hub "$HUB" --host 127.0.0.1 --port "$PORT" --tls \
  --service none --skip-npm --yes > "$WORK/install.out" 2>&1 \
  || { tail -30 "$WORK/install.out"; fail "installer exited non-zero"; }

python3 - "$HUB/registry.json" "$PORT" <<'PY' || fail "enterprise settings profile not applied"
import json, sys
reg = json.load(open(sys.argv[1]))
cp = reg["settings"]["control_plane"]
disp = reg["settings"]["dispatch"]
assert cp["host"] == "127.0.0.1", cp
assert cp["port"] == int(sys.argv[2]), cp
assert cp.get("tls", {}).get("enabled") is True, cp
assert disp.get("allow_concurrency") is True, disp
assert disp.get("agent_slots") == 2, disp
assert disp.get("rate_limit_cooldown_secs") == 300, disp
assert disp.get("hold_cooldown_secs") == 1800, disp
PY
[ -f "$HUB/.bizagent/auth.json" ] || fail "auth.json not created (auth init did not run)"
grep -q "^BIZAGENT_LOG_MAX_BYTES=10485760$" "$HUB/.bizagent/env" || fail "log profile not written to .bizagent/env"
grep -q "^BIZAGENT_LOG_KEEP_GENERATIONS=3$" "$HUB/.bizagent/env" || fail "log generations not written"
[ -f "$HUB/.bizagent/tls/tls.crt" ] || fail "self-signed TLS cert not generated on first start"
CODE="$(curl -skS -o /dev/null -w '%{http_code}' --max-time 5 "https://127.0.0.1:$PORT/api/health" 2>/dev/null || echo 0)"
[ "$CODE" = "200" ] || fail "control plane not answering /api/health (https) on port $PORT (HTTP $CODE)"

# --- 3. functional: auth init is skipped when auth already exists -------------
PORT2="$(pick_port)"
BIZAGENT_ADMIN_USER=ops BIZAGENT_ADMIN_PASSWORD=other-pw \
  bash "$ROOT/install/install-enterprise.sh" \
  --hub "$HUB" --host 127.0.0.1 --port "$PORT2" \
  --service none --skip-npm --yes > "$WORK/install2.out" 2>&1 \
  || { tail -30 "$WORK/install2.out"; fail "second installer run exited non-zero"; }
grep -q "already present — skipping auth init" "$WORK/install2.out" || fail "installer re-ran auth init over existing auth.json"

# --- cleanup: stop the scratch control plane -----------------------------------
bash "$HUB/scripts/control-plane.sh" stop "$HUB" >/dev/null 2>&1 || true

echo "test-enterprise-installer: PASS"
