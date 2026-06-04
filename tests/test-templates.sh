#!/usr/bin/env bash
# test-templates.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$SCRIPT_DIR/../templates"
fail() { echo "  FAIL: $1"; exit 1; }

# WEEKLY.md exists and covers required steps
[ -f "$T/WEEKLY.md" ] || fail "templates/WEEKLY.md missing"
grep -q "scripts/weekly.sh"  "$T/WEEKLY.md" || fail "WEEKLY.md does not invoke scripts/weekly.sh"
grep -q "MANIFEST.md"        "$T/WEEKLY.md" || fail "WEEKLY.md does not mention MANIFEST.md"
grep -q "company/"           "$T/WEEKLY.md" || fail "WEEKLY.md does not reference company/"
grep -q "no update"          "$T/WEEKLY.md" || fail "WEEKLY.md does not handle 'no update'"
grep -q "\[Maintenance\]"    "$T/WEEKLY.md" || fail "WEEKLY.md does not write a [Maintenance] journal entry"

# agent.md.template has a Knowledge Stack contribution section
grep -q "Knowledge Stack contribution" "$T/agent.md.template" \
  || fail "agent.md.template missing Knowledge Stack contribution section"

echo "  ok: templates"
