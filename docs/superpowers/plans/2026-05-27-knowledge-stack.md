# Knowledge Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the opt-in weekly Knowledge Stack refresh feature to bizagent — PTL collects company info + per-product agent overviews + curated source docs into `knowledge-stack/` for chat-with-docs tools (NotebookLM, MSTY).

**Architecture:** Mirrors the existing nightly pattern. A new mechanical script (`scripts/weekly.sh`) handles enablement check + orphan cleanup. A new agent routine doc (`templates/WEEKLY.md`) drives the judgment work (synthesis, agent messaging, manifest writing). `AGENT.md` gains new content in §§ 1–4. `registry.example.json` adds a `knowledge_stack` block. The product agent template gains a new contribution section. Disabled mode: `[Company]` journal tag still applied, everything else short-circuits.

**Tech Stack:** bash, python3 (JSON parsing, matching `scripts/nightly.sh`), markdown.

**Spec:** `docs/superpowers/specs/2026-05-27-knowledge-stack-design.md`

---

### Task 1: Add `knowledge_stack` block to `registry.example.json`

**Files:**
- Modify: `registry.example.json`

- [ ] **Step 1: Write the failing test**

Add the assertion to a new file `tests/test-registry-schema.sh`:

```bash
#!/usr/bin/env bash
# test-registry-schema.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EX="$SCRIPT_DIR/../registry.example.json"
fail() { echo "  FAIL: $1"; exit 1; }

python3 -c "
import json, sys
cfg = json.load(open('$EX'))
ks = cfg.get('knowledge_stack')
assert ks is not None, 'missing knowledge_stack block'
assert ks.get('enabled') is True, 'enabled should default to true in the example'
assert ks.get('refresh_day') == 'sunday', 'refresh_day should be sunday'
assert ks.get('refresh_time') == '01:00', 'refresh_time should be 01:00'
" || fail "registry.example.json schema check"

echo "  ok: registry-schema"
```

Make it executable: `chmod +x tests/test-registry-schema.sh`

- [ ] **Step 2: Run test to verify it fails**

```bash
bash tests/test-registry-schema.sh
```

Expected: FAIL with `AssertionError: missing knowledge_stack block`

- [ ] **Step 3: Implement — add the block to `registry.example.json`**

Insert this block immediately after the `settings` block (keep the existing `_comment`, `org`, `hub`, `settings`, `cross_product_edges`, `products` intact):

```json
  "knowledge_stack": {
    "enabled": true,
    "refresh_day": "sunday",
    "refresh_time": "01:00"
  },
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bash tests/test-registry-schema.sh
```

Expected: `ok: registry-schema`

Also run the full suite to confirm nothing else broke:

```bash
bash tests/run-tests.sh
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add registry.example.json tests/test-registry-schema.sh
git commit -m "feat: add knowledge_stack block to registry schema"
```

---

### Task 2: Add `scripts/weekly.sh` + `tests/test-weekly.sh`

**Files:**
- Create: `scripts/weekly.sh`
- Create: `tests/test-weekly.sh`

This script handles the two mechanical bits: enablement check (exit early if disabled) and orphan cleanup (remove `knowledge-stack/<slug>-*` files whose slug no longer appears in `registry.json`). The slug-prefix match handles multi-word slugs like `jobe-ai` correctly.

- [ ] **Step 1: Write the failing test**

Create `tests/test-weekly.sh`:

```bash
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
```

Make it executable: `chmod +x tests/test-weekly.sh`

- [ ] **Step 2: Run test to verify it fails**

```bash
bash tests/test-weekly.sh
```

Expected: FAIL (script doesn't exist yet).

- [ ] **Step 3: Implement — write `scripts/weekly.sh`**

Create `scripts/weekly.sh`:

```bash
#!/usr/bin/env bash
# weekly.sh
#
# The mechanical half of the weekly Knowledge Stack refresh:
#   1. enablement check (exit cleanly if disabled)
#   2. cleanup of orphaned slug files in knowledge-stack/
#
# Synthesis, agent messaging, URL fetching, manifest writing are agent
# tasks driven by WEEKLY.md — deliberately NOT done here.
set -u

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HUB"

# --- 1. enablement check ---------------------------------------------------
ENABLED="$(python3 -c '
import json
try:
    cfg = json.load(open("registry.json"))
    print("true" if cfg.get("knowledge_stack", {}).get("enabled") else "false")
except Exception:
    print("false")
' 2>/dev/null || echo false)"

if [ "$ENABLED" != "true" ]; then
  echo "weekly: knowledge_stack disabled, exiting"
  exit 0
fi

# --- 2. orphan cleanup -----------------------------------------------------
STACK="$HUB/knowledge-stack"
if [ ! -d "$STACK" ]; then
  echo "weekly: knowledge-stack/ missing, nothing to clean"
  exit 0
fi

SLUGS="$(python3 -c '
import json
print("\n".join(p["slug"] for p in json.load(open("registry.json")).get("products", [])))
' 2>/dev/null)"

removed=0
for f in "$STACK"/*; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  case "$base" in
    MANIFEST.md|00-company-*) continue ;;
  esac
  matched=false
  while IFS= read -r slug; do
    [ -z "$slug" ] && continue
    if [[ "$base" == "${slug}-"* ]]; then
      matched=true
      break
    fi
  done <<< "$SLUGS"
  if ! $matched; then
    rm "$f"
    echo "weekly: removed orphan $base (no matching slug in registry)"
    removed=$((removed + 1))
  fi
done

echo "weekly: $removed orphan file(s) removed"
```

Make it executable: `chmod +x scripts/weekly.sh`

- [ ] **Step 4: Run test to verify it passes**

```bash
bash tests/test-weekly.sh
```

Expected: `ok: weekly.sh`

Run the full suite too:

```bash
bash tests/run-tests.sh
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/weekly.sh tests/test-weekly.sh
git commit -m "feat: add weekly.sh for Knowledge Stack enablement check and orphan cleanup"
```

---

### Task 3: Add `templates/WEEKLY.md`

**Files:**
- Create: `templates/WEEKLY.md`

WEEKLY.md is the document PTL reads when the weekly cron fires (parallel to NIGHTLY.md). It tells PTL what to do, in order.

- [ ] **Step 1: Write the failing test**

Add to `tests/test-templates.sh` (create if it doesn't exist):

```bash
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
```

Make it executable: `chmod +x tests/test-templates.sh`

- [ ] **Step 2: Run test to verify it fails**

```bash
bash tests/test-templates.sh
```

Expected: FAIL with `templates/WEEKLY.md missing`.

- [ ] **Step 3: Implement — write `templates/WEEKLY.md`**

Create `templates/WEEKLY.md`:

```markdown
# WEEKLY.md

Run the weekly Knowledge Stack refresh for this `bizagent` hub.

Do exactly what **AGENT.md § 3 — Operating → Knowledge Stack → Refresh flow**
specifies, and nothing more.

1. Run `scripts/weekly.sh`. It checks `knowledge_stack.enabled` in
   `registry.json` and removes orphaned slug files from `knowledge-stack/`.
   If the script reports "disabled," stop here too — the rest of this pass
   does not apply.

2. Read the header of `knowledge-stack/MANIFEST.md` to get the **last
   refresh timestamp**. If the file does not exist, this is the first
   refresh — treat "last refresh" as the epoch (everything counts as new).

3. **PTL company contribution.** Check `company/` for files with mtime
   newer than the last refresh and scan `journal/` for `[Company]` bullets
   since the last refresh. If both are empty, leave existing
   `00-company-*.md` files in `knowledge-stack/` untouched. Otherwise
   synthesize the company docs (`00-company-overview.md` plus topical files
   like `00-company-mission.md`, `00-company-news.md`) and overwrite prior
   versions.

4. **Per agent.** For each product in `registry.json`, write a message to
   the agent's outbox addressed to the agent (so the router moves it to
   that agent's inbox): subject `"Refresh your Knowledge Stack
   contribution. Last refresh: YYYY-MM-DD."` Run `scripts/router.sh`, spawn
   the agent, collect its reply.
   - If the reply is `no update`, leave the agent's existing `<slug>-*.md`
     files in the stack untouched.
   - Otherwise, write `<slug>-overview.md` from the overview body and
     byte-copy each listed source doc as `<slug>-<basename>.<ext>`.
     Overwrite prior versions.

5. Write a fresh `knowledge-stack/MANIFEST.md`:
   - Header: this run's timestamp.
   - Then one line per file currently in the stack: owner (slug or `hub`),
     source path (for copied source docs) or `synthesized`, last refresh
     date for that file (older than the run timestamp if the file was
     carried forward via "no update").

6. Append a `[Maintenance]` bullet to `journal/YYYY-MM-DD.md` summarising
   the run, e.g. `[Maintenance] Refreshed Knowledge Stack. Updated: W, P.
   No update: T.`

This pass is maintenance only. It must never start product work or anything
that blocks the operator.
```

- [ ] **Step 4: Run test to verify it passes (templates/WEEKLY.md part)**

```bash
bash tests/test-templates.sh
```

Expected: FAIL on `agent.md.template missing Knowledge Stack contribution section` (next task), but the WEEKLY.md assertions should all pass. Verify the failure is only the agent.md.template assertion.

- [ ] **Step 5: Commit**

```bash
git add templates/WEEKLY.md tests/test-templates.sh
git commit -m "feat: add WEEKLY.md template for Knowledge Stack refresh routine"
```

---

### Task 4: Update `templates/agent.md.template` — add Knowledge Stack contribution section

**Files:**
- Modify: `templates/agent.md.template`

- [ ] **Step 1: Test already exists (Task 3 added the agent.md.template assertion).**

Verify it still fails:

```bash
bash tests/test-templates.sh
```

Expected: FAIL with `agent.md.template missing Knowledge Stack contribution section`.

- [ ] **Step 2: Implement — add the section**

Append this section to the end of `templates/agent.md.template` (after `## Responsibilities`):

```markdown

## Knowledge Stack contribution
When PTL sends a message titled "Refresh your Knowledge Stack contribution.
Last refresh: YYYY-MM-DD," examine your activity since that date — commits in
your project repo(s), new specs or papers, sitemap changes — and reply with
one of:

- `no update` if nothing meaningful has changed since the given date, or
- An overview body (markdown, ≤ ~500 words, no padding) followed by a
  `Source docs:` list of paths in your project repo(s) to publish into the
  stack. PTL byte-copies each listed file with a `<slug>-<basename>.<ext>`
  filename.

Reply is the shortest content that fulfills the request (Brevity rule).
```

- [ ] **Step 3: Run test to verify it passes**

```bash
bash tests/test-templates.sh
```

Expected: `ok: templates`

Run the full suite:

```bash
bash tests/run-tests.sh
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add templates/agent.md.template
git commit -m "feat: add Knowledge Stack contribution section to agent template"
```

---

### Task 5: Update `AGENT.md` § 1 (Interview) — add Knowledge Stack opt-in question

**Files:**
- Modify: `AGENT.md`

The interview currently has 9 numbered steps. This task inserts a new step 6 "Knowledge Stack" and renumbers existing 6–9 to 7–10.

- [ ] **Step 1: Write the failing test**

Add to `tests/test-agent-md.sh` (create if it doesn't exist):

```bash
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

echo "  ok: AGENT.md interview"
```

Make it executable: `chmod +x tests/test-agent-md.sh`

- [ ] **Step 2: Run test to verify it fails**

```bash
bash tests/test-agent-md.sh
```

Expected: FAIL on `§ 1 missing Knowledge Stack question (step 6)`.

- [ ] **Step 3: Implement — edit `AGENT.md` § 1**

Find this existing block (lines around 60–69 of AGENT.md, currently steps 5–9):

```
5. **Nightly maintenance time** — default `23:00`.
6. **Archive threshold** — auto-archive inbox messages left unactioned for how
   many days. Default `30`.
7. **Agent autonomy level** — `maintenance-only` (journals, sitemaps, routing),
   `+monitoring` (also flags failing builds / stale branches), or `+light-dev`
   (also makes small changes and proposes them). Default `maintenance-only`.
8. **Hub git remote** — optional; blank means local-only.
9. **CLI agent command** — what launches their agent for the nightly cron
   (e.g. `claude`). Confirm its absolute path with `which`.
```

Replace with:

```
5. **Nightly maintenance time** — default `23:00`.
6. **Knowledge Stack** — `enabled` (default `true`) plus `refresh_day`
   (default `sunday`) and `refresh_time` (default `01:00`) if enabled. The
   Knowledge Stack is a directory of synthesized docs PTL keeps fresh for
   chat-with-documents tools (NotebookLM, MSTY). Skip (`false`) if the
   operator doesn't use such tools.
7. **Archive threshold** — auto-archive inbox messages left unactioned for how
   many days. Default `30`.
8. **Agent autonomy level** — `maintenance-only` (journals, sitemaps, routing),
   `+monitoring` (also flags failing builds / stale branches), or `+light-dev`
   (also makes small changes and proposes them). Default `maintenance-only`.
9. **Hub git remote** — optional; blank means local-only.
10. **CLI agent command** — what launches their agent for the nightly cron
    (e.g. `claude`). Confirm its absolute path with `which`.
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bash tests/test-agent-md.sh
```

Expected: `ok: AGENT.md interview`

- [ ] **Step 5: Commit**

```bash
git add AGENT.md tests/test-agent-md.sh
git commit -m "feat: add Knowledge Stack opt-in to interview (AGENT.md § 1)"
```

---

### Task 6: Update `AGENT.md` § 2 (Setup) — add gated setup step

**Files:**
- Modify: `AGENT.md`

- [ ] **Step 1: Extend `tests/test-agent-md.sh` with § 2 assertion**

Add these lines just before the `echo "  ok: AGENT.md interview"` line in `tests/test-agent-md.sh`:

```bash
# § 2: Knowledge Stack setup step (gated)
grep -q "knowledge_stack.enabled == true" "$A" || fail "§ 2 missing knowledge_stack gating reference"
grep -q "templates/WEEKLY.md"             "$A" || fail "§ 2 does not reference WEEKLY.md template"
grep -q "company/"                        "$A" || fail "§ 2 does not reference company/ directory"
```

Also change the final echo line to `echo "  ok: AGENT.md"` (drop "interview" since we're adding more sections).

- [ ] **Step 2: Run test to verify it fails**

```bash
bash tests/test-agent-md.sh
```

Expected: FAIL on `§ 2 missing knowledge_stack gating reference`.

- [ ] **Step 3: Implement — edit `AGENT.md` § 2**

Find the existing step 5 in § 2 (currently `5. **Write `NIGHTLY.md`** from `templates/NIGHTLY.md`.`). Insert a new step 6 immediately after it:

```
5. **Write `NIGHTLY.md`** from `templates/NIGHTLY.md`.
6. **Set up the Knowledge Stack** — only if `knowledge_stack.enabled == true`
   in the registry. Create `company/` (with a one-line README explaining
   "drop mission, manifesto, press, etc. here — PTL reads on refresh") and
   `knowledge-stack/` (empty). Write `WEEKLY.md` from
   `templates/WEEKLY.md`. The weekly cron line is installed in step 9
   alongside the nightly cron.
```

Renumber existing steps 6–9 to 7–10. Update the nightly-cron step's number and add a second cron line description inside it. The new step 9 should read (four-backtick outer fence used here to allow the inner code block):

````
9. **Install the cron lines.** Build the nightly line and (if
   `knowledge_stack.enabled`) the weekly line, and add them to the
   operator's crontab.
   ```
   <min> <hr> * * *      cd <HUB_ABS_PATH> && <AGENT_CMD> -p "Follow NIGHTLY.md exactly." >> logs/nightly.log 2>&1
   <wmin> <whr> * * <dow> cd <HUB_ABS_PATH> && <AGENT_CMD> -p "Follow WEEKLY.md exactly."  >> logs/weekly.log  2>&1
   ```
   `<dow>` is the day-of-week from `knowledge_stack.refresh_day` (0–6,
   Sunday = 0). This modifies the user's crontab — a side effect outside
   this directory. Show the operator the exact lines and confirm before
   installing.
````

Final step 10 stays as the report step (formerly step 9).

- [ ] **Step 4: Run test to verify it passes**

```bash
bash tests/test-agent-md.sh
```

Expected: `ok: AGENT.md`

Full suite:

```bash
bash tests/run-tests.sh
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add AGENT.md tests/test-agent-md.sh
git commit -m "feat: add Knowledge Stack setup step + weekly cron (AGENT.md § 2)"
```

---

### Task 7: Update `AGENT.md` § 3 (Operating) — add Knowledge Stack subsection + extend Journal format

**Files:**
- Modify: `AGENT.md`

- [ ] **Step 1: Extend `tests/test-agent-md.sh` with § 3 assertions**

Add these lines before the final `echo` in `tests/test-agent-md.sh`:

```bash
# § 3: Knowledge Stack subsection
grep -q "^### Knowledge Stack"            "$A" || fail "§ 3 missing Knowledge Stack subsection"
grep -q "knowledge_stack.enabled == true" "$A" || fail "§ 3 Knowledge Stack section not gated by enabled flag"
grep -q "\[Company\]"                     "$A" || fail "§ 3 does not document the [Company] journal tag"
grep -q "\[Maintenance\]"                 "$A" || fail "§ 3 does not document the [Maintenance] journal tag"
grep -q "company/news/"                   "$A" || fail "§ 3 does not document the URL-fetch landing zone"
grep -q "00-company-"                     "$A" || fail "§ 3 does not document the company file naming convention"

# § 3: hub journal format
grep -q "hub journal"                     "$A" || fail "§ 3 missing hub journal format note"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bash tests/test-agent-md.sh
```

Expected: FAIL on `§ 3 missing Knowledge Stack subsection`.

- [ ] **Step 3: Implement — add the Knowledge Stack subsection**

Find the existing `### Two tiers of work` subsection in § 3. Insert this new subsection immediately after it (before `### Message format`):

```markdown
### Knowledge Stack (opt-in)
Only active when `knowledge_stack.enabled == true` in `registry.json`. If
disabled, ignore this section except for the `[Company]` journal tag below,
which is still applied so a future opt-in has data to work with.

**Three directories** at the hub root:

- `company/` — operator-controlled. Drop mission, manifesto, press, news,
  anything here. PTL writes here **only** when explicitly asked (currently:
  URL fetches land in `company/news/`). You can move, rename, or delete
  anything PTL puts there.
- `journal/` — PTL's notebook. One file per active day
  (`journal/YYYY-MM-DD.md`). Bullets tagged `[Company]` (operator-shared
  business info) or `[Maintenance]` (PTL routing/archiving notes).
- `knowledge-stack/` — published output, fully PTL-owned, regenerated on
  the weekly cron. Operator never edits this directory directly.

**Capture flow (continuous).** When the operator tells you anything about
the business — mission, press, decision, manifesto — immediately append a
`[Company]` bullet to `journal/YYYY-MM-DD.md`. When the operator shares an
article URL, fetch the page, extract the text, save it to
`company/news/YYYY-MM-DD-<slug>.md` with YAML front-matter (`url:`,
`fetched:`, `title:`), and add a `[Company]` journal bullet referencing
the file. Slug is kebab-cased from the article title, ASCII-only, truncated
to ~50 chars; fall back to URL path basename if no title is parseable.
PDFs and other non-HTML URLs are downloaded byte-for-byte. If the fetch
fails (paywall, JS-required, 404, video/tweet with no body), **alert the
operator in your reply** (e.g. "Hit a paywall on <url>. Log in, save as
PDF, drop in `company/news/`.") and journal the URL flagged unfetched.

**Refresh flow.** Driven by the weekly cron via `WEEKLY.md`. See that file
for the exact sequence.

**Naming convention (`knowledge-stack/` only):**

- Company docs: `00-company-<topic>.md` (e.g. `00-company-mission.md`).
  The `00-` prefix sorts company files first.
- Product overview: `<slug>-overview.md`.
- Product source docs: `<slug>-<basename>.<ext>` (PDFs welcome).

`company/` has no naming convention — name files however you want.
```

Then find the existing `### Journal format` subsection. Replace it with:

```markdown
### Journal format
**Project journals:** one file per active day per project,
`<project>/.agent/journal/YYYY-MM-DD.md`. No file on days with no commits.
One bullet per meaningful change. Add `Challenge:` / `Lesson:` lines only
when there is something worth keeping.

**Hub journal:** one file per active day at the hub root,
`journal/YYYY-MM-DD.md`. Bullets tagged `[Company]` (operator-shared
business info — only meaningful when Knowledge Stack is enabled, but
always applied) or `[Maintenance]` (PTL routing, archiving, refresh
summaries). Same prose rules as project journals.
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bash tests/test-agent-md.sh
```

Expected: `ok: AGENT.md`

Full suite:

```bash
bash tests/run-tests.sh
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add AGENT.md tests/test-agent-md.sh
git commit -m "feat: add Knowledge Stack operating section and hub journal format (AGENT.md § 3)"
```

---

### Task 8: Update `AGENT.md` § 4 (Honest limits) — add new bullets

**Files:**
- Modify: `AGENT.md`

- [ ] **Step 1: Extend `tests/test-agent-md.sh` with § 4 assertions**

Add these lines before the final `echo`:

```bash
# § 4: honest limits additions
grep -q "byte-copied" "$A" || fail "§ 4 missing source-doc byte-copy note"
grep -q "PTL does not crawl" "$A" || fail "§ 4 missing 'PTL does not crawl' note"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bash tests/test-agent-md.sh
```

Expected: FAIL on `§ 4 missing source-doc byte-copy note`.

- [ ] **Step 3: Implement — extend § 4**

Find the existing `## § 4 — Honest limits` section. Append these bullets to the existing list (keep the existing three bullets intact):

```
- Knowledge Stack source docs are byte-copied; no transformation. Proprietary
  formats publish as-is.
- `company/` is operator-controlled. PTL writes there only when the operator
  explicitly requests it (currently: successful URL fetches land in
  `company/news/`). The operator can move, rename, or delete anything PTL
  puts there.
- PTL does not crawl. URLs are fetched one at a time in response to the
  operator sharing them; PTL does not follow links or scrape sites.
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bash tests/test-agent-md.sh
```

Expected: `ok: AGENT.md`

Full suite:

```bash
bash tests/run-tests.sh
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add AGENT.md tests/test-agent-md.sh
git commit -m "feat: add Knowledge Stack honest limits (AGENT.md § 4)"
```

---

## Spec coverage check

| Spec section | Implementing task |
| --- | --- |
| Enablement (registry flag, default Y, disabled behavior) | Task 1 (schema), Task 5 (interview), Task 7 (gating note in operating) |
| Three directories | Task 7 (operating subsection) |
| Capture flow + URL handling + paywall alert | Task 7 (operating subsection) |
| Refresh flow | Task 3 (WEEKLY.md) |
| Naming convention | Task 7 (operating), Task 3 (WEEKLY.md) |
| `no update` semantics | Task 3 (WEEKLY.md), Task 4 (agent template) |
| Manifest (header timestamp + per-file lines) | Task 3 (WEEKLY.md) |
| Orphan cleanup | Task 2 (scripts/weekly.sh) |
| Edge cases (paywall/404/non-HTML, etc.) | Task 7 (operating subsection covers paywall + non-HTML; Task 3 WEEKLY.md covers manifest scaffolding for first-run) |
| § 1 / § 2 / § 3 / § 4 integration | Tasks 5, 6, 7, 8 |
| Agent template addition | Task 4 |

## Out of scope (per spec)

- On-demand refresh trigger (PTL just runs the routine when asked verbally)
- URL crawling / link following
- Versioning the published stack (operator may `git add knowledge-stack/`)
- Differential publishing (always full overwrite when an agent reports an update)
