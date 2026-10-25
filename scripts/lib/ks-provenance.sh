#!/usr/bin/env bash
# ks-provenance.sh — provenance tracking for the Knowledge Stack (library).
#
# Sourced by scripts/weekly-refresh.sh. Caller must define before use:
#   HUB     - hub root directory
#   STACK   - knowledge-stack directory ($HUB/knowledge-stack)
#   RUN_TS  - ISO timestamp of the current refresh run
#
# State: $STACK/.provenance.json (operator data — preserved by scripts/upgrade.sh)
#
#   {
#     "version": 1,
#     "updated": "<ISO ts>",
#     "files": {
#       "<slug>-<basename>.<ext>": {
#         "owner":     "<slug>",
#         "project":   "<registry project name>",
#         "source":    "<repo-relative source path>",
#         "sha":       "<short git SHA of source repo at copy time | null>",
#         "hash":      "sha256:<prefix of copied file> | null",
#         "copied_at": "<ISO ts>"
#       }
#     },
#     "claims": {
#       "<id>": {                       # id = sha256(claim text)[:6]
#         "owner":       "<slug>",
#         "text":        "<claim text>",
#         "src":         "<project>/<path> | <project>@<sha> | null",
#         "recorded_at": "<ISO ts>",
#         "last_checked": "<YYYY-MM-DD | null>"   # set by quiet-week spot-checks
#       }
#     }
#   }
#
# Rules:
#   - Only files with a RESOLVED source (project + source path) are eligible
#     for removal reconciliation. Unresolved/legacy files are never deleted.
#   - If the project directory itself is missing (repo not cloned), the file
#     is skipped — absence of the repo is not proof the source was deleted.
#
# All functions are idempotent and best-effort: a provenance failure must
# never fail the weekly refresh.
#
set -u

KS_PROV_FILE="$STACK/.provenance.json"

# ks_prov_reconcile — remove stack copies whose recorded source no longer exists.
# Prints one line per action: "REMOVED <file> (<reason>)" or "SKIP <file> (<reason>)".
# Caller collects REMOVED filenames for the manifest/journal.
ks_prov_reconcile() {
  python3 - "$HUB" "$STACK" "$RUN_TS" <<'PY'
import json, os, sys

hub, stack, ts = sys.argv[1], sys.argv[2], sys.argv[3]
pf = os.path.join(stack, ".provenance.json")
try:
    data = json.load(open(pf))
except Exception:
    sys.exit(0)  # no sidecar yet (legacy stack) — nothing to reconcile
files = data.get("files", {})
if not files:
    sys.exit(0)

try:
    reg = json.load(open(os.path.join(hub, "registry.json")))
except Exception:
    reg = {}
projects = {}
for p in reg.get("products", []):
    for pr in p.get("projects", []):
        if pr.get("name"):
            projects[pr["name"]] = os.path.normpath(os.path.join(hub, pr.get("path", "")))

removed = []
for f, e in sorted(files.items()):
    src, prj = e.get("source"), e.get("project")
    if not src or not prj:
        continue  # unresolved provenance — never delete
    pd = projects.get(prj)
    if not pd:
        continue  # project left the registry — weekly.sh orphan cleanup owns that
    if not os.path.isdir(pd):
        print("SKIP %s (project dir missing: %s)" % (f, pd))
        continue
    if os.path.exists(os.path.join(pd, src)):
        continue  # source still there
    try:
        os.remove(os.path.join(stack, f))
    except OSError as ex:
        print("SKIP %s (remove failed: %s)" % (f, ex))
        continue
    files.pop(f, None)
    removed.append(f)
    print("REMOVED %s (source deleted: %s/%s)" % (f, prj, src))

if removed:
    data["files"] = files
    data["updated"] = ts
    try:
        json.dump(data, open(pf, "w"), indent=2, sort_keys=True)
    except OSError as ex:
        print("SKIP provenance-write (failed: %s)" % ex)
PY
}

# ks_prov_record_for_slug <slug> <reply-file>
# Parse the agent reply's "Source docs:" list, match it against the stack files
# the agent copied (<slug>-<basename>.<ext>), and record provenance entries.
ks_prov_record_for_slug() {
  local slug="$1" reply="$2"
  [[ -f "$reply" ]] || return 0
  python3 - "$HUB" "$STACK" "$slug" "$reply" "$RUN_TS" <<'PY'
import json, os, re, hashlib, subprocess, sys

hub, stack, slug, reply, ts = sys.argv[1:6]

try:
    reg = json.load(open(os.path.join(hub, "registry.json")))
except Exception:
    sys.exit(0)
projects = []
for p in reg.get("products", []):
    if p.get("slug") == slug:
        for pr in p.get("projects", []):
            if pr.get("name"):
                projects.append((pr["name"], os.path.normpath(os.path.join(hub, pr.get("path", "")))))
if not projects:
    sys.exit(0)

# Parse the "Source docs:" block from the reply (agent.md convention).
docs = []
try:
    inblk = False
    for ln in open(reply, encoding="utf-8", errors="replace").read().splitlines():
        if re.match(r"^Source docs:", ln):
            inblk = True
            continue
        if inblk:
            if not ln.strip() or ln.lstrip().startswith("#"):
                inblk = False
                continue
            d = re.sub(r"^[-*]\s+", "", ln.strip())
            d = d.strip("`").strip()
            if d:
                docs.append(d)
except OSError:
    pass
if not docs:
    sys.exit(0)

def git_sha(pd, rel):
    try:
        out = subprocess.run(["git", "-C", pd, "log", "-1", "--format=%h", "--", rel],
                             capture_output=True, text=True, timeout=10)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
        out = subprocess.run(["git", "-C", pd, "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, timeout=10)
        if out.returncode == 0:
            return out.stdout.strip()
    except Exception:
        pass
    return None

def resolve(doc):
    for name, pd in projects:
        if not os.path.isdir(pd):
            continue
        if doc == name:
            return name, pd, ""
        if doc.startswith(name + "/"):
            return name, pd, doc[len(name) + 1:]
        for cand in (os.path.normpath(os.path.join(hub, doc)),
                     os.path.normpath(os.path.join(pd, doc))):
            if os.path.isfile(cand):
                rp, base = os.path.realpath(cand), os.path.realpath(pd) + os.sep
                if rp.startswith(base):
                    return name, pd, os.path.relpath(rp, base)
    return None

resolved = {}
for doc in docs:
    r = resolve(doc)
    if r:
        resolved[os.path.basename(doc)] = r

pf = os.path.join(stack, ".provenance.json")
try:
    data = json.load(open(pf))
except Exception:
    data = {"version": 1, "files": {}}
data.setdefault("files", {})

for f in sorted(os.listdir(stack)):
    if f.startswith(".") or f == "MANIFEST.md":
        continue
    if not f.startswith(slug + "-") or f == slug + "-overview.md":
        continue
    base = f[len(slug) + 1:]
    if base not in resolved:
        continue  # leave unknown/legacy files alone
    name, pd, rel = resolved[base]
    sha = git_sha(pd, rel) if rel else None
    h = None
    try:
        with open(os.path.join(stack, f), "rb") as fh:
            h = "sha256:" + hashlib.sha256(fh.read()).hexdigest()[:16]
    except OSError:
        pass
    data["files"][f] = {"owner": slug, "project": name, "source": rel,
                        "sha": sha, "hash": h, "copied_at": ts}
    print("PROV %s <- %s/%s@%s" % (f, name, rel, sha or "?"))

data["updated"] = ts
try:
    json.dump(data, open(pf, "w"), indent=2, sort_keys=True)
except OSError:
    pass
PY
}

# ks_prov_stamp_overview <slug>
# Write/replace an HTML-comment provenance block at the end of the slug's
# overview file listing the source revisions it summarizes. PTL (and any
# reader of the raw file) can then tell "current product state" from
# "what the stack knew at last refresh".
ks_prov_stamp_overview() {
  local slug="$1"
  python3 - "$STACK" "$slug" "$RUN_TS" <<'PY'
import json, os, re, sys

stack, slug, ts = sys.argv[1], sys.argv[2], sys.argv[3]
ov = os.path.join(stack, slug + "-overview.md")
if not os.path.isfile(ov):
    sys.exit(0)
try:
    data = json.load(open(os.path.join(stack, ".provenance.json")))
except Exception:
    data = {"files": {}}
entries = sorted((f, e) for f, e in data.get("files", {}).items()
                 if e.get("owner") == slug and e.get("source"))
lines = ["  - %s/%s @ %s" % (e.get("project"), e["source"], e.get("sha") or "unknown")
         for _, e in entries]
block = "<!-- ks-provenance\nrefreshed: %s\nsources:\n%s\n-->\n" % (
    ts, "\n".join(lines) if lines else "  - (none recorded)")
try:
    text = open(ov, encoding="utf-8", errors="replace").read()
except OSError:
    sys.exit(0)
text = re.sub(r"<!-- ks-provenance\n.*?-->\n?", "", text, flags=re.S)
if text.strip() and not text.endswith("\n"):
    text += "\n"
open(ov, "w", encoding="utf-8").write((text + "\n" + block) if text.strip() else block)
PY
}

# ks_prov_manifest_field <stack-filename>
# Print " | src: <project>/<source>@<sha>" for the manifest, or nothing.
ks_prov_manifest_field() {
  local f="$1"
  python3 - "$KS_PROV_FILE" "$f" <<'PY'
import json, sys
pf, f = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(pf))
except Exception:
    sys.exit(0)
e = data.get("files", {}).get(f)
if e and e.get("source"):
    print(" | src: %s/%s@%s" % (e.get("project"), e["source"], e.get("sha") or "unknown"))
PY
}

# --- Claim-level provenance -------------------------------------------------
#
# An overview can be wrong the day it is written ("the login rewrite is
# finished" while it was half done). Removal reconciliation cannot catch that:
# the source doc still exists, the claim was just never true. The refresh
# therefore also tracks the overview's factual claims as first-class records
# so they can be re-verified on quiet weeks and their freshness made visible.

# ks_prov_record_claims <slug> <overview-file>
# Parse the overview's "Claims:" block (one "- <claim> [src: <ref>]" bullet
# per checkable claim) into the sidecar. Idempotent: a claim with the same
# text keeps its id, src, and last_checked date; only the recorded_at stamp
# moves. Claims dropped from the overview stay in the sidecar (history) but
# are no longer stamped into the footer. Best-effort: never fails the refresh.
ks_prov_record_claims() {
  local slug="$1" ov="$2"
  [[ -f "$ov" ]] || return 0
  python3 - "$STACK" "$slug" "$ov" "$RUN_TS" <<'PY'
import json, os, re, hashlib, sys

stack, slug, ov, ts = sys.argv[1:5]
try:
    text = open(ov, encoding="utf-8", errors="replace").read()
except OSError:
    sys.exit(0)

# Parse the "Claims:" block: bullets "- <text> [src: <ref>]" until a
# non-bullet, non-blank line ends the block.
claims = []
inblk = False
for ln in text.splitlines():
    s = ln.strip()
    if re.match(r"^Claims:\s*$", s):
        inblk = True
        continue
    if inblk:
        if not s:
            continue
        if not s.startswith(("-", "*")):
            break
        m = re.match(r"^[-*]\s+(.*\S)\s*$", s)
        if m:
            claims.append(m.group(1))
if not claims:
    sys.exit(0)

pf = os.path.join(stack, ".provenance.json")
try:
    data = json.load(open(pf))
except Exception:
    data = {"version": 1, "files": {}}
data.setdefault("claims", {})

for c in claims:
    m = re.match(r"^(.*\S)\s*\[src:\s*([^\]]+)\]\s*$", c)
    ref = m.group(2).strip() if m else None
    body = (m.group(1) if m else c).strip()
    cid = hashlib.sha256(body.encode("utf-8")).hexdigest()[:6]
    prev = data["claims"].get(cid, {})
    data["claims"][cid] = {
        "owner": slug,
        "text": body,
        "src": ref,
        "recorded_at": ts,
        "last_checked": prev.get("last_checked"),
    }
    print("CLAIM %s %s" % (cid, body[:80]))

data["updated"] = ts
try:
    json.dump(data, open(pf, "w"), indent=2, sort_keys=True)
except OSError:
    pass
PY
}

# ks_prov_spot_check <slug>
# Quiet-week spot-check: pick up to KS_PROV_SPOT_CHECK_N (default 3) of the
# slug's least-recently-checked claims and re-verify each against its source:
#   - "proj/path"  -> the file exists in the project repo
#   - "proj@sha"   -> the commit exists in the project repo
#   - no src       -> cannot verify mechanically; agent judgment only
# Verified claims get last_checked = today (stamped into the overview footer).
# A claim whose source ref no longer resolves is reported as STALE (the agent
# decides whether the claim is outdated or just needs a new ref). Best-effort.
ks_prov_spot_check() {
  local slug="$1"
  python3 - "$HUB" "$STACK" "$slug" "$RUN_DATE" "${KS_PROV_SPOT_CHECK_N:-3}" <<'PY'
import json, os, re, subprocess, sys

hub, stack, slug, today, limit = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
pf = os.path.join(stack, ".provenance.json")
try:
    data = json.load(open(pf))
except Exception:
    sys.exit(0)
claims = data.get("claims", {})
mine = [(cid, c) for cid, c in claims.items() if c.get("owner") == slug]
if not mine:
    # No recorded claims for this slug (e.g. legacy overview written before
    # claim tracking): adopt its current Claims block first, then check.
    import hashlib
    try:
        text = open(os.path.join(stack, slug + "-overview.md"),
                    encoding="utf-8", errors="replace").read()
    except OSError:
        sys.exit(0)
    parsed, inblk = [], False
    for ln in text.splitlines():
        s = ln.strip()
        if re.match(r"^Claims:\s*$", s):
            inblk = True
            continue
        if inblk:
            if not s:
                continue
            if not s.startswith(("-", "*")):
                break
            m = re.match(r"^[-*]\s+(.*\S)\s*$", s)
            if m:
                mm = re.match(r"^(.*\S)\s*\[src:\s*([^\]]+)\]\s*$", m.group(1))
                ref = mm.group(2).strip() if mm else None
                body = (mm.group(1) if mm else m.group(1)).strip()
                parsed.append((hashlib.sha256(body.encode("utf-8")).hexdigest()[:6], body, ref))
    if not parsed:
        sys.exit(0)
    for cid, body, ref in parsed:
        claims[cid] = {"owner": slug, "text": body, "src": ref,
                       "recorded_at": today + "T00:00:00Z", "last_checked": None}
    mine = [(cid, claims[cid]) for cid, _, _ in parsed]

try:
    reg = json.load(open(os.path.join(hub, "registry.json")))
except Exception:
    reg = {}
projects = {}
for p in reg.get("products", []):
    if p.get("slug") == slug:
        for pr in p.get("projects", []):
            if pr.get("name"):
                projects[pr["name"]] = os.path.normpath(os.path.join(hub, pr.get("path", "")))

def resolve_src(ref):
    """Return (project_dir, kind, detail) or None if unresolvable."""
    if not ref:
        return None
    if "@" in ref:
        prj, sha = ref.rsplit("@", 1)
        pd = projects.get(prj.strip())
        if pd and os.path.isdir(pd):
            return pd, "commit", sha.strip()
        return None
    if "/" in ref:
        prj, rel = ref.split("/", 1)
        pd = projects.get(prj.strip())
        if pd and os.path.isdir(pd):
            return pd, "file", rel.strip()
    return None

# Least-recently-checked first; never-checked before checked.
def key(item):
    cid, c = item
    lc = c.get("last_checked") or ""
    return (lc, cid)

checked, stale = [], []
for cid, c in sorted(mine, key=key)[:limit]:
    r = resolve_src(c.get("src"))
    if r is None:
        print("CLAIM-UNVERIFIABLE %s (no resolvable src: %s)" % (cid, c.get("src") or "-"))
        continue
    pd, kind, detail = r
    if kind == "file":
        ok = os.path.isfile(os.path.join(pd, detail))
        why = "file %s/%s" % (os.path.basename(pd), detail)
    else:
        try:
            out = subprocess.run(["git", "-C", pd, "cat-file", "-e", detail + "^{commit}"],
                                 capture_output=True, timeout=10)
            ok = out.returncode == 0
        except Exception:
            ok = False
        why = "commit %s@%s" % (os.path.basename(pd), detail)
    if ok:
        c["last_checked"] = today
        checked.append(cid)
        print("CLAIM-OK %s (%s)" % (cid, why))
    else:
        stale.append(cid)
        print("CLAIM-STALE %s (src no longer resolves: %s)" % (cid, why))

if checked or stale:
    data["claims"] = claims
    data["updated"] = "%sT00:00:00Z" % today
    try:
        json.dump(data, open(pf, "w"), indent=2, sort_keys=True)
    except OSError:
        pass
PY
}

# ks_prov_stamp_claims <slug>
# Write/replace a visible "Claim checks:" footer (after the existing
# ks-provenance block) listing each live claim with its provenance ref and
# last-checked date, so PTL can tell a claim verified last week from one
# nobody has looked at since March. Claims never mechanically checked show
# "never checked". Best-effort.
ks_prov_stamp_claims() {
  local slug="$1"
  python3 - "$STACK" "$slug" "$RUN_DATE" <<'PY'
import json, os, re, sys

stack, slug, today = sys.argv[1], sys.argv[2], sys.argv[3]
ov = os.path.join(stack, slug + "-overview.md")
if not os.path.isfile(ov):
    sys.exit(0)
try:
    text = open(ov, encoding="utf-8", errors="replace").read()
except OSError:
    sys.exit(0)
# Only claims still present in the overview's Claims block are stamped;
# dropped claims stay in the sidecar (history) but leave the footer.
live = set()
inblk = False
for ln in text.splitlines():
    s = ln.strip()
    if re.match(r"^Claims:\s*$", s):
        inblk = True
        continue
    if inblk:
        if not s:
            continue
        if not s.startswith(("-", "*")):
            break
        m = re.match(r"^[-*]\s+(.*\S)\s*$", s)
        if m:
            body = re.sub(r"\s*\[src:\s*[^\]]+\]\s*$", "", m.group(1)).strip()
            live.add(body)
try:
    data = json.load(open(os.path.join(stack, ".provenance.json")))
except Exception:
    data = {}
claims = [(c.get("recorded_at") or "", cid, c) for cid, c in data.get("claims", {}).items()
          if c.get("owner") == slug and c.get("text") in live]
if not claims:
    sys.exit(0)
lines = []
for _, cid, c in sorted(claims):
    lc = c.get("last_checked")
    when = "checked %s" % lc if lc else "never checked"
    src = c.get("src") or "no ref"
    lines.append("  - [%s] %s (src: %s)" % (when, c.get("text", ""), src))
block = "<!-- ks-claim-checks\nupdated: %s\n%s\n-->\n" % (today, "\n".join(lines))
try:
    text = open(ov, encoding="utf-8", errors="replace").read()
except OSError:
    sys.exit(0)
text = re.sub(r"<!-- ks-claim-checks\n.*?-->\n?", "", text, flags=re.S)
if text.strip() and not text.endswith("\n"):
    text += "\n"
open(ov, "w", encoding="utf-8").write((text + "\n" + block) if text.strip() else block)
PY
}
