#!/usr/bin/env bash
# test-watch.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

grep -q "bizagent-control-plane.js.*serve" "$ROOT/scripts/bizagent-watch.sh" \
  || fail "bizagent-watch.sh does not run the Node control plane"
grep -q "install-control-plane.sh" "$ROOT/scripts/install-watch.sh" \
  || fail "install-watch.sh does not delegate to install-control-plane.sh"
grep -q "bizagent-control-plane.service" "$ROOT/scripts/install-control-plane.sh" \
  || fail "install-control-plane.sh does not install the service"
grep -q "legacy watch option" "$ROOT/scripts/bizagent-watch.sh" \
  || fail "bizagent-watch.sh does not handle legacy watch arguments"
grep -q "legacy install option" "$ROOT/scripts/install-dispatch.sh" \
  || fail "install-dispatch.sh does not handle legacy installer arguments"
grep -q "validate_port" "$ROOT/scripts/install-control-plane.sh" \
  || fail "install-control-plane.sh does not validate service ports"
grep -q "validate_host" "$ROOT/scripts/install-control-plane.sh" \
  || fail "install-control-plane.sh does not validate service hosts"
grep -q "systemd_escape_value" "$ROOT/scripts/install-control-plane.sh" \
  || fail "install-control-plane.sh does not escape systemd unit values"
if grep -q "systemd-escape --path" "$ROOT/scripts/install-control-plane.sh"; then
  fail "install-control-plane.sh uses systemd-escape --path for unit setting values"
fi
grep -q "remove_legacy_watch_service" "$ROOT/scripts/install-watch.sh" \
  || fail "install-watch.sh uninstall does not remove legacy watcher service"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/node"
chmod +x "$TMP/bin/node"
out="$(PATH="$TMP/bin:$PATH" XDG_CONFIG_HOME="$TMP/config" BIZAGENT_HOST=127.0.0.1 BIZAGENT_PORT=9876 bash "$ROOT/scripts/install-control-plane.sh" --name verify 2>&1)" \
  || fail "install-control-plane.sh failed with fake node: $out"
unit="$TMP/config/systemd/user/bizagent-control-plane-verify.service"
[ -f "$unit" ] || fail "install-control-plane.sh did not write expected unit"
grep -q '^WorkingDirectory=/' "$unit" \
  || fail "generated control-plane unit WorkingDirectory is not an absolute path"
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$unit" >/dev/null 2>&1 \
    || fail "generated control-plane unit fails systemd-analyze verify"
fi

space_hub="$TMP/hub with spaces"
mkdir -p "$space_hub/scripts" "$space_hub/install"
cp "$ROOT/scripts/install-control-plane.sh" "$space_hub/scripts/install-control-plane.sh"
cp "$ROOT/install/bizagent-control-plane.service" "$space_hub/install/bizagent-control-plane.service"
out="$(PATH="$TMP/bin:$PATH" XDG_CONFIG_HOME="$TMP/config-space" BIZAGENT_HOST=127.0.0.1 BIZAGENT_PORT=9877 bash "$space_hub/scripts/install-control-plane.sh" --name spaced 2>&1)" \
  || fail "install-control-plane.sh failed from path with spaces: $out"
space_unit="$TMP/config-space/systemd/user/bizagent-control-plane-spaced.service"
[ -f "$space_unit" ] || fail "install-control-plane.sh did not write spaced-path unit"
grep -q 'WorkingDirectory=.*/hub\\x20with\\x20spaces' "$space_unit" \
  || fail "generated unit does not escape spaces in WorkingDirectory"
grep -q 'ExecStart=.*".*/hub with spaces/scripts/bizagent-control-plane.js"' "$space_unit" \
  || fail "generated unit does not quote spaced ExecStart script path"
grep -q ' --hub ".*/hub with spaces"' "$space_unit" \
  || fail "generated unit does not quote spaced --hub path"

echo "  ok: bizagent-watch.sh wrapper"
