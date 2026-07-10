#!/usr/bin/env bash
# test-nightly.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "  FAIL: $1"; exit 1; }

mkdir -p "$TMP/scripts" "$TMP/inbox" "$TMP/outbox" "$TMP/agents"
cp "$SCRIPT_DIR/../scripts/nightly.sh" "$TMP/scripts/"
cat > "$TMP/scripts/router.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/scripts/router.sh"
echo '{"settings":{"archive_after_days":30},"products":[]}' > "$TMP/registry.json"

# one stale message (40 days old), one fresh
OLD="$TMP/inbox/old.md"
NEW="$TMP/inbox/new.md"
echo "stale" > "$OLD"
echo "fresh" > "$NEW"
touch -d "40 days ago" "$OLD" 2>/dev/null \
  || touch -t "$(date -d '40 days ago' +%Y%m%d0000 2>/dev/null || echo 202001010000)" "$OLD"

bash "$TMP/scripts/nightly.sh" >/dev/null

[ -f "$TMP/inbox/archive/old.md" ] || fail "stale message not archived"
[ -f "$TMP/inbox/new.md" ]         || fail "fresh message wrongly archived"
[ ! -f "$TMP/inbox/old.md" ]       || fail "stale message left in inbox"

echo "  ok: nightly.sh"
