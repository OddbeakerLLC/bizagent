#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }
[ -x "$ROOT/scripts/check-hub-ready.sh" ] || fail "check-hub-ready.sh missing"
# Live hub should pass if this is a dogfood install with keys
if [ -f "$ROOT/registry.json" ] && [ -f "$ROOT/.bizagent/env" ]; then
  bash "$ROOT/scripts/check-hub-ready.sh" "$ROOT" || fail "check-hub-ready failed on dogfood hub"
fi
# Synthetic: empty hub fails
TMP=$(mktemp -d)
trap 'rm -rf "$TMP" "$TMP2"' EXIT
mkdir -p "$TMP"
out="$(bash "$ROOT/scripts/check-hub-ready.sh" "$TMP" 2>/dev/null || true)"
if bash "$ROOT/scripts/check-hub-ready.sh" "$TMP" >/dev/null 2>&1; then
  fail "expected failure on empty hub"
fi
# Unconfigured llmapi must NOT be a first-class failure line (agents call
# providers directly when BIZAGENT_LLMAPI_URL is absent).
if printf '%s' "$out" | grep -q "llmapi not reachable"; then
  fail "unconfigured llmapi should not hard-fail the check"
fi

# llmapi readiness: configured + dead port must be reported as a first-class
# failure with the log path (fresh-install regression: dead llmapi looked
# like a healthy install).
TMP2=""
TMP2=$(mktemp -d)
mkdir -p "$TMP2/.bizagent"
printf 'BIZAGENT_LLMAPI_URL=http://127.0.0.1:18798\n' > "$TMP2/.bizagent/env"
out="$(bash "$ROOT/scripts/check-hub-ready.sh" "$TMP2" 2>/dev/null || true)"
printf '%s' "$out" | grep -q "llmapi not reachable at http://127.0.0.1:18798" \
  || fail "configured dead llmapi not reported: $out"
printf '%s' "$out" | grep -q "logs/llmapi.log" \
  || fail "llmapi failure missing log path: $out"

# configured + live /health -> reported reachable
cat > "$TMP2/healthsrv.js" <<'EOF'
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}).listen(18798, '127.0.0.1', () => console.log('up'));
EOF
node "$TMP2/healthsrv.js" & HSRV=$!
trap 'kill $HSRV 2>/dev/null; rm -rf "$TMP" "$TMP2"' EXIT
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:18798/health >/dev/null 2>&1 && break
  sleep 0.1
done
out="$(bash "$ROOT/scripts/check-hub-ready.sh" "$TMP2" 2>/dev/null || true)"
printf '%s' "$out" | grep -q "llmapi reachable at http://127.0.0.1:18798" \
  || fail "live llmapi not reported reachable: $out"

echo "  ok: hub-ready"
