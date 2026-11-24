# Moving a BizAgent installation to another computer

`scripts/migrate.sh` is the supported way to move an existing installation
(hub + registry + agents + mail + knowledge stack) to a different machine.
It complements, and does not replace, `scripts/migrate-to-bizagent-host.sh`
(the one-off host-specific mover) and `scripts/factory-reset.sh` (recovery).

## Quick path

On the **source** machine:

```bash
scripts/migrate.sh export                 # → ../bizagent-migration-<stamp>.tar.gz
```

Copy the archive to the target machine (scp, USB, etc.), then on the **target**:

```bash
tar not needed — restore unpacks it:
scripts/migrate.sh restore --archive bizagent-migration-<stamp>.tar.gz --hub ~/bizagent
```

`restore` unpacks, re-binds paths/host/port from the manifest inside the
archive, regenerates `node_modules`, and runs `verify`. Finish with a live
check:

```bash
scripts/migrate.sh verify --hub ~/bizagent --start
```

`--start` boots the control plane and probes `/api/health` (and llmapi when
configured). Keep the source control plane stopped or idle until the target
verifies clean — two live hubs on one registry cause dual-write confusion.

## Subcommands

| Command | Purpose |
| --- | --- |
| `export [--hub P] [--out F] [--include-logs]` | Full-state archive (chmod 600 — it contains provider keys and auth). |
| `restore --archive F --hub P [--host H] [--port P] [--public-url U] [--remote-map OLD=NEW] [--skip-npm] [--force]` | Unpack + rebind + npm install + verify. `--force` merges into a non-empty dir. |
| `rebind --hub P [--old-root X] [--host H] [--port P] [--public-url U] [--remote-map OLD=NEW]` | Re-bind an already-copied hub without a manifest. |
| `verify [--hub P] [--start]` | Registry, project paths, agent mailboxes, auth, deps, control-plane probe. |

`--remote-map OLD=NEW` rewrites git remote URLs (repeatable) — use it when
project remotes moved hosts, e.g. `--remote-map 'git@old.example:=git@new.example:'`.

## What re-binding touches

- `registry.json` — absolute project paths under the old hub root are rewritten to the new root; `settings.control_plane.host` / `.port` are set from `--host` / `--port`; product/project `remote` fields get `--remote-map` rewrites.
- `.bizagent/env` — values containing the old root are rewritten; `BIZAGENT_HOST` / `BIZAGENT_PORT` / `BIZAGENT_PUBLIC_URL` are updated when the matching flags are given (env wins over registry, so both are set).
- `agents/*/agent.md` — absolute paths mentioning the old root are rewritten. Relative paths (`../dev/<project>`) need no change when the target keeps the same `hub/../dev` layout; if it does not, fix the paths or update the registry project paths before `verify`.

## Safe to copy verbatim vs regenerate

**Copy verbatim (in the archive):**

- `registry.json`, `cli.json` — product registry and provider catalog.
- `agents/` — role files, `.dispatch.md`, and every mailbox (`inbox/`, `outbox/`, `archive/`, journals under `.agent/`).
- `.bizagent/` — `env` (provider keys), `auth.json` (console login), `conversations/`, `sessions/`, `dispatch-state/`, `defer/`, `health-state`, cross-chat alerts, `tls/` (keeps the same TLS identity), and the migration manifest.
- `company/`, `journal/`, `knowledge-stack/`, `library/` — company inputs, journals, knowledge stack, library documents.
- Framework code and `.git/` — the exact version the hub was running.

**Regenerated on restore (excluded from the archive):**

- `node_modules/` (hub + `agent-runtime/`) — `npm install` re-creates them (`--skip-npm` to skip).
- `logs/` — recreated empty (`--include-logs` keeps them, e.g. for a post-mortem move).
- Runtime scratch: `.bizagent/runtime-cwd/`, `.bizagent/prompts/turns/`, `.bizagent/pending-replies/`, `*.pid`, `*.sock`, `hub.lock`, `control-plane.heartbeat`, per-agent `.lock/` dirs, `.bizagent/forms/` (unclaimed DGen responses auto-expire after 24 h), `.bizagent/backups/`.

**Never copied (re-create by hand):**

- Provider API keys that lived only in the shell environment and not in `.bizagent/env` — re-enter them via the console or `.bizagent/env`.
- Anything outside the hub root that the registry points at (project repos under `~/dev`): clone them on the target, or use `scripts/migrate-to-bizagent-host.sh`, which clones projects with a git remote instead of copying them.

## After the move

1. `scripts/migrate.sh verify --hub <new-root> --start` — must PASS.
2. Log into the console, confirm conversations + library are present.
3. Ping one product agent from the UI (end-to-end dispatch check).
4. Only then stop the source control plane (`systemctl --user stop 'bizagent-control-plane-*.service'`).
