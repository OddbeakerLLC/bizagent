#!/usr/bin/env bash
# install-dispatch.sh
#
# Wire up the event-driven dispatcher to run on a short interval. This is a
# DELIBERATE, MANUAL step — bizagent never enables it for you. Run it once, by
# hand, after you've reviewed scripts/bizagent-dispatch.sh.
#
# Usage:
#   scripts/install-dispatch.sh cron      [interval_minutes]   # default 2
#   scripts/install-dispatch.sh systemd   [interval_minutes]   # user timer, default 2
#   scripts/install-dispatch.sh print     [interval_minutes]   # just show the line(s)
#
# Bootstrapping note: the very first run must be a manual kick, because nothing
# is dispatching yet:
#   bash scripts/bizagent-dispatch.sh
# After the cron/timer is installed, every subsequent tick is automatic.
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-print}"
INTERVAL="${2:-2}"

case "$INTERVAL" in (*[!0-9]*|'') echo "interval must be a whole number of minutes" >&2; exit 2;; esac

DISPATCH="$HUB/scripts/bizagent-dispatch.sh"
CRON_LINE="*/$INTERVAL * * * * cd $HUB && bash scripts/bizagent-dispatch.sh >> logs/dispatch.log 2>&1"

print_cron() {
  echo "# bizagent dispatcher — every $INTERVAL min"
  echo "$CRON_LINE"
}

install_cron() {
  echo "About to add this line to your crontab:"
  echo
  print_cron
  echo
  printf "Proceed? [y/N] "
  read -r ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted. Nothing changed."; exit 0;;
  esac
  local existing
  existing="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "$existing" | grep -Fq "bizagent-dispatch.sh"; then
    echo "A bizagent-dispatch cron line already exists; leaving it untouched."
    echo "Edit it with: crontab -e"
    exit 0
  fi
  { printf '%s\n' "$existing"; print_cron; } | crontab -
  echo "Installed. Verify with: crontab -l"
  echo "Remember the first manual kick if you haven't run one:"
  echo "  bash scripts/bizagent-dispatch.sh"
}

install_systemd() {
  local unitdir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unitdir"
  cat > "$unitdir/bizagent-dispatch.service" <<EOF
[Unit]
Description=bizagent event-driven agent dispatcher (one tick)

[Service]
Type=oneshot
WorkingDirectory=$HUB
ExecStart=/usr/bin/env bash $DISPATCH
EOF
  cat > "$unitdir/bizagent-dispatch.timer" <<EOF
[Unit]
Description=Run bizagent dispatcher every $INTERVAL min

[Timer]
OnBootSec=1min
OnUnitActiveSec=${INTERVAL}min
AccuracySec=15s
Persistent=true

[Install]
WantedBy=timers.target
EOF
  echo "Wrote:"
  echo "  $unitdir/bizagent-dispatch.service"
  echo "  $unitdir/bizagent-dispatch.timer"
  echo
  echo "Enable it yourself (deliberate step):"
  echo "  systemctl --user daemon-reload"
  echo "  systemctl --user enable --now bizagent-dispatch.timer"
  echo "  loginctl enable-linger \$USER   # keep it running when logged out"
  echo
  echo "First manual kick (bootstrapping):"
  echo "  bash scripts/bizagent-dispatch.sh"
}

case "$MODE" in
  cron)    install_cron ;;
  systemd) install_systemd ;;
  print)   print_cron ;;
  *) echo "usage: $0 {cron|systemd|print} [interval_minutes]" >&2; exit 2 ;;
esac
