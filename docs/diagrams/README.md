# Architecture Diagrams

PlantUML source for the BizAgent hub-and-spoke system. These are the canonical
architecture diagrams for the framework.

| File | Diagram |
|------|---------|
| `system-architecture.puml` | Hub-and-spoke system architecture (components, mailboxes, LLM, git) |
| `sequence.puml` | Turn sequence: user → control plane → hub → product agent → user |
| `use-case.puml` | Use-case diagram of the BizAgent system |
| `activity.puml` | Activity flow for a user prompt/turn |

## Rendering

Requires [PlantUML](https://plantuml.com/) (Java). Render all diagrams to PNG:

```bash
plantuml docs/diagrams/*.puml
```

Or render a single diagram:

```bash
plantuml docs/diagrams/system-architecture.puml
```
