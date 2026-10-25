#!/usr/bin/env bash
# business-preset.sh — business-type presets for first-run onboarding.
#
#   scripts/business-preset.sh list              -> preset slugs + labels
#   scripts/business-preset.sh show <slug>       -> one preset as JSON
#   scripts/business-preset.sh match "<text>"    -> resolve free text to a slug
#   scripts/business-preset.sh section           -> markdown section for
#                                                   agent.md rendering, from
#                                                   the hub's registry.json
#                                                   (empty when no preset set)
#
# See docs/ONBOARDING-BUSINESS-PRESETS.md. Read-only except `section` output.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB="$(cd "$SCRIPT_DIR/.." && pwd)"
PRESETS="$HUB/templates/business-presets.json"

fail() { echo "business-preset: $1" >&2; exit 1; }
[ -f "$PRESETS" ] || fail "templates/business-presets.json missing"

cmd="${1:-}"
case "$cmd" in
  list)
    python3 - "$PRESETS" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for slug, p in d["presets"].items():
    print(f"{slug}\t{p['label']}")
PY
    ;;
  show)
    slug="${2:-}"
    [ -n "$slug" ] || fail "show requires a slug"
    python3 - "$PRESETS" "$slug" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
p = d["presets"].get(sys.argv[2])
if p is None:
    print(f"unknown preset: {sys.argv[2]}" , file=sys.stderr); sys.exit(1)
print(json.dumps(p, indent=2))
PY
    ;;
  match)
    text="${2:-}"
    [ -n "$text" ] || fail "match requires text"
    python3 - "$PRESETS" "$text" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
t = sys.argv[2].strip().lower()
for slug, p in d["presets"].items():
    if t == slug or t == p["label"].lower() or t in p.get("aliases", []):
        print(slug); sys.exit(0)
print("other"); sys.exit(0)
PY
    ;;
  section)
    python3 - "$PWD" "$PRESETS" <<'PY'
import json, os, sys
hub, presets_path = sys.argv[1], sys.argv[2]
reg_path = os.path.join(hub, "registry.json")
try:
    bt = json.load(open(reg_path)).get("settings", {}).get("business_type") or {}
except Exception:
    bt = {}
slug = bt.get("slug")
if not slug:
    sys.exit(0)  # no preset -> empty section (backward compatible)
try:
    p = json.load(open(presets_path))["presets"].get(slug) or {}
except Exception:
    p = {}
defaults = bt.get("defaults") or p.get("defaults") or {}
gates = defaults.get("approval_gates") or []
roles = defaults.get("agent_roles") or []
off = defaults.get("features_off") or []
if not (gates or roles or off):
    sys.exit(0)
GATE_TEXT = {
    "code_review": "Never merge or push code changes without a review pass; "
                   "produce a short review summary (what changed, risks) for the owner.",
    "document_review": "Drafts (filings, letters, returns, client documents) are never "
                       "filed or sent without explicit owner review and approval.",
    "qa_shipment": "Production or shipment changes require a completed QA checklist "
                   "before anything ships.",
    "client_approval": "Anything sent to a client or published on their behalf needs "
                       "owner sign-off first.",
}
lines = ["", "## Business-type defaults", "",
         f"Hub business type: **{bt.get('label') or p.get('label') or slug}** "
         "(set during onboarding; overridable in `registry.json` → "
         "`settings.business_type`).", ""]
if roles:
    lines.append("Default roles you act as: " + ", ".join(f"**{r}**" for r in roles) + ".")
for g in gates:
    if g in GATE_TEXT:
        lines.append(f"- **Approval gate — {g}:** {GATE_TEXT[g]}")
    else:
        lines.append(f"- **Approval gate — {g}:** follow the owner's review process before acting.")
if off:
    lines.append("Off by default for this business type (enable via registry settings if wanted): "
                 + ", ".join(f"`{f}`" for f in off) + ".")
print("\n".join(lines).rstrip())
PY
    ;;
  *)
    fail "usage: business-preset.sh list | show <slug> | match <text> | section"
    ;;
esac
