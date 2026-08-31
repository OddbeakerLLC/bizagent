# MCP paste-in onboarding (hub operator contract)

**Audience:** hub PTL / control-plane operators. Not a public README feature pitch.
**User-facing path:** remote HTTP/SSE MCP only. Stdio/BYO stays internal (tests + maintainer).

## Goal

Operators must **never** be told to edit `registry.json` or `.bizagent/env` to add an MCP server.
They paste connection info from a vendor (Zapier, etc.) into hub chat; the hub runs a small helper that wires config + secrets and confirms tools.

## Helper

```bash
node scripts/mcp-onboard.js --hub "$BIZAGENT_HUB" paste --stdin
# or:  --text '...'   |   --file /path/paste.json
```

| Command | Purpose |
|--------|---------|
| `parse` | Dry-parse paste → JSON (`status: ok` or `needs_input` + `questions[]`) |
| `paste` | Write secrets + `settings.mcp`, optionally verify `tools/list` |
| `list`  | Show configured servers (no secrets) |
| `verify [name]` | Connect + list tools (soft-fail) |

**Flags (paste):** `--name` `--url` `--token` `--transport http|sse` `--header K=V` `--no-verify` `--dry-run` `--allow-no-auth`

**Exit codes:** `0` saved/connected/soft-fail · `2` needs operator input · `1` hard error  
**Stdout:** one JSON object. **Never** prints secret values.

## Hub UX contract

1. Operator pastes vendor MCP blob (JSON, Cursor `mcpServers`, URL + Bearer text, etc.).
2. Hub runs `paste` (or `parse` first if the blob looks incomplete).
3. If `status: needs_input` → ask **1–2** clarifying questions from `questions[]` (e.g. token, display name). Do **not** say “edit registry/env”.
4. If `status: connected` → reply exactly in this spirit:  
   **`connected: <name> → N tools`** (use `message` from JSON).
5. If `status: soft_fail` → config is saved; tell operator the server was unreachable/empty and agent turns will skip it until it responds — no manual file edits.
6. **Reload:** none required. Next agent turn re-reads `registry.json` and sources `.bizagent/env` on launch (`loadHubEnv` + shell `. env`). No control-plane restart.

## What the helper writes

- **Secrets only** → `hub/.bizagent/env` as `MCP_<SLUG>_TOKEN=…` (mode 600). Full header value (including `Bearer `).
- **Server entry** → `registry.json` → `settings.mcp.enabled: true` + `servers[]` with `url`, `transport`, `headers` whose values are **env-var name refs** (not literals).
- **Idempotent:** same name (or same URL) updates in place; safe slug from vendor name/URL.

## Example

Paste:

```json
{
  "mcpServers": {
    "zapier": {
      "url": "https://mcp.zapier.com/api/mcp/s/…",
      "headers": { "Authorization": "Bearer sk-…" }
    }
  }
}
```

Hub:

```bash
printf '%s' "$PASTE" | node scripts/mcp-onboard.js paste --stdin
```

Result (shape):

```json
{
  "ok": true,
  "status": "connected",
  "message": "connected: zapier → 12 tools",
  "tool_count": 12,
  "reload": "none — next agent turn re-reads registry.json and sources .bizagent/env (no CP restart)"
}
```

Tools appear on the **next** hub/product agent turn as `mcp__zapier__<tool>`.

## Safety

- Unreachable servers soft-fail; built-in tools still run.
- Do not expand public README with stdio/BYO MCP.
- Do not commit `.bizagent/env` or put token literals in `registry.json`.
