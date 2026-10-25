# Design: business-type presets drive onboarding defaults

Status: shipped 2026-10-25 (hub dispatch). Owner: bizagent (framework).

## Problem

First-run onboarding (AGENT.md § 1) should not interrogate the operator about
individual enforcement features (code review, approval gates, testing bar).
One question — "what type of business is this?" — is enough to pick sensible
defaults, and everything stays overridable afterwards.

**Discrepancy note (hub-flagged):** the public framework never shipped a "wall
of feature-gate questions." § 1's approved beats are org → repos → groupings →
agent names → peer messaging → nightly → KS → archive → autonomy → remote →
LLM → CP login → summary; neither `AGENT.md` nor `templates/agent.md.template`
contains code-review/approval-gate/testing-bar questions. So this change does
not *remove* anything — it **introduces** the business-type question and the
preset map as new schema/settings, and guarantees no per-feature gate questions
get added later (they are explicitly listed as "do not ask").

## Design

### 1. One new § 1 beat: business type

Inserted as beat 2 (right after welcome + org name) so it frames the rest of
setup. The operator picks from a curated list (software developer, product
manufacturer, lawyer, accountant, consultant, e-commerce/retail, agency, …) or
chooses **other** with free text. One question, one turn — it *replaces* the
individual code-review / approval-gate / testing-bar questions by never asking
them.

### 2. Preset map — `templates/business-presets.json`

Static, shipped in the repo. Each entry:

```json
{
  "slug": "software-developer",
  "label": "Software developer",
  "aliases": ["software", "dev", "saas"],
  "defaults": {
    "agent_roles": ["implementer", "reviewer"],
    "approval_gates": ["code_review"],
    "features_off": ["client_messaging"]
  }
}
```

- `agent_roles` — roles the product agents act as by default (rendered as
  guidance into `agent.md`; BizAgent keeps one agent per product, so "roles"
  are hats, not extra agents).
- `approval_gates` — enforcement rendered into `agent.md`:
  `code_review` (software dev), `document_review` (law/accounting),
  `qa_shipment` (manufacturing), `client_approval` (agency/consultant).
- `features_off` — features left off by default for this type (e.g. direct
  client messaging for law/accounting).

`other` (free text) maps to the `generic` preset: no gates, no roles — the
operator configures what they want later.

### 3. Registry schema addition — `settings.business_type`

```json
"business_type": {
  "slug": "software-developer",
  "label": "Software developer",
  "custom": false,
  "applied_at": "2026-10-25T12:00:00Z",
  "defaults": { "agent_roles": [...], "approval_gates": [...], "features_off": [...] },
  "overrides": {}
}
```

- Written during § 2 generate (step 1) from the § 1 answer.
- `custom: true` + `slug: "other"` for free-text answers (`label` = their text).
- **Starting point, not a cage:** post-setup overrides are plain registry edits
  — change `defaults`, or set `overrides` to add/remove gates; re-render agent
  files with `scripts/business-preset.sh section`. Absent block = no preset
  (backward compatible with existing hubs).

### 4. Conditional agent-template rendering

`templates/agent.md.template` gains a `{{BUSINESS_PRESET_SECTION}}`
placeholder. `scripts/business-preset.sh section` reads the hub's
`registry.json` and prints the markdown section (empty string when
`settings.business_type` is absent, so existing hubs and the industry-template
path are unaffected). Rendered gates:

- `code_review` → never merge/push unreviewed changes; produce a review
  summary for the owner.
- `document_review` → drafts (filings, letters, returns) are never
  filed/sent without owner review.
- `qa_shipment` → production/shipment changes require a completed QA
  checklist.
- `client_approval` → anything sent to a client needs owner sign-off.

Agents spawned after setup inherit the section because it is baked into
`agents/<slug>/agent.md` at generate time.

### 5. What stays out of onboarding

Per-service integrations (email, Google apps, calendars) remain per-product /
industry-template territory (`templates/industries/*.json` + `apply-template.sh`)
— not § 1 questions. The industry-template layer is unchanged; a hub can use
both (industry template for a vertical product, business_type for hub-wide
defaults).

## Files

- `templates/business-presets.json` — the preset map (new).
- `scripts/business-preset.sh` — `list` / `show <slug>` / `section` (new).
- `AGENT.md` — § 1 beat 2 + "do not ask" note; § 2 steps 1/3 wiring.
- `templates/agent.md.template` — `{{BUSINESS_PRESET_SECTION}}` placeholder.
- `registry.example.json` — `settings.business_type` example + comment.
- `control-plane/lib/hub-memory.js` — minimal-state beat list mentions
  business type (keeps the slim first-run prompt in sync with § 1).
- `tests/test-business-presets.sh` (new), `tests/test-agent-md.sh` (beat
  renumbering; also fixes its stale pre-existing numbering failure).

## Non-goals

- No control-plane UI for editing presets (registry edits are enough).
- No new agent-per-role spawning; roles are guidance inside the one agent.
- No per-service integration questions in § 1.
