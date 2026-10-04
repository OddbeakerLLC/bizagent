#!/usr/bin/env bash
# health-probe.sh — out-of-process hub health probe (survival instinct layer 2).
# Thin wrapper so systemd/cron never need to know where Node lives.
# Exit codes: 0 ok/warn, 1 critical, 2 emergency, 3 probe failure.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB="${1:-$ROOT}"
exec node "$ROOT/control-plane/lib/health-probe.js" "$HUB"
