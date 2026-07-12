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
an issue, and (via the local control plane) the moment one agent sends
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

### Install from a staging source

The one-liner defaults to the public GitHub repo. For staging, set
`BIZAGENT_SOURCE` to any source `git clone` can read: a local path, a `file://`
URL, or another repo URL. `BIZAGENT_DIR` still controls where the install lands.

```sh
BIZAGENT_SOURCE=/path/to/bizagent-framework \
BIZAGENT_DIR=$HOME/bizagent-stage \
bash /path/to/bizagent-framework/install.sh

BIZAGENT_SOURCE=file:///path/to/bizagent-framework \
BIZAGENT_DIR=$HOME/bizagent-stage \
bash /path/to/bizagent-framework/install.sh

curl -fsSL https://raw.githubusercontent.com/OddbeakerLLC/bizagent/main/install.sh | BIZAGENT_SOURCE=ssh://git@example.com/staging/bizagent.git BIZAGENT_DIR=$HOME/bizagent-stage bash
```

To test on `ai-trainer` before pushing to GitHub, commit the framework changes
locally, copy or mount that repo onto `ai-trainer`, then run:

```sh
BIZAGENT_SOURCE=/path/on/ai-trainer/bizagent-framework \
BIZAGENT_DIR=$HOME/bizagent-stage \
BIZAGENT_NO_LAUNCH=1 \
bash /path/on/ai-trainer/bizagent-framework/install.sh
```

The local source must be a Git repository. `git clone` copies committed local
history, so commit staging changes before running the installer. If you rerun a
staging install with `BIZAGENT_SOURCE` set, use a fresh `BIZAGENT_DIR` or remove
the previous install first; the installer will not silently reuse an existing
clone when a source override is active.

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

## Control plane

BizAgent includes a local Node.js control plane:

- a login-protected web UI that feels like an LLM chat app
- named conversations with file-backed history
- compact hub session memory in markdown
- an agent rail with mail status lights
- inbox polling every 2 seconds
- dispatch fingerprints so the same inbox file does not relaunch an agent on every poll
- outbox routing
- meaningful server activity logs in `logs/control-plane.log`
- a `user/inbox` reply mailbox relayed back into web conversations
- hub launches from the generated `.bizagent/prompts/hub.md` prompt
- parallel agent launches with one live instance per agent

Initialize the local UI login during setup:

```sh
node scripts/bizagent-control-plane.js auth-init --username <user> --password <password>
```

Then run it directly:

```sh
node scripts/bizagent-control-plane.js serve
```

Or use the local start/stop wrapper:

```sh
scripts/control-plane.sh start
scripts/control-plane.sh status
scripts/control-plane.sh stop
```

Or install the systemd user service:

```sh
scripts/install-control-plane.sh
systemctl --user daemon-reload
# use the instance-specific service name printed by the installer
systemctl --user enable --now bizagent-control-plane-<instance>.service
```

The server uses the existing file layout as its source of truth. Mail stays in
`inbox/`, `outbox/`, `user/inbox/`, and `agents/<slug>/...`; conversations and
sessions live under `.bizagent/`; the hub runtime prompt is generated at
`.bizagent/prompts/hub.md`; current hub memory is kept compact in
`.bizagent/hub-session.md`; older UI history is summarized instead of kept as
an unbounded transcript; agent launches read `agents/<slug>/.dispatch.md`. The legacy
`router.sh`, `bizagent-dispatch.sh`, and `bizagent-watch.sh` names remain only
as compatibility wrappers around the Node control plane.

Hub messages sent from the web UI include a `conversation_id`; the hub sends
visible replies as markdown files in `outbox/` addressed to `user` with that
same `conversation_id`. The router delivers them to `user/inbox/`, and the
server relays them into the matching web conversation. Only the hub root outbox
may address `user`; product agents still reply through the hub. For manual
repair, use `node scripts/bizagent-control-plane.js append-hub-turn --conversation <id> --content-file <file>`.

Multiple BizAgent hubs can run on one machine. Set
`settings.control_plane.port` in each hub's `registry.json`, or install with
`scripts/install-control-plane.sh --port <port> --name <instance>`. The service
installer writes an instance-specific user service and carries `BIZAGENT_PORT`
and `BIZAGENT_HOST` into the generated unit.

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
│   ├── bizagent-control-plane.js Node control-plane CLI
│   ├── install-control-plane.sh  wire the control plane to systemd
│   ├── router.sh                 compatibility wrapper: route once
│   ├── bizagent-dispatch.sh      compatibility wrapper: dispatch once
│   ├── bizagent-watch.sh         compatibility wrapper: run server
│   └── nightly.sh             route + archive the mechanical nightly work
├── install/
│   └── bizagent-control-plane.service systemd unit template
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
