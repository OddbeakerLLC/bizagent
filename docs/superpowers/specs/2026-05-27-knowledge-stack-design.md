# Knowledge Stack — Design

## Problem

The operator wants a directory of well-organized documents consumable by
chat-with-your-documents tools (NotebookLM, MSTY, etc.) without manual
maintenance. The hub already has a working agentic structure (PTL + product
agents); the Knowledge Stack should be a natural extension of that — agents
synthesize what they know, PTL adds company-level context, everything lands in
a clean published directory on a weekly cadence.

## Enablement

The Knowledge Stack is **opt-in**, asked once during the interview (default Y).
Stored in `registry.json`:

```json
"knowledge_stack": {
  "enabled": true,
  "refresh_day": "sunday",
  "refresh_time": "01:00"
}
```

**If disabled:**
- Setup skips creating `company/`, `knowledge-stack/`, and `WEEKLY.md`. The weekly cron line is not installed.
- PTL's capture flow still writes `[Company]` journal entries when the operator shares business info (zero cost, preserves data for future opt-in), but PTL does **not** fetch URLs and does **not** run the refresh routine.
- Operator can enable later by flipping the flag and rerunning the directory/cron creation step. Existing `[Company]` journal entries are picked up on the first refresh.
- Disabling after enablement leaves existing files in place; operator deletes them manually if desired.

Everything below describes enabled behavior.

## Three directories

| Directory | Owner | Purpose |
| --- | --- | --- |
| `company/` | Operator-controlled. PTL writes only when explicitly asked (e.g., URL fetch). | Raw source files about the company — mission, manifesto, press, news, anything. Name files however you want. Subdirectories OK; PTL recurses. |
| `journal/` | PTL | PTL's notebook. One file per active day (`YYYY-MM-DD.md`). Bullets tagged `[Company]` (operator-shared business info) or `[Maintenance]` (PTL routing/archiving notes). The `journal/` directory itself already exists in the current setup spec; this design adds the tagging convention and the `[Company]` use case. |
| `knowledge-stack/` | PTL (fully owned, refreshed on cron) | Published output. Operator never edits this directory directly. |

## Capture flow (continuous, during the week)

When the operator tells PTL anything about the business — a new mission, a
press hit, a strategic decision — PTL immediately appends a `[Company]` bullet
to `journal/YYYY-MM-DD.md`. No batching. The journal is the canonical record
of operator-shared facts between refreshes.

**URL handling.** When the operator shares an article URL ("there's a piece on
us at https://..."), PTL fetches the page, extracts the readable text, and
writes it to `company/news/YYYY-MM-DD-<slug>.md` with YAML front-matter
(`url:`, `fetched:`, `title:`). The `<slug>` is kebab-cased from the article
title, ASCII-only, truncated to ~50 chars; if no title is parseable, fall back
to the URL's path basename. The corresponding `[Company]` journal bullet
references the saved file. Reply to the operator stays under the Brevity rule
(e.g. *"Saved 'Title' to `company/news/`. Will appear in next refresh."*).

If the fetch fails — paywall, JS-required page, 404, or a tweet/video with no
extractable body — PTL **alerts the operator in the immediate reply** (e.g.
*"Hit a paywall on <url>. Log in, save as PDF, drop in `company/news/`."*) and
journals the URL as a `[Company]` bullet flagged unfetched. Nothing is written
to `company/news/` in this case.

PDFs and other non-HTML URLs are downloaded byte-for-byte to `company/news/`.
NotebookLM accepts them.

PTL does **not** touch `knowledge-stack/` during the week. Only `journal/` and
(on URL fetch) `company/news/`.

## Refresh flow (weekly cron, or ad-hoc operator request)

PTL drives the whole routine, in order:

**1. PTL's own contribution.**

- Check `company/` for any files with mtime newer than the last refresh.
- Scan `journal/` for any `[Company]` bullets since the last refresh.
- If both are empty → leave the existing `00-company-*.md` files in the stack untouched.
- Otherwise → synthesize from `company/` + `[Company]` journal entries into the stack. PTL decides how to break the synthesis into files (e.g., `00-company-overview.md`, `00-company-mission.md`, `00-company-news.md`). Overwrite prior versions.

**2. Per-agent contribution.**

For each product agent in `registry.json`:

- PTL sends a message to the agent's inbox: *"Refresh your Knowledge Stack contribution. Last refresh: YYYY-MM-DD."*
- The agent inspects its activity since that date and decides:
  - **No update.** Replies `no update`. PTL leaves the agent's existing `<slug>-*.md` files in the stack untouched.
  - **Update.** Replies with:
    - An **overview body** (markdown, no padding) — current state of the product, recent changes, roadmap.
    - A **list of source-doc paths** in the project repo to publish — specs, RFCs, papers, design docs. The agent chooses what counts as "knowledge-worthy" from its own understanding of the project; no designated directory is required.
- PTL writes `<slug>-overview.md` and byte-copies each source doc as `<slug>-<basename>.<ext>`. Overwrite prior versions.

**3. Cleanup.**

Remove any files in the stack whose owning slug is no longer present in
`registry.json` (product was deleted or renamed).

**4. Manifest.**

Write `knowledge-stack/MANIFEST.md`:
- Header line: this run's timestamp. The next refresh reads it to compute "last refresh" — that's the single source of truth for mtime checks and the date PTL sends each agent.
- Then one line per file: owner, source path (for copied source docs) or `synthesized`, last refresh date for that file (older than the run timestamp if the file was carried forward via "no update").

**5. Hub journal entry.**

PTL appends a `[Maintenance]` bullet: *"Refreshed Knowledge Stack. Updated:
W, P. No update: T."*

## Naming convention (knowledge-stack/ outputs only)

| Pattern | Example | Notes |
| --- | --- | --- |
| `00-company-<topic>.md` | `00-company-mission.md` | PTL output. `00-` prefix sorts company files first alphabetically. |
| `<slug>-overview.md` | `widgets-overview.md` | One per product. |
| `<slug>-<basename>.<ext>` | `widgets-api-spec.md`, `platform-architecture.pdf` | Source docs copied from the project repo. Slug prefix prevents collisions across products. PDFs welcome. |

`company/` has **no naming convention** — operator names files however they
want.

## What "no update" means

A token-saving optimization aligned with the new Brevity rule in AGENT.md § 3.
The agent has done the work of checking its own activity; PTL skips
regeneration for that agent and leaves the prior published files in place. The
MANIFEST line for those files retains its original refresh date so consumers
can see when each doc was last refreshed.

## Integration with AGENT.md

**§ 1 (Interview) additions:**
- New question: enable Knowledge Stack? (default Y). If yes, ask weekly refresh day + time (default Sunday 01:00). Skip both questions about mission/manifesto content — operator drops those into `company/` whenever they want; the interview just creates the directory and notes its purpose.

**§ 2 (Setup) additions** (gated on `knowledge_stack.enabled == true`):
- Create `company/` with a short README explaining its purpose.
- Create `knowledge-stack/` (empty).
- Write `WEEKLY.md` (parallel to existing `NIGHTLY.md`) describing the refresh routine PTL follows.
- Install a second cron line for the weekly refresh, mirroring the nightly cron line format.

**§ 3 (Operating) additions:**
- New subsection "Knowledge Stack" covering the three dirs, capture flow, refresh flow, and naming convention. **First line:** *"Only active when `knowledge_stack.enabled == true` in `registry.json`. If disabled, ignore this section except for the `[Company]` journal tag, which is still applied so a future opt-in has data to work with."*
- Document hub journal format (parallel to the existing project journal format spec): `journal/YYYY-MM-DD.md`, one file per active day, bullets tagged `[Company]` or `[Maintenance]`.

**§ 4 (Honest limits) additions:**
- Source docs are byte-copied; no transformation. Proprietary formats publish as-is.
- `company/` is operator-controlled. PTL writes there only when the operator explicitly requests it (currently: successful URL fetches land in `company/news/`). Operator can move, rename, or delete anything PTL puts there.
- PTL does not crawl. URLs are fetched one at a time in response to the operator sharing them; PTL does not follow links or scrape sites.

**`templates/agent.md.template` additions:**
- New section "Knowledge Stack contribution" — when PTL sends a refresh request, examine activity since the given date. If nothing meaningful changed → reply `no update`. Else → overview body + source-doc path list. Reply is the shortest content that fulfills the request (Brevity rule).

## Edge cases

- **Empty `company/` and no `[Company]` journal entries since last refresh.** PTL's contribution step does nothing. Existing `00-company-*.md` files remain.
- **Agent doesn't reply within a reasonable window.** Treat as `no update`. Log in the hub journal.
- **Operator renames a product slug.** Old `<old-slug>-*.md` files get deleted in the cleanup step; new `<new-slug>-*.md` files get written on the next refresh.
- **A source-doc path the agent listed doesn't exist.** Skip it, note in the hub journal.
- **`company/` file deleted by operator.** Next refresh regenerates from current `company/` state — the deleted file's content is no longer reflected in PTL's synthesis.
- **`company/` file has the same basename as a product's source doc.** No conflict — PTL's outputs use the `00-company-*` prefix and agents' outputs use `<slug>-*`. Collisions are prevented by construction.
- **Paywall or JS-required article fetch.** PTL alerts the operator in the immediate reply with the URL and a suggestion to save the article manually as PDF into `company/news/`. The journal entry preserves the URL flagged unfetched.
- **404 or network error on article fetch.** Same as paywall — alert in reply, journal entry with URL.
- **Non-HTML URL fetched.** PDFs downloaded as-is to `company/news/`. Other types (image, video, tweet) fetched best-effort; if no readable body, falls into the failure path above.

## Out of scope (v1)

- On-demand refresh as a designed feature. Operator can always say "refresh the stack now" and PTL runs the same routine — no special trigger needed.
- Versioning or history of the published stack. The operator can `git add knowledge-stack/` if they want history.
- Differential publishing (only changed sections of an overview). v1 always overwrites the whole file when an agent reports an update.
