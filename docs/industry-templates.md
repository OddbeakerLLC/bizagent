# Industry Templates

One JSON file configures a fresh BizAgent install for a solo-business vertical —
accountant, lawyer, fitness trainer — so the AI acts as the "first employee" that
pro can't yet afford. **A new vertical is a new JSON file. No code changes.**

## The two layers

- **Layer 1 — industry template** (`templates/industries/<slug>.json`, shipped in
  the repo): agents, behaviors, system prompts, MCP connections, routines,
  privacy guardrails. Industry-generic; one template serves every customer in
  that vertical.
- **Layer 2 — customer answers** (collected at install): business name, owner
  role, where client records live, working channels, credentials. These are
  substituted into `{{variables}}` inside the template.

## Apply a template

Fresh install (one command on site):

```bash
bash install.sh --template fitness-training --answers answers.json
```

Post-install (existing hub):

```bash
scripts/apply-template.sh --template fitness-training            # interactive interview
scripts/apply-template.sh --template fitness-training --answers answers.json
scripts/apply-template.sh --list                                 # available templates
```

`--answers` is a JSON object mapping variable keys to values:

```json
{
  "business_name": "Iron Path Fitness",
  "owner_name": "Sam Rivera",
  "client_roster": "/home/sam/clients.db",
  "sms_number": "+15551234567"
}
```

Without `--answers`, the installer runs the template's variable interview
(required variables re-ask until answered; optional variables may be skipped).
Unattended installs (no TTY) **require** `--answers` and fail loud if a required
variable is missing.

### What the installer writes

| Template field | Becomes at install |
|---|---|
| `products[]` | `registry.json` product entries (slug, agent_name, model, provider) |
| `products[].system_prompt_file` | `agents/<slug>/agent.md` — industry role + guardrails prepended to the standard agent template |
| `mcp.servers` | `registry.json` `settings.mcp` (merged by server name, `enabled: true`) |
| `behaviors[]` | `settings.industry_template.behaviors` + a "Routines" section in the agent's `agent.md` — they ride the existing defer/nightly scheduling; no new control-plane concepts in v1 |
| `guardrails` | Written explicitly into the generated `agent.md` (outbound approval gate, local-only data, never contact a client without the owner) |
| `variables` | The onboarding interview; answers substituted into all `{{...}}` placeholders |
| `knowledge_stack.seed_docs` | Copied into `knowledge-stack/industries/<slug>/` |

Also created: `agents/<slug>/{.dispatch.md,inbox/archive,outbox}` mailboxes and a
local-only `data/<slug>/` directory for customer records.

Re-running `apply-template.sh` is safe: registry/MCP entries are merged by
slug/name, and an existing `agents/<slug>/agent.md` is **never** overwritten
unless you pass `--force`.

## Author a new template

1. Copy `templates/industries/fitness-training.json` to
   `templates/industries/<your-slug>.json` and set `"industry": "<your-slug>"`.
2. Write the system prompt file(s) the products reference
   (`industries/<your-slug>/<agent>.md`, relative to `templates/`). Cover the
   vertical role, the guardrails, and any money/UPL/approval boundaries. Use
   `{{variable_name}}` anywhere a customer answer belongs — every placeholder
   must be declared in `variables`.
3. Add seed docs under `templates/industries/<your-slug>/docs/` and list them in
   `knowledge_stack.seed_docs` (globs must match at least one file).
4. Done — `scripts/apply-template.sh --template <your-slug>` picks it up.

### Schema v1 rules (validated, fail loud)

- Top-level: `template_version` (must be `1`), `industry` (must equal the slug),
  `display_name`, `variables[]`, `products[]`, `mcp.servers[]`, `behaviors[]`,
  `guardrails`, `knowledge_stack`. **Unknown fields are rejected.**
- `variables[]`: `{key, question, required, default?}`; keys match
  `[a-z][a-z0-9_]*`.
- `products[]`: `{slug, name, agent_name, system_prompt_file, autonomy, model?,
  provider?}`; `system_prompt_file` must exist; empty model/provider fall back
  to the registry's `agent_default` / hub provider (fail if those are unset too).
- `mcp.servers[]`: `{name, transport, command|url, args?, headers?, env?,
  required?}`; `stdio` needs `command`, `http`/`sse` need `url`. Put customer
  paths/numbers in `env` or `args` as `{{variables}}`.
- `behaviors[]`: `{agent, routine, trigger, detail}`; `agent` must be a template
  product slug; `trigger` ∈ daily | weekly | monthly | schedule | nightly.
- `guardrails`: all three booleans required; `local_only_data` must be `true` —
  the local-only-data guardrail is written explicitly into every generated
  `agent.md`.
- Every `{{variable}}` used anywhere (template JSON or prompt files) must be
  declared in `variables`.

## Door-to-door install kit (USB stick)

Build the bundle from any clone (includes `.git` so the installer can clone
locally — no internet needed for the framework; model/API access still needs
connectivity):

```bash
git clone https://github.com/OddbeakerLLC/bizagent.git
tar czf bizagent-bundle.tgz -C .. bizagent
cp bizagent-bundle.tgz answers.json /media/usb/
```

On site (USB mounted at `/media/usb`):

```bash
BIZAGENT_DIR="$HOME/bizagent" \
BIZAGENT_SOURCE=/media/usb/bizagent-bundle.tgz \
  bash /media/usb/bizagent/install.sh \
  --template fitness-training --answers /media/usb/answers.json
```

Pre-fill `answers.json` from the customer intake call before the visit; the
single command above produces a fully configured hub (registry, agent dir,
prompts, MCP config, seeded docs) and starts the control plane.
