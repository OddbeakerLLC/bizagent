# Standby helper pool (sub-agents)

**Date:** 2026-09-22  
**Status:** Implemented (v1)  
**Audience:** Operator / hub  
**Related:** `docs/ARCHITECTURE.md` (one agent per product, per-slug lock, filesystem mail)

---

## 0. Operator sketch

Keep product agents on smart models. When a turn has bounded extra work, the owning agent may hand that slice to a cheaper helper instead of burning the frontier model on it.

Registry declares a **standby pool**: how many helpers, which provider, which model.

## 1. What this is *not*

BizAgent’s spine stays: **one hub PTL, one agent per product, one live process per slug.**

Helpers are **not**:

- new products, slugs, sitemaps, or journals
- peers that mail the operator
- always-on idle LLM processes (that would pin local GPU VRAM for nothing)
- a way for the hub to do product work, or for one product to edit another

A helper is a **short in-turn worker** the owning agent hires and fires inside its already-locked turn.

## 2. Shape

```
operator → hub → product agent (smart model, holds .lock)
                      │
                      ├─ keep: judgment, writes, operator-facing summary via hub
                      └─ hire (optional): helper from pool (cheap model)
                            returns text/data → parent reviews → parent acts
```

**Standby** means *capacity reserved in `registry.json`*, not warm daemons. The runtime may run up to `max(pool_size, product count)` helper processes at once, across the whole hub. Spawn on hire, exit when the task returns.

## 3. Registry

Under `settings`, next to `dispatch` / `hub_agent` / `models`:

```json
"helpers": {
  "_comment": "Optional cheap in-turn workers. Not product agents. pool_size is the floor; live cap is max(pool_size, product count).",
  "enabled": false,
  "pool_size": 10,
  "provider": "venice",
  "model": "qwen3-5-9b",
  "max_concurrent_per_agent": 1,
  "max_wall_secs": 120,
  "max_depth": 1,
  "allow": ["research", "search", "summarize", "test-extract"]
}
```

| Field | Meaning |
| --- | --- |
| `enabled` | Hard off until you turn it on (example defaults false) |
| `pool_size` | Floor on live helpers. If product count is higher, the pool matches product count |
| `provider` / `model` | Same `cli.json` provider keys as product agents |
| `max_concurrent_per_agent` | One parent cannot drain the pool |
| `max_wall_secs` | Kill and return failure to the parent |
| `max_depth` | Helpers cannot hire helpers |
| `allow` | Closed list of task kinds; unknown kind = refuse |

v1 is hub-global. Per-product opt-out later if needed.

## 4. When an agent may hire

The parent must state **one sentence of justification** in the hire call. Allowed reasons:

| Hire | Why |
| --- | --- |
| **Research / read-back** | “Summarize these N files / URLs; I will decide.” |
| **Search** | Bounded grep/glob over a known tree; return hits, not edits. |
| **Summarize** | Compress logs, test output, or a long doc into bullets the parent will verify. |
| **Test-extract** | Run or read an existing test command and return fail list. Parent still owns the fix. Shell is allowed only for this kind. |

**Do not hire** for: architecture, product ownership, registry/hub machinery, operator-visible replies, commits, or any write.

v1 rule: **helpers are read-only.** They return markdown/text. The parent is the only writer. If the helper fails or times out, the parent does the work itself — it does not retry-spawn forever.

## 5. Why not mail-based sub-agents

A pool of `standby-1` slugs with inboxes would fight the current design:

- Per-slug `.lock` means the parent is busy *and* cannot process the helper’s reply until its own turn ends.
- New slugs look like products in the rail, KS, and nightly path.
- Helper mail to `user` is already banned.

In-turn hire keeps one lock, one mailbox, one accountable agent.

## 6. Control-plane / runtime

1. Parent tool: `hire_helper` `{ kind, justification, prompt, done_when }`.
2. Runtime checks `helpers.enabled`, pool slots (`max(pool_size, product count)`), allow-list, depth=1.
3. Spawns `bizagent-agent --helper` with a helper prompt (no product dispatch.md, no inbox archive duty, no `write-message`).
4. Helper may use read/search/fetch only; shell only for `test-extract`. No write / search_replace / mail / nested hire.
5. Result is a single string back to the parent tool call. Slot released.

Slots live under `.bizagent/helper-slots/` so concurrent parents share one cap. Console/rail does **not** show helpers as products.

## 7. Cost / lab fit

Named agents stay on frontier models. Helpers default to **Venice `qwen3-5-9b`**. Switch the pool to a local open-source model later when a GPU can run several small instances.

`pool_size: 10` is the floor. If product count is higher, the live cap matches product count. An API-backed helper model makes concurrency a spend/rate-limit cap, not VRAM.

## 8. Done-when (v1)

- Registry `helpers` block present; example defaults `enabled: false`.
- One parent can hire, get text back, and continue the same turn.
- Helper cannot write files, send mail, or hire again.
- Over-cap hire returns a clear error; parent proceeds without it.
- Console/rail does **not** show helpers as products.
