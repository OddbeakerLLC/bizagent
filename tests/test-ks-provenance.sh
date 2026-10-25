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
RUN_DATE="2026-10-25"
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

# --- case 10: record claims from overview "Claims:" block -------------------
cat > "$STACK/widgets-overview.md" <<OV
# widgets overview

Claims:
- Login rewrite is finished [src: widgets-api/docs/api-spec.md]
- v2.1 shipped on 2026-10-01 [src: widgets-api@$SRC_SHA]
- Dashboard uses the new cache [src: widgets-api/docs/missing.md]
OV
out="$(ks_prov_record_claims widgets "$STACK/widgets-overview.md")"
echo "$out" | grep -q "CLAIM " || fail "claims: no CLAIM lines"
python3 -c "
import json
d=json.load(open('$STACK/.provenance.json'))
cs=d['claims']
assert len(cs)==3, cs
assert all(c['owner']=='widgets' and c['last_checked'] is None for c in cs.values()), cs
assert any(c['src']=='widgets-api/docs/api-spec.md' for c in cs.values()), cs
assert any(c['src']=='widgets-api@$SRC_SHA' for c in cs.values()), cs
" || fail "claims: bad sidecar entries"

# --- case 11: spot-check verifies file+commit refs, stamps last_checked -----
echo "api spec v1" > "$PROJ/docs/api-spec.md"   # restore the source deleted in case 5
out="$(ks_prov_spot_check widgets)"
echo "$out" | grep -q "CLAIM-OK" || fail "spot-check: no CLAIM-OK"
echo "$out" | grep -q "CLAIM-STALE" || fail "spot-check: missing ref not flagged STALE"
python3 -c "
import json
d=json.load(open('$STACK/.provenance.json'))
cs=d['claims']
ok=[c for c in cs.values() if c['last_checked']=='2026-10-25']
assert len(ok)==2, cs
assert any(c['src']=='widgets-api/docs/missing.md' and c['last_checked'] is None for c in cs.values()), cs
" || fail "spot-check: last_checked not stamped"

# --- case 12: claim-checks footer stamped, replaced not duplicated ----------
ks_prov_stamp_claims widgets
grep -q "ks-claim-checks" "$STACK/widgets-overview.md" || fail "claims stamp: no block"
grep -q "never checked" "$STACK/widgets-overview.md" || fail "claims stamp: no never-checked line"
grep -q "checked 2026-10-25" "$STACK/widgets-overview.md" || fail "claims stamp: no checked line"
n1="$(grep -c 'ks-claim-checks' "$STACK/widgets-overview.md")"
RUN_DATE="2026-10-26" ks_prov_stamp_claims widgets
n2="$(grep -c 'ks-claim-checks' "$STACK/widgets-overview.md")"
[[ "$n1" == "1" && "$n2" == "1" ]] || fail "claims stamp: duplicated blocks ($n1/$n2)"
grep -q "updated: 2026-10-26" "$STACK/widgets-overview.md" || fail "claims stamp: ts not replaced"

# --- case 13: spot-check respects last_checked ordering + cap ---------------
# Cap 2: the never-checked claim plus the least-recently-checked one are
# eligible; the most-recently-checked claim must keep its 10-25 date.
RUN_DATE="2026-10-26" KS_PROV_SPOT_CHECK_N=2 out="$(ks_prov_spot_check widgets)"
python3 -c "
import json
d=json.load(open('$STACK/.provenance.json'))
cs=d['claims']
assert sum(1 for c in cs.values() if c['last_checked']=='2026-10-25')==1, cs
" || fail "spot-check: cap did not preserve most-recent check"
echo "$out" | grep -q "CLAIM-" || fail "spot-check: no output on second run"

# --- case 14: idempotent re-record keeps last_checked -----------------------
out="$(ks_prov_record_claims widgets "$STACK/widgets-overview.md")"
python3 -c "
import json
d=json.load(open('$STACK/.provenance.json'))
cs=d['claims']
assert len(cs)==3, cs
assert any(c['last_checked']=='2026-10-25' for c in cs.values()), cs
" || fail "claims: re-record lost last_checked"

# --- case 15: overview without Claims block -> no-op ------------------------
echo "plain overview, no claims" > "$STACK/widgets-overview2.md"
out="$(ks_prov_record_claims widgets "$STACK/widgets-overview2.md")"
[[ -z "$out" ]] || fail "claims: output without Claims block"
echo "  ok: claim provenance + spot-check"
