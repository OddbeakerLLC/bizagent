# Architecture Diagrams

PlantUML source for the BizAgent hub-and-spoke system. These are the canonical
architecture diagrams for the framework.

| File | Diagram |
|------|---------|
| `system-architecture.puml` | Hub-and-spoke system architecture (components, mailboxes, LLM, git) |
| `sequence.puml` | Turn sequence: user → control plane → hub → product agent → user |
| `use-case.puml` | Use-case diagram of the BizAgent system |
| `activity.puml` | Activity flow for a user prompt/turn |
| `smoke-library-diagram.puml` (+ `.svg`) | Library UI smoke diagram (click-to-view) |
| `2026-08-16-bizagent-hub-spoke-sample.puml` (+ `.svg`) | Sample hub-and-spoke diagram |

Browse these in the UI under **Library → Hub → docs/diagrams/** (filesystem walk; no manifest).

## Rendering

Requires [PlantUML](https://plantuml.com/) (Java) and [Graphviz](https://graphviz.org/)
(`dot`) for non-sequence diagrams. The BizAgent installer (`install.sh`) ensures
both. Render all diagrams to PNG:

```bash
plantuml docs/diagrams/*.puml
```

Or render a single diagram:

```bash
plantuml docs/diagrams/system-architecture.puml
```
