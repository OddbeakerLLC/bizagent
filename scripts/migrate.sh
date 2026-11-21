#!/usr/bin/env bash
# migrate.sh — supported way to move an existing BizAgent installation
# (hub + registry + agents + mail + knowledge stack) to a different computer.
#
# Subcommands:
#   export   Build a full-state archive of this hub (default: one level above
#            the hub, bizagent-migration-<stamp>.tar.gz).
#   restore  Unpack an archive into a new hub root, re-bind paths/host/port,
#            regenerate node_modules, then verify.
#   rebind   Re-bind an already-copied hub (paths, host/port, public URL,
#            git remote rewrites) without touching anything else.
#   verify   Post-move verification: registry, project paths, agent mailboxes,
#            auth, deps, and (with --start) a live control-plane probe.
#
# Usage:
#   scripts/migrate.sh export  [--hub PATH] [--out FILE] [--include-logs]
#   scripts/migrate.sh restore --archive FILE --hub PATH [--host H] [--port P]
#                     [--public-url URL] [--remote-map OLD=NEW]... [--skip-npm] [--force]
#   scripts/migrate.sh rebind  --hub PATH [--old-root PATH] [--host H] [--port P]
#                     [--public-url URL] [--remote-map OLD=NEW]...
#   scripts/migrate.sh verify  [--hub PATH] [--start]
#
# What is safe to copy verbatim vs regenerated: docs/MIGRATION.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HUB="$(cd "$SCRIPT_DIR/.." && pwd)"

BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; NC=$'\033[0m'
ok()   { printf "  ${GREEN}✓${NC} %s\n" "$1"; }
bad()  { printf "  ${RED}✗${NC} %s\n" "$1"; }
note() { printf "    %s\n" "$1"; }

MODE="${1:-}"
shift || true
case "$MODE" in
  export|restore|rebind|verify) ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \?//'; exit 2 ;;
esac

HUB=""
OUT=""
ARCHIVE=""
OLD_ROOT=""
NEW_HOST=""
NEW_PORT=""
PUBLIC_URL=""
INCLUDE_LOGS=0
SKIP_NPM=0
FORCE=0
START_CP=0
REMOTE_MAPS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --archive) ARCHIVE="${2:-}"; shift 2 ;;
    --old-root) OLD_ROOT="${2:-}"; shift 2 ;;
    --host) NEW_HOST="${2:-}"; shift 2 ;;
    --port) NEW_PORT="${2:-}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:-}"; shift 2 ;;
    --remote-map) REMOTE_MAPS+=("${2:-}"); shift 2 ;;
    --include-logs) INCLUDE_LOGS=1; shift ;;
    --skip-npm) SKIP_NPM=1; shift ;;
    --force) FORCE=1; shift ;;
    --start) START_CP=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "migrate: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ ! -d "$HUB" ]; then
  [ "$MODE" = "restore" ] || { echo "migrate: hub path not found: $HUB" >&2; exit 1; }
  mkdir -p "$HUB"
fi
HUB="$(cd "$HUB" && pwd)"
if [ "$MODE" != "restore" ] && [ ! -f "$HUB/registry.json" ]; then
  echo "migrate: no registry.json in $HUB — not a hub root" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------
if [ "$MODE" = "export" ]; then
  STAMP="$(date -u +%Y%m%d-%H%M%S)"
  PARENT="$(dirname "$HUB")"
  BASE="$(basename "$HUB")"
  OUT="${OUT:-$PARENT/bizagent-migration-$STAMP.tar.gz}"
  [ "$(dirname "$OUT")" != "$HUB" ] || { echo "migrate: --out must live outside the hub" >&2; exit 1; }

  # CR 2026-11-21 minor: a running control plane keeps writing mail, dispatch
  # state and conversations during the tar pass — warn so the operator can stop
  # it first for a consistent snapshot (export stays allowed; it is read-only).
  if pgrep -f "control-plane/server.js" >/dev/null 2>&1; then
    note "WARNING: the control plane is running — mail/state may change during export."
    note "  For a consistent snapshot stop it first: scripts/control-plane.sh stop"
  fi

  # Manifest travels inside the archive; restore reads it for re-binding.
  python3 - "$HUB" <<'PY'
import json, os, socket, sys
from datetime import datetime, timezone
hub = sys.argv[1]
reg = json.load(open(os.path.join(hub, "registry.json")))
cp = (reg.get("settings") or {}).get("control_plane") or {}
manifest = {
    "kind": "bizagent-migration",
    "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "hostname": socket.gethostname(),
    "hub_root": hub,
    "control_plane": {"host": cp.get("host", "127.0.0.1"), "port": cp.get("port", 8787)},
    "products": len(reg.get("products", [])),
}
with open(os.path.join(hub, ".bizagent", "migration-manifest.json"), "w") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
PY

  EXCLUDES=(
    --exclude='node_modules'
    --exclude='.git/objects/pack/tmp_*'
    --exclude='.bizagent/backups'
    --exclude='.bizagent/forms'
    --exclude='.bizagent/runtime-cwd'
    --exclude='.bizagent/prompts/turns'
    --exclude='.bizagent/pending-replies'
    --exclude='.bizagent/migration-staging'
    --exclude='*.pid'
    --exclude='*.sock'
    --exclude='hub.lock'
    --exclude='control-plane.heartbeat'
    --exclude='.lock'
    --exclude='tmp_*'
  )
  [ "$INCLUDE_LOGS" -eq 1 ] || EXCLUDES+=(--exclude='logs')

  echo "Exporting $HUB → $OUT"
  tar -czf "$OUT" -C "$PARENT" "${EXCLUDES[@]}" "$BASE"
  chmod 600 "$OUT" 2>/dev/null || true
  SIZE="$(du -h "$OUT" | awk '{print $1}')"
  ok "archive written: $OUT ($SIZE)"
  note "Move it to the target machine, then:"
  note "  scripts/migrate.sh restore --archive $(basename "$OUT") --hub /path/on/target"
  note "See docs/MIGRATION.md for what is copied verbatim vs regenerated."
  exit 0
fi

# ---------------------------------------------------------------------------
# rebind (shared by restore and standalone)
# ---------------------------------------------------------------------------
rebind_hub() {
  local hub="$1" old_root="$2"
  old_root="${old_root:-}"

  python3 - "$hub" "$old_root" "$HUB" "$NEW_HOST" "$NEW_PORT" "$PUBLIC_URL" "$(printf '%s\n' "${REMOTE_MAPS[@]:-}")" <<'PY'
import json, os, re, sys
hub, old_root, new_root, host, port, public_url, remote_maps = sys.argv[1:8]
maps = [m.split("=", 1) for m in remote_maps.splitlines() if "=" in m]
reg_path = os.path.join(hub, "registry.json")
reg = json.load(open(reg_path))

def rewrite(s):
    if not isinstance(s, str) or not s:
        return s
    out = s
    if old_root and old_root != "/" and out.startswith(old_root):
        out = new_root + out[len(old_root):]
    for old, new in maps:
        out = out.replace(old, new)
    return out

changed = []
for p in reg.get("products", []):
    if isinstance(p.get("remote"), str) and p["remote"]:
        new = rewrite(p["remote"])
        if new != p["remote"]:
            p["remote"], changed = new, changed + [f"{p.get('slug','?')} remote"]
    for proj in p.get("projects", []) or []:
        path = proj.get("path") or ""
        if old_root and old_root != "/" and path.startswith(old_root):
            proj["path"] = new_root + path[len(old_root):]
            changed.append(f"{p.get('slug','?')}/{proj.get('name','?')} path")
        new = rewrite(proj.get("remote") or "")
        if new != (proj.get("remote") or ""):
            proj["remote"] = new
            changed.append(f"{p.get('slug','?')}/{proj.get('name','?')} remote")

cp = reg.setdefault("settings", {}).setdefault("control_plane", {})
if host:
    cp["host"] = host
    changed.append(f"control_plane.host={host}")
if port:
    cp["port"] = int(port)
    changed.append(f"control_plane.port={port}")

with open(reg_path, "w") as fh:
    json.dump(reg, fh, indent=2)
    fh.write("\n")

# .bizagent/env — rewrite stale absolute paths, apply host/port/public-url wins
env_path = os.path.join(hub, ".bizagent", "env")
if os.path.isfile(env_path):
    lines = open(env_path).read().splitlines()
    out_lines = []
    want = {}
    if host:
        want["BIZAGENT_HOST"] = host
    if port:
        want["BIZAGENT_PORT"] = port
    if public_url:
        want["BIZAGENT_PUBLIC_URL"] = public_url
    seen = set()
    for line in lines:
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if m:
            key, val = m.group(1), m.group(2)
            if old_root and old_root != "/" and old_root in val:
                val = val.replace(old_root, new_root)
                line = f"{key}={val}"
            if key in want:
                line = f"{key}={want[key]}"
                seen.add(key)
        out_lines.append(line)
    for key, val in want.items():
        if key not in seen:
            out_lines.append(f"{key}={val}")
    with open(env_path, "w") as fh:
        fh.write("\n".join(out_lines) + "\n")
    os.chmod(env_path, 0o600)
    changed.append(".bizagent/env re-bound")

# Agent role files may carry absolute project paths from the old root.
import glob
for md in glob.glob(os.path.join(hub, "agents", "*", "agent.md")):
    body = open(md).read()
    if old_root and old_root != "/" and old_root in body:
        open(md, "w").write(body.replace(old_root, new_root))
        changed.append(f"agents/{os.path.basename(os.path.dirname(md))}/agent.md paths")

print("rebound: " + ("; ".join(changed) if changed else "nothing to change"))
PY
}

# ---------------------------------------------------------------------------
# rebind (standalone entry point)
# ---------------------------------------------------------------------------
if [ "$MODE" = "rebind" ]; then
  rebind_hub "$HUB" "$OLD_ROOT"
  exit 0
fi

# ---------------------------------------------------------------------------
# restore
# ---------------------------------------------------------------------------
if [ "$MODE" = "restore" ]; then
  [ -n "$ARCHIVE" ] || { echo "restore: --archive FILE is required" >&2; exit 2; }
  [ -f "$ARCHIVE" ] || { echo "restore: archive not found: $ARCHIVE" >&2; exit 1; }
  if [ -d "$HUB" ] && [ -n "$(ls -A "$HUB" 2>/dev/null)" ]; then
    # CR 2026-11-21 minor: ANY non-empty target needs --force — a hub without a
    # registry.json (partial/failed install) is exactly the target you least
    # want to silently merge an archive into.
    if [ "$FORCE" -ne 1 ]; then
      echo "restore: target $HUB is not empty — pass --force to merge into it" >&2
      exit 1
    fi
  fi
  mkdir -p "$HUB"
  echo "Restoring archive → $HUB"
  tar -xzf "$ARCHIVE" -C "$HUB" --strip-components=1

  OLD_ROOT="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['hub_root'])" "$HUB/.bizagent/migration-manifest.json" 2>/dev/null || true)"
  if [ -n "$OLD_ROOT" ] && [ "$OLD_ROOT" != "$HUB" ]; then
    rebind_hub "$HUB" "$OLD_ROOT"
  elif [ -n "$NEW_HOST$NEW_PORT$PUBLIC_URL${REMOTE_MAPS[*]:-}" ]; then
    rebind_hub "$HUB" "$OLD_ROOT"
  fi

  if [ "$SKIP_NPM" -ne 1 ] && command -v npm >/dev/null 2>&1; then
    echo "Regenerating node_modules (npm install)…"
    (cd "$HUB" && npm install --silent) || echo "WARN: hub npm install failed — run it manually" 
    if [ -f "$HUB/agent-runtime/package.json" ]; then
      (cd "$HUB/agent-runtime" && npm install --silent) || echo "WARN: agent-runtime npm install failed — run it manually"
    fi
  fi
  chmod 600 "$HUB/.bizagent/env" "$HUB/.bizagent/auth.json" 2>/dev/null || true

  MODE=verify
fi

# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------
if [ "$MODE" = "verify" ]; then
  FAIL=0
  fail() { bad "$1"; FAIL=1; }

  echo "Verifying hub: $HUB"
  if python3 - "$HUB" <<'PY'
import json, os, sys
hub = sys.argv[1]
reg = json.load(open(os.path.join(hub, "registry.json")))
products = reg.get("products", [])
missing = []
for p in products:
    for proj in p.get("projects", []) or []:
        path = (proj.get("path") or "").strip()
        if not path:
            continue
        ap = os.path.expanduser(path) if path.startswith("~/") else os.path.join(hub, path)
        if not os.path.exists(ap):
            missing.append(f"{p.get('slug','?')}/{proj.get('name','?')}: {path}")
print(f"registry: {len(products)} product(s)")
for m in missing:
    print(f"  MISSING {m}")
sys.exit(1 if missing else 0)
PY
  then
    ok "registry parses; all project paths exist"
  else
    fail "registry.json missing project paths (see MISSING above)"
  fi

  # Agent mailboxes
  MB_MISSING=0
  for ad in "$HUB"/agents/*/; do
    [ -d "$ad" ] || continue
    slug="$(basename "$ad")"
    if [ "$slug" = "archive" ]; then continue; fi
    for d in inbox outbox; do
      [ -d "$ad$d" ] || { bad "agents/$slug/$d missing"; MB_MISSING=1; }
    done
  done
  [ "$MB_MISSING" -eq 0 ] && ok "agent mailboxes present" || FAIL=1

  [ -f "$HUB/.bizagent/env" ] && ok ".bizagent/env present" || { bad ".bizagent/env missing (provider keys not migrated)"; FAIL=1; }
  if [ -f "$HUB/.bizagent/auth.json" ]; then
    ok "console auth present"
  else
    note "auth.json missing — first console visit will run first-run login creation"
  fi
  if [ -f "$HUB/agent-runtime/package.json" ]; then
    [ -d "$HUB/agent-runtime/node_modules/openai" ] && ok "agent-runtime deps installed" \
      || { bad "agent-runtime deps missing (cd $HUB/agent-runtime && npm install)"; FAIL=1; }
  fi

  # Control plane probe
  PORT="$(python3 -c "import json,sys;r=json.load(open(sys.argv[1]));print((r.get('settings',{}).get('control_plane',{}) or {}).get('port',8787))" "$HUB/registry.json" 2>/dev/null || echo 8787)"
  HOSTBIND="$(python3 -c "import json,sys;r=json.load(open(sys.argv[1]));print((r.get('settings',{}).get('control_plane',{}) or {}).get('host','127.0.0.1'))" "$HUB/registry.json" 2>/dev/null || echo 127.0.0.1)"
  if [ "$START_CP" -eq 1 ]; then
    echo "Starting control plane (port $PORT)…"
    bash "$HUB/scripts/control-plane.sh" start "$HUB" || true
    _i=0
    while [ "$_i" -lt 15 ]; do
      (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break
      sleep 1; _i=$((_i + 1))
    done
  fi
  if (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo 0)"
    if [ "$CODE" = "200" ]; then
      ok "control plane answering on 127.0.0.1:$PORT (bind $HOSTBIND)"
    else
      fail "port $PORT open but /api/health returned HTTP $CODE"
    fi
  else
    if [ "$START_CP" -eq 1 ]; then
      fail "control plane did not come up on port $PORT (log: $HUB/logs/control-plane-server.log)"
    else
      note "control plane not running (pass --start to boot it as part of verify)"
    fi
  fi

  # llmapi probe (only when configured)
  LLMAPI_URL=""
  [ -f "$HUB/.bizagent/env" ] && LLMAPI_URL="$(grep -E '^BIZAGENT_LLMAPI_URL=' "$HUB/.bizagent/env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"'"'"' \t\r' || true)"
  if [ -n "$LLMAPI_URL" ] && command -v curl >/dev/null 2>&1; then
    CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${LLMAPI_URL%/}/health" 2>/dev/null || echo 0)"
    [ "$CODE" = "200" ] && ok "llmapi answering at $LLMAPI_URL" \
      || { bad "llmapi not reachable at ${LLMAPI_URL%/}/health (HTTP $CODE) — start: scripts/llmapi.sh start $HUB"; FAIL=1; }
  fi

  if [ "$FAIL" -eq 0 ]; then
    printf "\n${BOLD}${GREEN}Migration verify: PASS${NC}\n"
  else
    printf "\n${BOLD}${RED}Migration verify: FAIL${NC} — fix the ✗ items above\n"
    exit 1
  fi
  exit 0
fi
