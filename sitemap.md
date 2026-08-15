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
- Systemd for service management (optional).

## Active Work
- **Add reasoning extraction to agent runtime** (2026‑08‑15): Mapping provider‑specific reasoning fields (`reasoning_content` for Grok/Venice, `reasoning` for ChatGPT/Gemini/OpenRouter, `thinking` for Claude) and logging `Thinking:` lines to stdout for hub preview.

## Known Issues
- None currently tracked.