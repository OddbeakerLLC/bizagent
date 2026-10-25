# WEEKLY.md

Run the weekly Knowledge Stack refresh for this `bizagent` hub.

**This file describes the full refresh flow. The mechanical steps are now
implemented in `scripts/weekly-refresh.sh`, which orchestrates the process
with minimal LLM usage. Only the two judgment steps invoke LLM:**

1. **PTL company synthesis** — when company files or `[Company]` journal
   bullets have changed since the last refresh.
2. **Each product agent's decision** — whether to update their contribution
   or report "no update".

---

## How the refresh works

The weekly cron runs `scripts/weekly-refresh.sh`, which:

1. **Enablement check** — reads `knowledge_stack.enabled` from `registry.json`
   and exits cleanly if disabled.

2. **Orphan cleanup** — runs `scripts/weekly.sh` to remove slug files from
   `knowledge-stack/` that no longer match any product in the registry.

3. **Timestamp read** — reads the last refresh timestamp from
   `knowledge-stack/MANIFEST.md` (epoch if missing).

4. **Company change detection** — checks `company/` for files newer than the
   last refresh and scans `journal/` for `[Company]` bullets since then.

5. **Company synthesis (if changes)** — writes a request to the hub inbox
   and spawns the PTL agent to synthesize `00-company-*.md` files.

6. **Per-agent refresh** — for each product in `registry.json`:
   - Writes a request to the agent's inbox
   - Runs the router
   - Spawns the agent
   - Collects the reply (update or "no update")
   - Archives the request

7. **Manifest write** — writes a fresh `knowledge-stack/MANIFEST.md` with
   this run's timestamp and all current files. Copied docs with recorded
   provenance get a `| src: <project>/<path>@<sha>` field; docs removed by
   reconciliation are listed under "Removed this refresh".

8. **Journal bullet** — appends a `[Maintenance]` bullet to `journal/YYYY-MM-DD.md`.

Between steps 6 and 7, claim provenance runs: updated agents get their
overview's `Claims:` block recorded and the claim-checks footer stamped;
"no update" agents get a quiet-week spot-check of their least-recently-checked
claims (see "Claim-level provenance and quiet-week spot-checks" below).

---

## Provenance and removal reconciliation

The timestamp-based refresh has a blind spot: a spec deleted from a product
repo stops appearing among "files newer than the last refresh", but its stale
copy in `knowledge-stack/` keeps answering questions as if current. The
refresh closes this gap with provenance tracking in
`scripts/lib/ks-provenance.sh` (sourced by `weekly-refresh.sh`):

- **Sidecar** — `knowledge-stack/.provenance.json` maps each copied stack
  file to its owner slug, registry project name, repo-relative source path,
  source git SHA, content hash, and copy timestamp. It is operator data:
  `scripts/upgrade.sh` preserves `knowledge-stack/` wholesale, so the sidecar
  survives upgrades.
- **Capture** — after a product agent reports an update, the refresh parses
  the reply's `Source docs:` list (the existing agent.md convention) and
  matches it against the `<slug>-<basename>.<ext>` files the agent copied.
  Docs it cannot resolve are left untracked — never guessed.
- **Removal reconciliation** — before agents run each week, any stack copy
  whose recorded source file no longer exists in its project repo is removed
  and logged. Safety rules: files without resolved provenance (legacy stacks)
  are never touched, and a missing project directory (repo not cloned) is
  treated as "cannot verify" — skipped, not deleted.
- **Overview revision stamping** — after an update, the slug's
  `<slug>-overview.md` gets an HTML-comment `<!-- ks-provenance ... -->`
  footer listing the source paths and revisions it summarizes (replaced, not
  duplicated, on each refresh). PTL can then distinguish "current product
  state" from "what the stack knew at last refresh".

Backward compatibility: existing `MANIFEST.md` files keep working unchanged
(the `Last refresh:` header format is untouched); stacks without a sidecar
simply have nothing to reconcile until agents start reporting `Source docs:`.

---

## Claim-level provenance and quiet-week spot-checks

Provenance + removal reconciliation catches source docs that get deleted, but
not the failure mode where an overview was wrong when it was written ("the
login rewrite is finished" while it was half done). Nothing removes that line;
on quiet weeks the agent replies "no update" and the claim gets older and
sounds more settled every time it is quoted. The refresh closes this gap:

- **Claims block** — product agents list their overview's factual claims
  under a `Claims:` heading, one bullet per claim, each ending with a source
  reference in brackets: `- Login rewrite is finished [src: <project>/<path>]`
  or `- v2.1 shipped on 2026-10-01 [src: <project>@<commit>]`. This builds on
  the `Source docs:` convention (same `[src: ...]` shape as the MANIFEST's
  `| src:` field) — no new protocol. Claims without a ref are recorded but
  cannot be mechanically re-verified.
- **Recording** — after an update, the refresh parses the overview's
  `Claims:` block into the sidecar (`claims` key: id = hash of the claim
  text, owner slug, text, src ref, recorded_at, last_checked). Re-recording
  the same claim text keeps its id and last_checked date — only recorded_at
  moves. Claims dropped from the overview stay in the sidecar but are no
  longer stamped into the footer.
- **Quiet-week spot-check** — when an agent replies "no update", the refresh
  does not just trust the timestamp: it picks up to
  `KS_PROV_SPOT_CHECK_N` (default 3) of that slug's least-recently-checked
  claims and re-verifies each against its recorded source (file exists in
  the project repo / commit exists). Verified claims get
  `last_checked = today`; a claim whose source ref no longer resolves is
  logged as `CLAIM-STALE` for the agent to resolve next week. Claims with no
  resolvable ref are logged as `CLAIM-UNVERIFIABLE` (agent judgment only).
- **Checked-vs-unchecked visibility** — the overview gets a visible
  `<!-- ks-claim-checks ... -->` footer (replaced, not duplicated) listing
  every live claim with its ref and last-checked date; never-checked claims
  say so explicitly. PTL can thus tell a claim someone verified last week
  from one nobody has looked at since March. The footer is an HTML comment,
  so rendered markdown stays clean while the raw file carries the state.

Backward compatibility: overviews without a `Claims:` block are untouched
(no footer, no sidecar entries); existing sidecars gain an empty `claims`
key only when the first claims are recorded.

---

## Agent responsibilities

### Hub agent (PTL)

When spawned for company synthesis:

- Read `company/` for files newer than the last refresh
- Scan `journal/` for `[Company]` bullets since the last refresh
- If changes exist:
  - Write `00-company-overview.md` to `knowledge-stack/`
  - Write topical files (`00-company-mission.md`, `00-company-news.md`, etc.)
  - Overwrite prior versions
- If no changes, leave existing `00-company-*.md` files untouched
- Archive the synthesis request message

### Product agents

When spawned for Knowledge Stack refresh:

- Review your project(s) for changes since the last refresh
- If meaningful updates:
  - Write `<slug>-overview.md` to `knowledge-stack/`
  - Copy source documents as `<slug>-<basename>.<ext>`
  - List every copied file's repo-relative path under a `Source docs:` heading
    in your reply — this is recorded as provenance, and stack copies whose
    source later disappears are removed automatically on refresh
  - List the overview's factual claims under a `Claims:` heading, one bullet
    per claim, each ending with a source reference in brackets
    (`[src: <project>/<path>]` or `[src: <project>@<commit>]`) — this lets the
    refresh re-verify the claim against your repo and show when it was last
    checked
- If no meaningful updates, reply with "no update" — your existing files are
  preserved and the refresh spot-checks a few of your carried-over claims
  against your repo, recording which ones were re-verified (with date)
- Archive the refresh request message

---

## Cron line

The weekly cron should invoke the script directly:

```
<wmin> <whr> * * <dow> <HUB_ABS_PATH>/scripts/weekly-refresh.sh >> <HUB_ABS_PATH>/logs/weekly.log 2>&1
```

Where `<dow>` is the day-of-week from `knowledge_stack.refresh_day` (0–6, Sunday = 0).

This replaces the previous approach of running `run-agent.sh "Follow WEEKLY.md exactly."`,
which could exceed `MAX_ITERATIONS` with many products.