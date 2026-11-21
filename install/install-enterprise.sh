#!/usr/bin/env bash
# install-enterprise.sh — first-class installer for running BizAgent as an
# Enterprise server (hosted / always-on deployment).
#
# Covers: dependency install, control-plane service setup (systemd system
# service by default), TLS config, auth init, and a sane default settings
# profile for enterprise operation. Keeps the standard hub layout, so
# scripts/upgrade.sh and scripts/factory-reset.sh keep working unchanged.
#
# Usage:
#   sudo bash install/install-enterprise.sh [options]
#
# Options:
#   --hub PATH          hub root (default: repo root containing this installer)
#   --host HOST         control-plane bind host   (default 0.0.0.0)
#   --port PORT         control-plane port        (default 8787)
#   --tls               enable TLS; the server auto-generates a self-signed
#                       cert into <hub>/.bizagent/tls/ on first start
#   --tls-cert FILE     use an existing cert (writes BIZAGENT_TLS_CERT)
#   --tls-key FILE      use an existing key  (writes BIZAGENT_TLS_KEY)
#   --admin-user NAME   console operator login (default: current user)
#   --service system|user|none
#                       system  = systemd system service (default; needs root)
#                       user    = systemd user service (scripts/install-control-plane.sh)
#                       none    = do not install a service (start manually)
#   --service-user NAME user the system service runs as (default: current user)
#   --skip-npm          skip npm install (deps already present)
#   --yes               non-interactive; fail instead of prompting
#
# Auth: set BIZAGENT_ADMIN_USER + BIZAGENT_ADMIN_PASSWORD in the environment
# for fully non-interactive auth init (values never need to appear on the
# command line). Otherwise the installer prompts for a hidden password.
set -euo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[32m'; BLUE=$'\033[34m'; NC=$'\033[0m'
step() { printf "\n${BOLD}${BLUE}==>${NC} ${BOLD}%s${NC}\n" "$1"; }
ok()   { printf "  ${GREEN}✓${NC} %s\n" "$1"; }
note() { printf "    %s\n" "$1"; }
warn() { printf "  ! %s\n" "$1"; }
die()  { printf "\n✗ %s\n\n" "$1" >&2; exit 1; }

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB="$(cd "$SELF_DIR/.." && pwd)"
HOST="0.0.0.0"
PORT="8787"
TLS_SELF_SIGNED=0
TLS_CERT=""
TLS_KEY=""
ADMIN_USER="${BIZAGENT_ADMIN_USER:-}"
SERVICE="system"
SERVICE_USER=""
SKIP_NPM=0
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --tls) TLS_SELF_SIGNED=1; shift ;;
    --tls-cert) TLS_CERT="${2:-}"; shift 2 ;;
    --tls-key) TLS_KEY="${2:-}"; shift 2 ;;
    --admin-user) ADMIN_USER="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --service-user) SERVICE_USER="${2:-}"; shift 2 ;;
    --skip-npm) SKIP_NPM=1; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,36p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "install-enterprise: unknown argument: $1" >&2; exit 2 ;;
  esac
done

HUB="$(cd "$HUB" && pwd)"
[ -f "$HUB/control-plane/server.js" ] || die "control-plane/server.js not found under $HUB — pass --hub PATH"
case "$SERVICE" in system|user|none) ;; *) die "--service must be system|user|none" ;;
esac
case "$PORT" in ''|*[!0-9]*) die "invalid port: $PORT" ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "port out of range: $PORT"
case "$HOST" in
  ''|*[!A-Za-z0-9_.:-]*) die "invalid host: $HOST" ;;
esac
if { [ -n "$TLS_CERT" ] && [ -z "$TLS_KEY" ]; } || { [ -z "$TLS_CERT" ] && [ -n "$TLS_KEY" ]; }; then
  die "--tls-cert and --tls-key must be given together"
fi

# --- 1. Dependencies -------------------------------------------------------
step "Dependencies"
node_major() { local v; v="$(node -v 2>/dev/null || true)"; v="${v#v}"; echo "${v%%.*}"; }
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major; major="$(node_major)"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 ))
}
if ! node_ok; then
  note "installing the latest Node.js LTS (need v22+)…"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - \
      && sudo apt-get install -y nodejs \
      || sudo apt-get install -y nodejs npm || true
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash - \
      && sudo dnf install -y nodejs || sudo dnf install -y nodejs npm || true
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm nodejs npm || true
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper install -y nodejs npm || true
  elif command -v brew >/dev/null 2>&1; then
    brew install node || true
  fi
  hash -r 2>/dev/null || true
fi
node_ok || die "Node.js v22+ is required (install the latest LTS and re-run)"
ok "node $(node -v)"
command -v python3 >/dev/null 2>&1 || die "python3 is required (registry seeding / settings edits)"
command -v git >/dev/null 2>&1 || die "git is required"

if [ "$SKIP_NPM" -ne 1 ]; then
  (cd "$HUB" && npm install --silent) || die "hub npm install failed — run it manually and re-run"
  [ -f "$HUB/agent-runtime/package.json" ] && \
    (cd "$HUB/agent-runtime" && npm install --silent) || true
  ok "npm dependencies installed"
else
  ok "npm install skipped (--skip-npm)"
fi

# --- 2. Registry seed + enterprise settings profile ------------------------
step "Enterprise settings profile"
if [ ! -f "$HUB/cli.json" ] && [ -f "$HUB/cli.json.example" ]; then
  cp "$HUB/cli.json.example" "$HUB/cli.json"
  ok "cli.json seeded from example"
fi
if [ ! -f "$HUB/registry.json" ] && [ -f "$HUB/registry.example.json" ]; then
  PROVIDER="${BIZAGENT_PROVIDER:-venice}"
  python3 - "$HUB/registry.example.json" "$HUB/registry.json" "$PROVIDER" <<'PY'
import json, sys
src, dest, provider = sys.argv[1:4]
d = json.load(open(src))
d["org"] = ""
d["products"] = []
d["cross_product_edges"] = []
ha = d.setdefault("settings", {}).setdefault("hub_agent", {})
ha["provider"] = provider
ha["cliName"] = provider
# Example ships the venice default model — replace it with the selected
# provider's default so non-venice installs don't inherit it.
PROVIDER_DEFAULT_MODEL = {
    "grok": "grok-4.5",
    "chatgpt": "gpt-5.4",
    "claude": "claude-sonnet-4-6",
    "gemini": "gemini-2.5-flash",
    "venice": "z-ai-glm-5-3-flash",
    "ollama": "llama3.2",
}
if provider in PROVIDER_DEFAULT_MODEL:
    ha["model"] = PROVIDER_DEFAULT_MODEL[provider]
else:
    ha.pop("model", None)
models = d.setdefault("settings", {}).setdefault("models", {})
if provider in PROVIDER_DEFAULT_MODEL:
    models["agent_default"] = PROVIDER_DEFAULT_MODEL[provider]
json.dump(d, open(dest, "w"), indent=2)
open(dest, "a").write("\n")
PY
  ok "registry.json seeded (provider=$PROVIDER, no products — add them post-install)"
fi
[ -f "$HUB/registry.json" ] || die "registry.json missing and could not be seeded"

python3 - "$HUB/registry.json" "$HOST" "$PORT" "$TLS_SELF_SIGNED" "$TLS_CERT" "$TLS_KEY" <<'PY'
import json, sys
path, host, port, tls_self, tls_cert, tls_key = sys.argv[1:7]
d = json.load(open(path))
cp = d.setdefault("settings", {}).setdefault("control_plane", {})
cp["host"] = host
cp["port"] = int(port)
if tls_self == "1" or tls_cert or tls_key:
    tls = cp.setdefault("tls", {})
    tls["enabled"] = True
    if tls_cert:
        tls["cert"] = tls_cert
    if tls_key:
        tls["key"] = tls_key
# Sane enterprise defaults: concurrent agent turns with per-provider slots,
# gentler rate-limit handling for shared provider keys, longer hold windows.
disp = d.setdefault("settings", {}).setdefault("dispatch", {})
disp.setdefault("allow_concurrency", True)
disp.setdefault("agent_slots", 2)
disp.setdefault("api_min_interval_ms", 500)
disp.setdefault("rate_limit_cooldown_secs", 300)
disp.setdefault("hold_cooldown_secs", 1800)
json.dump(d, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
TLS_LABEL=""
if [ "$TLS_SELF_SIGNED" -eq 1 ] || [ -n "$TLS_CERT" ]; then TLS_LABEL=" tls=on"; fi
ok "control_plane: host=$HOST port=$PORT$TLS_LABEL"
ok "dispatch: concurrency on, agent_slots=2, rate-limit cooldown 300s, hold 1800s"

# --- 3. TLS ----------------------------------------------------------------
step "TLS"
mkdir -p "$HUB/.bizagent"
touch "$HUB/.bizagent/env"
chmod 600 "$HUB/.bizagent/env"
# Pin host/port in .bizagent/env: env wins over registry.json and the shell
# environment, so the service always binds what this installer configured.
python3 - "$HUB/.bizagent/env" "BIZAGENT_HOST=$HOST" "BIZAGENT_PORT=$PORT" <<'PY'
import re, sys
path, *pairs = sys.argv[1:]
lines = open(path).read().splitlines()
want = dict(p.split("=", 1) for p in pairs)
seen = set()
out = []
for line in lines:
    m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", line)
    if m and m.group(1) in want:
        out.append(f"{m.group(1)}={want[m.group(1)]}")
        seen.add(m.group(1))
    else:
        out.append(line)
for k, v in want.items():
    if k not in seen:
        out.append(f"{k}={v}")
open(path, "w").write("\n".join(out) + "\n")
PY
ok ".bizagent/env pinned: BIZAGENT_HOST=$HOST BIZAGENT_PORT=$PORT"
if [ -n "$TLS_CERT" ]; then
  [ -f "$TLS_CERT" ] || die "TLS cert not found: $TLS_CERT"
  [ -f "$TLS_KEY" ] || die "TLS key not found: $TLS_KEY"
  for pair in "BIZAGENT_TLS_CERT=$TLS_CERT" "BIZAGENT_TLS_KEY=$TLS_KEY"; do
    k="${pair%%=*}"
    grep -qE "^${k}=" "$HUB/.bizagent/env" 2>/dev/null || printf '%s\n' "$pair" >> "$HUB/.bizagent/env"
  done
  ok "existing cert/key wired via BIZAGENT_TLS_CERT / BIZAGENT_TLS_KEY"
elif [ "$TLS_SELF_SIGNED" -eq 1 ]; then
  ok "TLS enabled — a self-signed cert is generated into .bizagent/tls/ on first start"
else
  note "no TLS requested — console stays on plain http (enable later with --tls)"
fi

# --- 4. Enterprise log profile ---------------------------------------------
for pair in "BIZAGENT_LOG_MAX_BYTES=10485760" "BIZAGENT_LOG_KEEP_GENERATIONS=3"; do
  k="${pair%%=*}"
  grep -qE "^${k}=" "$HUB/.bizagent/env" 2>/dev/null || printf '%s\n' "$pair" >> "$HUB/.bizagent/env"
done
ok "log profile: 10 MB rotation cap, 3 generations (env BIZAGENT_LOG_*)"

# --- 5. Auth init ------------------------------------------------------------
step "Auth"
if [ -f "$HUB/.bizagent/auth.json" ]; then
  ok "auth.json already present — skipping auth init"
else
  if [ -z "$ADMIN_USER" ]; then
    ADMIN_USER="$(id -un)"
  fi
  ADMIN_PASSWORD="${BIZAGENT_ADMIN_PASSWORD:-}"
  if [ -z "$ADMIN_PASSWORD" ]; then
    if [ "$YES" -eq 1 ] || ! [ -e /dev/tty ]; then
      die "no password: set BIZAGENT_ADMIN_PASSWORD (or run interactively without --yes)"
    fi
    printf "  Console password for %s (hidden): " "$ADMIN_USER"
    read -r -s ADMIN_PASSWORD </dev/tty; printf "\n"
    [ -n "$ADMIN_PASSWORD" ] || die "empty password"
  fi
  node "$HUB/scripts/bizagent-control-plane.js" auth-init \
    --hub "$HUB" --username "$ADMIN_USER" --password "$ADMIN_PASSWORD"
  unset ADMIN_PASSWORD
  chmod 600 "$HUB/.bizagent/auth.json" 2>/dev/null || true
  ok "console auth initialized for '$ADMIN_USER'"
fi

# --- 6. Service --------------------------------------------------------------
step "Service ($SERVICE)"
if [ "$SERVICE" = "system" ]; then
  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    die "--service system needs root (re-run with sudo) or use --service user"
  fi
  SUDO=""
  if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi
  SVC_USER="${SERVICE_USER:-}"
  if [ -z "$SVC_USER" ]; then
    if [ "$(id -u)" -eq 0 ]; then
      # Running the control plane as root is never the right default.
      if id -u bizagent >/dev/null 2>&1; then
        SVC_USER="bizagent"
      else
        die "running as root: pass --service-user NAME (a dedicated non-root user, e.g. bizagent) or use --service user"
      fi
    else
      SVC_USER="$(id -un)"
    fi
  fi
  NODE_BIN="$(command -v node)"
  UNIT_SRC="$SELF_DIR/bizagent-control-plane-system.service"
  UNIT_DST="/etc/systemd/system/bizagent-control-plane.service"
  sed -e "s|__USER__|$(printf '%s' "$SVC_USER" | sed 's/[&|]/\\&/g')|g" \
      -e "s|__HUB__|$(printf '%s' "$HUB" | sed 's/[&|]/\\&/g')|g" \
      -e "s|__HOST__|$HOST|g" \
      -e "s|__PORT__|$PORT|g" \
      -e "s|__NODE__|$NODE_BIN|g" "$UNIT_SRC" > "$HUB/.bizagent/bizagent-control-plane-system.rendered"
  $SUDO cp "$HUB/.bizagent/bizagent-control-plane-system.rendered" "$UNIT_DST"
  rm -f "$HUB/.bizagent/bizagent-control-plane-system.rendered"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now bizagent-control-plane.service || \
    $SUDO systemctl restart bizagent-control-plane.service
  ok "systemd system service installed and enabled: bizagent-control-plane.service (User=$SVC_USER)"
elif [ "$SERVICE" = "user" ]; then
  bash "$HUB/scripts/install-control-plane.sh" --host "$HOST" --port "$PORT"
  ok "systemd user service installed (scripts/install-control-plane.sh)"
else
  note "no service installed (--service none) — start with: bash $HUB/scripts/control-plane.sh start $HUB"
fi

# --- 7. Health watchdog ------------------------------------------------------
if [ -f "$HUB/scripts/install-health-timer.sh" ]; then
  if bash "$HUB/scripts/install-health-timer.sh" "$HUB" >/dev/null 2>&1; then
    ok "health probe timer installed"
  else
    warn "health probe timer not enabled automatically — run: bash $HUB/scripts/install-health-timer.sh $HUB"
  fi
fi

# --- 8. Start + verify --------------------------------------------------------
step "Verify"
# Effective TLS: registry tls settings (possibly from a previous run) or env
# cert material — the probe must match the scheme the server actually speaks.
TLS_ACTIVE="$(python3 - "$HUB/registry.json" <<'PY'
import json, sys
try:
    tls = (json.load(open(sys.argv[1])).get("settings", {}).get("control_plane", {}) or {}).get("tls", {}) or {}
except Exception:
    tls = {}
print(1 if (tls.get("enabled") or tls.get("key") or tls.get("cert")) else 0)
PY
)"
if [ -f "$HUB/.bizagent/env" ] && grep -qE '^BIZAGENT_TLS_(KEY|CERT)=' "$HUB/.bizagent/env" 2>/dev/null; then
  TLS_ACTIVE=1
fi
SCHEME="http"
[ "$TLS_ACTIVE" = "1" ] && SCHEME="https"
if [ "$SERVICE" = "none" ]; then
  bash "$HUB/scripts/control-plane.sh" start "$HUB" || true
fi
# Re-run with a changed host/port: a running control plane still binds the old
# port — restart it so the service matches the configured values.
CP_PID=""
[ -f "$HUB/.bizagent/control-plane.pid" ] && CP_PID="$(cat "$HUB/.bizagent/control-plane.pid" 2>/dev/null || true)"
if [ -n "$CP_PID" ] && kill -0 "$CP_PID" 2>/dev/null; then
  if ! (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    note "control plane running on a different port — restarting to apply host/port"
    bash "$HUB/scripts/control-plane.sh" restart "$HUB" || true
  fi
fi
_i=0
while [ "$_i" -lt 15 ]; do
  (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break
  sleep 1
  _i=$((_i + 1))
done
CURL_TLS=""
[ "$SCHEME" = "https" ] && CURL_TLS="-k"
CODE="$(curl -sS $CURL_TLS -o /dev/null -w '%{http_code}' --max-time 5 "$SCHEME://127.0.0.1:$PORT/api/health" 2>/dev/null || echo 0)"
[ "$CODE" = "200" ] || die "control plane did not answer /api/health on port $PORT (HTTP $CODE) — log: $HUB/logs/control-plane-server.log"
ok "control plane answering on port $PORT"

if [ -x "$HUB/scripts/check-hub-ready.sh" ]; then
  bash "$HUB/scripts/check-hub-ready.sh" "$HUB" || true
fi

printf "\n${BOLD}BizAgent Enterprise server is up:${NC} ${SCHEME}://<this-host>:%s\n" "$PORT"
note "Add products with the console (or registry.json), then manage via:"
note "  systemctl status bizagent-control-plane.service   # system service"
note "  bash $HUB/scripts/upgrade.sh                      # upgrades (compatible)"
note "  bash $HUB/scripts/factory-reset.sh repair         # recovery (compatible)"
