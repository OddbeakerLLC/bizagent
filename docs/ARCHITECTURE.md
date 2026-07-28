# Architecture

This document explains how `bizagent` is built and why. If you only want to
_use_ it, the README and the interview are enough; read this when you want to
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

- **Mailboxes are per recipient**, and live in the hub: `inbox/` and `outbox/`
  at the hub root for the hub itself, `user/inbox` for browser-visible replies,
  and `agents/<slug>/inbox` + `outbox` for each product agent. Messages are
  addressed to known recipient slugs, so the mailbox belongs with the recipient.
  This removes any ambiguity about _where_ a message addressed to a multi-repo
  product should land.
- **Journals and sitemaps are per project**, and live in each project repo:
  `.agent/journal/` and a root `sitemap.md`. These describe a specific
  codebase, so they belong with that codebase and travel with it.

## Two tiers of work

- **Real-time** is the primary path. The operator raises something; the hub
  routes it and spawns the work immediately. Beyond operator-initiated work,
  agent-to-agent mail is picked up in near-real-time by the **Node control
  plane** (see below): an agent reacts to a new message in its inbox within a
  poll or two, not at the next nightly run.
- **Nightly / weekly** is maintenance only — journal entries, sitemap
  refreshes, a knowledge-stack refresh, and archiving of long-stale messages. It
  is time-based housekeeping; it never processes fresh inbox mail (that's the
  control plane's job) and never blocks the operator.

This split exists because the original design started schedule-only and that
felt too slow: an operator reporting a problem wants it picked up now, not at
11 PM, and a message handed agent-to-agent at 09:00 should not sit until 23:00.
The nightly run remains, but only for housekeeping.

## The control plane

`scripts/bizagent-control-plane.js serve` runs a local Node.js server. It hosts
the web UI, requires login for UI/API access, polls inboxes every 2 seconds,
routes queued outbox mail, relays `user/inbox/*.md` replies into web
conversations, updates agent mail status, launches the hub when `inbox/*.md`
has pending mail, and launches product agents with pending mail.
Install it as a systemd user service with
`scripts/install-control-plane.sh`.

The listen address is per instance. Runtime config reads `BIZAGENT_HOST` /
`BIZAGENT_PORT`, then `settings.control_plane.{host,port}` from `registry.json`,
then defaults to `127.0.0.1:8787`. The service installer resolves the same
values, writes them into the generated unit, and names the unit from the hub path
plus a stable hash (or `--name`) so two hubs on one machine do not overwrite each
other's service file.

The server does not replace the hub filesystem with a database:

- Mailboxes still live at `inbox/`, `outbox/`, `user/inbox/`, and
  `agents/<slug>/...`.
- The hub always-on runtime prompt lives in `.bizagent/prompts/hub.md` (slim
  identity/limits/outbox rules; derived for runtime, not a dump of the full
  setup manual). Each hub launch also gets an **ephemeral turn prompt** under
  `.bizagent/prompts/turns/` that injects pending inbox bodies, `conversation_id`,
  and a CP-compacted session excerpt. Hub CLI processes run with cwd
  `.bizagent/runtime-cwd/` (operational symlinks, **no** root `AGENT.md`) so
  workspace project-instructions do not re-run setup §0 “detect built”.
  Historical note: early builds derived hub.md from `AGENT.md §§ 3-4`; the
  always-on file is now a dedicated slim prompt with on-demand path refs.
- Agent launch prompts live in `agents/<slug>/.dispatch.md`, generated from
  `templates/dispatch.md.template`. Dispatch code reads this file instead of
  embedding product-agent prompt text inline.
- Current hub session memory lives in `.bizagent/hub-session.md` as markdown:
  a rolling summary plus recent turns. The **control plane** compacts this file
  on conversation updates; the hub LLM must not rewrite it. A new session file
  starts when the operator changes topic or explicitly creates a new conversation.
- Invalid multi-recipient outbox mail (`to: a, b`), missing `to:`, and
  non-slug `to:` values are moved once to `.bizagent/quarantine/` so they do
  not WARN every poll tick. Unknown but well-formed single slugs still WARN
  (operator may add the product).
- `settings.dispatch.poll_seconds` is honored (default 2, clamped 1–30).
- Product-agent launches get an **ephemeral turn prompt** (like the hub) under
  `.bizagent/prompts/turns/` that inlines pending inbox bodies so agents need
  not tool-list the inbox first. Standing rules still come from
  `agents/<slug>/.dispatch.md`.
- Console-originated hub inbox messages carry `conversation_id`. The launched
  hub sends its operator-visible response or delegation summary as a markdown
  file in `outbox/` addressed to `user` with the same `conversation_id`; the
  router delivers it to `user/inbox/`, and the server relays it into the same
  web conversation. Only the hub root `outbox/` may address `user`; product
  agents still report to the hub. `scripts/bizagent-control-plane.js
  append-hub-turn` remains available for manual repair/imports.
- Login config and salted password hash live in `.bizagent/auth.json`.
- Sessions live in `.bizagent/sessions.json` and are deleted on logout.
- **Enterprise plugin seams (Phase 0):** optional multi-user layer. When
  `settings.enterprise` is absent or `enabled` is not strictly `true`, the hub
  is pure single-operator OSS. When enabled, `control-plane/lib/enterprise-plugin.js`
  resolves `BIZAGENT_ENTERPRISE_PATH` → `package_path` → `package` name, calls
  `register(api)`, and **soft-fails to OSS** if the package is missing or throws.
  The injected `api` exposes `hub`, `registry`, `appDir`, `registerRoute`,
  `getSession`, `requireAuth`, `log`, and a `hooks` map
  (`authProvider`, `resolveUserInbox`, `filterAgents`, `getHubSessionPath`) for
  Phase 1+ packages. Design lives in the private `bizagent-enterprise` repo;
  public OSS never hard-depends on that package.
- Named conversation history lives as JSON files under `.bizagent/conversations/`.
  That UI history is bounded: older raw turns are compressed into a JSON summary
  and the hub runtime reads the markdown session file, not an unbounded transcript.

The design is deliberately minimal:

- **The filesystem is the only ledger.** A pending message is a `.md` file in an
  inbox; a done message is the same file `mv`'d to `inbox/archive/`. The `mv` is
  atomic and crash-safe. There is **no checksum/seen JSON** — inbox filenames
  are write-once and unique, so the file's presence/absence already dedupes.
- **At-least-once delivery.** An agent archives each message _as it finishes
  it_. If an agent crashes, its unhandled messages stay in the inbox and the
  next tick retries them. (So agent work should be safe to re-run; archiving
  each message right after acting on it keeps the re-run window small.)
- **Per-agent lock = mutual exclusion** (the crux). Before launching an agent,
  the control plane acquires `agents/<slug>/.lock` atomically with `mkdir` and
  writes the PID + start-epoch. If the lock already exists, the control plane skips
  that agent — _unless_ the holder PID is dead **or** the lock is older than a
  max lease (default 30 min), in which case the stale lock is reclaimed. This is
  what stops a long run (spanning several ticks) from being launched twice, and
  what recovers from a crash that left a lock behind.
- **Concurrency tiers** (Phase 2): hub and product agents use **separate** slot
  pools so a long hub turn does not consume a product slot (and vice versa).
  Defaults: `hub_slots=1`, `agent_slots` = `max_concurrency` (default **8**).
  Agents over the product cap wait for the next tick. Per-agent locks still
  ensure at most one live instance per slug.

Lease and caps are configurable via env (`BIZAGENT_*`) or
`settings.dispatch.{poll_seconds,max_concurrency,hub_slots,agent_slots,lock_lease_secs}`
in `registry.json`.

CLI selection is **registry + `cli.json`**:

- `cli.json` — catalog of engines (executable, `promptFlag`, headless extras).
- `registry.json` `settings.hub_agent.cliName` and product `cliName` — which
  catalog entry to launch.
- Legacy root `.cli` is **migration-only**: if present and hub `cliName` is
  empty, its `CLI_CMD` supplies the hub name. Flags are never read from `.cli`.

## Messaging

Plain markdown files moved between directories — no database, no broker. Each
message carries a small `from / to / date / subject` header and a plain-English
body kept as terse as the content allows. The control plane reads the `to:` slug
and moves the file to that recipient's inbox. An actioned message is moved to
`inbox/archive/` by the agent that handled it; user reply messages are archived
by the server after relay into the matching conversation. One left _unactioned_
past the configured threshold is auto-archived by the nightly run as cleanup.
Replies are new files — there are no threads.

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

Small scripts do the mechanical work:

- `onboard.sh <path>` — scaffold `.agent/journal/` and `sitemap.md` into a
  project repo. Idempotent.
- `bizagent-control-plane.js` — serve the UI/API, route mail, dispatch agents,
  initialize auth, and generate dispatch prompt files.
- `install-control-plane.sh` — a deliberate, manual one-time helper to write the
  systemd user service. Never run automatically.
- `router.sh`, `bizagent-dispatch.sh`, and `bizagent-watch.sh` — compatibility
  wrappers around the Node control plane.
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
