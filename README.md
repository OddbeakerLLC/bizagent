# BizAgent

**An interview-driven starter kit for managing digital-product development with AI agents.**

Clone this repo, point your CLI coding agent at it, answer a short interview,
and you walk away with a working hub-and-spoke agent system tailored to _your_
products — no architecture decisions required.

---

![bizagent](bizagent.png)

---

## What it builds

`bizagent` is a **hub**. Around it sit one **agent per product**, and each
agent looks after one or more **project repositories**.

```
            ┌─────────────────────────┐
            │   You (the operator)    │
            └────────────┬────────────┘
                         │ directives / "give me the big picture"
            ┌────────────▼────────────┐
            │   bizagent  (the hub)   │
            │   Products Team Lead    │
            └──┬──────┬──────┬────────┘
               │      │      │
          ┌────▼─┐ ┌──▼───┐ ┌▼─────┐    one agent per product;
          │ Prod │ │ Prod │ │ Prod │    each owns one or more repos
          │  A   │ │  B   │ │  C   │
          └──────┘ └──────┘ └──────┘
```

Each agent keeps a **journal** (plain-English "what changed and why",
git-log-for-humans) and a **sitemap** (a living structure map) for every repo
it owns. Agents talk to each other by dropping markdown messages in each
other's mailboxes. Work happens two ways: **real-time** — the moment you raise
an issue, and (via the event-driven dispatcher) the moment one agent sends
another a message — plus a light **nightly** maintenance pass for housekeeping.

You ask the hub for the big picture; it digests every journal and reports back.

---

## Quick start

One command — macOS, Linux, or WSL on Windows:

```sh
curl -fsSL https://raw.githubusercontent.com/OddbeakerLLC/bizagent/main/install.sh | bash
```

This installs anything missing (`git`, `cron`, and your chosen CLI coding agent),
clones bizagent into a `bizagent/` folder in your current directory, and hands you off
to your CLI. The installer will ask which agent to use — Claude Code, Antigravity,
Codex, or Grok — and install it if needed. When your CLI opens, tell it:

> Read AGENT.md and set up my system.

The agent will interview you — what your products are, where the repos live,
how they relate, when the nightly run should fire — then generate everything
and (with your confirmation) install the nightly schedule.

From then on, working in that directory, your agent _is_ your Digital Products
Lead. Raise an issue and it routes the work; ask for the big picture and it
summarizes across every product.

### Windows

bizagent uses `cron` for the nightly pass, so on Windows you'll need WSL.
In PowerShell, run `wsl --install`, reboot, then run the one-liner above
inside your new WSL shell.

### Manual install

Prefer to do it by hand? You'll need a CLI coding agent (e.g. Claude Code),
plus `git`, `bash`, and `cron`. Then:

```sh
git clone https://github.com/OddbeakerLLC/bizagent
cd bizagent
```

Launch your CLI agent in that directory and tell it the same thing:
"Read AGENT.md and set up my system."

---

## Bring your own engine — including local models

bizagent is **engine-agnostic**: the "CLI agent" it runs is just a command, so any
CLI coding agent works (Claude Code, Antigravity, Codex, Grok, OpenCode, and others).
That command is also what the nightly cron invokes — whatever you choose runs the
whole hub.

You can back that agent with a **local, open-weight model via [Ollama](https://ollama.com)**
and run the entire system on your own hardware — private, offline, no per-token cost:

```sh
# launch a supported coding agent backed by a local model
ollama launch claude --model qwen3-coder-next
```

Ollama's launcher supports several agents this way (Claude Code, Codex, OpenCode,
Hermes, and others). A coding-tuned model with strong tool-calling and a large context
window — e.g. `qwen3-coder-next` (256K context, tool-calling out of the box) — suits
the hub's agent loop well. Point the interview's "CLI agent command" at your
local-model-backed agent and the nightly pass runs fully local too.

---

## Real-time dispatch (event-driven inbox)

By default the hub picks up work the moment *you* raise it. To also have agents
react to each other's messages in near-real-time, enable the **dispatcher** — a
tiny script that runs every 1–2 minutes, routes mail, and launches any agent
that has a new inbox message (and isn't already running) to drain its inbox.

It's an opt-in, one-time manual step (the agent offers it during setup):

```sh
# install a cron line (or use 'systemd' for a user timer); default every 2 min
scripts/install-dispatch.sh cron 2

# bootstrap: the very first tick is a manual kick
bash scripts/bizagent-dispatch.sh
```

**Permission mode is safe-by-default.** A default install grants agents **no**
extra permissions, so cron-driven runs won't act unattended until you pick a
mode. Running unattended needs an explicit opt-in — autonomous agents driven by
cron run **unsandboxed with full permissions**, which is powerful and risky:

```sh
# opt in to autonomous (full-permission) dispatch — read the warning first
scripts/install-dispatch.sh cron 2 --allow-autonomous
```

Without the flag, an interactive install asks (defaulting to **no**). The
autonomous flag is **per-CLI** (written to `.cli` as `CLI_YOLO_FLAG` by the
installer): `--dangerously-skip-permissions` for Claude and Antigravity,
`--full-auto` for Codex. The flag for Grok CLI is not yet confirmed — if you
use Grok, set `CLI_EXTRA_ARGS` in `.cli` manually once you identify the correct
flag from `grok --help`. `CLI_EXTRA_ARGS` holds **pre-prompt** CLI options
(model flags, permission flags, etc.) — they are inserted between the prompt
flag and the prompt text. Prefer hardening over a blanket grant: run the CLI
inside a sandbox (`firejail` / `bwrap` / `docker`), or set `CLI_EXTRA_ARGS` in
`.cli` to a tool allowlist (e.g. `--allowedTools ...`).

It's cheap when idle — an empty tick is just `ls` + lock checks and launches no
agent — so it only costs tokens when there's actual mail. A per-agent lock
guarantees one run at a time, a global cap bounds concurrency, and the
filesystem (inbox vs `inbox/archive/`) is the only ledger, so a crashed run is
simply retried next tick. See `docs/ARCHITECTURE.md → The dispatcher` for the
full model. Tunables live under `settings.dispatch` in `registry.json` (or
`BIZAGENT_*` env vars).

### Near-instant dispatch (optional: file-watch based)

For sub-second latency between message arrival and agent launch, enable the
**event-driven watcher** instead of cron polling. It uses `inotifywait` to
catch inbox file events and immediately dispatch the corresponding agent:

```sh
# install (requires inotify-tools and systemd)
scripts/install-watch.sh

# the watcher runs as a systemd service
sudo systemctl status bizagent-watch
sudo journalctl -u bizagent-watch -f   # view live logs
```

The watcher is **fully compatible with the cron dispatcher** — they share the
same lock mechanism, so a message processed by the watcher is automatically
skipped by the next cron tick. You can run both (cron as a fallback) or just
the watcher.

The watcher also optionally dispatches a **hub agent** for processing hub inbox
messages (e.g., incoming issues or cross-product coordination). Set
`settings.hub_agent` in `registry.json` to enable it:

```json
{
  "settings": {
    "hub_agent": {
      "prompt": "You are the hub PTL agent...",
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

If `hub_agent` is absent or has an empty prompt, the hub inbox is not watched.

To uninstall: `scripts/install-watch.sh --uninstall`

---

## What the interview asks

Only the things that are genuinely yours:

- your organization name
- where your project repositories live (a folder to scan, or a list)
- how repos group into products, and a short slug for each
- which products' agents need to message each other
- nightly run time _(default 23:00)_
- how long an unactioned message waits before being archived _(default 30 days)_
- agent autonomy: maintenance-only, +monitoring, or +light-dev _(default maintenance-only)_
- an optional git remote for the hub

It does **not** ask you to design the system. The hub-and-spoke topology,
file-based messaging, the journal and sitemap formats, and the real-time +
nightly model are decided — that is what this template _is_.

---

## Repository layout

```
bizagent/
├── AGENT.md                 the agent's instructions: interview -> build -> operate
├── README.md                this file
├── registry.example.json    the shape of the generated registry.json
├── scripts/
│   ├── onboard.sh             scaffold .agent/ + sitemap.md into a project repo
│   ├── router.sh              deliver messages between agent mailboxes
│   ├── bizagent-dispatch.sh   one dispatcher tick: route + launch agents w/ mail
│   ├── install-dispatch.sh    wire the dispatcher to cron / systemd (manual step)
│   ├── bizagent-watch.sh      event-driven dispatcher (inotifywait-based, near-instant)
│   ├── install-watch.sh       wire the watcher to systemd (manual step)
│   └── nightly.sh             route + archive the mechanical nightly work
├── install/
│   └── bizagent-watch.service systemd unit template for the watcher
├── tests/                   shell tests for the scripts
├── templates/
│   ├── agent.md.template    per-product agent config
│   ├── NIGHTLY.md           thin file the nightly cron points at
│   └── WEEKLY.md            thin file the weekly cron points at
└── docs/
    └── ARCHITECTURE.md       how and why the system is built this way
```

Cloning gives you the template. Running the interview adds your `registry.json`
and an `agents/` directory — that clone becomes _your_ instance.

---

## Customizing

Everything generated is plain files. `registry.json` is the source of truth —
edit it and re-run the relevant step to add a product or change a setting. The
scripts are short, dependency-light bash; read them, change them, re-run
`tests/run-tests.sh`. `docs/ARCHITECTURE.md` explains the design choices.

---

## License

MIT — see [LICENSE](LICENSE). Built and shared by Oddbeaker LLC.
