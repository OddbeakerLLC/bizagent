# BizAgent Product Sitemap

## Overview
BizAgent is a hub-and-spoke system for running AI agents across digital products. This repository includes the control plane, agent runtime, and operational tooling.

## Structure
- `agent-runtime/` – OpenAI-compatible tool-calling agent runtime (multi-provider).
- `control-plane/` – Web UI, dispatcher, mail router, hub daemon.
- `agents/` – Per-product agent definitions and mailboxes.
- `scripts/` – Operational scripts (control plane, nightly, pruning, etc.).
- `templates/` – Templates for agent.md, dispatch, NIGHTLY, WEEKLY.
- `tests/` – Integration test suite.
- `docs/` – Architecture and planning documents.

## Key Integrations
- LLM providers: Grok (xAI), ChatGPT (OpenAI), Claude (Anthropic), Gemini (Google), Venice, Ollama.
- File‑based messaging (inbox/outbox).
- Git for version control of product repos.
- Environment variables via `~/.bizagent/env`.
- Systemd for service management (optional).

## Active Work
- **Fleet-wide rate-limit cooldown** (2026-10-21): first `rate_limit` classification writes `.bizagent/rate-limit-cooldown.json`; `dispatchPendingAgents()` gates every launch (hub + product agents) until the window expires. `settings.dispatch.rate_limit_cooldown_secs` (default 120, clamp 30–3600); each new 429 extends the window. rate_limit error card text updated. Tests in `tests/test-dispatch.sh`. Public `82c9c5f`.
- **TTS summary full-read fix** (2026-10-21): labeled-TLDR speak path no longer caps sentence chunks at 2 — a two-sentence summary with internal periods ("v2.1", "e.g.") is spoken in full. Regression test in `tests/test-control-plane.sh`. Public `95504d4`.
- **Allow concurrency nav switch — restored** (2026-10-21): merge `9d91a34` had silently reverted the feature; re-applied from `45e3fbd` (public `c4048a9`). Same merge also reverted the agent-runtime fault tolerance below — flagged to hub, not yet re-added.
- **Allow concurrency nav switch** (2026-10-20): hamburger / Nav drawer, next to TTS. Default ON. Unchecked = at most one live turn (hub or product agent). Persist `settings.dispatch.allow_concurrency` (omit/true = allow). GET/POST `/api/settings/dispatch`. Env `BIZAGENT_ALLOW_CONCURRENCY=0` forces off. Tests: `tests/test-settings-dispatch.sh` + serial case in `tests/test-dispatch.sh`.
- **LLM API fault tolerance: retry with backoff + circuit breaker** (2026-10-20): `agent-runtime/src/client.js` now retries transient errors (429/5xx/network timeouts) with exponential backoff + jitter. Circuit breaker opens after N consecutive failures with configurable cooldown. Graceful degradation via RETRIES_EXHAUSTED / CIRCUIT_OPEN error codes. Configurable via env vars: `BIZAGENT_AGENT_MAX_RETRIES`, `BIZAGENT_AGENT_RETRY_BASE_MS`, `BIZAGENT_AGENT_CIRCUIT_THRESHOLD`, `BIZAGENT_AGENT_CIRCUIT_COOLDOWN_MS`. Public `ad72708`; enterprise `1a1591b`.
- **Optional TLS (self-signed) for console server** (2026-10-18): hub spec; `control-plane/server.js` switches to `https.createServer` when TLS is configured (`settings.control_plane.tls.{enabled,key,cert}` or `BIZAGENT_TLS_KEY`/`BIZAGENT_TLS_CERT`), plain http otherwise. Missing cert material → self-signed auto-generated into `<hub>/.bizagent/tls/` (CN=<hostname>, ~10y, key 0600). Startup log prints https URL. Opt-in; default behavior unchanged; no new caching. Public `e1f4367` (pushed); hub run repo synced.
- **TTS aside heading "Spoken summary" → "Summary"** (2026-10-17): operator request; `control-plane/public/markdown.js` aside header label + nearby comment now read "Summary" (speaker icon/styling/speak path unchanged). Public `91c3ef0` (pushed); local synced via merge `9e61784`. Cache-bust `20261017-summary-label` in index.html/library.html. `docs/TTS-CONSOLE.md` never named the label — no doc change needed. Static-only, no CP restart — hard refresh.
- **Agent errors route to originating conversation** (2026-10-12): `resolveAlertConversationId` prefers the slug's pending-agent-work conversation; other chats get a one-line "error waiting" badge (`/api/cross-chat-alerts` GET, cleared on open; 24h TTL, `.bizagent/cross-chat-alerts.json`). Commit `0eb8bf5` (local main, not pushed). Test `tests/test-cross-chat-alerts.sh`. Live CP restarted 15:18 with the change; cache-bust `20261012-cross-chat-alert`.
- **Hub-only chat thinking stream** (2026-10-12): agent dispatches no longer post a launch-ack / recordThinking into the conversation — only the hub may own a chat thinking bubble. `/api/thinking/stream` pinned strictly to the hub slug (no latest-slug fallback); `/api/thinking/stop` keeps the fallback for legacy residue (TTL-pruned). Agent logs remain in the fleet thinking viewer. Commit `3e01780` (local main, not pushed).
- **Ordered-list numbers** (2026-09-30): chat and library already share `control-plane/public/markdown.js`. Blank lines between items closed the `<ol>`, so each item restarted at 1. Loose same-type items stay one list; explicit `value`/`start`. Cache-bust `20260930-ol-numbers`. Not a CSS reset.
- **Secure paste dialog v1** (2026-09-26): browser-only key dialog on `#configModal` (one provider, `keyEnv` + saved/not set, password field, never shows the value). `POST /api/secrets` writes one line to `hub/.bizagent/env` (mode 600) and `process.env`. Hub `secret-request:` markers are stripped before conversation/inbox. Redaction refuses chat/inbox text that contains a current env secret (≥12 chars). SSH `chat.sh` has no dialog; keys must not be passed on the command line. Test: `tests/test-secrets.sh`.
- **Clipboard image paste → vision** (2026-09-04): console Ctrl/Cmd+V pastes clipboard images into the chat; rides uploads pipeline + `Attachments:` mail blocks; turn prompts carry a `bizagent-vision` marker the runtime attaches as `image_url` content (hub + product agents; uploads/company roots only; cap 8). Soft-fail text-only retry with operator-visible note if the model can't take images. Public `e50e564`; live hub synced (runtime + hub-memory + static); CP + hub-daemon restarted. Cache-bust `20260904-paste-vision`.
- **Console conversation-switch animation** (2026-09-04): 250ms fade+slide of the messages panel on conversation change; no added delay; `prefers-reduced-motion` respected. Public `993b446`; live hub static synced.
- **Key-gated model picker + live model lists** (2026-09-04): providers gated on saved API keys; server-side `GET /api/provider-models` (OpenAI-style + Anthropic /v1/models); chat-model filtering, display names, pricing when reported; custom entry + cli.json fallback. Public `a919839`; live hub synced (server.js + lib + static); CP restarted.
- **Silent model fallback fix** (2026-09-01): fail-clear when agent model unset; roster `(unset)`; public `a8d00b2`; live CP restarted.
- **Operator stop + no re-dispatch** (2026-09-01): live hub synced from public `bdec5d3`; CP + hub-daemon restarted. Hard-refresh UI cache-bust `20260901-operator-stop`.
- **MCP paste-in onboarding** (2026-08-31): live hub has `scripts/mcp-onboard.js` + `docs/MCP-ONBOARD.md` from public `3df1208`. Paste path ready; MCP still default off until operator paste.
- **MCP remote HTTP/SSE** (2026-08-31): live runtime synced from public `baa98ea` (Streamable HTTP + legacy SSE client). `settings.mcp` still default off.
- **MCP client MVP** (2026-08-31): runtime + CP launch path synced from public `0f2fbb5`; `settings.mcp` default off on this hub.
- **Nested markdown lists + shared renderer** (2026-08-30): single `control-plane/public/markdown.js` for console + library; nested ul/ol (2+ spaces/tab; mixed; multi-child). Cache-bust `nested-lists`. Public `f06b562`; live hub static applied.
- **TTS last-word cutoff** (2026-08-29): scrub kept stripping trailing connectors (`on`/`for`/…); Web Audio also padded +200ms so final phoneme is audible. Public main + live static; hard-refresh `?v=20260829-tts-lastword`.
- **Library MD hr + math** (2026-08-28): thematic breaks → `<hr>`; display/inline math prettified monospace blocks (no KaTeX). Public `5916a2c`; live hub static applied.
- **Library nested Product→Project accordion** (2026-08-28): Hub first, then products → projects → files. Live hub matches public `e4ea97c`.
- **Remove PlantUML preview button** (2026-08-20): chat-header PlantUML button/modal + `/api/plantuml/render` scratch endpoint removed; Library remains sole PlantUML path.
- **Library named-tab + repo accordion** (2026-08-18): full-page Library tab with registry-repo accordion browse.
- **Add reasoning extraction to agent runtime** (2026‑08‑15): Mapping provider‑specific reasoning fields (`reasoning_content` for Grok/Venice, `reasoning` for ChatGPT/Gemini/OpenRouter, `thinking` for Claude) and logging `Thinking:` lines to stdout for hub preview.

## Known Issues
- `tests/test-control-plane.sh` fails on main (pre-existing, 2026-10-21): always-on hub prompt is 8951 bytes vs the 8500 budget (drift since `dceba0e` DGen forms). Unrelated to recent fixes; needs a prompt slim-down or budget decision.
- Merge `9d91a34` (2026-10-20) reverted the agent-runtime fault tolerance (`agent-runtime/src/client.js` retry/backoff + circuit breaker, `index.js` error handling). Flagged to hub 2026-10-21; not re-added yet.