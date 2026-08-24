---
title: Login boot crash from stale applyRoute
tags: [hub, ui, login, routing]
products: [bizagent]
status: active
created: 2026-08-23
updated: 2026-08-23
source: hub
---

# Login boot crash from stale applyRoute

## Problem

Web UI login/boot threw before auth handlers were bound because a stale **`applyRoute`** call still ran at startup. Users saw a broken login shell even when route/auth code elsewhere was fine.

## What worked

- Remove the **boot-time** `applyRoute` invocation that ran prior to auth bind.
- Keep route application on the post-auth / explicit navigation path only.
- Port the same fix to public `main` and verify login + Library still load; run existing UI tests (ignore unrelated pre-existing failures).

## Pitfalls

- “Login looks fine in one bundle” while an older cached `app.js` still has the early `applyRoute` — hard-refresh after deploy.
- Reintroducing eager apply on boot when adding deep-link features; gate on auth-ready.

## Links

- Product agent: **Agent BA** (`bizagent`) — public main fix noted as `09d9437` in hub session history
- UI entry: `control-plane/public/app.js` (and related auth/boot path)
