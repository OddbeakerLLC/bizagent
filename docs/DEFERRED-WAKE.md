# Deferred wake / poll-after

**Status:** Built (MVP) — 2026-08-07  
**Owner:** Hub scripts (+ light CP/hub-daemon glue); product agents are **callers only**  
**Goal:** Let hub or any product agent say “wake me in N minutes with this reminder,” without a standing heartbeat process.

## Problem

Fixed-schedule maintenance (nightly / weekly) and on-demand mail cannot cover mid-task follow-ups, e.g. “check a long job every 15 minutes until done.” A continuous heartbeat daemon is overkill. Deferred wake delivers a **one-shot mail** that re-enters the normal inbox → route → dispatch path.

## Design principles

1. **Mail is the wake signal.** Delivery = a normal `.md` message in the target inbox.
2. **No always-on poller** for the feature. Prefer OS one-shot timers (`systemd-run --on-active=…`, `at`, or a sleep child).
3. **Reuse existing pipes.** After the message lands, router / watch / CP dispatch behave as today.
4. **Idempotent and cancelable.** Every defer has a stable `defer_id`; cancel removes the pending job.
5. **Bounded.** Caps on delay, body size, and outstanding defers per agent.
6. **Hub-owned machinery; agents only call the CLI.** Do not hand-edit `.bizagent/defer/`.
7. **Survives CP restarts when possible.** Durable timer + on-disk payload; `--reconcile` on hub-daemon start and nightly.

## CLI

```bash
# Schedule
scripts/defer.sh \
  --to <slug|hub> \
  --from <slug|hub> \
  --in <duration> \
  --subject "short subject" \
  --body "…"                 # or --body-file PATH
  [--id <defer_id>]          # optional; auto-generated if omitted
  [--conversation-id <id>]   # optional; hub console thread only
  [--once-key <key>]         # optional dedupe key

# Cancel / list / reconcile
scripts/defer.sh --cancel <defer_id>
scripts/defer.sh --list [--to <slug>]
scripts/defer.sh --reconcile
```

**Duration grammar:** `Nm` / `Nmin`, `Nh` / `Nhr`, `Nd`, or integer seconds.

| Limit | Default |
| --- | --- |
| Min delay | 1 minute |
| Max delay | 7 days |
| Max pending per `to` | 20 |
| Max body size | 32 KiB |
| Max subject length | 120 chars |

## On-disk layout

```text
.bizagent/defer/
  pending/
    <defer_id>.json
    <defer_id>.body.md
  fired/
  cancelled/
  locks/
```

Example metadata:

```json
{
  "id": "20260807T0745Z-alpha-a1b2c3",
  "to": "alpha",
  "from": "alpha",
  "subject": "wake: check long job",
  "created_at": "2026-08-07T07:45:00Z",
  "fire_at": "2026-08-07T08:00:00Z",
  "delay_seconds": 900,
  "conversation_id": null,
  "once_key": "alpha:job-poll",
  "status": "pending",
  "timer_backend": "systemd-run",
  "timer_ref": "bizagent-defer-20260807T0745Z-alpha-a1b2c3.service",
  "hub_root": "/path/to/hub"
}
```

`defer_id` format: `YYYYMMDDTHHMMSZ-<to>-<6 hex>` (UTC).

## Fire path

Internal helper (not for casual agent use):

```bash
scripts/lib/defer-fire.sh <defer_id> [--hub PATH]
```

Timer backends (first available wins): **systemd-run --user** → **at** → **sleep** child.

On fire: claim pending record → write inbox mail with frontmatter including `kind: defer-wake` and `defer_id` → move record to `fired/`.

## Message contract

```yaml
---
from: alpha
to: alpha
date: 2026-08-07
subject: wake: check long job
defer_id: 20260807T0745Z-alpha-a1b2c3
kind: defer-wake
---
```

Body is exactly what the scheduler put in `--body`. Recommended caller template:

```markdown
## Deferred wake

**Why:** Poll long job X.
**Check:** … ; success = … ; fail = …
**If still running:** reschedule same `--once-key`.
**If done / failed:** mail hub; do not reschedule.
```

## Who may schedule what

| Caller | May `--to` | Notes |
| --- | --- | --- |
| Product agent | Self | Default self-wake for polls |
| Product agent | `hub` | Allowed; body must be complete |
| Product agent | Other product slug | **Disallowed** in MVP |
| Hub | Any slug or `hub` | Full access |

Enforcement: `defer.sh` checks `from`/`to` against `registry.json` products + `hub`.

## Deduping (`once_key`)

If `--once-key` is set and a **pending** record already has the same `to` + `once_key`, the new schedule **replaces** the old one (cancel old timer, write new fire time/body). Ideal for poll loops.

## Reconcile

`scripts/defer.sh --reconcile`:

- Overdue pending → fire now
- Dead sleep-backend PIDs / missing timers for future work → reschedule
- Invoked best-effort on **hub-daemon start** and during **nightly.sh**

## Observability

- `logs/defer.log` — schedule / fire / cancel / reconcile
- `defer.sh --list` — id, to, fire_at, subject, once_key, backend

## Non-goals (MVP)

- Not a general cron/workflow engine
- Not a substitute for nightly/weekly
- Not cross-host scheduling (timer runs on the hub machine only)
- Not sub-minute precision (1 minute floor)

## Example

```bash
scripts/defer.sh \
  --to alpha \
  --from alpha \
  --in 15m \
  --once-key "alpha:job-poll" \
  --subject "wake: poll long job" \
  --body "## Deferred wake
Check job X.
- If running: reschedule same once-key in 15m.
- If succeeded: mail hub; do not reschedule.
- If failed: mail hub with log tail; do not reschedule."
```

## Implementation files

- `scripts/defer.sh` — schedule / cancel / list / reconcile
- `scripts/lib/defer-fire.sh` — one-shot delivery
- `scripts/hub-daemon.js` — `--reconcile` on start
- `scripts/nightly.sh` — mechanical reconcile
- `templates/agent.md.template` + `templates/dispatch.md.template` — agent ops blurb
- `control-plane/lib/hub-memory.js` — hub runtime prompt blurb
- `control-plane/lib/dispatcher.js` — refresh `.dispatch.md` from template each launch so ops updates reach agents
