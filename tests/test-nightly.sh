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

# push subcommand exists and is safe with no git remotes
grep -q 'push' "$SCRIPT_DIR/../scripts/nightly.sh" \
  || fail "nightly.sh missing push subcommand for hub/project backup"
out="$(bash "$TMP/scripts/nightly.sh" push 2>&1 || true)"
echo "$out" | grep -qi 'commit + push\|nightly: commit' \
  || fail "nightly.sh push did not run commit+push path: $out"

# detach helper present and documents private hub remote
[ -x "$SCRIPT_DIR/../scripts/detach-framework-remote.sh" ] \
  || fail "detach-framework-remote.sh missing or not executable"
grep -q 'private' "$SCRIPT_DIR/../scripts/detach-framework-remote.sh" \
  || fail "detach script missing private remote advice"
grep -q 'nightly.sh push' "$SCRIPT_DIR/../templates/NIGHTLY.md" \
  || fail "NIGHTLY.md template missing nightly.sh push step"
grep -q 'detach-framework-remote' "$SCRIPT_DIR/../install.sh" \
  || fail "install.sh does not call detach-framework-remote"

echo "  ok: nightly.sh"
