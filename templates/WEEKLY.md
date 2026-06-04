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
