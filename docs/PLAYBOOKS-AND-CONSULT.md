# Playbooks and PTL consult

Design locked 2026-08-23 (operator greenlight). Implementation is **file-based + norms** first — no peer broadcast channel, no new mail protocol required.

## Problem

Cross-product know-how (OOM tricks, deploy footguns, UI regressions) dies in one agent’s journal. Parallel agents re-pay the same cost.

## Non-goals

- Open agent-to-agent broadcast / fleet chat
- Dumping all KS docs into a generic “search everything” soup
- Silent cross-repo reads between product agents
- Uncurated tip spam

## Two layers

| Layer | Role |
|---|---|
| **Playbooks** | Durable, curated cards under `knowledge-stack/playbooks/` |
| **PTL consult** | Stuck agent → hub → playbooks first → optional 1–2 targeted agents → one answer → promote |

## Agent norms

- On non-obvious proven wins: mail hub `playbook candidate` (problem / what worked / pitfalls / tags).
- When stuck after a real try: mail hub `consult: …` (not other product slugs for “has anyone…?”).
- Still obey isolation: no editing other products; no guessing (existing rule).

## Hub (PTL) norms

1. Grep playbooks + INDEX on consult.
2. Answer from cards when possible (zero wakes).
3. Else query ≤2 likely agents; synthesize; do not relay thread wars.
4. File new cards + INDEX rows for reusable outcomes.
5. Cap noise (TTL, no broadcast). Escalate to operator only when nobody knows and work is blocked.

## Operator visibility

- Cards live in `knowledge-stack/playbooks/` (KS tree; not a substitute for Library plans).
- This doc: `docs/PLAYBOOKS-AND-CONSULT.md`.
- Schema/README: `knowledge-stack/playbooks/README.md`.

## Evolution

Only add thin helpers (dedicated grep tool, `kind: consult`, auto-TTL) after a manual pilot shows agents actually query and promotions stay high-quality. See kill criteria in the playbooks README.
