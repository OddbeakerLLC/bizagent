#!/usr/bin/env bash
# test-installer-node.sh — E2E: installer auto-installs/upgrade Node on a WSL-like box.
#
# Operator decision 2026-11-11: the installer must ensure a modern Node itself —
# on Windows/WSL (and Linux generally), if Node is missing or below the minimum
# (v22), the installer installs/upgrades to the latest Node LTS automatically
# (NodeSource setup script, system-wide so systemd/cron see it) and continues
# setup without manual steps.
#
# Two scenarios, both simulated with PATH shims (the host's real Node install
# and the live hub are never touched):
#   1. "old"     — fresh WSL distro with Node 18.19.1 (the "newest easily
#                  installable" distro Node): installer must detect it, take
#                  the NodeSource path, and continue with the "upgraded" Node.
#   2. "missing" — fresh WSL distro with no Node at all: installer must
#                  install the latest Node LTS and continue.
# The fake `apt-get` "installs nodejs" by writing a node shim that reports
# v24 (still delegating real execution to the host node), so the control
# plane + llmapi genuinely start at the end of each scenario.
#
# Isolation: everything runs in a mktemp dir with BIZAGENT_SOURCE pointing at
# this checkout; stub servers use random free ports.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "node required"
command -v npm  >/dev/null 2>&1 || fail "npm required"
command -v curl >/dev/null 2>&1 || fail "curl required"

REAL_NODE="$(command -v node)"
REAL_NPM="$(command -v npm)"
REAL_CURL="$(command -v curl)"

run_scenario() { # $1 = "old" | "missing"
  local scenario="$1"
  # Globals (not locals): the safety-net EXIT trap and per-scenario cleanup
  # both need them after the function returns.
  WORK="$(mktemp -d "/tmp/bizagent-install-node-$scenario.XXXXXX")"
  HUB_DIR="$WORK/hub"
  SHIMS="$WORK/shims"
  BIN="$WORK/bin"
  mkdir -p "$SHIMS" "$BIN"

  # Restricted PATH: symlinks to every system binary EXCEPT node/npm/npx, so
  # the "missing" scenario is a distro with no Node at all (the host's real
  # node must not be discoverable). The "old" scenario shadows the same tree
  # with its v18 node shim.
  for d in /usr/bin /bin /usr/sbin /sbin; do
    for f in "$d"/*; do
      b="$(basename "$f")"
      [[ "$b" == node || "$b" == npm || "$b" == npx ]] && continue
      [[ -e "$BIN/$b" ]] || ln -s "$f" "$BIN/$b" 2>/dev/null || true
    done
  done
  SCENARIO_PATH="$SHIMS:$BIN"

  # --- shims: the simulated WSL distro ---------------------------------------
  write_node_shim() { # $1 = version string to report
    cat > "$SHIMS/node" <<EOF
#!/bin/sh
case "\$1" in
  -v|--version) echo "$1"; exit 0 ;;
esac
exec "$REAL_NODE" "\$@"
EOF
    chmod +x "$SHIMS/node"
  }
  if [[ "$scenario" == "old" ]]; then
    write_node_shim "v18.19.1"
    # npm present (distro ships it with node) — delegate to the real npm.
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$REAL_NPM" > "$SHIMS/npm"
    chmod +x "$SHIMS/npm"
  fi
  # "missing": no node/npm on PATH at all — the NodeSource package brings both.

  # sudo: WSL default user can sudo; just exec (strip -E like real sudo).
  printf '#!/bin/bash\n[[ "$1" == "-E" ]] && shift\nexec "$@"\n' > "$SHIMS/sudo"
  chmod +x "$SHIMS/sudo"

  # apt-get: `update` no-ops; `install ... nodejs` simulates the NodeSource-built
  # package by writing a node shim reporting v24 (delegating execution).
  cat > "$SHIMS/apt-get" <<EOF
#!/bin/bash
if [[ "\$1" == "update" ]]; then exit 0; fi
if [[ "\$1" == "install" ]]; then
  shift
  for a in "\$@"; do
    if [[ "\$a" == nodejs ]]; then
      cat > "$SHIMS/node" <<'NODE'
#!/bin/sh
case "\$1" in
  -v|--version) echo "v24.13.1"; exit 0 ;;
esac
exec "$REAL_NODE" "\$@"
NODE
      chmod +x "$SHIMS/node"
      printf '#!/bin/sh\nexec "%s" "\$@"\n' "$REAL_NPM" > "$SHIMS/npm"
      chmod +x "$SHIMS/npm"
    fi
  done
  exit 0
fi
exit 0
EOF
  chmod +x "$SHIMS/apt-get"

  # curl: the NodeSource setup script "succeeds" without network; everything
  # else delegates to the real curl.
  cat > "$SHIMS/curl" <<EOF
#!/bin/sh
for a in "\$@"; do
  case "\$a" in *nodesource.com*) exit 0 ;; esac
done
exec "$REAL_CURL" "\$@"
EOF
  chmod +x "$SHIMS/curl"

  # Other deps the installer would otherwise try to install via apt:
  printf '#!/bin/sh\nexit 0\n' > "$SHIMS/plantuml"
  chmod +x "$SHIMS/plantuml"

  pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
  CP_PORT="$(pick_port)"
  LL_PORT="$(pick_port)"
  OL_PORT="$(pick_port)"
  [[ "$CP_PORT" != "$LL_PORT" && "$LL_PORT" != "$OL_PORT" && "$CP_PORT" != "$OL_PORT" ]] || fail "port pick collision"

  # --- stub servers (llmapi /health + ollama provider endpoint) ----------------
  cat > "$WORK/stub.js" <<EOF
const http = require('http');
const port = Number(process.argv[2]);
const name = process.argv[3] || 'stub';
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stub: name }));
    return;
  }
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'node-upgrade-test stub: no LLM behind this port' } }));
}).listen(port, '127.0.0.1', () => console.log('up'));
EOF
  node "$WORK/stub.js" "$LL_PORT" llmapi-stub > "$WORK/llmapi-stub.log" 2>&1 &
  LLSTUB=$!
  node "$WORK/stub.js" "$OL_PORT" ollama-stub > "$WORK/ollama-stub.log" 2>&1 &
  OLSTUB=$!
  for port in "$LL_PORT" "$OL_PORT"; do
    for _ in $(seq 1 50); do
      "$REAL_CURL" -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
      sleep 0.1
    done
    "$REAL_CURL" -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1 || fail "[$scenario] stub on $port did not come up"
  done

  cleanup() {
    bash "$HUB_DIR/scripts/control-plane.sh" stop "$HUB_DIR" >/dev/null 2>&1 || true
    pkill -f "$HUB_DIR" 2>/dev/null || true
    kill "$LLSTUB" "$OLSTUB" 2>/dev/null || true
    wait "$LLSTUB" "$OLSTUB" 2>/dev/null || true
    sleep 0.5
    if (exec 3<>"/dev/tcp/127.0.0.1/$CP_PORT") 2>/dev/null; then
      echo "WARN: [$scenario] control plane still listening on $CP_PORT after stop" >&2
    fi
    rm -rf "$WORK"
    return 0
  }
  # Safety net: if anything below fails/exits, still clean this scenario up.
  trap cleanup EXIT INT TERM

  # --- run the installer on the simulated box ---------------------------------
  BIZAGENT_SOURCE="$ROOT" \
  BIZAGENT_DIR="$HUB_DIR" \
  BIZAGENT_PROVIDER=ollama \
  BIZAGENT_NONINTERACTIVE=1 \
  BIZAGENT_AUTO_UPDATE=0 \
  BIZAGENT_SKIP_TTS=1 \
  BIZAGENT_SKIP_HEALTH_TIMER=1 \
  BIZAGENT_PORT="$CP_PORT" \
  LLMAPI_PORT="$LL_PORT" \
  PATH="$SCENARIO_PATH" \
    bash "$ROOT/install.sh" > "$WORK/install.log" 2>&1
  rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "[$scenario] installer exited $rc — last 40 log lines:" >&2
    tail -n 40 "$WORK/install.log" >&2
    fail "[$scenario] installer exited $rc (expected 0)"
  fi

  # --- assertions: the install/upgrade actually happened ----------------------
  if [[ "$scenario" == "old" ]]; then
    grep -q "below the required v22" "$WORK/install.log" \
      || fail "[$scenario] installer did not detect the old Node"
  else
    grep -q "node not found — installing the latest Node.js LTS" "$WORK/install.log" \
      || fail "[$scenario] installer did not report the missing-Node install path"
  fi
  grep -q "NodeSource LTS repository" "$WORK/install.log" \
    || fail "[$scenario] installer did not take the NodeSource path"
  grep -q "node v24.13.1 (>= v22)" "$WORK/install.log" \
    || fail "[$scenario] installer did not verify the installed Node version"
  NODE_V="$(PATH="$SHIMS:$PATH" "$SHIMS/node" -v)"
  [[ "$NODE_V" == "v24.13.1" ]] || fail "[$scenario] node shim was not installed/upgraded (still $NODE_V)"

  # --- assertions: the hub actually runs on the "installed" node --------------
  grep -q "control plane answering on port $CP_PORT" "$WORK/install.log" \
    || fail "[$scenario] installer did not verify the control plane port: $(tail -n 5 "$WORK/install.log")"
  grep -q "llmapi answering at" "$WORK/install.log" \
    || fail "[$scenario] installer did not verify llmapi /health before the handoff URL"
  "$REAL_CURL" -sf "http://127.0.0.1:$CP_PORT/api/health" >/dev/null 2>&1 \
    || fail "[$scenario] control plane /api/health not 200 on port $CP_PORT"
  if ! bash "$HUB_DIR/scripts/check-hub-ready.sh" "$HUB_DIR" > "$WORK/ready.log" 2>&1; then
    cat "$WORK/ready.log" >&2
    fail "[$scenario] check-hub-ready.sh failed on the fresh install"
  fi
  grep -q "READY" "$WORK/ready.log" || fail "[$scenario] check-hub-ready did not report READY"

  echo "  ok: [$scenario] installer node provisioning (→ v24.13.1 via NodeSource path, CP=$CP_PORT llmapi=$LL_PORT)"
  cleanup   # explicit per-scenario cleanup (the EXIT trap is only a safety net)
}

run_scenario old
run_scenario missing
trap - EXIT INT TERM
echo "  ok: installer node provisioning (both scenarios)"
