# BizAgent latency & efficiency optimization plan

**Date:** 2026-07-24  
**Author:** Agent B (bizagent-oss)  
**Status:** Phase 0–2 implemented (2026-07-24). Phase 3 (warm hub) only with hub approval.  
**Scope:** Control plane, hub PTL launches, product-agent launches  
**Measured on:** Live hub `/home/tmanso/bizagent` + OSS tree `bizagent-public` @ `7dc024d`

---

## 1. Executive summary

The model path works. Latency is dominated by **cold CLI agent runs that rediscover context every turn**, not by mail routing or the 2s poll loop.

| Path | Measured | Dominant cost |
| --- | ---: | --- |
| Operator “Hi” → hub reply | **33.3s** | Agent wall ~32.0s; poll lag ~1.3s |
| Trivial hub first-replies (short ack) | **~18–33s** | Same cold discovery tax |
| Product status snapshot (per agent) | **p50 ~36s**, min 30 / max 90 | Cold CLI + agent.md/sitemap reads |
| 10-agent status fanout end-to-end | **~286s** | Per-agent ~30–90s **plus** `max_concurrency=4` queue (~240s launch span) |
| CP tick (route + dispatch, dry) | **~1.2ms** | Negligible |
| Binary `grok --help` | **~40ms** | Process start is not the bottleneck |

**Bottom line:** Fix context injection and prompt isolation first. Expect “Hi”-class p95 to fall from ~30s+ into the **sub-10–15s** band without a long-lived process; warm hub is optional phase 2 if still needed.

---

## 2. Measurement method (reproducible)

Sources used (no production write tests):

1. **Conversation JSON** — `.bizagent/conversations/2026-07-19-bizagent-6ea565.json` message `created_at` pairs (user → first hub).
2. **Control-plane log** — `logs/control-plane.log` `launched` / `routed` timestamps (2s resolution on tick, ms on log line).
3. **Hub agent log** — `logs/dispatch-hub.log` narration patterns (“System is built”, “session memory”, “pending inbox”).
4. **Code path audit** — `control-plane/server.js`, `lib/dispatcher.js`, `lib/hub-memory.js`, `lib/mail.js`, `lib/conversations.js`, `lib/cli-config.js`.
5. **Microbenches** — Node `ensureHubRuntimePrompt` (~0.3ms), dry `routeOutboxes`+`dispatchPendingAgents` (~1.2ms/tick). No live “Hi” re-send (would burn another cold launch).

### 2.1 Canonical “Hi” breakdown (2026-07-24)

| Stage | Timestamp (UTC) | Δ |
| --- | --- | ---: |
| User message written | `00:38:24.705` | 0 |
| Hub launched | `00:38:26.010` | **+1.30s** poll/dispatch |
| Outbox routed to user | `00:38:58.006` | **+31.996s** agent wall |
| Conversation hub stamp | `00:38:58.010` | **33.305s** total |

Same pattern on later turns: poll lag **0.1–1.6s** (well under poll interval); agent wall is the rest.

### 2.2 Hub first-reply distribution (this conversation)

All user→first-hub pairs (includes heavy work): n=21, min 8.9s, med **109s**, p95 **548s**, max 686s.

**Short operator turns** (body ≤80 chars) that still cold-start the hub:

| Latency | User | First hub |
| ---: | --- | --- |
| 18.2s | “I don't have a Grok API key yet…” | short ack |
| 24.4s | “That worked!” | short ack |
| 25.3s | “Yeah go ahead and push it” | interim “On it…” |
| **33.3s** | **“Hi”** | “Hi — standing by…” |

**Takeaway:** Even pure chat with no product work costs **~18–33s**. Anything that dispatches agents or investigates is additive on top.

### 2.3 Product-agent path (status fanout 2026-07-23 ~06:03Z)

Launch → first `-> hub` route:

| Agent | Wall |
| --- | ---: |
| o-protocol | 30s |
| synthmining | 30s |
| bizagent-oss (status) | 34s |
| shell-ai / orbitwar / oddbeaker | 36s |
| oddbeaker-edu | 46s |
| beakerboard | 48s |
| jobe-ai | 52s |
| ternary | 90s |

- **min / med / max:** 30 / 36 / 90s  
- **Fanout launch span:** 240s (cap 4)  
- **First product launch → last agent reply:** ~286s  
- If concurrency were unbounded: wall ≈ max agent (~90s) + poll, not ~5 minutes

---

## 3. Bottleneck map (ranked by wall-clock impact)

### B1 — Cold multi-tool discovery every hub turn  ★★★★★

**Evidence**

- `dispatch-hub.log` constant prefix: load hub prompt → “is the system built?” → session → registry/inbox → *then* answer.
- Counts in hub log: “System is built” ×16, “session memory” ×60, “pending inbox” ×18, “registry” ×56.
- “Hi” spent ~32s of agent wall for a one-line reply.

**Mechanism**

1. Launch is `cd $HUB && grok -p <promptFile> --always-approve` (fresh process every message).
2. Prompt file is **not** the only context: Grok Build loads workspace project instructions from hub root (`AGENT.md`), which still contains **§0 Detect state / interview / setup**. That reintroduces “is the system built?” on every PTL turn even though runtime was supposed to use only §§3–4 via `.bizagent/prompts/hub.md`.
3. Inbox body and compacted session are **not injected** at launch. The agent must tool-read `inbox/`, `hub-session.md`, often `registry.json`.
4. `hub.md` Runtime Memory still orders: *before responding, read session and keep it compact* — redundant with CP `compactHubSession` on every `appendMessage`.

**Impact:** ~15–25s of the “Hi” budget (order-of-magnitude from multi-round tool tax); primary reason trivial turns are never sub-10s.

### B2 — Prompt content / CLI flag mismatch for Grok  ★★★★☆

**Evidence**

- Grok help: `-p/--single <PROMPT>` = prompt **text**; `--prompt-file <PATH>` = prompt **from file**.
- Dispatch always does: `"$cli" $pflag "$pfile" $extra` with `promptFlag: "-p"` for grok in `cli.json`.
- Agent narration often begins with “I'll load the hub runtime prompt…” — consistent with receiving a path/instruction rather than a fully-inlined ops prompt (confirm in Phase 0 with a dry flag experiment).

**Impact:** Extra first tool round(s) + weaker system priming. Switching to `--prompt-file` (and/or inlining turn context) is low effort, high confidence.

### B3 — Fat always-on hub prompt + session payload  ★★★☆☆

| Artifact | Size |
| --- | ---: |
| `.bizagent/prompts/hub.md` | **12.8 KB** / 249 lines |
| `.bizagent/hub-session.md` | **15.4 KB** (12 recent turns) |
| Root `AGENT.md` (workspace inject) | **23.4 KB** full setup manual |

Largest always-on sections inside hub.md that rarely affect a “Hi”:

| Section | Bytes |
| --- | ---: |
| Inbox-check hook (Claude-only) | 2512 |
| Knowledge Stack | 2169 |
| Two tiers of work | 1676 |
| Runtime prompt and memory | 1668 |
| Journal format | 1311 |

**Impact:** Token + attention cost every turn; secondary to tool rounds but compounds B1.

### B4 — Product agents: same cold pattern at smaller prompt  ★★★☆☆

- Dispatch prompt ~1.3 KB + agent.md ~1.6–2.0 KB, but agent still re-reads sitemap/journal/inbox every run (by design for memoryless agents).
- Status snapshots cluster **30–50s**; outliers (ternary 90s) are task-depth, not CP.
- Fanout limited by **`max_concurrency: 4`** → launch queue of ~240s for 10 agents.

**Impact:** Multi-agent operator requests feel multi-minute even when each agent is “only” ~35s.

### B5 — Concurrency / lock serialization  ★★☆☆☆

- Per-agent locks: correct for at-least-once; not a bug.
- `max_concurrency=4` + 10 products: expected queueing.
- Hub and product agents share the same cap — a long hub run blocks a product slot.
- Lock lease 1800s is fine; no evidence of stale locks on the “Hi” path.

**Impact:** Fanouts and overlapping work only; not “Hi”.

### B6 — Config / hygiene drag (small but real)  ★★☆☆☆

| Issue | Detail |
| --- | --- |
| **Dead `poll_seconds: 6`** | Registry still advertises 6s; live server hardcodes `setInterval(..., 2000)`. Docs already say 2s. Operator confusion only — live is already 2s. |
| **Public vs live cli-config drift** | Live reads `cliDef.promptFlag`; public tree still has `cliDef.prompt` (bug). Live is ahead; public must not regress. |
| **Stuck bad outbox** | `agents/jobe-ai/outbox/2026-07-20-jobe-ai-skeleton-integration-complete.md` has `to: hub, o-protocol` → CP logs `WARN unknown recipient` **every 2s**. Inflates `control-plane.log` (~38 MB). |
| **`ensureHubRuntimePrompt` every launch** | Rewrites hub.md each hub start (~0.3ms). Cheap, but wipes any manual tweak and does needless I/O. |
| **UI poll 2s** | Client polls conversation every 2s — adds ≤2s display lag after route; not in conversation timestamps (those use append time). |

### B7 — Sync I/O on CP hot path  ★☆☆☆☆

Each tick: refresh registry mtime, walk agent outboxes, pending mail, locks. Measured **~1ms**. Not a latency driver for human turns.

### Non-bottlenecks (ruled out)

| Suspect | Verdict |
| --- | --- |
| Session compaction sequencing | CP already compacts on user send *and* hub relay via `compactHubSession`. Not a pre-launch stall. |
| Poll interval 2s | Contributes ≤2s; measured lag ~0.1–1.6s. |
| `grok` process cold start | Help exits in ~40ms; model+tools dominate. |
| Mail routing | Same-tick as dispatch after outbox write; route→conversation is ms-scale. |

---

## 4. Optimization options

For each option: **expected savings**, **risk**, **effort**, **compat**.

### O1 — Turn-context injection at launch (P0)

**What:** When launching hub (and optionally product agents), write an ephemeral prompt file that already contains:

- Pending inbox message bodies (or the single newest console message)
- `conversation_id`
- Compact session excerpt (or “session already compacted at path X; do not rewrite”)
- Explicit: system is built; do not re-detect
- Ordered steps: answer → outbox → archive

**Savings:** Largest single win — remove 2–4 tool rounds. Target **−10–20s** on “Hi”-class.  
**Risk:** Medium — must keep at-least-once semantics (ephemeral file must not skip archive).  
**Effort:** M (dispatcher + hub-memory + tests).  
**Compat:** Additive; old agents still work if they ignore injection.

### O2 — Grok `--prompt-file` + correct cli.json flags (P0)

**What:** Per-CLI prompt mode in `cli.json`:

```json
"grok": {
  "executable": "grok",
  "promptFlag": "--prompt-file",
  "flags": { "extra": "--always-approve" }
}
```

Align public `getCliSettings` with live (`promptFlag`, not `prompt`). Document Claude/agy/codex flag differences.

**Savings:** −1 tool round / cleaner system prompt; **−2–8s** if path-as-text is confirmed.  
**Risk:** Low if tested per CLI.  
**Effort:** S.  
**Compat:** Schema extension; keep default `-p` for Claude.

### O3 — Isolate hub launch from workspace AGENT.md §0 (P0)

**What (pick one or combine):**

- Launch hub with `--cwd` pointing at a **runtime sandbox** that only contains the prompt + session symlink (no root `AGENT.md`), **or**
- Generate hub runtime into a dir without setup sections and set cwd there, **or**
- Split `AGENT.md` so setup (§§0–2) is not auto-loaded as project instructions (e.g. `SETUP.md` + slim `AGENT.md` / `AGENTS.md` ops-only).

**Savings:** Kills “is it built?” loop; **−5–15s** and huge token waste.  
**Risk:** Medium — Grok/Claude project-instruction behavior differs; need per-CLI verify.  
**Effort:** M.  
**Compat:** Setup interview still lives in repo; only runtime cwd/prompt changes.

### O4 — CP owns session compaction; strip LLM compression duty (P0)

**What:** Rewrite Runtime Memory in `deriveHubRuntimePrompt`: session is read-only for the agent (or already inlined). Never instruct the LLM to compress/rewrite `hub-session.md`.

**Savings:** Fewer tools + no rewrite races; **−1–5s** and cleaner files.  
**Risk:** Low (CP already compacts).  
**Effort:** S.  
**Compat:** Full.

### O5 — Slim always-on vs on-demand hub prompt (P1)

**What:** Split generated prompt:

- **Always-on (~3–5 KB):** identity, non-negotiable limits, brevity, message/outbox format, interim-message rule, “built system assumed”.
- **On-demand refs:** Knowledge Stack, journal/sitemap schemas, Claude inbox-check hook, nightly details — linked as paths to open only when needed.

**Savings:** Tokens + slight latency; **−1–3s** and better instruction following.  
**Risk:** Low.  
**Effort:** S–M.  
**Compat:** Full.

### O6 — Outbox-first, then housekeep (P1)

**What:** Explicit prompt + optional CP metric: first operator-visible outbox write is success; archive/session/journal after.

**Savings:** Perceived latency (first token/route) **−2–10s** on turns that currently housekeep mid-flight; true wall similar.  
**Risk:** Low if archive still mandatory before exit.  
**Effort:** S.  
**Compat:** Full; improves at-least-once (smaller unarchived window for the reply itself).

### O7 — Raise or tier concurrency (P1)

**What:**

- `max_concurrency` default 6–8 for multi-product hubs, **or**
- Separate caps: `hub_slots=1`, `agent_slots=N` so hub never starves fanout and vice versa.

**Savings:** Status fanout **−1–3 min** wall on 10 agents.  
**Risk:** Medium — machine load, API rate limits, disk thrash.  
**Effort:** S.  
**Compat:** Registry setting only.

### O8 — Fix dead config + stuck mail hygiene (P1)

**What:**

- Honor `settings.dispatch.poll_seconds` **or** fix registry+docs to 2 and stop claiming 6.
- Repair/quarantine multi-`to:` outbox messages; stop per-tick WARN spam.
- Sync public `cli-config.js` `promptFlag` key with live.

**Savings:** Ops clarity; log size; avoid mis-tunes. Negligible user latency.  
**Risk:** Low.  
**Effort:** S.  
**Compat:** Full.

### O9 — Dispatch timing instrumentation (P1, enables all later work)

**What:** Structured log lines (JSON or key=value):

```
dispatch_start slug= hub|agent t=
cli_spawn slug= t=
cli_exit slug= code= duration_ms=
route file= to= t=
```

Optional: wrap CLI with `/usr/bin/time -f` for wall/RSS without model changes.

**Savings:** None directly; enables p50/p95 dashboards.  
**Risk:** Low.  
**Effort:** S.  
**Compat:** Full.

### O10 — Warm / long-lived hub process (P2)

**What:** Keep a persistent hub CLI session (`--continue` / leader socket / custom loop) that receives new turns via stdin or a mail-wake file, instead of cold spawn.

**Savings:** Could approach **~3–8s** “Hi” if model stays warm — **after** O1–O4. Alone, a warm process still pays multi-tool discovery if prompts stay wrong.  
**Risk:** High — session drift, crash recovery, lock model, multi-conversation, memory growth.  
**Effort:** L.  
**Compat:** Parallel path; keep cold launch as fallback.

### O11 — Streaming first token to UI (P2)

**What:** Stream hub stdout into conversation as partial hub messages, or a “typing” channel.

**Savings:** Perceived latency only.  
**Risk:** Medium (partial wrong answers).  
**Effort:** M–L.  
**Compat:** Additive API.

### O12 — Optional model tiering (P2)

**What:** Fast/cheap model for “Hi”-class / routing; strong model for design/debug. Heuristic on message length + keywords, or explicit operator command.

**Savings:** **−5–15s** and $ on trivial turns.  
**Risk:** Medium quality regressions.  
**Effort:** M.  
**Compat:** Registry `hub_agent.model` already exists; need classifier.

---

## 5. Phased refactor plan

### Phase 0 — Instrumentation & flag truth (0.5–1 day)

1. Add O9 timing logs to dispatcher + route.
2. Confirm O2: one dry hub launch with `--prompt-file` vs `-p` in a **scratch cwd** (not production inbox).
3. Confirm O3: whether Grok injects root `AGENT.md` (compare launch with sandbox cwd).
4. Align public `cli-config.js` with live `promptFlag`.
5. Quarantine stuck multi-recipient outbox (O8).
6. Re-measure 3× “Hi”-class turns after *only* O2+O3 if those are pure flag/cwd fixes (operator approval to re-test on live).

**Exit:** Written numbers for prompt-injection mode and workspace-instruction effect.

### Phase 1 — Context plane (core efficiency refactor) (2–4 days)

Implement as one coherent slice (not a drive-by P0 patch):

| Work item | Options |
| --- | --- |
| Ephemeral turn prompt builder | O1 |
| Grok `--prompt-file` + cli schema | O2 |
| Hub cwd / instruction isolation | O3 |
| CP-only session compaction wording | O4 |
| Slim always-on hub prompt | O5 |
| Outbox-first ordering in prompt | O6 |
| `poll_seconds` truth | O8 |

**Design constraints (non-negotiable):**

- At-least-once mail: archive-on-done still agent responsibility; unarchived mail re-dispatches.
- Per-agent / hub locks unchanged.
- Filesystem remains the ledger (no DB for mail).
- Product agents remain memoryless across dispatches unless injection gives them the current message.

**Suggested API (sketch):**

```
.bizagent/prompts/turns/hub-<timestamp>-<id>.md   # ephemeral, deleted after exit
# Contains:
#   ## System (always-on slim)
#   ## Session (inline or path, read-only)
#   ## Pending mail
#   ## Instructions this turn
```

Launch: `grok --prompt-file <turnFile> --always-approve` with `--cwd` = sandbox or hub as decided in Phase 0.

**Exit metrics (Phase 1 success):** see §6.

### Phase 2 — Throughput & fanout (1–2 days) — **done 2026-07-24**

1. O7 concurrency tiering: `hub_slots` (default 1) + `agent_slots` (default = `max_concurrency`, default raised **4→8**). Hub no longer consumes a product slot.
2. Product-agent light injection: `buildAgentTurnPrompt` inlines pending inbox bodies; launch uses ephemeral turn file (cleaned on exit).
3. Optional sitemap skip for pure status: prompt soft-guidance only (no mtime heuristic — correctness over cleverness).
4. Stuck-mail hygiene: multi-to + missing `to` + invalid slug path-tricks quarantine once.

**Exit:** 10-agent status fanout **&lt; 90s** wall on this machine (measure after live apply + restart).

### Phase 3 — Warm hub & UX (optional, 3–7 days)

1. O10 long-lived hub with crash → cold fallback.
2. O11 streaming partial replies.
3. O12 model tiering.

Only if Phase 1 p95 still misses targets.

### Phase 4 — Docs & deploy path

1. Update `docs/ARCHITECTURE.md` (poll 2s, context injection, CP owns session).
2. Update `registry.example.json` defaults.
3. Deploy story: reduce hub↔public drift (known issue); `deploy.sh` + restart checklist.

---

## 6. Success metrics

| Metric | Baseline (now) | Phase 1 target | Phase 2 target | Stretch (warm hub) |
| --- | ---: | ---: | ---: | ---: |
| “Hi”-class p50 | ~25–33s | **≤12s** | ≤10s | ≤5s |
| “Hi”-class p95 | ~33s+ | **≤18s** | ≤15s | ≤8s |
| Poll lag p95 | ≤2s | ≤2s (unchanged) | ≤ poll | ≤ poll |
| Hub tool rounds before first outbox | ~3–6 (inferred) | **≤1** | ≤1 | 0–1 |
| Hub prompt always-on size | 12.8 KB + 23 KB workspace | **≤6 KB** total injected | ≤6 KB | ≤6 KB |
| Product status p50 | ~36s | ≤30s | **≤20s** | ≤15s |
| 10-agent fanout wall | ~286s | ≤200s | **≤90s** | ≤60s |
| CP tick time | ~1ms | &lt;5ms | &lt;5ms | &lt;5ms |
| False “detect built” on hub | always | **never** | never | never |

Measurement recipe after changes: 5× “Hi” in the same conversation, 5 minutes apart, report min/med/max from conversation JSON + `dispatch_*` timing lines.

---

## 7. What NOT to change

Preserve unless a future design explicitly supersedes:

1. **At-least-once mail** — presence in inbox = pending; archive only after work.
2. **Per-agent and hub locks** — one live instance per slug.
3. **Filesystem ledger** — no required DB for mail/journals.
4. **Hub never implements product code** — PTL coordinates only.
5. **Product agents memoryless by default** — injection is per-turn, not long-term agent memory.
6. **Nightly does not process fresh inbox** — CP owns real-time dispatch.
7. **Message format** — YAML frontmatter `from`/`to`/`date`/`subject` (+ `conversation_id` for console).
8. **Operator-facing agent names** from registry (`agent_name`), slugs only in mail headers.

---

## 8. Recommended implementation order (when approved)

```
Phase 0  instrumentation + prompt-file + cwd truth + public promptFlag fix + stuck outbox
    ↓
Phase 1  turn injection + slim prompt + CP session ownership + outbox-first + poll truth
    ↓  measure “Hi” ×5
Phase 2  concurrency tiers + product injection
    ↓  measure fanout
Phase 3  warm hub / stream / model tier  (only if needed)
```

**Do not start Phase 3 before Phase 1 numbers.** Warm process on a confused prompt wastes complexity.

---

## 9. Incidental findings (fix while optimizing)

1. **`registry.settings.dispatch.poll_seconds: 6` is ignored** — server hardcodes 2000ms (`server.js` `setInterval`).
2. **Public `cli-config.js` uses `cliDef.prompt`** but `cli.json` defines `promptFlag`; **live hub already fixed** to `promptFlag`. Reconcile before next public release.
3. **Stuck outbox** multi-recipient `to: hub, o-protocol` spams WARN every tick — quarantine file and optionally teach router to split multi-`to` or reject at write time.
4. **Deployment drift** remains the #1 ops risk: latency fixes in public do nothing until each hub is synced + CP restarted.

---

## 10. Appendix — code map

| Concern | Location |
| --- | --- |
| Poll loop 2s | `control-plane/server.js` `start()` / `runTick` |
| Launch hub/agent | `control-plane/lib/dispatcher.js` `launchHub` / `launchAgent` |
| Prompt generation | `control-plane/lib/hub-memory.js` `deriveHubRuntimePrompt` |
| Session compact | `hub-memory.js` `compactHubSession` ← `conversations.js` `appendMessage` |
| CLI flags | `control-plane/lib/cli-config.js` + hub `cli.json` |
| Mail route | `control-plane/lib/mail.js` `routeOutboxes` |
| UI poll | `control-plane/public/app.js` 2000ms |

---

*End of plan. Awaiting operator approval before implementation.*
