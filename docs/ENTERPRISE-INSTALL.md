# BizAgent Enterprise server installer

`install/install-enterprise.sh` installs BizAgent as an **Enterprise server**:
an always-on, hosted control plane with a systemd system service, TLS, an
initialized console login, and a settings profile tuned for unattended
operation. It uses the standard hub layout, so `scripts/upgrade.sh` and
`scripts/factory-reset.sh` keep working unchanged.

## Install

```bash
git clone https://github.com/OddbeakerLLC/bizagent.git /opt/bizagent
cd /opt/bizagent
sudo BIZAGENT_ADMIN_USER=ops BIZAGENT_ADMIN_PASSWORD='…' \
  bash install/install-enterprise.sh --tls --service-user bizagent
```

Non-interactive auth: set `BIZAGENT_ADMIN_USER` and `BIZAGENT_ADMIN_PASSWORD`
in the environment (never on the command line). Interactive runs prompt for a
hidden password instead.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--hub PATH` | repo root | hub root to install |
| `--host HOST` | `0.0.0.0` | control-plane bind host |
| `--port PORT` | `8787` | control-plane port |
| `--tls` | off | enable TLS; a self-signed cert is generated into `.bizagent/tls/` on first start |
| `--tls-cert F --tls-key F` | off | use an existing cert/key (written to `BIZAGENT_TLS_CERT`/`BIZAGENT_TLS_KEY`) |
| `--admin-user NAME` | current user | console operator login |
| `--service system\|user\|none` | `system` | systemd system service / user service / none |
| `--service-user NAME` | current user (root: required) | user the system service runs as |
| `--skip-npm` | off | skip `npm install` (deps already present) |
| `--yes` | off | non-interactive; fail instead of prompting |

## What it sets up

1. **Dependencies** — Node.js v22+ (auto-installs the latest LTS when missing),
   `npm install` for the hub and `agent-runtime`.
2. **Enterprise settings profile** (written into `registry.json`):
   - `control_plane.host` / `port` — LAN-reachable bind.
   - `control_plane.tls.enabled` — when `--tls` or cert/key paths are given.
   - `dispatch.allow_concurrency: true`, `agent_slots: 2` — concurrent agent
     turns with a per-provider cap of 2.
   - `dispatch.api_min_interval_ms: 500`, `rate_limit_cooldown_secs: 300`,
     `hold_cooldown_secs: 1800` — gentle handling for shared provider keys.
3. **TLS** — self-signed (auto-generated, `~10y`, key `0600`) or your own
   cert/key via env. Behind a reverse proxy instead? Skip `--tls` and set
   `BIZAGENT_PUBLIC_URL=https://biz.example.com` in `.bizagent/env`.
4. **Auth init** — creates the console login via
   `node scripts/bizagent-control-plane.js auth-init` (skipped when
   `.bizagent/auth.json` already exists).
5. **Service** — a systemd **system** unit
   (`install/bizagent-control-plane-system.service`, `WantedBy=multi-user.target`,
   `Restart=on-failure`, `NoNewPrivileges`, `PrivateTmp`) running as a
   non-root user. `--service user` delegates to `scripts/install-control-plane.sh`
   (user unit, for hosts without root); `--service none` skips service setup.
6. **Log profile** — `BIZAGENT_LOG_MAX_BYTES=10485760` (10 MB) and
   `BIZAGENT_LOG_KEEP_GENERATIONS=3` in `.bizagent/env`, so a busy server
   rotates instead of growing unbounded.
7. **Health watchdog** — `scripts/install-health-timer.sh` (best effort).
8. **Verify** — waits for the port, probes `/api/health`, then runs
   `scripts/check-hub-ready.sh`.

## Day-2 operations

```bash
systemctl status bizagent-control-plane.service   # system service
bash scripts/upgrade.sh                           # upgrade (compatible)
bash scripts/factory-reset.sh repair              # recovery (compatible)
scripts/migrate.sh export                         # move to another host (docs/MIGRATION.md)
```

Add products through the console or `registry.json` after install; the
installer seeds an empty registry (no products) when none exists.
