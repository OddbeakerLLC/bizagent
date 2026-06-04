# Design: Agent Naming and Hub Delegation Enforcement

**Date:** 2026-05-25
**Status:** Approved

## Problem

1. Product agents have no short, human-friendly names, making it awkward for the operator to direct the hub ("delegate to the widgets agent" vs "delegate to Agent W").
2. The hub has been bypassing product agents and doing product-level work directly, silently skipping the journal and sitemap updates that agents are responsible for.

## Goals

- Each product agent gets a short name ("Agent W", "Agent JA") that the hub uses when talking to the operator.
- The hub is explicitly prohibited from doing any product work. Its only job is vision/coordination with the operator and delegation to agents.
- Names are confirmed interactively during setup so the operator can accept the calculated name or suggest their own.

## Out of Scope

- Agent names in message headers (slugs remain the addressing mechanism).
- Agent names in individual `agent.md` files (human-facing only, lives in the hub layer).

---

## Design

### 1. Naming Algorithm

Applied during § 1 (interview), once per product, in the order products are confirmed:

1. Take the first letter of each word in the product name, capitalize, prefix "Agent ". Single-word names use one letter: "Widgets" → `Agent W`. Multi-word names use initials: "Jobe AI" → `Agent JA`.
2. If the proposed name conflicts with an already-confirmed product's name, fall back to the first two letters of the first word (e.g., "Widgets" vs "Wrappers" → `Agent Wi` vs `Agent Wr`). If still clashing, extend to three letters.
3. Present to the operator: *"I'd suggest calling this agent **Agent W**. Want to use that, or do you have a different name in mind?"* Accept or replace. If the operator proposes a name that conflicts with an already-confirmed agent, flag it and ask them to choose a different one.
4. Store the confirmed name as `agent_name` on the product entry in `registry.json`.

### 2. Registry Schema

Add `agent_name` to each product object in `registry.example.json`:

```json
{
  "slug": "widgets",
  "name": "Widgets",
  "agent_name": "Agent W",
  "projects": [...]
}
```

`agent_name` is written during § 2 setup (populated from the interview answer).

### 3. Hub Identity and Roster

In `AGENT.md` § 3 (Identity block), add:

> When referring to product agents in conversation with the operator, always use their `agent_name` from `registry.json` (e.g., "I've delegated this to **Agent W**"). Use the slug only in message headers (`from:`, `to:`).

This lets the operator say "ask Agent W to do X" and the hub maps it to the `widgets` slug internally.

### 4. Hub Law (Non-Negotiable Limits)

A new dedicated block added to `AGENT.md` § 3, placed before "Two tiers of work":

```
### Non-negotiable limits
You are a coordinator, not an implementer. These rules have no exceptions:

1. You NEVER write code, edit project files, update sitemaps, or write journal
   entries for any product. Those are the agent's job, always.
2. You NEVER do work that belongs to a product agent — even if it seems faster,
   even if the work is small, even if you already know the answer.
3. When the operator gives you a task: identify the owning agent, delegate to
   them, wait for their reply, report back. That is the complete workflow.
4. If you catch yourself touching anything inside a project repo or an agent's
   agents/<slug>/ directory: stop, undo, delegate.

Breaking these rules silently corrupts the journals and sitemaps the operator
depends on.
```

---

## Files Changed

| File | Change |
|------|--------|
| `AGENT.md` | § 1: add name confirmation step per product |
| `AGENT.md` | § 2: add `agent_name` to registry generation step |
| `AGENT.md` | § 3: add "Non-negotiable limits" block; add roster guidance to Identity block |
| `registry.example.json` | Add `agent_name` field to each product object |

No changes to `templates/agent.md.template` or any script files.
