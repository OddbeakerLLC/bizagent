#!/usr/bin/env bash
# apply-template.sh — apply an industry template to a bizagent hub.
#
# Declarative front-end to the first-run §2 generate: validates the template,
# runs the variable interview (or takes --answers for unattended installs),
# substitutes {{variables}}, then writes registry.json products, the agent dir
# (agent.md with the industry system prompt prepended), MCP config, and seeded
# knowledge-stack docs. No control-plane core changes; routines ride the
# existing defer/nightly scheduling.
#
# Usage:
#   scripts/apply-template.sh --template <slug> [--answers <file.json>]
#                             [--hub <path>] [--force] [--list]
#
#   --template <slug>   Industry template (templates/industries/<slug>.json)
#   --answers <file>    JSON object {variable_key: value} — unattended installs
#   --hub <path>        Hub directory (default: BIZAGENT_HUB, else the repo this
#                       script lives in)
#   --force             Overwrite an existing agents/<slug>/agent.md
#   --list              List available templates and exit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB=""
SLUG=""
ANSWERS=""
FORCE=0
LIST=0

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --template)  SLUG="${2:-}"; shift 2 ;;
    --template=*) SLUG="${1#*=}"; shift ;;
    --answers)   ANSWERS="${2:-}"; shift 2 ;;
    --answers=*) ANSWERS="${1#*=}"; shift ;;
    --hub)       HUB="${2:-}"; shift 2 ;;
    --hub=*)     HUB="${1#*=}"; shift ;;
    --force)     FORCE=1; shift ;;
    --list)      LIST=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "✗ unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

HUB="${HUB:-${BIZAGENT_HUB:-$(cd "$SCRIPT_DIR/.." && pwd)}}"

if [[ "$LIST" -eq 1 ]]; then
  for f in "$HUB"/templates/industries/*.json; do
    [[ -f "$f" ]] || { echo "no templates in $HUB/templates/industries/"; exit 1; }
    basename "$f" .json
  done
  exit 0
fi

if [[ -z "$SLUG" ]]; then
  echo "✗ --template <slug> is required (available: $(bash "$0" --hub "$HUB" --list | tr '\n' ' '))" >&2
  exit 2
fi

if [[ -n "$ANSWERS" && ! -f "$ANSWERS" ]]; then
  echo "✗ answers file not found: $ANSWERS" >&2
  exit 2
fi

exec python3 - "$HUB" "$SLUG" "$ANSWERS" "$FORCE" <<'PY'
import datetime
import glob as globmod
import json
import os
import re
import shutil
import sys

hub, slug, answers_path, force = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
tdir = os.path.join(hub, "templates", "industries")
tpath = os.path.join(tdir, slug + ".json")


def die(msg):
    print("  ✗ apply-template: " + msg, file=sys.stderr)
    sys.exit(1)


def ok(msg):
    print("  ✓ " + msg)


def note(msg):
    print("    " + msg)


# --- load template (fail loud on bad JSON) ---
if not os.path.isfile(tpath):
    die("template not found: %s" % tpath)
try:
    t = json.load(open(tpath, encoding="utf-8"))
except json.JSONDecodeError as e:
    die("invalid JSON in %s: %s" % (tpath, e))
if not isinstance(t, dict):
    die("template root must be a JSON object: %s" % tpath)

# --- schema v1 validation (fail loud on unknown fields) ---
ALLOWED_TOP = {"template_version", "industry", "display_name", "variables",
               "products", "mcp", "behaviors", "guardrails", "knowledge_stack"}
ALLOWED_VAR = {"key", "question", "required", "default"}
ALLOWED_PRODUCT = {"slug", "name", "agent_name", "model", "provider",
                   "system_prompt_file", "autonomy", "projects"}
ALLOWED_SERVER = {"name", "transport", "command", "args", "url", "headers",
                  "env", "required"}
ALLOWED_BEHAVIOR = {"agent", "routine", "trigger", "detail"}
ALLOWED_GUARD = {"outbound_approval_required", "local_only_data",
                 "never_contact_client_without_owner"}
ALLOWED_KS = {"seed_docs", "playbooks"}
TRIGGERS = {"daily", "weekly", "monthly", "schedule", "nightly"}
AUTONOMY = {"maintenance-only", "+monitoring", "+light-dev"}
TRANSPORTS = {"stdio", "http", "sse", "streamable-http"}


def check_unknown(where, obj, allowed):
    if not isinstance(obj, dict):
        die("%s must be an object" % where)
    extra = sorted(set(obj) - allowed)
    if extra:
        die("%s: unknown field(s) %s (allowed: %s)" % (where, extra, sorted(allowed)))


def check_str(where, obj, field, required=True):
    val = obj.get(field)
    if val is None and not required:
        return ""
    if not isinstance(val, str) or not val.strip():
        die("%s: %s must be a non-empty string" % (where, field))
    return val


check_unknown("template", t, ALLOWED_TOP)
if t.get("template_version") != 1:
    die("template_version must be 1 (got %r)" % t.get("template_version"))
if check_str("template", t, "industry") != slug:
    die("template industry %r does not match slug %r" % (t.get("industry"), slug))
check_str("template", t, "display_name")

variables = t.get("variables")
if not isinstance(variables, list) or not variables:
    die("variables must be a non-empty list")
declared = {}
for v in variables:
    check_unknown("variables[]", v, ALLOWED_VAR)
    key = check_str("variables[]", v, "key")
    if not re.fullmatch(r"[a-z][a-z0-9_]*", key):
        die("variables[]: key %r must match [a-z][a-z0-9_]*" % key)
    if key in declared:
        die("variables[]: duplicate key %r" % key)
    check_str("variables[]", v, "question")
    v.setdefault("required", True)
    if not isinstance(v["required"], bool):
        die("variables[]: required must be a boolean")
    declared[key] = v

products = t.get("products")
if not isinstance(products, list) or not products:
    die("products must be a non-empty list")
product_slugs = set()
for p in products:
    check_unknown("products[]", p, ALLOWED_PRODUCT)
    pslug = check_str("products[]", p, "slug")
    if not re.fullmatch(r"[a-z][a-z0-9-]*", pslug):
        die("products[]: slug %r must match [a-z][a-z0-9-]*" % pslug)
    if pslug in product_slugs:
        die("products[]: duplicate slug %r" % pslug)
    product_slugs.add(pslug)
    check_str("products[]", p, "name")
    check_str("products[]", p, "agent_name")
    prompt_file = check_str("products[]", p, "system_prompt_file")
    p["system_prompt_file"] = prompt_file
    # Template file paths are relative to templates/ (e.g.
    # "industries/<slug>/assistant-coach.md"), per the design doc.
    abs_prompt = os.path.join(hub, "templates", prompt_file)
    if not os.path.isfile(abs_prompt):
        die("products[]: system_prompt_file not found: %s" % abs_prompt)
    p.setdefault("autonomy", "maintenance-only")
    if p["autonomy"] not in AUTONOMY:
        die("products[]: autonomy %r not in %s" % (p["autonomy"], sorted(AUTONOMY)))
    p.setdefault("model", "")
    p.setdefault("provider", "")

mcp = t.get("mcp") or {}
check_unknown("mcp", mcp, {"servers"})
servers = mcp.get("servers") or []
if not isinstance(servers, list):
    die("mcp.servers must be a list")
for s in servers:
    check_unknown("mcp.servers[]", s, ALLOWED_SERVER)
    check_str("mcp.servers[]", s, "name")
    transport = check_str("mcp.servers[]", s, "transport")
    if transport not in TRANSPORTS:
        die("mcp.servers[]: transport %r not in %s" % (transport, sorted(TRANSPORTS)))
    if transport == "stdio":
        check_str("mcp.servers[]", s, "command")
    else:
        check_str("mcp.servers[]", s, "url")
    s.setdefault("required", True)
    if not isinstance(s["required"], bool):
        die("mcp.servers[]: required must be a boolean")

behaviors = t.get("behaviors") or []
if not isinstance(behaviors, list):
    die("behaviors must be a list")
for b in behaviors:
    check_unknown("behaviors[]", b, ALLOWED_BEHAVIOR)
    if check_str("behaviors[]", b, "agent") not in product_slugs:
        die("behaviors[]: agent %r is not a template product slug" % b.get("agent"))
    check_str("behaviors[]", b, "routine")
    trig = check_str("behaviors[]", b, "trigger")
    if trig not in TRIGGERS:
        die("behaviors[]: trigger %r not in %s" % (trig, sorted(TRIGGERS)))
    check_str("behaviors[]", b, "detail")

guardrails = t.get("guardrails") or {}
check_unknown("guardrails", guardrails, ALLOWED_GUARD)
for g in ALLOWED_GUARD:
    val = guardrails.get(g)
    if not isinstance(val, bool):
        die("guardrails: %s must be a boolean" % g)
if not guardrails.get("local_only_data"):
    die("guardrails: local_only_data must be true in v1 templates — the "
        "local-only-data guardrail is written explicitly into every generated agent.md")

ks = t.get("knowledge_stack") or {}
check_unknown("knowledge_stack", ks, ALLOWED_KS)
seed_docs = ks.get("seed_docs") or []
if not isinstance(seed_docs, list):
    die("knowledge_stack.seed_docs must be a list")
seed_files = []
for pattern in seed_docs:
    if not isinstance(pattern, str) or not pattern.strip():
        die("knowledge_stack.seed_docs: patterns must be non-empty strings")
    matches = sorted(globmod.glob(os.path.join(hub, "templates", pattern)))
    if not matches:
        die("knowledge_stack.seed_docs: pattern matched no files: %s" % pattern)
    seed_files.extend(matches)

# --- variable placeholders: every {{var}} used must be declared ---
PH = re.compile(r"\{\{\s*([a-z][a-z0-9_]*)\s*\}\}")
used = set()


def collect(obj):
    if isinstance(obj, str):
        used.update(PH.findall(obj))
    elif isinstance(obj, list):
        for x in obj:
            collect(x)
    elif isinstance(obj, dict):
        for x in obj.values():
            collect(x)


collect(t)
prompt_texts = {}
for p in products:
    text = open(os.path.join(hub, "templates", p["system_prompt_file"]), encoding="utf-8").read()
    prompt_texts[p["slug"]] = text
    used.update(PH.findall(text))
undeclared = sorted(used - set(declared))
if undeclared:
    die("template uses undeclared variable(s): %s" % undeclared)

# --- answers: file, or interview on /dev/tty ---
if answers_path:
    try:
        answers = json.load(open(answers_path, encoding="utf-8"))
    except json.JSONDecodeError as e:
        die("invalid JSON in answers file %s: %s" % (answers_path, e))
    if not isinstance(answers, dict):
        die("answers file must be a JSON object of {key: value}")
    answers = {str(k): "" if v is None else str(v) for k, v in answers.items()}
else:
    try:
        tty = open("/dev/tty", "r+")
    except OSError:
        die("no --answers file and no TTY for the variable interview — "
            "pass --answers <file.json> for unattended installs")
    answers = {}
    for v in variables:
        suffix = "" if v["required"] else " [optional, enter to skip]"
        while True:
            tty.write("  %s%s: " % (v["question"], suffix))
            tty.flush()
            line = tty.readline()
            if not line:
                die("interview aborted (EOF on /dev/tty)")
            val = line.strip()
            if val or not v["required"]:
                answers[v["key"]] = val
                break
            tty.write("    required — please answer.\n")
    tty.close()

missing = [v["key"] for v in variables if v["required"] and not answers.get(v["key"], "").strip()]
if missing:
    die("missing required answer(s): %s%s" %
        (missing, " (answers file: %s)" % answers_path if answers_path else ""))


def sub(text):
    return PH.sub(lambda m: answers.get(m.group(1), ""), text)


extra = sorted(set(answers) - set(declared))
if extra:
    note("ignoring answer key(s) not declared in the template: %s" % extra)

# --- registry merge ---
reg_path = os.path.join(hub, "registry.json")
if not os.path.isfile(reg_path):
    die("registry.json not found in %s — run install.sh first (or seed it from "
        "registry.example.json)" % hub)
try:
    reg = json.load(open(reg_path, encoding="utf-8"))
except json.JSONDecodeError as e:
    die("invalid JSON in %s: %s" % (reg_path, e))
if not isinstance(reg, dict):
    die("registry root must be a JSON object: %s" % reg_path)

settings = reg.setdefault("settings", {})
models = settings.setdefault("models", {})
agent_default = str(models.get("agent_default") or "").strip()
hub_agent = settings.get("hub_agent") or {}
hub_provider = str(hub_agent.get("provider") or hub_agent.get("cliName") or "").strip()

reg_products = reg.setdefault("products", [])
if not isinstance(reg_products, list):
    die("registry products must be a list")
existing = {p.get("slug"): i for i, p in enumerate(reg_products) if isinstance(p, dict)}

for p in products:
    model = sub(p.get("model") or "").strip() or agent_default
    provider = sub(p.get("provider") or "").strip() or hub_provider
    if not model:
        die("no model for product %r — template model is empty and registry "
            "settings.models.agent_default is unset (product launches fail without "
            "an explicit model)" % p["slug"])
    if not provider:
        die("no provider for product %r — template provider is empty and registry "
            "settings.hub_agent.provider is unset" % p["slug"])
    entry = {
        "slug": p["slug"],
        "name": p["name"],
        "agent_name": p["agent_name"],
        "model": model,
        "provider": provider,
        "cliName": provider,
        "projects": [{"name": "client-data", "path": "data/%s" % p["slug"], "remote": ""}],
    }
    if p["slug"] in existing:
        reg_products[existing[p["slug"]]] = entry
        ok("registry product updated: %s" % p["slug"])
    else:
        reg_products.append(entry)
        existing[p["slug"]] = len(reg_products) - 1
        ok("registry product added: %s (%s)" % (p["slug"], p["agent_name"]))

# --- MCP config merge (by server name) ---
tpl_servers = []
for s in servers:
    entry = {"name": sub(s["name"]), "transport": s["transport"], "required": s["required"]}
    if s.get("command"):
        entry["command"] = sub(s["command"])
    if s.get("args"):
        entry["args"] = [sub(a) for a in s["args"]]
    if s.get("url"):
        entry["url"] = sub(s["url"])
    if s.get("headers"):
        entry["headers"] = {k: sub(v) for k, v in s["headers"].items()}
    if s.get("env"):
        entry["env"] = {k: sub(v) for k, v in s["env"].items()}
    tpl_servers.append(entry)

if tpl_servers:
    mcp_cfg = settings.get("mcp")
    if not isinstance(mcp_cfg, dict):
        mcp_cfg = {}
    current = mcp_cfg.get("servers")
    current = current if isinstance(current, list) else []
    by_name = {s.get("name"): i for i, s in enumerate(current) if isinstance(s, dict)}
    for s in tpl_servers:
        if s["name"] in by_name:
            current[by_name[s["name"]]] = s
        else:
            current.append(s)
            by_name[s["name"]] = len(current) - 1
    mcp_cfg["enabled"] = True
    mcp_cfg["servers"] = current
    settings["mcp"] = mcp_cfg
    ok("mcp config written (%d server(s), enabled)" % len(current))

# --- industry metadata + behaviors (ride defer/nightly; no CP core changes) ---
settings["industry_template"] = {
    "slug": slug,
    "industry": t["industry"],
    "display_name": t["display_name"],
    "applied_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "guardrails": guardrails,
    "behaviors": [
        {"agent": b["agent"], "routine": b["routine"], "trigger": b["trigger"],
         "detail": sub(b["detail"])}
        for b in behaviors
    ],
}

# --- agent dirs: agent.md (industry prompt prepended) + .dispatch.md + mailboxes ---
agent_tpl_path = os.path.join(hub, "templates", "agent.md.template")
dispatch_tpl_path = os.path.join(hub, "templates", "dispatch.md.template")
for path, what in ((agent_tpl_path, "agent.md.template"), (dispatch_tpl_path, "dispatch.md.template")):
    if not os.path.isfile(path):
        die("missing %s — run from a bizagent repo checkout" % what)

routines_md = ""
if behaviors:
    lines = ["", "## Routines (industry template)", "",
             "Ride the existing scheduling machinery (defer/wake + nightly); "
             "no new control-plane concepts.", ""]
    for b in behaviors:
        lines.append("- **%s — %s:** %s" % (b["trigger"], b["routine"], sub(b["detail"])))
    routines_md = "\n".join(lines) + "\n"

agent_tpl = open(agent_tpl_path, encoding="utf-8").read()
dispatch_tpl = open(dispatch_tpl_path, encoding="utf-8").read()

for p in products:
    pslug = p["slug"]
    adir = os.path.join(hub, "agents", pslug)
    for d in (adir, os.path.join(adir, "inbox", "archive"), os.path.join(adir, "outbox")):
        os.makedirs(d, exist_ok=True)

    agent_md_path = os.path.join(adir, "agent.md")
    industry_md = sub(prompt_texts[pslug]).rstrip() + routines_md
    filled = (agent_tpl
              .replace("{{PRODUCT_NAME}}", p["name"])
              .replace("{{PRODUCT_SLUG}}", pslug)
              .replace("{{AGENT_NAME}}", p["agent_name"])
              .replace("{{AUTONOMY_LEVEL}}", p["autonomy"])
              .replace("{{CROSS_PRODUCT_EDGES}}", "None")
              .replace("{{PROJECT_LIST}}",
                       "- `client-data` — data/%s (customer business records; "
                       "local-only, never pushed to any remote)" % pslug))
    if os.path.isfile(agent_md_path) and not force:
        note("agents/%s/agent.md already exists — leaving it (use --force to overwrite)" % pslug)
    else:
        with open(agent_md_path, "w", encoding="utf-8") as f:
            f.write(industry_md + "\n\n---\n\n" + filled)
        ok("agents/%s/agent.md written (industry prompt prepended)" % pslug)

    dispatch_md_path = os.path.join(adir, ".dispatch.md")
    dispatch = (dispatch_tpl
                .replace("{{slug}}", pslug)
                .replace("{{agent_md}}", "agents/%s/agent.md" % pslug)
                .replace("{{inbox}}", "agents/%s/inbox" % pslug)
                .replace("{{outbox}}", "agents/%s/outbox" % pslug))
    with open(dispatch_md_path, "w", encoding="utf-8") as f:
        f.write(dispatch)
    ok("agents/%s/.dispatch.md written" % pslug)

    data_dir = os.path.join(hub, "data", pslug)
    os.makedirs(data_dir, exist_ok=True)
    readme = os.path.join(data_dir, "README.md")
    if not os.path.isfile(readme):
        with open(readme, "w", encoding="utf-8") as f:
            f.write("# %s — client data (local-only)\n\n"
                    "Customer business records for the %s agent. Never upload, "
                    "sync, or commit this data to any remote.\n"
                    % (t["display_name"], pslug))

# --- hub mailboxes/dirs (§2 step 2 subset; idempotent) ---
for d in ("inbox", os.path.join("inbox", "archive"), "outbox", "journal", "logs"):
    os.makedirs(os.path.join(hub, d), exist_ok=True)

# --- seed knowledge-stack docs ---
ks_root = os.path.join(hub, "knowledge-stack", "industries", slug)
copied = 0
for src in seed_files:
    dest = os.path.join(ks_root, os.path.basename(src))
    if os.path.isfile(dest):
        note("knowledge-stack doc already present: %s" % os.path.relpath(dest, hub))
        continue
    os.makedirs(ks_root, exist_ok=True)
    shutil.copyfile(src, dest)
    copied += 1
if copied:
    ok("knowledge-stack seeded: %d doc(s) → knowledge-stack/industries/%s/" % (copied, slug))
else:
    note("knowledge-stack docs already seeded")

# --- write registry ---
with open(reg_path, "w", encoding="utf-8") as f:
    json.dump(reg, f, indent=2)
    f.write("\n")
ok("registry.json written (industry_template=%s, guardrails enforced in agent.md)" % slug)
ok("done — template %r applied to %s" % (slug, hub))
PY
