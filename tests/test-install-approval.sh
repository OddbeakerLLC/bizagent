#!/usr/bin/env bash
# test-install-approval.sh — formal software-install approval procedure:
# the no-self-install rule is encoded in the framework prompt/templates
# (agent.md.template limit 10, dispatch.md.template standing paragraph,
# hub-memory.js fallback standing text), and scripts/install-approval.js
# provides the default-deny allowlist check + install-audit.jsonl trail.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

command -v node >/dev/null || fail "node not available"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HUB="$TMP/hub"
mkdir -p "$HUB"

# --- 1. Rule encoded in the framework prompt/templates
grep -q "No self-authorized machine changes" "$ROOT/templates/agent.md.template" \
  || fail "agent.md.template missing the no-self-install limit"
grep -q "docs/SOFTWARE-INSTALL-APPROVAL.md" "$ROOT/templates/agent.md.template" \
  || fail "agent.md.template limit does not point at the procedure doc"
grep -q "No software installs or machine-level changes on your own" "$ROOT/templates/dispatch.md.template" \
  || fail "dispatch.md.template missing the standing no-install paragraph"
grep -q "install-allowlist.json" "$ROOT/templates/dispatch.md.template" \
  || fail "dispatch.md.template does not mention the allowlist mechanism"
grep -q "Never install packages or make machine-level changes on your own" "$ROOT/control-plane/lib/hub-memory.js" \
  || fail "hub-memory.js fallback standing text missing the no-install rule"
[ -f "$ROOT/docs/SOFTWARE-INSTALL-APPROVAL.md" ] || fail "procedure doc missing"

# --- 2. Default deny: no allowlist file -> check exits 1
node "$ROOT/scripts/install-approval.js" check --hub "$HUB" --command "apt-get install -y jq" --slug tester >/dev/null 2>&1
[ $? -eq 1 ] || fail "check must deny (exit 1) when no allowlist exists"
[ -f "$HUB/logs/install-audit.jsonl" ] || fail "denied check must append to the audit log"
grep -q '"status":"allowlist-deny"' "$HUB/logs/install-audit.jsonl" || fail "audit log missing allowlist-deny entry"

# --- 3. init creates an empty example allowlist; re-run does not clobber
node "$ROOT/scripts/install-approval.js" init --hub "$HUB" >/dev/null || fail "init failed"
[ -f "$HUB/.bizagent/install-allowlist.json" ] || fail "allowlist not created"
node -e 'const l=require(process.argv[1]);if(!Array.isArray(l.entries)||l.entries.length!==0)process.exit(1);' "$HUB/.bizagent/install-allowlist.json" || fail "example allowlist malformed"
echo '{"entries":[{"match":"git","note":"x"}]}' > "$HUB/.bizagent/install-allowlist.json"
node "$ROOT/scripts/install-approval.js" init --hub "$HUB" >/dev/null || fail "init re-run failed"
grep -q '"match":"git"' "$HUB/.bizagent/install-allowlist.json" || fail "init re-run clobbered an existing allowlist"

# --- 4. Allowlist matching: exact, first-token, prefix; non-matches denied
node "$ROOT/scripts/install-approval.js" check --hub "$HUB" --command "git status" --slug tester >/dev/null 2>&1 \
  || fail "first-token match 'git' should allow 'git status'"
node "$ROOT/scripts/install-approval.js" check --hub "$HUB" --command "git" >/dev/null 2>&1 \
  || fail "exact match 'git' should allow 'git'"
node "$ROOT/scripts/install-approval.js" check --hub "$HUB" --command "  git   commit -m x " >/dev/null 2>&1 \
  || fail "trimmed command should match prefix entry"
node "$ROOT/scripts/install-approval.js" check --hub "$HUB" --command "github-cli something" >/dev/null 2>&1 \
  && fail "prefix must not match a longer token ('github-cli' vs 'git')"
node "$ROOT/scripts/install-approval.js" check --hub "$HUB" --command "apt-get install -y jq" >/dev/null 2>&1 \
  && fail "non-listed command must be denied"
node "$ROOT/scripts/install-approval.js" check --hub "$HUB" --command "" >/dev/null 2>&1 \
  && fail "empty command must be denied"

# --- 5. log subcommand: statuses validated, JSONL appended
node "$ROOT/scripts/install-approval.js" log --hub "$HUB" --status requested --command "apt-get install -y jq" --slug tester --note "parse CI JSON" >/dev/null || fail "log requested failed"
node "$ROOT/scripts/install-approval.js" log --hub "$HUB" --status installed --command "apt-get install -y jq" --slug hub --by hub >/dev/null || fail "log installed failed"
node "$ROOT/scripts/install-approval.js" log --hub "$HUB" --status bogus --command x >/dev/null 2>&1 \
  && fail "bogus status must be rejected"
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n");
const parsed = lines.map((l) => JSON.parse(l)); // throws on malformed lines
const req = parsed.find((e) => e.status === "requested");
const inst = parsed.find((e) => e.status === "installed");
if (!req || req.command !== "apt-get install -y jq" || req.slug !== "tester" || req.note !== "parse CI JSON") process.exit(1);
if (!inst || inst.by !== "hub") process.exit(1);
if (!req.ts || !/^\d{4}-\d{2}-\d{2}T/.test(req.ts)) process.exit(1);
' "$HUB/logs/install-audit.jsonl" || fail "audit log entries malformed"

# --- 6. show: readable allowlist prints; missing file exits 1
node "$ROOT/scripts/install-approval.js" show --hub "$HUB" | grep -q '"match": "git"' || fail "show must print the allowlist"
node "$ROOT/scripts/install-approval.js" show --hub "$TMP/no-hub" >/dev/null 2>&1 && fail "show must fail without an allowlist"

echo "test-install-approval: PASS"
