# bizagent-agent

OpenAI-compatible tool-calling agent runtime for BizAgent.

Local tools (list/glob/grep/read/edit/shell/fetch) + multi-provider HTTP backend
+ optional **MCP client** (BYO servers from hub `registry.json` `settings.mcp`:
**stdio**, **http** Streamable HTTP, or legacy **sse**). MCP tools appear as
`mcp__<server>__<tool>` beside built-ins; missing/hung servers soft-fail.
Remote `headers` values are env-var **refs** (not secrets in git). TLS verify
on by default. MCP ≠ agent bus (mail still mediates agents).
Defaults: temperature `0.2`, up to `100` tool iterations (`BIZAGENT_AGENT_MAX_ITERATIONS`).
Hub launches set `BIZAGENT_HUB` so MCP config resolves from any cwd.

### MCP remote example

```json
"settings": {
  "mcp": {
    "enabled": true,
    "servers": [
      {
        "name": "remote_tools",
        "transport": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": { "Authorization": "MCP_REMOTE_TOKEN" }
      }
    ]
  }
}
```

```bash
# ~/.bizagent/env — full header value via env ref name above
MCP_REMOTE_TOKEN="Bearer sk-your-token"
```

`transport: "stdio"` still works (local `command`/`args`/`env`). Prefer `http`
for remote servers; use `sse` only for legacy HTTP+SSE endpoints.

## Providers

| Name | Base URL | Key env |
|------|----------|---------|
| `xai` | `https://api.x.ai/v1` | `XAI_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `venice` | `https://api.venice.ai/api/v1` | `VENICE_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `ollama` | `http://127.0.0.1:11434/v1` | optional |

Overrides: `--provider`, `--base-url`, `-k`, `-m`, or `BIZAGENT_AGENT_*` env vars.

## CLI (dispatch-compatible)

```bash
# Headless (control plane style)
scripts/bizagent-agent -y -f /path/to/prompt.md --provider xai -m grok-4.5

# Inline
scripts/bizagent-agent -y -p "List files in ."
```

## Install deps

```bash
cd agent-runtime && npm install
```

## cli.json

```json
"bizagent-agent": {
  "executable": "scripts/bizagent-agent",
  "promptFlag": "-f",
  "flags": { "extra": "-y" },
  "models": ["grok-4.5", "gpt-4o", "llama-3.3-70b"]
}
```

Set `registry` product/hub `cliName` to `bizagent-agent` to use it.
