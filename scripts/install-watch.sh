#!/usr/bin/env bash
# install-watch.sh — install bizagent-watch.sh as a systemd service
#
# Usage:
#   scripts/install-watch.sh                # install + enable
#   scripts/install-watch.sh --uninstall    # disable + remove
#
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="bizagent-watch"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
TEMPLATE_FILE="$HUB/install/bizagent-watch.service"

UNINSTALL=0
if [ "${1:-}" = "--uninstall" ]; then
  UNINSTALL=1
fi

# --- uninstall ---
if [ "$UNINSTALL" = "1" ]; then
  echo "Disabling and removing $SERVICE_NAME..."
  sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  sudo rm -f "$SERVICE_FILE"
  sudo systemctl daemon-reload
  echo "$SERVICE_NAME uninstalled."
  exit 0
fi

# --- install ---
echo "Installing $SERVICE_NAME event-driven dispatcher..."

if [ ! -f "$TEMPLATE_FILE" ]; then
  echo "ERROR: template file not found: $TEMPLATE_FILE"
  exit 1
fi

if ! command -v inotifywait >/dev/null 2>&1; then
  echo "ERROR: inotifywait not found. Install inotify-tools:"
  echo "  Ubuntu/Debian: sudo apt install inotify-tools"
  echo "  CentOS/RHEL:   sudo yum install inotify-tools"
  exit 1
fi

# Substitute the hub path into the service template
echo "Writing $SERVICE_FILE..."
sudo bash -c "cat '$TEMPLATE_FILE' | sed 's|__HUB_PATH__|$HUB|g' > '$SERVICE_FILE'"

# Reload systemd and enable the service
echo "Reloading systemd..."
sudo systemctl daemon-reload

echo "Enabling $SERVICE_NAME..."
sudo systemctl enable "$SERVICE_NAME"

echo "Starting $SERVICE_NAME..."
sudo systemctl start "$SERVICE_NAME"

echo "Checking status..."
sudo systemctl status "$SERVICE_NAME" --no-pager || true

echo ""
echo "✓ $SERVICE_NAME installed and started."
echo ""
echo "To view logs:     sudo journalctl -u $SERVICE_NAME -f"
echo "To stop:          sudo systemctl stop $SERVICE_NAME"
echo "To disable:       sudo systemctl disable $SERVICE_NAME"
echo "To uninstall:     scripts/install-watch.sh --uninstall"
