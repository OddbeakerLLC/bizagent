---
title: Library PlantUML path — no scratch preview button
tags: [hub, ui, library, plantuml, web]
products: [bizagent]
status: active
created: 2026-08-23
updated: 2026-08-24
source: hub
---

# Library PlantUML path — no scratch preview button

## Problem

Operators expected diagrams in the **Library**, but the web UI kept a leftover **PlantUML** toolbar button + scratch preview modal. That path fought the product rule: write `.puml` under hub curated dirs, render SVG beside it, browse/click to view — not paste-and-preview in a dialog.

## What worked

1. Write PlantUML source under hub curated paths, e.g. `docs/diagrams/<name>.puml` (Library **Hub** accordion walks `docs/`, `company/`, `reports/` only — no `library/manifest.json`).
2. Render SVG beside it (`plantuml.sh` / CP `renderPlantUml`) → `docs/diagrams/<name>.svg`.
3. **Remove** `#plantumlBtn` and its preview modal from the web app so the only operator path is Library click-to-view (SVG + optional Source / `?render=1`).
4. Hard-refresh the UI after deploy; cached bundles keep showing the old button.

## Pitfalls

- Fixing render/allowlist without deleting the button leaves a second, unsupported UX.
- Nested `..` / path escape under browse roots is rejected — keep diagrams inside the curated trees.
- Do not reintroduce `library/manifest.json` as a required index; filesystem walk is the source of truth.

## Links

- `library/README.md` (legacy pointer → curated dirs)
- `control-plane/lib/library.js`, `control-plane/lib/plantuml.js`
- Smoke: Library → **Hub** → `docs/diagrams/` → smoke diagram
