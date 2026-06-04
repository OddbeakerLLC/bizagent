# NIGHTLY.md

Run the nightly maintenance pass for this `bizagent` hub.

Do exactly what **AGENT.md § 3 — Operating → Two tiers of work → Nightly**
specifies, and nothing more:

1. Route any queued messages (`scripts/nightly.sh` handles routing + stale-
   message archiving mechanically).
2. For each project in `registry.json`, run `git log --since=midnight` to
   detect the day's commits.
3. For each project with activity, refresh its root `sitemap.md` and add a
   `.agent/journal/YYYY-MM-DD.md` entry — plain English, one bullet per
   meaningful change, with `Challenge:` / `Lesson:` lines where warranted.
4. If any work was done this run, add a hub journal entry under `journal/`.

This pass is maintenance only. It must never start product work or anything
that blocks the operator — those happen in real time, on request.
