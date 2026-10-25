#!/usr/bin/env bash
# test-ks-provenance.sh — provenance tracking, removal reconciliation, and
# overview revision stamping for the Knowledge Stack (scripts/lib/ks-provenance.sh).
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "  FAIL: $1"; exit 1; }

HUB="$TMP/hub"
STACK="$HUB/knowledge-stack"
PROJ="$TMP/proj-repo"          # product repo (git)
RUN_TS="2026-10-25T01:00:00Z"
mkdir -p "$HUB" "$STACK"

cat > "$HUB/registry.json" <<'EOF'
{"products": [{"slug": "widgets", "projects": [{"name": "widgets-api", "path": "../proj-repo"}]}]}
EOF

# Product repo with a committed source doc
mkdir -p "$PROJ/docs"
echo "api spec v1" > "$PROJ/docs/api-spec.md"
git -C "$PROJ" init -q
git -C "$PROJ" add docs/api-spec.md
git -C "$PROJ" -c user.email=t@t -c user.name=t commit -qm "spec"
SRC_SHA="$(git -C "$PROJ" log -1 --format=%h)"

# Stack: overview + copied doc; reply with Source docs list (agent.md convention)
echo "widgets overview" > "$STACK/widgets-overview.md"
echo "api spec v1" > "$STACK/widgets-api-spec.md"
cat > "$TMP/reply.md" <<'EOF'
Overview body here.

Source docs:
- widgets-api/docs/api-spec.md
EOF

# shellcheck source=../scripts/lib/ks-provenance.sh
. "$SCRIPT_DIR/../scripts/lib/ks-provenance.sh"

# --- case 1: record provenance from reply ---------------------------------
out="$(ks_prov_record_for_slug widgets "$TMP/reply.md")"
echo "$out" | grep -q "PROV widgets-api-spec.md <- widgets-api/docs/api-spec.md@" || fail "record: no PROV line"
python3 -c "
import json,sys
d=json.load(open('$STACK/.provenance.json'))
e=d['files']['widgets-api-spec.md']
assert e['owner']=='widgets' and e['project']=='widgets-api', e
assert e['source']=='docs/api-spec.md', e
assert e['sha']=='$SRC_SHA', e
assert (e['hash'] or '').startswith('sha256:'), e
" || fail "record: bad sidecar entry"

# --- case 2: manifest field -------------------------------------------------
f="$(ks_prov_manifest_field widgets-api-spec.md)"
[[ "$f" == *" | src: widgets-api/docs/api-spec.md@$SRC_SHA"* ]] || fail "manifest field: got '$f'"
[[ -z "$(ks_prov_manifest_field widgets-overview.md)" ]] || fail "manifest field: overview should have none"

# --- case 3: overview stamping (write, then replace, never duplicate) ------
ks_prov_stamp_overview widgets
grep -q "ks-provenance" "$STACK/widgets-overview.md" || fail "stamp: no block"
grep -q "docs/api-spec.md @ $SRC_SHA" "$STACK/widgets-overview.md" || fail "stamp: no source rev"
n1="$(grep -c 'ks-provenance' "$STACK/widgets-overview.md")"
RUN_TS="2026-10-26T01:00:00Z" ks_prov_stamp_overview widgets
n2="$(grep -c 'ks-provenance' "$STACK/widgets-overview.md")"
[[ "$n1" == "1" && "$n2" == "1" ]] || fail "stamp: duplicated blocks ($n1/$n2)"
grep -q "refreshed: 2026-10-26T01:00:00Z" "$STACK/widgets-overview.md" || fail "stamp: ts not replaced"
grep -q "widgets overview" "$STACK/widgets-overview.md" || fail "stamp: overview body lost"

# --- case 4: reconcile keeps file while source exists -----------------------
out="$(ks_prov_reconcile)"
[[ -z "$out" ]] || fail "reconcile: unexpected output '$out'"
[[ -f "$STACK/widgets-api-spec.md" ]] || fail "reconcile: removed file with live source"

# --- case 5: reconcile removes copy when source is deleted ------------------
rm "$PROJ/docs/api-spec.md"
out="$(ks_prov_reconcile)"
echo "$out" | grep -q "REMOVED widgets-api-spec.md (source deleted: widgets-api/docs/api-spec.md)" || fail "reconcile: no REMOVED line"
[[ ! -f "$STACK/widgets-api-spec.md" ]] || fail "reconcile: stale copy not removed"
python3 -c "
import json
d=json.load(open('$STACK/.provenance.json'))
assert 'widgets-api-spec.md' not in d['files'], d
" || fail "reconcile: sidecar entry not dropped"

# --- case 6: project dir missing -> skip (never delete on absent repo) ------
echo "spec" > "$STACK/widgets-other.md"
python3 -c "
import json
d=json.load(open('$STACK/.provenance.json'))
d['files']['widgets-other.md']={'owner':'widgets','project':'widgets-api','source':'docs/gone.md','sha':None,'hash':None,'copied_at':'2026-10-25T01:00:00Z'}
json.dump(d,open('$STACK/.provenance.json','w'))
"
mv "$PROJ" "$PROJ-hidden"
out="$(ks_prov_reconcile)"
echo "$out" | grep -q "SKIP widgets-other.md (project dir missing" || fail "reconcile: no SKIP for missing project dir"
[[ -f "$STACK/widgets-other.md" ]] || fail "reconcile: deleted copy while repo unavailable"
mv "$PROJ-hidden" "$PROJ"

# --- case 7: legacy files without provenance are never touched --------------
# (widgets-other.md is now legitimately removed — its source docs/gone.md
# does not exist even with the repo back — but widgets-legacy.md, which has
# no provenance entry, must survive untouched.)
echo "legacy" > "$STACK/widgets-legacy.md"
out="$(ks_prov_reconcile)"
[[ -f "$STACK/widgets-legacy.md" ]] || fail "reconcile: touched legacy file"
echo "$out" | grep -q "REMOVED widgets-other.md" || fail "reconcile: gone.md source not reconciled"
[[ ! -f "$STACK/widgets-other.md" ]] || fail "reconcile: stale copy (gone.md) not removed"

# --- case 8: no sidecar at all -> reconcile is a no-op ----------------------
rm "$STACK/.provenance.json"
out="$(ks_prov_reconcile)" || fail "reconcile: non-zero exit without sidecar"
[[ -z "$out" ]] || fail "reconcile: output without sidecar '$out'"

# --- case 9: reply without Source docs -> no entries, no crash --------------
echo "no update" > "$TMP/empty-reply.md"
ks_prov_record_for_slug widgets "$TMP/empty-reply.md" || fail "record: non-zero on reply without Source docs"
[[ ! -f "$STACK/.provenance.json" ]] || fail "record: sidecar written without Source docs"

echo "  ok: ks-provenance"
