# Software install approval procedure

Agents must never install software or make machine-level changes on their own.
This document defines the request/approval flow, the operator pre-approval
(allowlist) mechanism, and the audit trail.

## The default rule

Agents do **not** install packages, system software, or modify the host machine
(system services, global config, drivers, firmware) without approval. The rule
is encoded at the framework level so every agent sees it on every launch:

- `templates/agent.md.template` — Non-negotiable limit 10 ("No self-authorized
  machine changes"), rendered into each agent's `agents/<slug>/agent.md`.
- `templates/dispatch.md.template` — standing dispatch paragraph ("No software
  installs or machine-level changes on your own"), rendered into each agent's
  `agents/<slug>/.dispatch.md` on every launch.
- `control-plane/lib/hub-memory.js` `buildAgentTurnPrompt` — fallback standing
  line used when `.dispatch.md` is missing.

Existing hubs pick the rule up via `scripts/upgrade.sh` (templates + framework
code); already-rendered `agent.md` copies update on the next template apply.

## Request path (agent → hub)

When an agent determines it needs something installed, it mails **hub** (never
installs, never asks the operator directly) with:

1. **What** to install (package name + version if it matters),
2. **Why** — the task/blocker that needs it,
3. **Which product/task** needs it,
4. The **exact command(s)** it would run.

Suggested subject: `install request: <short name>`. Before mailing, the agent
may run the allowlist check — if the command is already pre-approved it can
proceed without a request:

```bash
node scripts/install-approval.js check --hub . --command "python3 -m pip install --user foo" --slug <slug>
```

`check` exits 0 when allowlisted (ALLOWED) and 1 otherwise (DENIED, with the
reason and the instruction to mail hub). Every check — allowed or denied — is
appended to the audit log.

## Hub-side handling (PTL)

On receiving an install request the hub does exactly one of:

- **(a) Perform the install itself.** The PTL runs the command, verifies the
  result, replies to the requesting agent, and logs `installed`.
- **(b) Relay an approval request to the operator** (console chat or a
  form-request for anything needing secrets). On operator approval the hub
  performs or supervises the install and logs `approved` + `installed`.

**Operator pre-approvals (allowlist).** Routine, low-risk items can be recorded
in `<hub>/.bizagent/install-allowlist.json` so they skip the ask:

```json
{
  "comment": "Operator pre-approvals for routine agent software installs.",
  "updated": "2026-11-25",
  "entries": [
    { "match": "python3 -m pip install --user", "note": "user-scope pip only" },
    { "match": "npm install", "note": "project-local npm installs in product repos" }
  ]
}
```

- Entries are **case-sensitive prefix matches** on the trimmed command line
  (whole command, first token, or prefix + whitespace). Write them precisely —
  `"npm install"` also allows `npm install -g`; prefer narrower prefixes when
  scope matters.
- Anything not matched is **denied** (default-deny; a missing file denies
  everything).
- `node scripts/install-approval.js init --hub .` creates an empty example
  allowlist; `show` prints the effective one. The operator (or hub on explicit
  operator instruction) edits the file by hand.

## Deny / defer path

If the request is denied or deferred, the agent must **work around it or report
blocked** — no silent installs, no "temporary" manual installs, no installing
in a sibling environment to dodge the rule. The agent journals the blocker and
says so in its reply to hub.

## Auditability

Every request, approval, denial, deferral, and install is appended as one JSON
line to `<hub>/logs/install-audit.jsonl`:

```json
{"ts":"2026-11-25T10:00:00.000Z","status":"requested","command":"apt-get install -y jq","slug":"bizagent","note":"needed to parse CI JSON","by":"bizagent"}
{"ts":"2026-11-25T10:05:00.000Z","status":"installed","command":"apt-get install -y jq","slug":"hub","note":"PTL performed install","by":"hub"}
```

Statuses: `requested`, `approved`, `denied`, `deferred`, `installed` (written
via `node scripts/install-approval.js log ...`), plus `allowlist-pass` /
`allowlist-deny` written automatically by `check`. The log is the machine-level
change history: review it (with the journal) to see what changed on the host
and when. It rotates with the other `logs/*.jsonl` files under the nightly log
caps.

## Quick reference

| Actor | Action |
| --- | --- |
| Agent | Needs software → `check` → if DENIED, mail hub the request; wait; work around or report blocked on deny/defer |
| Hub (PTL) | Allowlisted → agent proceeds; else perform install (a) or relay to operator (b); log the outcome |
| Operator | Approves/denies relayed requests; maintains `.bizagent/install-allowlist.json` pre-approvals |
| Audit | `logs/install-audit.jsonl` — one JSON line per request/check/approval/denial/install |
