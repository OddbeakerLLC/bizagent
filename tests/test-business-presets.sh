#!/usr/bin/env bash
# test-business-presets.sh — business-type presets (onboarding defaults)
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
BP="$ROOT/scripts/business-preset.sh"
PRESETS="$ROOT/templates/business-presets.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "  FAIL: $1"; exit 1; }
pass() { echo "  ok: $1"; }

# 1. preset map is valid JSON with required keys
python3 - "$PRESETS" <<'PY' || fail "preset map invalid"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("version") == 1
for slug, p in d["presets"].items():
    assert p["label"], slug
    df = p["defaults"]
    assert isinstance(df.get("agent_roles"), list), slug
    assert isinstance(df.get("approval_gates"), list), slug
    assert isinstance(df.get("features_off"), list), slug
assert "software-developer" in d["presets"]
assert "generic" in d["presets"]
PY
pass "preset map valid JSON with required keys"

# 2. list works
"$BP" list | grep -q "software-developer" || fail "list missing software-developer"
pass "list"

# 3. show works
"$BP" show software-developer | grep -q "code_review" || fail "show missing code_review"
"$BP" show nosuch >/dev/null 2>&1 && fail "show unknown slug should fail"
pass "show"

# 4. match: alias, label, slug, fallback
[ "$("$BP" match "saas")" = "software-developer" ] || fail "match alias"
[ "$("$BP" match "Software developer")" = "software-developer" ] || fail "match label"
[ "$("$BP" match "law")" = "law" ] || fail "match slug"
[ "$("$BP" match "underwater basket weaver")" = "other" ] || fail "match fallback"
pass "match"

# 5. section: empty when no registry / no business_type
[ -z "$("$BP" section 2>/dev/null)" ] || fail "section should be empty without registry"
pass "section empty without registry"

# 6. section: renders gates for a configured hub
mkdir -p "$TMP/hub"
python3 - "$TMP/hub" <<'PY'
import json, sys, os
hub = sys.argv[1]
reg = {"org": "T", "products": [], "settings": {"business_type": {
    "slug": "software-developer", "label": "Software developer", "custom": False,
    "applied_at": "2026-10-25T00:00:00Z",
    "defaults": {"agent_roles": ["implementer", "reviewer"],
                 "approval_gates": ["code_review"],
                 "features_off": ["client_messaging"]},
    "overrides": {}}}}
json.dump(reg, open(os.path.join(hub, "registry.json"), "w"))
PY
out="$(cd "$TMP/hub" && "$BP" section)"
echo "$out" | grep -q "## Business-type defaults" || fail "section missing heading"
echo "$out" | grep -q "code_review" || fail "section missing code_review gate"
echo "$out" | grep -q "review pass" || fail "section missing gate text"
echo "$out" | grep -q "client_messaging" || fail "section missing features_off"
pass "section renders software-developer gates"

# 7. section: document_review for law
python3 - "$TMP/hub" <<'PY'
import json, sys, os
hub = sys.argv[1]
reg = json.load(open(os.path.join(hub, "registry.json")))
reg["settings"]["business_type"]["slug"] = "law"
reg["settings"]["business_type"]["label"] = "Lawyer / law firm"
reg["settings"]["business_type"]["defaults"] = {
    "agent_roles": ["drafter", "reviewer"],
    "approval_gates": ["document_review"],
    "features_off": ["client_messaging", "auto_publish"]}
json.dump(reg, open(os.path.join(hub, "registry.json"), "w"))
PY
out="$(cd "$TMP/hub" && "$BP" section)"
echo "$out" | grep -q "document_review" || fail "section missing document_review"
echo "$out" | grep -q "never.*filed or sent without" || fail "section missing document gate text"
pass "section renders law document_review gate"

# 8. section: custom "other" with no defaults -> empty
python3 - "$TMP/hub" <<'PY'
import json, sys, os
hub = sys.argv[1]
reg = json.load(open(os.path.join(hub, "registry.json")))
reg["settings"]["business_type"] = {"slug": "other", "label": "Beekeeper",
                                    "custom": True, "applied_at": "2026-10-25T00:00:00Z",
                                    "defaults": {"agent_roles": [], "approval_gates": [],
                                                 "features_off": []}, "overrides": {}}
json.dump(reg, open(os.path.join(hub, "registry.json"), "w"))
PY
[ -z "$(cd "$TMP/hub" && "$BP" section)" ] || fail "section should be empty for empty defaults"
pass "section empty for gate-free custom type"

# 9. agent.md.template has the placeholder
grep -q "{{BUSINESS_PRESET_SECTION}}" "$ROOT/templates/agent.md.template" \
  || fail "agent.md.template missing {{BUSINESS_PRESET_SECTION}}"
pass "agent.md.template placeholder"

# 10. AGENT.md has the business-type beat and no per-gate questions
grep -q "Business type" "$ROOT/AGENT.md" || fail "AGENT.md §1 missing business-type beat"
grep -q "business-preset.sh match" "$ROOT/AGENT.md" || fail "AGENT.md missing preset match wiring"
grep -q "settings.business_type" "$ROOT/AGENT.md" || fail "AGENT.md §2 missing business_type recording"
grep -q "BUSINESS_PRESET_SECTION" "$ROOT/AGENT.md" || fail "AGENT.md §2 missing placeholder wiring"
pass "AGENT.md wiring"

# 11. registry.example.json documents the block
grep -q '"business_type"' "$ROOT/registry.example.json" || fail "registry.example.json missing business_type"
pass "registry.example.json"

# 12. hub-memory minimal beats mention business type
grep -q "business type" "$ROOT/control-plane/lib/hub-memory.js" || fail "hub-memory.js beats missing business type"
pass "hub-memory.js beats"

echo "  ok: business-presets"
