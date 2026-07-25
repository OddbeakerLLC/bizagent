# BizAgent

**A local hub-and-spoke system for running AI agents across your digital products.**

Clone this repo, run the installer, and your CLI coding agent builds a complete hub — one agent per product, plain-file messaging, a dark-themed web UI, and a local control plane that dispatches work in real time. No architecture decisions required.

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

Each agent keeps a **journal** and a **sitemap** for every repo it owns. Agents
talk by dropping markdown messages in each other's mailboxes. Work happens in
real time — the moment the operator raises an issue, or the moment one agent
sends another a message — plus a light nightly maintenance pass for housekeeping
(journals, sitemaps, archive pruning).

You ask the hub for the big picture; it digests every journal and reports back.

---

## ⚠ Security — read before you install

> [!WARNING]
> **BizAgent runs your AI agent in "YOLO mode" — no permission prompts.**
>
> Agents execute with the CLI's autonomous flag enabled by default:
> `--dangerously-skip-permissions` for Claude Code and Antigravity,
> `--full-auto` for Codex. This means the agent can read, write, delete,
> and execute **anything the OS user account has access to** — including your
> home directory, SSH keys, `.env` files, and more.
>
> **Strongly recommended: create a dedicated OS user for BizAgent** — see
> **Step 1 (optional)** in the Quick Start below. Running as a dedicated user
> is the single most effective way to contain the risk of an agent making an
> unintended change to your system.

---

## Quick start

Three steps — one command does the work.

**Step 1 (optional).** Create a dedicated OS user (strongly recommended):

```sh
# Pre-install system dependencies (requires sudo/root)
sudo apt-get install -y git nodejs cron   # Debian/Ubuntu
# sudo dnf install -y git nodejs cron     # Fedora/RHEL
# brew install git node                   # macOS

# Create the user and run the installer as that user
sudo adduser bizagent
sudo -u bizagent bash -c 'curl -fsSL https://raw.githubusercontent.com/OddbeakerLLC/bizagent/main/install.sh | bash'
```

The installer uses `sudo` to install missing packages, so pre-installing
them (or granting `bizagent` passwordless `sudo` for your package manager)
is required.

> **Headless server (VPS, SSH-only)?** Set `ANTHROPIC_API_KEY` as an env var
> or run `claude login --api-key <key>` before the installer — otherwise
> it will hang waiting for a browser. Other CLI engines have equivalent env
> vars (`OPENAI_API_KEY` for Codex, etc.).

**Step 2.** Run the installer (macOS, Linux, or WSL on Windows):

```sh
curl -fsSL https://raw.githubusercontent.com/OddbeakerLLC/bizagent/main/install.sh | bash
```

This installs `git`, `python3`, Node.js, and `cron` if missing; asks which CLI
coding agent to use; clones bizagent; starts the control plane; and prints
your URL. The whole process takes about two minutes.

**Step 3.** Open the URL shown in your terminal (or `http://localhost:8787`
if it doesn't appear). PTL has already read AGENT.md and begun the setup
process — respond to it in the chat.

### Install from a staging source

The one-liner defaults to the public GitHub repo. For staging, set
`BIZAGENT_SOURCE` to any source `git clone` can read: a local path, a `file://`
URL, or another repo URL. `BIZAGENT_DIR` controls where the install lands.

```sh
BIZAGENT_SOURCE=/path/to/bizagent-framework \
BIZAGENT_DIR=$HOME/bizagent-stage \
bash /path/to/bizagent-framework/install.sh
```

The local source must be a Git repository with committed changes; `git clone`
copies committed history only. If you rerun with `BIZAGENT_SOURCE` set, use a
fresh `BIZAGENT_DIR` — the installer refuses to reuse an existing clone when a
source override is active.

### Windows

bizagent uses `cron` for the nightly pass, so on Windows you'll need WSL.
In PowerShell, run `wsl --install`, reboot, then run the one-liner above
inside your new WSL shell.

### Manual install

```sh
git clone https://github.com/OddbeakerLLC/bizagent
cd bizagent
```

Then run `bash install.sh` to complete setup — equivalent to the one-liner above.

---

## The web UI

After installation, open `http://localhost:8787` (or the port in
your `registry.json`).

- **Login-protected** — on first visit the browser shows a setup form to create credentials; afterwards, standard login
- **Dark-themed chat** — named conversations; create new ones with a button or pick from the dropdown
- **Agent rail** — left sidebar showing each product agent with a status dot: green when active, gray when idle
- **Agent detail panel** — click any agent row to expand an inline panel showing inbox message count, last-dispatched relative time, and a snippet from the most recent journal entry
- **Dynamic page title** — browser tab reads `BizAgent — {org name}` from `registry.json`
- **Inbox polling** — checks every 2 seconds; skips re-renders when nothing changed
- **Hub session memory** — compact rolling markdown; older turns are summarized, not accumulated

---

## Bring your own engine — including local models

bizagent is **engine-agnostic**: the "CLI agent" it runs is just a command, so any
CLI coding agent works (Claude Code, Antigravity, Codex, Grok, OpenCode, and others).
That command is what both the real-time control plane and the nightly cron invoke —
whatever you choose runs the whole hub.

You can back that agent with a **local, open-weight model via [Ollama](https://ollama.com)**
and run the entire system on your own hardware — private, offline, no per-token cost:

```sh
ollama launch claude --model qwen3-coder-next
```

A coding-tuned model with strong tool-calling and a large context window —
e.g. `qwen3-coder-next` (256K context, tool-calling out of the box) — suits
the hub's agent loop well. Point the setup's "CLI agent command" at your
local-model-backed agent and the nightly pass runs fully local too.

---

## Control plane

`scripts/bizagent-control-plane.js serve` runs a local Node.js server. It:

- hosts the web UI with login-protected access
- polls inboxes every few seconds and routes queued outbox mail in near real time
- launches the hub when new mail arrives; launches product agents for their own mail
- enforces one live instance per agent (per-agent lock file prevents double-dispatch)
- caps simultaneous agent runs (default 8) to bound burst behavior; separate pools for hub turns vs. agent fan-out
- relays `user/inbox/*.md` replies into the matching web conversation
- uses dispatch fingerprinting so the same inbox file doesn't re-trigger on every tick
- writes structured events to `logs/structured.log` (and legacy logs for compatibility)

The server uses the existing file layout as its source of truth — no database.
Mailboxes at `inbox/`, `outbox/`, `agents/<slug>/...`; the always-on hub runtime prompt at
`.bizagent/prompts/hub.md`; compact hub session memory at `.bizagent/hub-session.md`;
login config at `.bizagent/auth.json`.

### Warm hub path (preferred) and cold fallback

A long-lived **hub daemon** (`scripts/hub-daemon.js` + `hub-daemon.sh`) stays running with your keys loaded from `.bizagent/env`. The control plane prefers sending turns over the Unix socket (`.bizagent/hub.sock`) for lower latency. If the daemon is down, the control plane falls back to a fresh CLI spawn (cold path). Both paths produce the same observable behavior.

### Console replies and the write-message path

For console-initiated hub turns the control plane creates a reserved reply body file (`.bizagent/pending-replies/<conversation_id>.body.md`). The hub process must write **only the body** there; the control plane then wraps front-matter and routes it. All operator/user mail must go through `scripts/write-message.sh` (or the equivalent `node scripts/bizagent-control-plane.js write-message`). Stdout is debug-only. On exit with no visible reply the safety net promotes the last assistant blob from the dispatch log or surfaces a clear hard error in the UI.

### Secrets and environment

Keys and secrets live in `.bizagent/env` (never committed). The control-plane systemd unit and CLI wrappers source it so child processes inherit `XAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. See `.bizagent/env.example`.

### Operator commands

```sh
scripts/control-plane.sh start
scripts/control-plane.sh status
scripts/control-plane.sh restart
scripts/control-plane.sh stop

scripts/hub-daemon.sh start
scripts/hub-daemon.sh status
scripts/hub-daemon.sh ping
scripts/hub-daemon.sh stop

# Safe preview then apply archive pruning (default 15 days)
scripts/prune-archives.sh --dry-run
scripts/prune-archives.sh
```

Multiple BizAgent hubs can run on one machine. Set
`settings.control_plane.port` in each hub's `registry.json`, or pass
`--port` and `--name` to `scripts/install-control-plane.sh`.

### Tuning (registry.json)

```json
"settings": {
  "dispatch": {
    "poll_seconds": 2,
    "max_concurrency": 8,
    "hub_slots": 1,
    "agent_slots": 8,
    "lock_lease_secs": 1800
  },
  "tuning": {
    "archive": { "retention_days": 15, "prune_on_nightly": true }
  }
}
```

`poll_seconds` (1–30) controls how often the control plane wakes. Separate hub/agent slot pools keep operator turns responsive even under heavy fan-out. Archive pruning removes old `*/archive/` mail automatically on the nightly (or on demand).

---

## What PTL asks during setup

Once the control plane starts, PTL automatically detects the new-install signal
and begins setup in the web UI. It only asks for the things that are genuinely yours:

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
├── install.sh               one-liner installer
├── install/
│   ├── install.sh             control-plane installer (npm, service, start, browser open)
│   └── bizagent-control-plane.service  systemd unit template
├── scripts/
│   ├── bizagent-control-plane.js  Node control-plane CLI + write-message
│   ├── control-plane.sh       start/stop/status/restart wrapper
│   ├── hub-daemon.js          warm hub turn worker (socket protocol)
│   ├── hub-daemon.sh          daemon start/stop/status/ping
│   ├── install-control-plane.sh  wire the control plane + daemon to systemd
│   ├── prune-archives.sh      archive retention (15-day default, registry-driven)
│   ├── write-message.sh       canonical outbox helper (conversation stamping)
│   ├── nightly.sh             route + prune + journal/sitemap housekeeping
│   └── ...                    (router, run-agent, onboard, publish-check, etc.)
├── control-plane/
│   ├── server.js
│   └── lib/                 (dispatcher, mail, hub-memory, hub-turn-safety,
│                            conversations, config, cli-config, profile, ...)
├── templates/               agent.md, dispatch, NIGHTLY, WEEKLY
├── tests/                   shell test suite
└── docs/
    ├── ARCHITECTURE.md
    └── LATENCY-OPTIMIZATION-PLAN.md
```

Cloning gives you the template. Running the PTL interview adds your `registry.json`
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
