# library/ (legacy)

Operator-facing Library content now lives under hub curated directories and is
browsed by filesystem walk — **not** this folder and **not** a `manifest.json`.

| Path | Purpose |
|------|---------|
| `docs/` | Architecture, specs, technical docs |
| `docs/diagrams/` | PlantUML sources (`.puml`) + rendered `.svg` |
| `company/` | Company overview, mission, news, incidents |
| `reports/` | Reports (when present) |

The Library UI accordion shows **Hub** (only the dirs above) plus each registry
project repo. Excluded from Hub browse: `agents/`, `control-plane/`, `library/`,
`.bizagent/`, mailboxes, scripts, registry files, etc.

## Publishing diagrams

1. Write `docs/diagrams/<name>.puml`
2. Render beside it (`plantuml.sh` / `renderPlantUml`) → `docs/diagrams/<name>.svg`
3. Open **Library** → **Hub** → `docs/diagrams/` — click the file (no manifest entry)

From hub/agent Node code:

- `addLibraryDocument(hub, { title, filename: 'x.puml', content, source: 'agent' })`
- `addLibraryDiagram(hub, { title, content, source: 'agent' })`

Both write under `docs/` / `docs/diagrams/` and do **not** touch `manifest.json`.

Legacy deep links (`?id=…` or old `library/` basenames) still resolve when the
file exists under `docs/`, `docs/diagrams/`, or this legacy `library/` folder.
