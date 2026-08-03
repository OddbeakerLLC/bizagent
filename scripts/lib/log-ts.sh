# log-ts.sh — shared ISO-8601 UTC timestamps for shell log lines.
# shellcheck shell=bash
# Source from scripts/:  . "$HUB/scripts/lib/log-ts.sh"

bizagent_ts() {
  date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ
}

# Prefix each stdin line with a timestamp; write to stdout.
bizagent_ts_prefix() {
  local line
  while IFS= read -r line || [[ -n "${line:-}" ]]; do
    printf '%s %s\n' "$(bizagent_ts)" "$line"
  done
}
