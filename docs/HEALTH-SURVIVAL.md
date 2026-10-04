# Health & Survival Instinct

The incident that drove this: a product agent filled the shared volume with a
200 GB unbounded VCD until `/` hit 100% and the hub could not write or restart.
Survival instinct watches the **whole hub volume and its growth rate**, and
alerts even when the LLM / control plane is already wedged.

## Two watchdog layers

1. **In-process** (`control-plane/server.js`, every ~45s): cheap `statfs` / `os`
   checks via `control-plane/lib/health.js`. Dies with the control plane, so it
   is not enough alone.
2. **Out-of-process** (`scripts/health-probe.sh` → `control-plane/lib/health-probe.js`,
   systemd **user** timer or cron every 2 min): a few-KB probe that only needs
   to write one small status file (`logs/health.json` overwrite + one-line
   `logs/health.status`). Works when the control plane cannot start; systemd
   `OnFailure=` still fires.

Install the timer: `scripts/install-health-timer.sh [hub-path]`
(optional `BIZAGENT_HEALTH_WEBHOOK` for out-of-band Slack/ntfy/email alerts via
`scripts/health-alert-failure.sh`). Probe exit codes: 0 ok/warn, 1 critical,
2 emergency, 3 probe itself failed (all non-zero trigger `OnFailure=`).

The timer is wired in automatically: a fresh `install.sh` / `install/install.sh`
installs and enables it after setup, and `scripts/upgrade.sh` installs it when
missing (idempotent — existing timers are left untouched; dry-run mentions the
step). Set `BIZAGENT_SKIP_HEALTH_TIMER=1` (or upgrade with `--no-health-timer`)
to opt out. If the environment has no systemd user session and cron cannot be
written, install/upgrade print the single command to run by hand.
`scripts/install-health-timer.sh --check` exits 0 when the probe is wired up.

## Checks and tripwires

| Check | Warn | Critical | Emergency |
|---|---|---|---|
| Disk free on hub volume | <15% or <10 GB | <10% or <3 GB | <5% or <1 GB |
| Inodes | >80% | >90% | >95% |
| Hub `logs/` size | >200 MB | >1 GB | growth >50 MB/h |
| Volume growth rate | fast fill toward warn | heading to critical | heading to 100% |
| RAM available | <15% | <8% | OOM in last hour |
| Load / FD count | high vs CPU | near `ulimit` | fork/EMFILE |
| Control-plane heartbeat | missed 1 min | missed 3 min | crash loop |
| Hub daemon / lock / pid | stale lock | CP pid dead | cannot start |
| Registry/env/auth readable | — | corrupt/unreadable | — |
| Provider key present | — | missing | — |
| Filesystem | — | — | read-only remount / unwritable hub dirs |
| Clock | — | — | wall-clock jump >90s between probes |

Also flagged: `provider_fallback_active` (paid provider refused; hub turns on
local Ollama — see below).

## Reserved free-space buffer

`control-plane/lib/log-caps.js` keeps a reserved buffer (default **1.5 GB**,
`BIZAGENT_RESERVED_FREE_BYTES` to override). Bulky writes (≥256 KB — uploads,
exports, session dumps, big log appends) are **refused** while the buffer is at
risk; small JSON/status writes always pass. `structured-log.js` guards every
append. Emergency mitigation truncates `logs/*.{log,stderr,jsonl}` to their
tails **before** the disk hits 100%.

## Emergency auto-mitigation (no LLM)

On an emergency report the watchdog, without any model involvement:

- enters **safe mode** (below),
- caps hub logs (512 KB tails),
- prunes mail archives (`scripts/prune-archives.sh --days 3`),
- stops helper processes (`--helper`).

**Never** touched: git, `registry.json`, `company/`. Product artifacts (VCDs,
checkpoints) are **never** auto-deleted — warn only.

## Boot safe-mode

`control-plane/lib/safe-mode.js`. When the flag `.bizagent/safe-mode.json` is
present (set automatically on emergency, or by hand), the control plane only
serves login/setup/logout, the health JSON, and a blocking banner. No agent
launches, no mail routing, no multi-MB log appends, no session dumps. All other
APIs get `503` with the health payload so the UI can banner it.

## Alerts (none depend on a successful hub turn)

1. **UI banner** on every console page (`/api/health`, polled every 30s):
   red = safe mode / critical / emergency; yellow = warn or
   `provider_fallback_active`. Persisted server-side — stays until green.
2. **Console chat line** once per incident (30-min dedupe) so it lands in
   conversation history.
3. **Out-of-band:** systemd `OnFailure=` → `health-alert-failure.sh` writes
   `HEALTH-ALERT.md` and posts the optional webhook — works with port 8787 down.
4. **Local last-resort:** `HEALTH-ALERT.md` in the hub root (Library can show
   it); removed automatically when the next check is green.

## Hub-only Ollama fallback (provider reachable, request refused)

`control-plane/lib/ollama-fallback.js`, hooked from
`dispatcher.recordAgentError`. Trips only on **credits / auth / model**
refusals (via `provider-errors.js`) — never on network outages, rate limits,
or bad prompts, and **never for product agents** (they stay paused; hub turns
only).

1. Classify the hub LLM error.
2. If Ollama is installed and `127.0.0.1:11434` is up, pull `qwen3:4b` if
   missing (`BIZAGENT_OLLAMA_FALLBACK_MODEL` to override). The pull is
   **skipped** when the disk is already in the emergency zone.
3. The next hub turn (cold dispatcher or warm daemon) launches with a
   **launch-time override** — `registry.json` / `cli.json` are never rewritten.
4. The operator is told in console chat what failed and what to fix (top up,
   new key, switch provider). If Ollama is missing/unavailable, the existing
   provider-failure message + health alert stand — no silent death.
5. Health flag + banner `provider_fallback_active` until a paid-provider probe
   (cheap authenticated `GET /models`) succeeds again; the in-process health
   tick probes while the flag is active.

## Tests

`tests/test-health.sh` — classification tripwires, log-cap/refuse-write,
safe-mode gate, fallback trigger (credits/auth/model vs network/rate-limit),
out-of-process probe end-to-end, growth-rate sampling, HEALTH-ALERT lifecycle.
