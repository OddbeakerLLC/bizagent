#!/usr/bin/env bash
# test-weekly.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "  FAIL: $1"; exit 1; }

mkdir -p "$TMP/scripts" "$TMP/knowledge-stack"
cp "$SCRIPT_DIR/../scripts/weekly.sh" "$TMP/scripts/"
cd "$TMP"

# --- case 1: disabled --> exits 0 with disabled message ---
cat > registry.json <<'EOF'
{"knowledge_stack": {"enabled": false}, "products": []}
EOF
out="$(bash scripts/weekly.sh 2>&1)" || fail "disabled case: non-zero exit"
echo "$out" | grep -q "disabled" || fail "disabled case: no disabled message"

# --- case 2: enabled, no orphans (and multi-word slug like 'jobe-ai') ---
cat > registry.json <<'EOF'
{"knowledge_stack": {"enabled": true}, "products": [{"slug": "widgets"}, {"slug": "jobe-ai"}]}
EOF
touch knowledge-stack/widgets-overview.md
touch knowledge-stack/jobe-ai-overview.md
touch knowledge-stack/jobe-ai-api-spec.md
touch knowledge-stack/00-company-mission.md
touch knowledge-stack/MANIFEST.md
bash scripts/weekly.sh >/dev/null 2>&1 || fail "enabled case: non-zero exit"
[ -f knowledge-stack/widgets-overview.md ]    || fail "widgets-overview wrongly removed"
[ -f knowledge-stack/jobe-ai-overview.md ]    || fail "jobe-ai-overview wrongly removed (multi-word slug)"
[ -f knowledge-stack/jobe-ai-api-spec.md ]    || fail "jobe-ai-api-spec wrongly removed"
[ -f knowledge-stack/00-company-mission.md ]  || fail "company file wrongly removed"
[ -f knowledge-stack/MANIFEST.md ]            || fail "MANIFEST wrongly removed"

# --- case 3: orphan removal ---
touch knowledge-stack/tooling-overview.md  # slug 'tooling' not in registry
out="$(bash scripts/weekly.sh 2>&1)"
[ ! -f knowledge-stack/tooling-overview.md ] || fail "orphan file not removed"
echo "$out" | grep -q "tooling-overview.md"  || fail "no orphan removal log"

# --- case 4: knowledge-stack/ missing --> exits 0 with note ---
rm -rf knowledge-stack
out="$(bash scripts/weekly.sh 2>&1)" || fail "missing-dir case: non-zero exit"
echo "$out" | grep -q "missing"  || fail "missing-dir case: no missing note"

echo "  ok: weekly.sh"
