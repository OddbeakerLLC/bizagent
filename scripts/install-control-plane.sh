#!/usr/bin/env bash
# Install the BizAgent Node control plane as a systemd user service.
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNITDIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TEMPLATE="$HUB/install/bizagent-control-plane.service"
PORT="${BIZAGENT_PORT:-}"
HOST="${BIZAGENT_HOST:-}"
NAME="${BIZAGENT_INSTANCE_NAME:-}"
UNINSTALL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1; shift ;;
    --host)
      [ -n "${2:-}" ] || { echo "ERROR: --host requires a value" >&2; exit 2; }
      HOST="$2"; shift 2
      ;;
    --port)
      [ -n "${2:-}" ] || { echo "ERROR: --port requires a value" >&2; exit 2; }
      PORT="$2"; shift 2
      ;;
    --name)
      [ -n "${2:-}" ] || { echo "ERROR: --name requires a value" >&2; exit 2; }
      NAME="$2"; shift 2
      ;;
    *)
      echo "usage: install-control-plane.sh [--host HOST] [--port PORT] [--name INSTANCE] [--uninstall]" >&2
      exit 2
      ;;
  esac
done

json_value() {
  python3 - "$HUB/registry.json" "$1" "$2" <<'PY'
import json
import sys

path, key, default = sys.argv[1:]
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    print(default)
    raise SystemExit

value = data
for part in key.split("."):
    if isinstance(value, dict):
        value = value.get(part)
    else:
        value = None
    if value in (None, ""):
        print(default)
        raise SystemExit
print(value)
PY
}

path_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf "%s" "$HUB" | sha256sum | awk '{print substr($1,1,8)}'
  else
    printf "%s" "$HUB" | shasum -a 256 | awk '{print substr($1,1,8)}'
  fi
}

validate_port() {
  case "$1" in
    ''|*[!0-9]*) echo "ERROR: invalid port: $1" >&2; exit 2 ;;
  esac
  if [ "$1" -lt 1 ] || [ "$1" -gt 65535 ]; then
    echo "ERROR: port must be between 1 and 65535: $1" >&2
    exit 2
  fi
}

validate_host() {
  case "$1" in
    ''|*[!A-Za-z0-9_.:-]*)
      echo "ERROR: invalid host: $1" >&2
      exit 2
      ;;
  esac
}

systemd_escape_value() {
  printf "%s" "$1" | sed -e 's/\\/\\\\/g' -e 's/%/%%/g' -e 's/ /\\x20/g'
}

systemd_escape_exec_arg() {
  printf "%s" "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g'
}

sed_replacement() {
  printf "%s" "$1" | sed -e 's/[\\&|]/\\&/g'
}

instance_name() {
  if [ -n "$NAME" ]; then
    local clean
    clean="$(printf "%s" "$NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-' | sed 's/^-//; s/-$//')"
    printf "%s" "${clean:-hub}"
    return
  fi
  local base hash
  base="$(basename "$HUB" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-' | sed 's/^-//; s/-$//')"
  hash="$(path_hash)"
  printf "%s-%s" "${base:-hub}" "$hash"
}

HOST="${HOST:-$(json_value settings.control_plane.host 127.0.0.1)}"
PORT="${PORT:-$(json_value settings.control_plane.port 8787)}"
validate_host "$HOST"
validate_port "$PORT"
INSTANCE="$(instance_name)"
SERVICE_NAME="bizagent-control-plane-${INSTANCE}.service"
SERVICE="$UNITDIR/$SERVICE_NAME"
HUB_SETTING="$(systemd_escape_value "$HUB")"
HUB_EXEC="$(systemd_escape_exec_arg "$HUB")"
HUB_SETTING_REPL="$(sed_replacement "$HUB_SETTING")"
HUB_EXEC_REPL="$(sed_replacement "$HUB_EXEC")"

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$SERVICE"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "$SERVICE_NAME uninstalled"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is required. Run install.sh or install node with your package manager." >&2
  exit 127
fi
NODE_BIN="$(command -v node)"

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: missing service template: $TEMPLATE" >&2
  exit 1
fi

NODE_REPL="$(sed_replacement "$(systemd_escape_exec_arg "$NODE_BIN")")"

mkdir -p "$UNITDIR"
sed \
  -e "s|__HUB_SETTING__|$HUB_SETTING_REPL|g" \
  -e "s|__HUB_EXEC__|$HUB_EXEC_REPL|g" \
  -e "s|__HOST__|$HOST|g" \
  -e "s|__PORT__|$PORT|g" \
  -e "s|__NODE__|$NODE_REPL|g" \
  "$TEMPLATE" > "$SERVICE"

echo "Wrote $SERVICE"
echo "Instance: $INSTANCE"
echo "Listen: http://$HOST:$PORT"
echo
echo "Enable the control plane:"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable --now $SERVICE_NAME"
echo "  loginctl enable-linger \$USER   # optional: keep running after logout"
echo
echo "Initialize login before first use:"
echo "  node scripts/bizagent-control-plane.js auth-init --username <user> --password <password>"
