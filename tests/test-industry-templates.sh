#!/usr/bin/env bash
# test-industry-templates.sh — industry template schema + apply-template flow.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }
pass() { echo "  ok: $1"; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ba-industry-tpl.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Fresh-install-shaped hub: clone of the repo + seeded minimal registry
# (mirrors install.sh write_registry_seed: empty org/products, no MCP servers).
make_hub() {
  local dir="$1"
  git clone -q "$ROOT" "$dir"
  python3 - "$dir/registry.example.json" "$dir/registry.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["org"] = ""
d["products"] = []
d["cross_product_edges"] = []
mcp = d.get("settings", {}).get("mcp")
if isinstance(mcp, dict):
    mcp["servers"] = []
    mcp["enabled"] = False
s = d.setdefault("settings", {})
s.setdefault("hub_agent", {})["provider"] = "grok"
s.setdefault("models", {})["agent_default"] = "grok-4.5"
json.dump(d, open(sys.argv[2], "w"), indent=2)
PY
}

# --- §1: all three starter templates exist and are valid JSON ---
for slug in fitness-training accounting law; do
  tpl="$ROOT/templates/industries/$slug.json"
  [ -f "$tpl" ] || fail "missing template: $tpl"
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$tpl" \
    || fail "invalid JSON: $tpl"
done
pass "three starter templates parse as JSON"

# --- §2: template schema v1 required fields ---
python3 - "$ROOT" <<'PY' || fail "schema check failed"
import json, os, sys
root = sys.argv[1]
for slug in ("fitness-training", "accounting", "law"):
    t = json.load(open(os.path.join(root, "templates", "industries", slug + ".json")))
    assert t["template_version"] == 1, slug
    assert t["industry"] == slug, slug
    assert t["display_name"], slug
    assert t["variables"] and all(v.get("key") and v.get("question") for v in t["variables"]), slug
    assert t["products"], slug
    for p in t["products"]:
        assert p["slug"] and p["name"] and p["agent_name"], slug
        f = os.path.join(root, "templates", p["system_prompt_file"])
        assert os.path.isfile(f), "missing prompt file " + p["system_prompt_file"]
    assert t["guardrails"]["local_only_data"] is True, slug
    assert t["guardrails"]["outbound_approval_required"] is True, slug
    assert t["guardrails"]["never_contact_client_without_owner"] is True, slug
    assert t["knowledge_stack"]["seed_docs"], slug
    for b in t["behaviors"]:
        assert b["agent"] in {p["slug"] for p in t["products"]}, slug
        assert b["routine"] and b["trigger"] and b["detail"], slug
PY
pass "schema v1 required fields + referenced files present"

# --- §3: happy path — apply fitness-training unattended ---
HUB="$SCRATCH/hub"
make_hub "$HUB"
cat > "$SCRATCH/answers.json" <<'EOF'
{
  "business_name": "Iron Path Fitness",
  "owner_name": "Sam Rivera",
  "client_roster": "/home/customer/clients.db",
  "sms_number": "+15550001111"
}
EOF
bash "$ROOT/scripts/apply-template.sh" --hub "$HUB" --template fitness-training \
  --answers "$SCRATCH/answers.json" > "$SCRATCH/apply.log" 2>&1 \
  || { cat "$SCRATCH/apply.log"; fail "apply-template fitness-training exited non-zero"; }
pass "apply-template fitness-training --answers succeeded"

python3 - "$HUB" <<'PY' || fail "generated hub invalid"
import json, os, sys
hub = sys.argv[1]
r = json.load(open(os.path.join(hub, "registry.json")))
prods = {p["slug"]: p for p in r["products"]}
assert "assistant-coach" in prods, "product missing from registry"
p = prods["assistant-coach"]
assert p["agent_name"] == "Agent AC"
assert p["model"] == "grok-4.5" and p["provider"] == "grok", p
mcp = r["settings"]["mcp"]
assert mcp["enabled"] is True, "mcp not enabled"
names = {s["name"] for s in mcp["servers"]}
assert {"client-db", "calendar", "sms", "pdf-export"} <= names, names
sms = next(s for s in mcp["servers"] if s["name"] == "sms")
assert sms["env"]["SMS_NUMBER"] == "+15550001111", sms
db = next(s for s in mcp["servers"] if s["name"] == "client-db")
assert db["env"]["DB_PATH"] == "/home/customer/clients.db", db
it = r["settings"]["industry_template"]
assert it["slug"] == "fitness-training" and it["guardrails"]["local_only_data"] is True
assert len(it["behaviors"]) == 4
md = open(os.path.join(hub, "agents", "assistant-coach", "agent.md")).read()
assert "Iron Path Fitness" in md and "Sam Rivera" in md, "variables not substituted"
assert "Local-only data" in md, "local-only guardrail missing from agent.md"
assert "Outbound approval gate" in md, "approval gate missing from agent.md"
assert "Non-negotiable limits" in md, "standard agent template missing"
assert "Routines (industry template)" in md, "routines section missing"
assert "checkin-sweep" in md
assert "{{" not in md and "{{" not in json.dumps(r), "unsubstituted placeholder"
assert os.path.isfile(os.path.join(hub, "agents", "assistant-coach", ".dispatch.md"))
for d in ("agents/assistant-coach/inbox/archive", "agents/assistant-coach/outbox",
          "data/assistant-coach"):
    assert os.path.isdir(os.path.join(hub, d)), d
assert os.path.isfile(os.path.join(hub, "knowledge-stack", "industries",
                                   "fitness-training", "checkin-sweep-playbook.md"))
PY
pass "registry + agent.md + MCP + mailboxes + seeded docs all generated"

# --- §4: idempotent re-run does not clobber agent.md ---
echo "OPERATOR EDIT" >> "$HUB/agents/assistant-coach/agent.md"
bash "$ROOT/scripts/apply-template.sh" --hub "$HUB" --template fitness-training \
  --answers "$SCRATCH/answers.json" > "$SCRATCH/reapply.log" 2>&1 \
  || { cat "$SCRATCH/reapply.log"; fail "re-apply exited non-zero"; }
grep -q "OPERATOR EDIT" "$HUB/agents/assistant-coach/agent.md" \
  || fail "re-apply clobbered an existing agent.md"
pass "re-apply is non-destructive without --force"

# --- §5: fail loud — bad JSON ---
BAD="$SCRATCH/bad.json"
echo '{ not json' > "$BAD"
mkdir -p "$SCRATCH/tpl/templates/industries"
cp "$BAD" "$SCRATCH/tpl/templates/industries/broken.json"
bash "$ROOT/scripts/apply-template.sh" --hub "$SCRATCH/tpl" --template broken \
  --answers "$SCRATCH/answers.json" >/dev/null 2>&1 \
  && fail "bad JSON template did not fail"
pass "bad JSON fails loud"

# --- §6: fail loud — unknown field ---
python3 - "$ROOT" "$SCRATCH/tpl/templates/industries/unknown-field.json" <<'PY'
import json, sys
t = json.load(open(sys.argv[1] + "/templates/industries/fitness-training.json"))
t["bogus_field"] = True
json.dump(t, open(sys.argv[2], "w"), indent=2)
PY
bash "$ROOT/scripts/apply-template.sh" --hub "$SCRATCH/tpl" --template unknown-field \
  --answers "$SCRATCH/answers.json" >/dev/null 2>&1 \
  && fail "unknown template field did not fail"
pass "unknown field fails loud"

# --- §7: fail loud — missing required answer ---
python3 - "$SCRATCH/answers-partial.json" <<'PY'
import json, sys
a = json.load(open("/dev/stdin")) if False else {
    "business_name": "Iron Path Fitness", "owner_name": "Sam Rivera"}
json.dump(a, open(sys.argv[1], "w"))
PY
bash "$ROOT/scripts/apply-template.sh" --hub "$HUB" --template fitness-training \
  --answers "$SCRATCH/answers-partial.json" >/dev/null 2>&1 \
  && fail "missing required answer did not fail"
pass "missing required answer fails loud in unattended mode"

# --- §8: fail loud — undeclared {{variable}} in prompt file ---
cp "$ROOT/templates/industries/fitness-training.json" \
   "$SCRATCH/tpl/templates/industries/undeclared-var.json"
python3 - "$SCRATCH/tpl" <<'PY'
import json, os, sys
root = sys.argv[1]
t = json.load(open(root + "/templates/industries/undeclared-var.json"))
t["industry"] = "undeclared-var"
t["variables"].append({"key": "extra_var", "question": "q?", "required": False})
json.dump(t, open(root + "/templates/industries/undeclared-var.json", "w"), indent=2)
PY
bash "$ROOT/scripts/apply-template.sh" --hub "$SCRATCH/tpl" --template undeclared-var \
  --answers "$SCRATCH/answers.json" >/dev/null 2>&1 \
  && fail "undeclared variable use did not fail"
pass "undeclared {{variable}} fails loud"

# --- §9: install.sh wiring (source-level, like test-installer-source) ---
grep -q -- '--template' "$ROOT/install.sh" || fail "install.sh missing --template flag"
grep -q 'BIZAGENT_TEMPLATE' "$ROOT/install.sh" || fail "install.sh missing BIZAGENT_TEMPLATE env"
grep -q 'apply_industry_template' "$ROOT/install.sh" || fail "install.sh does not call apply_industry_template"
grep -q 'apply-template.sh' "$ROOT/install.sh" || fail "install.sh does not invoke apply-template.sh"
grep -q '\.tar\.gz' "$ROOT/install.sh" || fail "install.sh missing USB-bundle tarball support"
pass "install.sh --template/--answers/tarball wiring present"

echo "  ok: industry templates"
