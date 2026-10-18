# DGen Form Requests — Sensitive Input That Bypasses Chat

Date: 2026-10-18
Status: live (control-plane + console)

## What it is

Agents (hub or product) can request sensitive information from the operator —
API keys, passwords, tokens — through a modal dialog in the console. The
submitted values **never enter the chat history**, session memory, or logs.

The dialect is DGen (the operator's markup language for modal dialogs), using
the Jobe-device dialect as the base (`/home/bizagent/dev/jobeai/docs/DGEN-FORMS-SPEC.md`)
plus one new field type: `[P:]` masked password.

## Flow

1. **Agent emits a form request** — an outbox message with `kind: form-request`
   and a ` ```dgen ` fenced block:
   ```bash
   scripts/write-message.sh --to hub --from <slug> --kind form-request \
     --subject "form-request: <title>" --body-file /tmp/form.md
   ```
2. **Router intercepts it** (`lib/mail.js` → `lib/forms.js`): the markup is
   parsed server-side and appended to the originating conversation as a
   `kind: form-request` card. The outbox file is consumed — it never becomes
   mail, and the browser never sees raw DGen.
3. **Operator fills the modal** — the console card's "Provide information"
   button opens a modal built from the parsed form JSON.
4. **Submit** — the browser POSTs `/api/forms/submit`; the server writes the
   values once to `.bizagent/forms/<form_id>.json` (mode 0600, dir 0700) and
   drops a **secret-free pointer mail** into the requesting agent's inbox
   (which also wakes the agent via normal dispatch).
5. **Agent claims it** — `scripts/form-answer.sh <form_id>` prints the JSON
   and deletes the file in one step (claim-once). The chat shows only a neutral
   "Form submitted." marker.

## Non-persistence guarantees

- Values live **only** in the 0600 response file.
- Deleted on claim (`form-answer.sh` / `rm`), or auto-deleted after **24h**
  (`form-sweep` in nightly.sh, and on every submit).
- The submit endpoint logs only `form_id`, agent, button — never field names
  or values.
- The pointer mail and the conversation card contain no secrets.

## DGen quick reference (BizAgent dialect)

```
<{Form Title}>
<{Description line.}>
<{Label:}{[T:id,maxlen=default]}>          text
<{Label:}{[P:id,maxlen]}>                  masked password (BizAgent extension)
<{Label:}{[A:id,rows=default]}>            textarea
<{Label:}{[N:id,min,max=default]}>         number
<{[X:id] Inline label}>                    checkbox
<{Label:}{[D:id,v|Label,v2|Label2=default]}>  dropdown (id|label supported)
<{Label:}{[L:Label=url]}>                  link (display only)
<{[B:cancel,Cancel][B:submit,Submit]}>     footer buttons
```

Parser is deliberately lenient (LLM-mangle tolerant): bad rows/fields are
skipped; it throws only when there are no usable input fields.

## Agent awareness

- Product agents: "Sensitive input" section in the shared dispatch prompt
  (`templates/dispatch.md.template`, regenerated into `agents/<slug>/.dispatch.md`).
- Hub: "Form requests" section in the generated hub runtime prompt
  (`control-plane/lib/hub-memory.js` → `.bizagent/prompts/hub.md`).

## Hub form requests

The hub emits the same message with `--to user --from hub --kind form-request`
and **without** `--conversation-id` (so it is not funneled into the reserved
reply body); the router stamps it into the originating conversation.

## Files touched

- `control-plane/lib/forms.js` (new) — parser + ephemeral response store
- `control-plane/lib/mail.js` — form-request interception in `routeOutboxes`, `kind:` header support
- `control-plane/lib/conversations.js` — `appendMessage` carries form metadata
- `control-plane/server.js` — `POST /api/forms/submit`
- `control-plane/public/{index.html,app.js,styles.css}` — card + modal UI
- `scripts/bizagent-control-plane.js` — `--kind` flag, `form-answer`, `form-sweep`
- `scripts/form-answer.sh` (new), `scripts/nightly.sh` — claim + sweep
- `templates/dispatch.md.template`, `control-plane/lib/hub-memory.js` — agent awareness
