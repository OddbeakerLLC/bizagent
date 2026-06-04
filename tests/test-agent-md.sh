#!/usr/bin/env bash
# test-agent-md.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A="$SCRIPT_DIR/../AGENT.md"
fail() { echo "  FAIL: $1"; exit 1; }

# § 1: Knowledge Stack interview question
grep -q "^6\. \*\*Knowledge Stack" "$A" || fail "§ 1 missing Knowledge Stack question (step 6)"
grep -q "default \`true\`"          "$A" || fail "§ 1 missing default-true note"

# § 1: subsequent steps renumbered
grep -q "^7\. \*\*Archive threshold" "$A" || fail "§ 1 step 7 should be Archive threshold (renumbered from 6)"

# § 2: Knowledge Stack setup step (gated)
grep -q "knowledge_stack.enabled == true" "$A" || fail "§ 2 missing knowledge_stack gating reference"
grep -q "templates/WEEKLY.md"             "$A" || fail "§ 2 does not reference WEEKLY.md template"
grep -q "company/"                        "$A" || fail "§ 2 does not reference company/ directory"

# § 3: Knowledge Stack subsection
grep -q "^### Knowledge Stack"            "$A" || fail "§ 3 missing Knowledge Stack subsection"
grep -q "\[Company\]"                     "$A" || fail "§ 3 does not document the [Company] journal tag"
grep -q "\[Maintenance\]"                 "$A" || fail "§ 3 does not document the [Maintenance] journal tag"
grep -q "company/news/"                   "$A" || fail "§ 3 does not document the URL-fetch landing zone"
grep -q "00-company-"                     "$A" || fail "§ 3 does not document the company file naming convention"

# § 3: hub journal format
grep -q "hub journal"                     "$A" || fail "§ 3 missing hub journal format note"

# § 4: honest limits additions
grep -q "byte-copied" "$A" || fail "§ 4 missing source-doc byte-copy note"
grep -q "PTL does not crawl" "$A" || fail "§ 4 missing 'PTL does not crawl' note"

echo "  ok: AGENT.md"
