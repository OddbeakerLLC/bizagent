# Architecture

This document explains how `bizagent` is built and why. If you only want to
*use* it, the README and the interview are enough; read this when you want to
change the design.

## The shape: hub and spoke

One **hub** (this repo) and one **agent per product**. An agent owns one or
more **project repositories**. A single project never has more than one agent;
a product never has more than one agent. This keeps the agent count equal to
the product count — small and easy to reason about — even when the project
count is large.

The hub is itself an agent: the **Products Team Lead** (PTL). It receives the
operator's directives, dispatches work to product agents, routes all messages,
and aggregates journals into a "big picture" on request.

## Two levels of state

A deliberate split:

- **Mailboxes are per agent**, and live in the hub: `inbox/` and `outbox/` at
  the hub root for the hub itself, and `agents/<slug>/inbox` + `outbox` for
  each product agent. Messages are addressed agent-to-agent, so the mailbox
  belongs with the agent. This removes any ambiguity about *where* a message
  addressed to a multi-repo product should land.
- **Journals and sitemaps are per project**, and live in each project repo:
  `.agent/journal/` and a root `sitemap.md`. These describe a specific
  codebase, so they belong with that codebase and travel with it.

## Two tiers of work

- **Real-time** is the primary path. The operator raises something; the hub
  routes it and spawns the work immediately. Beyond operator-initiated work,
  agent-to-agent mail is picked up in near-real-time by the **dispatcher** (see
  below): an agent reacts to a new message in its inbox within a tick or two,
  not at the next nightly run.
- **Nightly / weekly** is maintenance only — journal entries, sitemap
  refreshes, a knowledge-stack refresh, and archiving of long-stale messages. It
  is time-based housekeeping; it never processes fresh inbox mail (that's the
  dispatcher's job) and never blocks the operator.

This split exists because the original design started schedule-only and that
felt too slow: an operator reporting a problem wants it picked up now, not at
11 PM, and a message handed agent-to-agent at 09:00 should not sit until 23:00.
The nightly run remains, but only for housekeeping.

## The dispatcher (event-driven inbox processing)

`bizagent-dispatch.sh` runs on a short interval (every 1–2 min via cron or a
systemd `--user` timer; install with `scripts/install-dispatch.sh`). Each tick
it: (1) runs `router.sh` to deliver any queued outbox mail, (2) scans
`agents/<slug>/inbox/*.md` (excluding `archive/`) for agents with pending mail,
and (3) launches each such agent **detached** (`setsid`) to drain its whole
inbox in one run. A tick with no mail is just `ls` + lock checks — it launches
no CLI and spends ~zero tokens.

The design is deliberately minimal:

- **The filesystem is the only ledger.** A pending message is a `.md` file in an
  inbox; a done message is the same file `mv`'d to `inbox/archive/`. The `mv` is
  atomic and crash-safe. There is **no checksum/seen JSON** — inbox filenames
  are write-once and unique, so the file's presence/absence already dedupes.
- **At-least-once delivery.** An agent archives each message *as it finishes
  it*. If an agent crashes, its unhandled messages stay in the inbox and the
  next tick retries them. (So agent work should be safe to re-run; archiving
  each message right after acting on it keeps the re-run window small.)
- **Per-agent lock = mutual exclusion** (the crux). Before launching an agent,
  the dispatcher acquires `agents/<slug>/.lock` atomically with `mkdir` and
  writes the PID + start-epoch. If the lock already exists, the dispatcher skips
  that agent — *unless* the holder PID is dead **or** the lock is older than a
  max lease (default 30 min), in which case the stale lock is reclaimed. This is
  what stops a long run (spanning several ticks) from being launched twice, and
  what recovers from a crash that left a lock behind.
- **Global concurrency cap** (default 4 live runs) bounds how many agents run at
  once under a burst of mail; agents over the cap simply wait for the next tick.

Lease and cap are configurable via env (`BIZAGENT_*`) or
`settings.dispatch.{max_concurrency,lock_lease_secs}` in `registry.json`.

Bootstrapping note: enabling the dispatcher is a deliberate manual step, and the
*first* tick after install is a manual kick (`bash scripts/bizagent-dispatch.sh`)
— nothing can auto-dispatch the dispatcher into existence.

## Messaging

Plain markdown files moved between directories — no database, no broker. Each
message carries a small `from / to / date / subject` header and a plain-English
body kept as terse as the content allows. `router.sh` reads the `to:` slug and
moves the file to that agent's inbox. An actioned message is moved to
`inbox/archive/` by the agent that handled it; one left *unactioned* past the
configured threshold is auto-archived by the nightly run as cleanup. Replies are
new files — there are no threads.

File-based messaging was chosen over a database or git-commit log because it is
trivially auditable (every message is a file you can open), needs no
infrastructure, and is easy for both humans and agents to inspect and debug.

## Journals and sitemaps

A **journal** entry is written only on days a project actually changed — think
of it as a git log rewritten for a non-coder, one bullet per meaningful change,
with an optional `Challenge:` / `Lesson:` note when something was worth
learning. A **sitemap** is a living structure map of a repo — overview, file
tree, integrations, active work, known issues — refreshed when commits land.

Together they let the operator peek at any single `sitemap.md` for one
project's state, or ask the hub to read every journal for the whole portfolio.

## The scripts

Short, dependency-light bash scripts do the mechanical work:

- `onboard.sh <path>` — scaffold `.agent/journal/` and `sitemap.md` into a
  project repo. Idempotent.
- `router.sh` — deliver messages from every outbox to the addressed inbox.
- `bizagent-dispatch.sh` — one dispatcher tick: route, scan inboxes, lock, and
  launch agents with mail (detached) under a concurrency cap. Cheap when idle.
- `install-dispatch.sh` — a deliberate, manual one-time helper to wire the
  dispatcher to cron or a systemd `--user` timer. Never run automatically.
- `nightly.sh` — run the router, then archive messages past the stale
  threshold (time-based housekeeping only).

Everything requiring judgment — proposing product groupings, writing journal
prose, refreshing sitemaps, doing the actual product work — is done by the agent
following `AGENT.md`, not by the scripts. The scripts move files and launch
agents; the agents think.

## Extending it

`registry.json` is the source of truth. Adding a product, changing the nightly
time, or adjusting the archive threshold is an edit there followed by re-running
the relevant generation step from `AGENT.md § 2`. The autonomy setting
(`maintenance-only`, `+monitoring`, `+light-dev`) is the main dial for how much
an agent does on its own; it starts conservative on purpose.
