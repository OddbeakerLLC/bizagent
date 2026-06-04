# Agent Naming and Hub Delegation Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each product agent a short human-facing name (e.g. "Agent W") confirmed during setup, store it in `registry.json`, and add hard delegation rules to the hub so it never does product-level work directly.

**Architecture:** All changes are to two plain-text files: `AGENT.md` (hub instructions) and `registry.example.json` (schema example). No scripts, no templates, no tests are affected. Changes are purely instructional.

**Tech Stack:** Markdown, JSON

---

## File Map

| File | Change |
|------|--------|
| `registry.example.json` | Add `agent_name` field to each product object |
| `AGENT.md` | § 1: add agent naming step after product groupings are confirmed |
| `AGENT.md` | § 2: note that `agent_name` is written into `registry.json` during generation |
| `AGENT.md` | § 3 Identity: add roster guidance (use `agent_name` with operator, slug in headers) |
| `AGENT.md` | § 3: add "Non-negotiable limits" block before "Two tiers of work" |

---

## Task 1: Add `agent_name` to `registry.example.json`

**Files:**
- Modify: `registry.example.json`

- [ ] **Step 1: Add `agent_name` to each product in `registry.example.json`**

  Open `registry.example.json`. The three product objects currently look like:

  ```json
  { "slug": "widgets", "name": "Widgets", "projects": [...] }
  { "slug": "platform", "name": "Platform", "projects": [...] }
  { "slug": "tooling", "name": "Tooling", "projects": [...] }
  ```

  Add `"agent_name"` after `"name"` in each one. Final result for the full `products` array:

  ```json
  "products": [
    {
      "slug": "widgets",
      "name": "Widgets",
      "agent_name": "Agent W",
      "projects": [
        { "name": "widgets-web", "path": "../widgets-web", "remote": "" },
        { "name": "widgets-api", "path": "../widgets-api", "remote": "" }
      ]
    },
    {
      "slug": "platform",
      "name": "Platform",
      "agent_name": "Agent P",
      "projects": [
        { "name": "platform-core", "path": "../platform-core", "remote": "" }
      ]
    },
    {
      "slug": "tooling",
      "name": "Tooling",
      "agent_name": "Agent T",
      "projects": [
        { "name": "cli-tools", "path": "../cli-tools", "remote": "" }
      ]
    }
  ]
  ```

- [ ] **Step 2: Verify**

  Run:
  ```bash
  grep "agent_name" registry.example.json
  ```
  Expected output (3 lines):
  ```
      "agent_name": "Agent W",
      "agent_name": "Agent P",
      "agent_name": "Agent T",
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add registry.example.json
  git commit -m "feat: add agent_name field to registry.example.json products"
  ```

---

## Task 2: Add agent naming step to `AGENT.md` § 1

**Files:**
- Modify: `AGENT.md` (lines 40–44, the step-3 block in § 1)

- [ ] **Step 1: Insert agent naming as step 3b in § 1**

  Locate this text in `AGENT.md` (currently step 3 of the interview):

  ```
  3. **Confirmation of the product groupings.** Each product needs a short
     lowercase `slug` (e.g. `jobe-ai`). One agent is created per product; an
     agent owns one or more project repos.
  ```

  Add a new numbered step `3b.` immediately after it (before the blank line that precedes step 4):

  ```
  3b. **Agent names.** For each confirmed product, propose a short name using
      initials: "Widgets" → **Agent W**, "Jobe AI" → **Agent JA** (first letter
      of each word, uppercased). If the proposed name conflicts with an
      already-confirmed agent, fall back to the first two letters of the first
      word (e.g. "Agent Wi" vs "Agent Wr"); extend to three letters if still
      clashing. Present the proposal: *"I'd suggest calling this agent
      **Agent W**. Want to use that, or do you have a different name in mind?"*
      If the operator proposes a custom name that conflicts with an existing
      agent name, flag it and ask them to choose again. Record the final name;
      it becomes the `agent_name` field in `registry.json`.
  ```

- [ ] **Step 2: Verify**

  Run:
  ```bash
  grep -n "Agent names" AGENT.md
  ```
  Expected output (one line, line number will vary):
  ```
  44:3b. **Agent names.** For each confirmed product, propose a short name using
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add AGENT.md
  git commit -m "feat: add agent naming step to interview (AGENT.md §1)"
  ```

---

## Task 3: Update `AGENT.md` § 2 to write `agent_name` into `registry.json`

**Files:**
- Modify: `AGENT.md` (step 1 of § 2)

- [ ] **Step 1: Update the registry generation step**

  Locate this text in `AGENT.md` § 2 (currently step 1):

  ```
  1. **Write `registry.json`.** Use the schema in `registry.example.json`,
     populated from the interview answers.
  ```

  Replace it with:

  ```
  1. **Write `registry.json`.** Use the schema in `registry.example.json`,
     populated from the interview answers. Include the `agent_name` confirmed
     in step 3b of the interview on each product entry.
  ```

- [ ] **Step 2: Verify**

  Run:
  ```bash
  grep -A2 "Write \`registry.json\`" AGENT.md | head -6
  ```
  Expected output includes:
  ```
  Include the `agent_name` confirmed
  in step 3b of the interview on each product entry.
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add AGENT.md
  git commit -m "feat: note agent_name written to registry.json during setup (AGENT.md §2)"
  ```

---

## Task 4: Add roster guidance to `AGENT.md` § 3 Identity block

**Files:**
- Modify: `AGENT.md` (Identity paragraph in § 3)

- [ ] **Step 1: Extend the Identity block**

  Locate this text in `AGENT.md` § 3:

  ```
  ### Identity
  You are the **Digital Products Lead**. You report to the operator (the CEO).
  You run a hub-and-spoke system: this repo is the hub; each product has one
  agent; each agent owns one or more project repos. `registry.json` is the
  source of truth.
  ```

  Replace it with:

  ```
  ### Identity
  You are the **Digital Products Lead**. You report to the operator (the CEO).
  You run a hub-and-spoke system: this repo is the hub; each product has one
  agent; each agent owns one or more project repos. `registry.json` is the
  source of truth.

  When referring to product agents in conversation with the operator, always use
  their `agent_name` from `registry.json` (e.g. "I've delegated this to
  **Agent W**"). Use the slug only in message file headers (`from:`, `to:`).
  This lets the operator direct you by name ("ask Agent W to do X") and you map
  it to the correct slug internally.
  ```

- [ ] **Step 2: Verify**

  Run:
  ```bash
  grep -n "agent_name from" AGENT.md
  ```
  Expected output (one line):
  ```
  101:  their `agent_name` from `registry.json` (e.g. "I've delegated this to
  ```
  *(line number may differ)*

- [ ] **Step 3: Commit**

  ```bash
  git add AGENT.md
  git commit -m "feat: add agent roster guidance to hub identity block (AGENT.md §3)"
  ```

---

## Task 5: Add "Non-negotiable limits" block to `AGENT.md` § 3

**Files:**
- Modify: `AGENT.md` (insert before "Two tiers of work" in § 3)

- [ ] **Step 1: Insert the Hub Law block**

  Locate this text in `AGENT.md` § 3:

  ```
  ### Two tiers of work
  ```

  Insert the following block immediately before it (preserve the blank line between sections):

  ```
  ### Non-negotiable limits
  You are a coordinator, not an implementer. These rules have no exceptions:

  1. You **NEVER** write code, edit project files, update sitemaps, or write
     journal entries for any product. Those are the agent's job, always.
  2. You **NEVER** do work that belongs to a product agent — even if it seems
     faster, even if the work is small, even if you already know the answer.
  3. When the operator gives you a task: identify the owning agent by name,
     delegate to them, wait for their reply, report back. That is the complete
     workflow.
  4. If you catch yourself touching anything inside a project repo or an agent's
     `agents/<slug>/` directory: stop, undo, delegate.

  Breaking these rules silently corrupts the journals and sitemaps the operator
  depends on.

  ```

- [ ] **Step 2: Verify**

  Run:
  ```bash
  grep -n "Non-negotiable limits" AGENT.md
  ```
  Expected output (one line):
  ```
  108:### Non-negotiable limits
  ```
  *(line number may differ)*

  Also confirm it appears before "Two tiers of work":
  ```bash
  grep -n "Non-negotiable limits\|Two tiers of work" AGENT.md
  ```
  Expected: "Non-negotiable limits" line number is lower than "Two tiers of work" line number.

- [ ] **Step 3: Commit**

  ```bash
  git add AGENT.md
  git commit -m "feat: add non-negotiable delegation rules to hub instructions (AGENT.md §3)"
  ```

---

## Done

All four files changed, all committed. The hub now:
- Proposes an agent name per product during setup and stores it in `registry.json`
- Uses agent names when talking to the operator, slugs only in message headers
- Has explicit, unconditional rules against doing product-level work directly
