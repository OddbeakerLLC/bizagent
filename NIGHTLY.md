# NIGHTLY.md

Run the nightly maintenance pass for this `bizagent` hub.

Do exactly what **AGENT.md § 3 — Operating → Two tiers of work → Nightly**
specifies, and nothing more:

1. **Mechanical half first:**
   ```sh
   bash scripts/nightly.sh
   ```
   (if `settings.auto_update` is true, runs `scripts/upgrade.sh --yes` first;
   then pulls project repos + hub if remotes exist; routes mail; archives stale
   inbox messages; prunes old `*/archive/` files. Default auto_update is false.)

2. For each project in `registry.json`, run `git log --since=midnight` to
   detect the day's commits.

3. For each project with activity, spawn its product agent to refresh root
   `sitemap.md` and add a `.agent/journal/YYYY-MM-DD.md` entry — plain English,
   one bullet per meaningful change, with `Challenge:` / `Lesson:` lines where
   warranted. After the agent finishes, if that project repo has a git remote,
   ensure journal/sitemap changes are committed (agent or you).

4. If any work was done this run, add a hub journal entry under `journal/`.

5. **Backup / push (required when remotes exist):**
   ```sh
   bash scripts/nightly.sh push
   ```
   This commits dirty trees and pushes:
   - each **product project** repo that has a remote (code + journals/sitemaps)
   - the **hub** ops repo itself (registry, `agents/*/agent.md`, `journal/`,
     `company/`, `knowledge-stack/`, local code tweaks) **if** the hub has a
     private remote

   The hub must **never** push to the public BizAgent framework remote. If the
   hub has no remote, log a reminder: set a private `origin` or
   `registry.json` → `hub.remote` (see `scripts/detach-framework-remote.sh`).

This pass is maintenance only. It must never start product work or anything
that blocks the operator — those happen in real time, on request.
