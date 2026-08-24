# Cross-agent playbooks

Curated, **proven** how-we-did-it cards shared across products. Not product specs, not journals, not speculation.

## Why

Agents rediscover the same hard lessons (OOM eval, deploy footguns, UI gotchas) because lived know-how stays trapped in one journal/repo. Playbooks are the durable store; **PTL-mediated consult** is the exception path when no card exists.

## Rules

1. **Proven only** — something that actually worked in this hub/fleet. No “we should try…”.
2. **No secrets** — no tokens, passwords, private keys, customer data, or prod credentials.
3. **One problem per card** — short; link out for deep specs.
4. **Hub files cards** — product agents propose via mail (`subject: playbook candidate`); PTL writes/edits under `knowledge-stack/playbooks/`.
5. **Query before reinvent** — stuck agents ask hub; hub greps this directory (and INDEX) before waking peers.
6. **No fleet broadcast** — agents never blast all slugs. Consult is hub-routed, max 1–2 callees.

## Layout

```text
knowledge-stack/playbooks/
  README.md          ← this file
  INDEX.md           ← tag → card map (keep current)
  YYYY-MM-DD-<slug>.md
```

## Card schema

Filename: `YYYY-MM-DD-<kebab-slug>.md`

```markdown
---
title: Short human title
tags: [gpu, training, oom]
products: [beakernet]          # who proved it; optional others who reuse
status: active                 # active | deprecated
created: YYYY-MM-DD
updated: YYYY-MM-DD
source: hub|agent:<slug>
---

# <Title>

## Problem
What failed / what you were trying to do (2–4 sentences).

## What worked
Concrete steps or settings that fixed it. Commands OK if non-secret.

## Pitfalls
What looked right but wasn’t; traps for the next agent.

## Links
- Paths, journal dates, PRs, Library docs (hub-relative when possible)
```

## PTL consult flow (no peer chat)

1. **Stuck agent → hub** with subject `consult: <short topic>` and body:
   - problem, constraints, tags, what already tried, deadline / blocking line
2. **Hub** greps `knowledge-stack/playbooks/` (+ INDEX tags). On hit → one synthesized reply; no agent wake.
3. **Miss** → hub mails **at most 1–2** likely owners (registry + tags + recent work). Callee replies once to hub.
4. **Hub** synthesizes one answer to the asker.
5. **Promote** reusable proven answers into a new playbook card; update INDEX.
6. **Caps:** prefer one open consult per asker; TTL ~24h then “no answer — proceed or escalate to operator”; never open broadcast.

## Kill criteria

If cards go unread, consults become status chatter, or unvetted advice spreads without promotion/curation — stop automating and tighten the bar.
