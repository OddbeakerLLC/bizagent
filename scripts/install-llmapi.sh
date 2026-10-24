#!/usr/bin/env bash
# Install the BizAgent llmapi (LLM provider REST API) as a systemd user service.
# Mirrors install-control-plane.sh; the port comes from LLMAPI_PORT (env or
# .bizagent/env) and defaults to 8788 (8787 is the control plane's default).
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNITDIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TEMPLATE="$HUB/install/bizagent-llmapi.service"
NAME="${BIZAGENT_INSTANCE_NAME:-}"
UNINSTALL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1; shift ;;
    --name)
      [ -n "${2:-}" ] || { echo "ERROR: --name requires a value" >&2; exit 2; }
      NAME="$2"; shift 2
      ;;
    *)
      echo "usage: install-llmapi.sh [--name INSTANCE] [--uninstall]" >&2
      exit 2
      ;;
  esac
done

path_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf "%s" "$HUB" | sha256sum | awk '{print substr($1,1,8)}'
  else
    printf "%s" "$HUB" | shasum -a 256 | awk '{print substr($1,1,8)}'
  fi
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

if [ "$UNINSTALL" -eq 1 ]; then
  SERVICE_NAME="bizagent-llmapi-$(instance_name).service"
  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNITDIR/$SERVICE_NAME"
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
if [ ! -f "$HUB/llmapi.js" ]; then
  echo "ERROR: missing $HUB/llmapi.js" >&2
  exit 1
fi

INSTANCE="$(instance_name)"
SERVICE_NAME="bizagent-llmapi-${INSTANCE}.service"
SERVICE="$UNITDIR/$SERVICE_NAME"
HUB_SETTING="$(systemd_escape_value "$HUB")"
HUB_EXEC="$(systemd_escape_exec_arg "$HUB")"
HUB_SETTING_REPL="$(sed_replacement "$HUB_SETTING")"
HUB_EXEC_REPL="$(sed_replacement "$HUB_EXEC")"
NODE_REPL="$(sed_replacement "$(systemd_escape_exec_arg "$NODE_BIN")")"

mkdir -p "$UNITDIR"
sed \
  -e "s|__HUB_SETTING__|$HUB_SETTING_REPL|g" \
  -e "s|__HUB_EXEC__|$HUB_EXEC_REPL|g" \
  -e "s|__NODE__|$NODE_REPL|g" \
  "$TEMPLATE" > "$SERVICE"

PORT="${LLMAPI_PORT:-8788}"
echo "Wrote $SERVICE"
echo "Instance: $INSTANCE"
echo "Listen: http://127.0.0.1:$PORT (LLMAPI_PORT in .bizagent/env overrides)"
echo
echo "Enable llmapi:"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable --now $SERVICE_NAME"
echo "  loginctl enable-linger \$USER   # optional: keep running after logout"
