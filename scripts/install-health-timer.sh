#!/usr/bin/env bash
# install-health-timer.sh — install the out-of-process health watchdog.
#
# Prefers a systemd **user** timer (every 2 min) with OnFailure= wired to
# scripts/health-alert-failure.sh; falls back to a cron line when systemd
# user units are unavailable (containers, WSL1, …).
#
# Usage: scripts/install-health-timer.sh [hub-path]
# Env:
#   BIZAGENT_HEALTH_WEBHOOK   optional out-of-band webhook (fires via OnFailure)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB="${1:-$ROOT}"
SERVICE_NAME="bizagent-health"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

chmod +x "$ROOT/scripts/health-probe.sh" "$ROOT/scripts/health-alert-failure.sh" 2>/dev/null || true

install_systemd() {
  mkdir -p "$UNIT_DIR"

  cat > "$UNIT_DIR/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=BizAgent out-of-process health probe (disk, RAM, heartbeat)
OnFailure=${SERVICE_NAME}-alert.service

[Service]
Type=oneshot
WorkingDirectory=$HUB
Environment=BIZAGENT_HUB=$HUB
Environment=BIZAGENT_HEALTH_WEBHOOK=${BIZAGENT_HEALTH_WEBHOOK:-}
ExecStart=$ROOT/scripts/health-probe.sh $HUB
EOF

  cat > "$UNIT_DIR/${SERVICE_NAME}-alert.service" <<EOF
[Unit]
Description=BizAgent health alert (fires when the probe fails)

[Service]
Type=oneshot
Environment=BIZAGENT_HUB=$HUB
Environment=BIZAGENT_HEALTH_WEBHOOK=${BIZAGENT_HEALTH_WEBHOOK:-}
ExecStart=$ROOT/scripts/health-alert-failure.sh %i
EOF

  cat > "$UNIT_DIR/${SERVICE_NAME}.timer" <<EOF
[Unit]
Description=Run BizAgent health probe every 2 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
Unit=${SERVICE_NAME}.service

[Install]
WantedBy=timers.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE_NAME}.timer"
  echo "installed: systemd user timer ${SERVICE_NAME}.timer (every 2 min, OnFailure=${SERVICE_NAME}-alert.service)"
  echo "check:     systemctl --user list-timers | grep ${SERVICE_NAME}"
  echo "logs:      journalctl --user -u ${SERVICE_NAME}.service -n 20"
}

install_cron() {
  CRON_LINE="*/2 * * * * $ROOT/scripts/health-probe.sh $HUB >> $HUB/logs/health-probe.cron.log 2>&1"
  if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
    install_systemd
    return
  fi
  ( crontab -l 2>/dev/null | grep -vF "$ROOT/scripts/health-probe.sh" || true
    echo "$CRON_LINE" ) | crontab -
  echo "installed: cron entry (every 2 min) — systemd user session unavailable"
  echo "logs:      $HUB/logs/health-probe.cron.log"
}

install_cron
