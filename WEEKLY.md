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
   this run's timestamp and all current files.

8. **Journal bullet** — appends a `[Maintenance]` bullet to `journal/YYYY-MM-DD.md`.

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
- If no meaningful updates, reply with "no update"
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