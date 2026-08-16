# Library

Operator-facing documents and diagrams produced for you (plans, specs, reports).
Browse them in the BizAgent UI under **Library**.

PTL and product agents should write deliverables here (or register them)
so you can open them without SSH access to the hub.

## Diagrams (PlantUML)

End-to-end path so the operator can **click a Library entry and see the rendered image**:

1. Write PlantUML source as a top-level file: `library/<name>.puml`
2. Render SVG beside it (hub has `plantuml.sh` / Graphviz):
   ```bash
   plantuml.sh library/<name>.puml svg
   # → library/<name>.svg
   ```
3. Register in `library/manifest.json` (one entry; image is what the UI opens):
   ```json
   {
     "id": "lib_YYYYMMDD_<slug>",
     "title": "Human title",
     "path": "<name>.svg",
     "source_path": "<name>.puml",
     "kind": "diagram",
     "type": "diagram",
     "created_at": "YYYY-MM-DDTHH:MM:SS.000Z",
     "source": "agent",
     "tags": ["diagram"]
   }
   ```

From hub/agent Node code you can also call:

- `addLibraryDocument(hub, { title, filename: 'x.puml', content, source: 'agent' })` — writes `.puml`, renders `.svg`, indexes both
- `addLibraryDiagram(hub, { title, content, source: 'agent' })` — same, forces `.puml` name

Markdown docs are unchanged (`.md` / `.markdown` / `.txt`). Allowed diagram artifacts: `.puml`, `.plantuml`, `.svg`, `.png` (top-level only; no `..` / subdirs).

Smoke check: open **Library** → **Library PlantUML smoke diagram** — you should see the rendered SVG, with optional source download.
