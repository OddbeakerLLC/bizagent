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

# --- staleness guard: push must never commit/push a stale or diverged tree --
command -v git >/dev/null 2>&1 || { echo "  ok: nightly.sh (no git — skipping staleness guard tests)"; exit 0; }
REMOTE="$TMP/remote.git"
WORK="$TMP/work"
OTHER="$TMP/other"
git init --bare -q "$REMOTE"
git init -q "$WORK"
git -C "$WORK" config user.email t@t
git -C "$WORK" config user.name t
echo base > "$WORK/fix.txt"
git -C "$WORK" add -A
git -C "$WORK" commit -qm base
git -C "$WORK" branch -M main
git -C "$WORK" remote add origin "$REMOTE"
git -C "$WORK" push -q -u origin main
git -C "$REMOTE" symbolic-ref HEAD refs/heads/main
git clone -q "$REMOTE" "$OTHER"
git -C "$OTHER" config user.email t@t
git -C "$OTHER" config user.name t

# registry points the nightly at the work repo
echo "{\"settings\":{\"archive_after_days\":30},\"products\":[{\"projects\":[{\"path\":\"$WORK\"}]}]}" > "$TMP/registry.json"

# 1) same-day fix lands on the remote DURING the nightly pass (router stub
#    simulates it between the step-0 pull and the push step): the push step must
#    fetch, fast-forward, and never revert the fix.
cat > "$TMP/scripts/router.sh" <<EOF
#!/usr/bin/env bash
echo fixed > "$OTHER/fix.txt"
git -C "$OTHER" add -A
git -C "$OTHER" commit -qm "same-day fix from another machine"
git -C "$OTHER" push -q origin main
exit 0
EOF
chmod +x "$TMP/scripts/router.sh"
echo churn > "$WORK/churn.txt"
out="$(bash "$TMP/scripts/nightly.sh" push 2>&1 || true)"
echo "$out" | grep -q 'fast-forwarding before commit' \
  || fail "push step did not fast-forward a tree that went stale mid-run: $out"
[ "$(git -C "$REMOTE" show main:fix.txt)" = "fixed" ] \
  || fail "nightly push reverted the same-day fix (remote fix.txt no longer 'fixed')"
git -C "$REMOTE" log --oneline main | grep -q 'nightly:' \
  || fail "nightly commit missing on top of the fast-forwarded fix: $out"

# 2) diverged repo (local unpushed commit + newer remote head): refuse loudly,
#    push nothing, never force. (No-op router stub — nothing lands mid-run.)
cat > "$TMP/scripts/router.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/scripts/router.sh"
git -C "$WORK" reset -q --hard origin/main 2>/dev/null || true
echo local > "$WORK/fix.txt"
git -C "$WORK" add -A
git -C "$WORK" commit -qm "local work"
echo newer > "$OTHER/fix.txt"
git -C "$OTHER" pull -q origin main 2>/dev/null || true
git -C "$OTHER" add -A
git -C "$OTHER" commit -qm "newer remote work"
git -C "$OTHER" push -q origin main
remote_head="$(git -C "$REMOTE" rev-parse main)"
out="$(bash "$TMP/scripts/nightly.sh" push 2>&1 || true)"
echo "$out" | grep -q 'DIVERGED' \
  || fail "push step did not refuse a diverged repo: $out"
[ "$(git -C "$REMOTE" rev-parse main)" = "$remote_head" ] \
  || fail "diverged repo was pushed anyway (remote head moved)"
git -C "$REMOTE" show main:fix.txt | grep -q newer \
  || fail "diverged push overwrote newer remote content"

# 3) guard wiring present in the script (static)
grep -q 'sync_with_remote' "$SCRIPT_DIR/../scripts/nightly.sh" \
  || fail "nightly.sh missing sync_with_remote staleness guard"
grep -q 'rev-list --count "HEAD..\$up"' "$SCRIPT_DIR/../scripts/nightly.sh" \
  || fail "nightly.sh guard missing behind check"
grep -q -- '--ff-only "$up"' "$SCRIPT_DIR/../scripts/nightly.sh" \
  || fail "nightly.sh guard missing fast-forward before commit"
grep -q 'NOT force-pushing' "$SCRIPT_DIR/../scripts/nightly.sh" \
  || fail "nightly.sh push rejection not loud / may force-push"

echo "  ok: nightly.sh"
