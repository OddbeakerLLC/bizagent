# Journal search — MVP spec

**Date:** 2026-10-05  
**Status:** Locked MVP — file in product docs, then implement  
**Owner:** Agent BA (`bizagent`)  
**Audience:** Agent BA (cold start)  
**Source:** operator console `2026-08-14-bizagent-78cf12`  
**Hub copy:** `docs/2026-10-05-journal-search-mvp-spec.md` (this file; operator will review)

This spec is the build contract for **fast journal retrieval**. It is **not** a vector RAG stack, not a Knowledge Stack change, and not a new product.

---

## 1. What we are building

Journals already exist. Nobody can search them as a set.

Today:

- Hub writes `journal/YYYY-MM-DD.md`.
- Each product project writes `<project>/.agent/journal/YYYY-MM-DD.md` (and occasional extra dated notes).
- Product agents and the hub **read the latest 1–2 files** on cold start.
- The Knowledge Stack is a **weekly synthesis**, not a search index.
- “What did we learn about X three weeks ago?” is a grep lottery.

We add a **hub-owned journal search tool** over the hub journal plus every registered product journal, so agents retrieve a few ranked snippets instead of stuffing history into the prompt.

Proof for MVP: one query from the hub finds a hit in another product’s older journal; a product agent query does **not** leak other products’ journals.

---

## 2. Locked decisions (do not re-litigate)

| # | Topic | Decision |
| --- | --- | --- |
| 1 | Approach | **Keyword FTS**, not embeddings. SQLite FTS5 (preferred) or equivalent local full-text. No Chroma, Pinecone, Ollama-embed, or vector DB. |
| 2 | Corpus | **Journals only.** Hub `journal/*.md` + each registry `products[].projects[].path` → `<path>/.agent/journal/*.md`. |
| 3 | KS / docs / sitemaps | **Out of v1.** Leave Knowledge Stack as the synthesized layer. Do not index `knowledge-stack/`, `company/`, `docs/`, or `sitemap.md`. |
| 4 | Interface | **Tool, not prompt stuffing.** Agents call `journal_search`. Do not dump whole journals into every turn. |
| 5 | Owner | **Agent BA** — BizAgent machinery in the public product clone. Not a new product. Not hub PTL implementing. |
| 6 | Scope | **Hub** searches all products (optional slug filter). **Product agent** defaults to **its own** product’s project journals only. |
| 7 | Results | **5–10 short hits** (default 8, max 20): path, date, product/project, snippet. Not full files. |
| 8 | Live hub | Implement in `../dev/bizagent`. **Do not** edit the live operator hub at `/home/bizagent/bizagent` unless hub mail later says to patch that tree. |

---

## 3. Problem this solves

Cold-start instructions tell agents to read 1–2 recent journal files. That is correct for *today’s* context and wrong for *recall*.

Operators and the hub PTL need: “search all journals for disk-full / survival / enterprise connect / token fallback” and get dated snippets with sources.

Product agents need the same for **their** history without reading every `YYYY-MM-DD.md` by hand.

---

## 4. MVP in / out

### In

1. **Index** of hub + registered product project journals.
2. **CLI** to rebuild and query (human + tests).
3. **Agent tool** `journal_search` in `agent-runtime`.
4. **Nightly rebuild** (or stale-on-query rebuild) so the index does not rot.
5. **Prompt pointers** so hub and product agents actually use the tool for historical questions.
6. **Tests** for hit, miss, date filter, and product-scope isolation.

### Out (v2+)

Embeddings / hybrid semantic search. Indexing KS, company docs, library, or sitemaps. A Library/UI search page. Cross-hub / Enterprise Server journal search. Changing how journals are written. Rerankers. Auto-injecting search hits into every turn.

---

## 5. Repos and ownership

Agent BA owns `../dev/bizagent` (public OSS BizAgent).

Do **not** edit:

- Live hub `/home/bizagent/bizagent` (ops tree).
- `../dev/bizagent-enterprise` (unrelated).
- Product project journals’ *content* (search them; do not rewrite history).

If a choice is not in this spec, **ask hub**. Do not guess.

---

## 6. Corpus

Walk, do not invent paths:

| Source | Glob | `source` field | `product_slug` | `project_name` |
| --- | --- | --- | --- | --- |
| Hub notebook | `<hub>/journal/*.md` | `hub` | (empty) | (empty) |
| Product project | `<projects[].path>/.agent/journal/*.md` | `product` | registry `slug` | `projects[].name` |

Rules:

- Resolve `projects[].path` the same way the rest of the hub does (relative to hub root).
- Skip missing directories and unreadable files.
- Include markdown that is **not** strictly `YYYY-MM-DD.md` (incident notes exist).
- Skip `*.bak`, editor junk, and non-`.md`.
- Do **not** index `agents/<slug>/.agent/journal/` unless that path is also a registered project path (the real journals live in **project repos**).
- Do **not** follow symlinks outside the journal dir.
- Binary / huge files: skip if not valid UTF-8 or if larger than **1 MiB**.

`date` column: if the basename matches `YYYY-MM-DD` (optional suffix after the date is OK), use that date; else use file mtime UTC date.

---

## 7. Index

- **Engine:** SQLite FTS5.
- **Path:** `<hub>/.bizagent/journal-fts.sqlite` (must be gitignored; not a repo artifact).
- **Rebuild CLI:** `scripts/journal-index.sh` (wrapper around a small Node module is fine). Idempotent.
- **Incremental:** reindex a file when size or mtime changes; delete rows for files that vanished.
- **Freshness:**
  - `scripts/nightly.sh` runs a rebuild (mechanical half).
  - Query path: if the DB is missing **or** older than the newest journal mtime among known roots, rebuild (or incremental update) before search. Do not require a separate daemon.
- **Failure:** if SQLite/FTS5 is unavailable, fall back to ripgrep over the same file list with the same result shape. Log once; do not crash the agent turn.

Suggested row fields (names can vary; keep them queryable):

`path`, `source`, `product_slug`, `project_name`, `date`, `mtime_ms`, `body`

FTS over `body` plus filename/path tokens. Rank = FTS rank, with a **light recency boost** (newer dates first among similar scores). Do not require BM25 tuning beyond defaults.

---

## 8. Tool: `journal_search`

Add to `agent-runtime` built-in tools (same list as `grep_search` / `read_file`).

### Parameters

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string | yes | Keyword / FTS query. Plain text should work; do not require operators. |
| `product_slug` | string | no | Limit to one registry slug. Hub only, effectively — see scope. |
| `since` | string | no | Inclusive `YYYY-MM-DD`. |
| `until` | string | no | Inclusive `YYYY-MM-DD`. |
| `limit` | number | no | Default **8**, clamp **1–20**. |

### Scope (mandatory)

- **Hub PTL / hub runtime:** default = all sources. `product_slug` filters when set. Hub may also search hub journals (`source=hub`) always.
- **Product agent:** default = that agent’s product slug only (hub journal **not** included unless you add an explicit flag later — **v1: product agents do not see hub `journal/` or other products**). If the model passes another product’s slug, **ignore it** and stay in-product. Never return another product’s rows.

Resolve “who is calling” from existing agent-runtime / dispatch context (slug, hub vs product). If context is missing, treat as **hub** only when the process is the hub agent; otherwise fail closed to the current product.

### Result shape (text the model sees)

Return a compact list, not JSON-only soup. Each hit:

- `product_slug` or `hub`
- `project_name` (if product)
- `date`
- `path` (absolute or hub-relative; stable enough to `read_file`)
- `snippet` (~240 characters around the first match, whitespace-collapsed; **no full file**)
- optional score (integer/float, fine)

Zero hits: one line `no journal hits`. Do not error.

Cap total tool output similarly to grep (do not exceed ~8k chars).

### Latency

Warm query should be **well under 1s** on a laptop-sized corpus (hundreds of markdown files). Rebuild of a typical hub should be a few seconds, not minutes.

---

## 9. CLI

`scripts/journal-search.sh --query "…" [--product slug] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit N] [--hub PATH]`

Same engine as the tool. Exit 0 on no hits. `--rebuild` may live on `journal-index.sh` instead.

Useful for tests and for the operator without starting an agent turn.

---

## 10. Prompts (use the tool)

Keep “read the latest 1–2 journal files” for **current** context.

Add, in the product-agent template and hub operating notes that ship in the product clone:

- For historical / “what did we decide / learn / try” questions, call **`journal_search`** before wandering the tree with grep.
- Do not paste entire journals into the prompt; use snippets, then `read_file` on a specific path if one hit is the answer.
- Product agents: search is **your product only**. Hub: all products.

Touch only what the product clone already owns (`templates/agent.md.template`, `templates/dispatch.md.template`, hub runtime prompt source if it lives in this repo). Do not rewrite live hub `AGENT.md` on the operator machine.

---

## 11. Security and hygiene

- Journals can contain operational detail. **Do not** log query strings to world-readable files beyond normal debug.
- Do not index inbox, outbox, session memory, `.env`, or secrets dirs.
- Product-scope isolation is a **feature**, not a suggestion.
- The SQLite file is local cache; deleting it is always safe (rebuild).

---

## 12. Tests

Add focused tests (Node tape/assert style already used in `agent-runtime/test/` is fine):

1. Fixture hub: hub journal + two fake products with journals on different dates.
2. Query finds the expected older hit and returns snippet + path + date.
3. `since` / `until` exclude the out-of-range file.
4. Product-scoped search on product A does not return product B rows.
5. Missing DB: first search rebuilds and still hits.
6. No embedding libraries required (assert package/deps).

Keep fixtures tiny; do not scan the live operator hub in CI.

---

## 13. Explicit non-goals (do not invent)

- Vector RAG, embeddings, chunking pipelines
- Indexing Knowledge Stack, `company/`, `docs/`, sitemaps
- Changing nightly journal *writing* or sitemap rules
- A console search UI
- Enterprise combined-KS search (different product)
- Auto-running search on every turn
- Editing the live operator hub tree

---

## 14. Done-when

1. This document (or equivalent) lives in `../dev/bizagent/docs/2026-10-05-journal-search-mvp-spec.md`. Update that repo’s `sitemap.md` Active Work.
2. Index + CLI + `journal_search` tool + tests are in the product clone and tests are green.
3. Nightly mechanical path rebuilds (or stale-on-query updates) the index.
4. Agent/hub templates tell agents to use the tool for recall.
5. Reply to hub with: spec path, how to run one example query, test command, and that **nothing was pushed** unless hub asked.
6. **Do not push. Do not touch the live hub.**

Operator will review the spec shortly; **do not wait** — file it, then build.
