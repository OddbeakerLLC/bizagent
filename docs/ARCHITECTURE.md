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
  routes it and spawns the work immediately. Nothing waits for a schedule.
- **Nightly** is maintenance only — journal entries, sitemap refreshes, a
  message-routing sweep, and archiving of stale messages. It never starts
  product work and never blocks the operator.

This split exists because the original design started schedule-only and that
felt too slow: an operator reporting a problem wants it picked up now, not at
11 PM. The nightly run remains, but only for housekeeping.

## Messaging

Plain markdown files moved between directories — no database, no broker. Each
message carries a small `from / to / date / subject` header and a plain-English
body kept as terse as the content allows. `router.sh` reads the `to:` slug and
moves the file to that agent's inbox. An actioned message is moved to
`inbox/archive/`; one left unactioned past the configured threshold is
auto-archived by the nightly run. Replies are new files — there are no threads.

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

Three short, dependency-light bash scripts do the mechanical work:

- `onboard.sh <path>` — scaffold `.agent/journal/` and `sitemap.md` into a
  project repo. Idempotent.
- `router.sh` — deliver messages from every outbox to the addressed inbox.
- `nightly.sh` — run the router, then archive messages past the stale
  threshold.

Everything requiring judgment — proposing product groupings, writing journal
prose, refreshing sitemaps, dispatching work — is done by the agent following
`AGENT.md`, not by the scripts. The scripts move files; the agent thinks.

## Extending it

`registry.json` is the source of truth. Adding a product, changing the nightly
time, or adjusting the archive threshold is an edit there followed by re-running
the relevant generation step from `AGENT.md § 2`. The autonomy setting
(`maintenance-only`, `+monitoring`, `+light-dev`) is the main dial for how much
an agent does on its own; it starts conservative on purpose.
