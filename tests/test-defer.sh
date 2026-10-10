#!/usr/bin/env bash
# test-defer.sh — deferred wake schedule / once-key / cancel / fire (no long sleep)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -x "$ROOT/scripts/defer.sh" ] || fail "scripts/defer.sh missing or not executable"
[ -x "$ROOT/scripts/lib/defer-fire.sh" ] || fail "scripts/lib/defer-fire.sh missing or not executable"
grep -q 'Deferred wake' "$ROOT/templates/agent.md.template" \
  || fail "agent.md.template missing Deferred wake section"
grep -q 'kind: defer-wake' "$ROOT/templates/dispatch.md.template" \
  || fail "dispatch.md.template missing defer-wake blurb"
grep -q 'Deferred wake' "$ROOT/control-plane/lib/hub-memory.js" \
  || fail "hub-memory.js missing Deferred wake blurb"
grep -q 'defer.sh' "$ROOT/scripts/hub-daemon.js" \
  || fail "hub-daemon.js missing defer reconcile"
grep -q 'reconciling deferred wakes' "$ROOT/scripts/nightly.sh" \
  || fail "nightly.sh missing defer reconcile"
grep -q 'Always refresh from template' "$ROOT/control-plane/lib/dispatcher.js" \
  || fail "dispatcher.js does not always refresh .dispatch.md"
[ -f "$ROOT/docs/DEFERRED-WAKE.md" ] || fail "docs/DEFERRED-WAKE.md missing"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/agents/alpha/inbox" "$TMP/agents/alpha/outbox" "$TMP/logs" "$TMP/scripts/lib"
cp "$ROOT/scripts/defer.sh" "$TMP/scripts/"
cp "$ROOT/scripts/lib/defer-fire.sh" "$TMP/scripts/lib/"
cp "$ROOT/scripts/lib/log-ts.sh" "$TMP/scripts/lib/"
chmod +x "$TMP/scripts/defer.sh" "$TMP/scripts/lib/defer-fire.sh"

cat > "$TMP/registry.json" <<'JSON'
{
  "settings": {},
  "products": [
    { "slug": "alpha", "name": "Alpha", "agent_name": "Agent A", "projects": [] }
  ]
}
JSON

# Min delay is 60s — schedule, list, once-key replace, cancel, force-fire via defer-fire
out="$(bash "$TMP/scripts/defer.sh" --hub "$TMP" \
  --to alpha --from alpha --in 2m \
  --once-key "alpha:test-poll" \
  --subject "wake: test" \
  --body "## Deferred wake
check test job" 2>&1)" || fail "schedule failed: $out"
echo "$out" | grep -q 'scheduled id=' || fail "schedule output missing id: $out"
ID="$(echo "$out" | sed -n 's/.*scheduled id=\([^ ]*\).*/\1/p')"
[ -n "$ID" ] || fail "could not parse defer id from: $out"
[ -f "$TMP/.bizagent/defer/pending/${ID}.json" ] || fail "pending json missing"
[ -f "$TMP/.bizagent/defer/pending/${ID}.body.md" ] || fail "pending body missing"

list="$(bash "$TMP/scripts/defer.sh" --hub "$TMP" --list --to alpha 2>&1)" || fail "list failed"
echo "$list" | grep -q "$ID" || fail "list missing id: $list"

# once-key replace
out2="$(bash "$TMP/scripts/defer.sh" --hub "$TMP" \
  --to alpha --from alpha --in 3m \
  --once-key "alpha:test-poll" \
  --subject "wake: test2" \
  --body "replaced body" 2>&1)" || fail "reschedule failed: $out2"
ID2="$(echo "$out2" | sed -n 's/.*scheduled id=\([^ ]*\).*/\1/p')"
[ -n "$ID2" ] || fail "could not parse second id"
# old pending should be gone (replaced/cancelled)
if [ "$ID" != "$ID2" ]; then
  [ ! -f "$TMP/.bizagent/defer/pending/${ID}.json" ] \
    || fail "old pending still present after once-key replace"
fi
[ -f "$TMP/.bizagent/defer/pending/${ID2}.json" ] || fail "new pending missing"

# cancel
bash "$TMP/scripts/defer.sh" --hub "$TMP" --cancel "$ID2" >/dev/null 2>&1 \
  || fail "cancel failed"
[ ! -f "$TMP/.bizagent/defer/pending/${ID2}.json" ] || fail "pending remains after cancel"

# Fresh schedule + direct fire (bypass timer)
out3="$(bash "$TMP/scripts/defer.sh" --hub "$TMP" \
  --to alpha --from alpha --in 5m \
  --subject "wake: fire-now" \
  --body "deliver me" 2>&1)" || fail "schedule3 failed: $out3"
ID3="$(echo "$out3" | sed -n 's/.*scheduled id=\([^ ]*\).*/\1/p')"
bash "$TMP/scripts/lib/defer-fire.sh" "$ID3" --hub "$TMP" >/dev/null 2>&1 \
  || fail "defer-fire failed"
# inbox should have a defer-wake mail
found=0
for f in "$TMP/agents/alpha/inbox"/*.md; do
  [ -f "$f" ] || continue
  if grep -q 'kind: defer-wake' "$f" && grep -q 'deliver me' "$f"; then
    found=1
    break
  fi
done
[ "$found" -eq 1 ] || fail "no defer-wake mail delivered to alpha inbox"
[ ! -f "$TMP/.bizagent/defer/pending/${ID3}.json" ] || fail "pending remains after fire"

# unknown recipient rejected
if bash "$TMP/scripts/defer.sh" --hub "$TMP" \
  --to nope --from alpha --in 2m --subject x --body y >/dev/null 2>&1; then
  fail "unknown --to should fail"
fi

# cross-agent disallowed
if bash "$TMP/scripts/defer.sh" --hub "$TMP" \
  --to hub --from alpha --in 2m --subject x --body y >/dev/null 2>&1; then
  : # hub target from product is allowed
else
  fail "product→hub should be allowed"
fi
# add beta and try alpha→beta
python3 -c "import json,pathlib,sys; p=pathlib.Path(sys.argv[1]); reg=json.loads(p.read_text()); reg['products'].append({'slug':'beta','name':'Beta','agent_name':'B','projects':[]}); p.write_text(json.dumps(reg))" "$TMP/registry.json"
if bash "$TMP/scripts/defer.sh" --hub "$TMP" \
  --to beta --from alpha --in 2m --subject x --body y >/dev/null 2>&1; then
  fail "cross-product defer should be rejected"
fi

echo "  ok: defer.sh"
