#!/usr/bin/env bash
# health-alert-failure.sh — systemd OnFailure= hook for the health timer.
#
# Fires when bizagent-health.service fails (probe exit 1/2/3), i.e. the hub is
# critical/emergency or the watchdog itself is broken. Works even when port
# 8787 is down: it only writes local files and (optionally) posts a webhook.
#
# Webhook (optional): BIZAGENT_HEALTH_WEBHOOK — receives JSON
#   { "text": "..." } (Slack-style) plus full probe fields.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB="${BIZAGENT_HUB:-$ROOT}"

LEVEL="${1:-unknown}"
DETAIL="${2:-}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$HUB/logs" "$HUB/.bizagent"

# Local last-resort alert file (Library can show it). Never appended — overwritten.
cat > "$HUB/HEALTH-ALERT.md" <<EOF
# HEALTH-ALERT — ${LEVEL^^}

\`$TS\` — the out-of-process health probe FAILED (systemd OnFailure).

- Level: $LEVEL
- Detail: ${DETAIL:-see logs/health.json and journalctl --user -u bizagent-health.service}

The control plane may be down or the hub volume is in the critical/emergency
zone. This file is replaced when the next health check is green.
EOF

# Optional out-of-band webhook (email gateways, Slack, ntfy, …).
if [ -n "${BIZAGENT_HEALTH_WEBHOOK:-}" ]; then
  curl -fsS -m 10 -X POST "$BIZAGENT_HEALTH_WEBHOOK" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"BizAgent health $LEVEL on $HOSTNAME at $TS: ${DETAIL:-probe failed}\",\"level\":\"$LEVEL\",\"host\":\"$HOSTNAME\",\"ts\":\"$TS\"}" \
    >/dev/null 2>&1 || true
fi

exit 0
