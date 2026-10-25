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
