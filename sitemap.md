# bizagent-public — Sitemap

## Overview
Open-source BizAgent control plane: Node server, CLI dispatch, web console, mail routing, hub/agent launches.

## Structure
- `control-plane/` — server.js + lib (auth, cli-config, config, conversations, dispatcher, hub-memory, hub-turn-safety, mail, profile, log) + public UI
- `scripts/` — control-plane CLI, install, router/dispatch wrappers
- `templates/` — agent/dispatch/NIGHTLY/WEEKLY templates
- `docs/` — ARCHITECTURE, LATENCY-OPTIMIZATION-PLAN (+ superpowers specs)
- `tests/` — shell test suite (control-plane + dispatch)

## Key Integrations
- CLI agents via `cli.json` (`promptFlag` path flag; grok `--prompt-file`)
- Registry `settings.dispatch.poll_seconds` / max_concurrency / hub_slots / agent_slots / lock_lease
- Hub + product-agent turn injection; hub runtime-cwd isolation
- Active console conversation stamp for hub→user mail (`active-conversation.json`, 30s TTL)
- Originating in-flight hub turn preferred over active tab when stamping missing `conversation_id`
- CP launch ack + hub outbox safety net (`hub-turn-safety.js`, pending-hub-turns.json)
- Reserved operator reply body path (`.bizagent/pending-replies/<id>.body.md`) + mandatory `write-message.sh`
- Console profile (`.bizagent/profile.json`) for display name in chat attribution
- Stdout is debug-only; safety net promotes log blob only as last resort, else hard in-UI fail

## Active Work
- All six control-plane fixes from 2026-07-24 nightly committed on main: control-plane.sh PID discovery (`edf0ea5`), web UI chat sessions (`ce11041`), console interim status (`34b7280`), wrong-channel hardening (`b77d0b9`), write-message helper (`6a69c46`), launch-ack + safety net (`577bb31`).
- Enterprise layer design lives only in private `bizagent-enterprise`. No OSS implementation yet; recommended first PR = Phase 0 plugin seam.
- Latency Phase 0–2 complete on main. Phase 3 (warm hub/stream) not started — needs hub approval.

## Known Issues
- Live hub public→live drift is manual (sync control-plane/ + scripts/ + CP restart)
- Launch-ack / safety-net / reserved-reply / profile need CP restart on live hub after public→live sync
- Nested `.bizagent/runtime-cwd` scaffolding can deepen if runtime-cwd is re-entered; monitor if disk growth appears
