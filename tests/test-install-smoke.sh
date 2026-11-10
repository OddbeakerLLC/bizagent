#!/usr/bin/env bash
# test-install-smoke.sh — E2E smoke: non-interactive installer run in a temp dir.
#
# Zero-failure-install gate (CR 2026-11-09): a fresh install with
# BIZAGENT_PROVIDER=ollama must exit 0 with a control plane that answers
# /health, an llmapi endpoint that answers /health, check-hub-ready.sh green
# (including the keyless-ollama optionalKey path), and a first-run seed that
# was written unblocked. Doubles as the regression test for both ollama root
# causes (catalog fallback wrote the x.ai baseURL; check-hub-ready demanded
# OLLAMA_API_KEY for a keyless provider).
#
# Isolation: everything runs in a mktemp dir with BIZAGENT_SOURCE pointing at
# this checkout; the control plane and llmapi stubs use random free ports, so
# the live hub (8787/8788) is never touched.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "node required"
command -v npm  >/dev/null 2>&1 || fail "npm required"
command -v curl >/dev/null 2>&1 || fail "curl required"

WORK="$(mktemp -d /tmp/bizagent-install-smoke.XXXXXX)"
HUB_DIR="$WORK/hub"
SHIMS="$WORK/shims"
mkdir -p "$SHIMS"
# Shims so the installer never reaches for sudo/apt or downloads PlantUML:
# every real dependency (git, python3, node, npm, curl, java, dot, crontab)
# must already be present on this host.
for c in plantuml sudo; do
  printf '#!/bin/sh\nexit 0\n' > "$SHIMS/$c"
  chmod +x "$SHIMS/$c"
done

pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
CP_PORT="$(pick_port)"
LL_PORT="$(pick_port)"
OL_PORT="$(pick_port)"
[[ "$CP_PORT" != "$LL_PORT" && "$LL_PORT" != "$OL_PORT" && "$CP_PORT" != "$OL_PORT" ]] || fail "port pick collision"

# --- stub servers ------------------------------------------------------------
# llmapi stub: /health 200 (what the installer handoff + check-hub-ready probe).
# ollama stub: the provider endpoint, so nothing in the install ever reaches a
# real ollama on 11434.
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
  // Anything else (e.g. a stray chat completion from a dispatched agent):
  // fail fast and cheap — this test must not lean on a fake LLM.
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'smoke-test stub: no LLM behind this port' } }));
}).listen(port, '127.0.0.1', () => console.log('up'));
EOF
node "$WORK/stub.js" "$LL_PORT" llmapi-stub > "$WORK/llmapi-stub.log" 2>&1 &
LLSTUB=$!
node "$WORK/stub.js" "$OL_PORT" ollama-stub > "$WORK/ollama-stub.log" 2>&1 &
OLSTUB=$!
for port in "$LL_PORT" "$OL_PORT"; do
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
    sleep 0.1
  done
  curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1 || fail "stub on $port did not come up"
done

cleanup() {
  local rc=$?
  bash "$HUB_DIR/scripts/control-plane.sh" stop "$HUB_DIR" >/dev/null 2>&1 || true
  pkill -f "$HUB_DIR" 2>/dev/null || true
  kill "$LLSTUB" "$OLSTUB" 2>/dev/null || true
  wait "$LLSTUB" "$OLSTUB" 2>/dev/null || true
  # Verify cleanup actually happened (a leaked CP would poison later runs).
  sleep 0.5
  if (exec 3<>"/dev/tcp/127.0.0.1/$CP_PORT") 2>/dev/null; then
    echo "WARN: control plane still listening on $CP_PORT after stop" >&2
  fi
  rm -rf "$WORK"
  exit $rc
}
trap cleanup EXIT INT TERM

# --- run the installer -------------------------------------------------------
BIZAGENT_SOURCE="$ROOT" \
BIZAGENT_DIR="$HUB_DIR" \
BIZAGENT_PROVIDER=ollama \
BIZAGENT_NONINTERACTIVE=1 \
BIZAGENT_AUTO_UPDATE=0 \
BIZAGENT_SKIP_TTS=1 \
BIZAGENT_SKIP_HEALTH_TIMER=1 \
BIZAGENT_PORT="$CP_PORT" \
LLMAPI_PORT="$LL_PORT" \
PATH="$SHIMS:$PATH" \
  bash "$ROOT/install.sh" > "$WORK/install.log" 2>&1
rc=$?
if [[ $rc -ne 0 ]]; then
  echo "installer exited $rc — last 40 log lines:" >&2
  tail -n 40 "$WORK/install.log" >&2
  fail "installer exited $rc (expected 0)"
fi
grep -q "control plane answering on port $CP_PORT" "$WORK/install.log" \
  || fail "installer did not verify the control plane port: $(tail -n 5 "$WORK/install.log")"
grep -q "llmapi answering at" "$WORK/install.log" \
  || fail "installer did not verify llmapi /health before the handoff URL"

# --- assertions --------------------------------------------------------------
curl -sf "http://127.0.0.1:$CP_PORT/api/health" >/dev/null 2>&1 \
  || fail "control plane /api/health not 200 on port $CP_PORT"

# Keyless ollama install: cli.json must carry the real ollama entry (not the
# x.ai placeholder the old defaults-dict fallback wrote).
node -e '
const j = require(process.argv[1]);
const o = j.ollama || {};
if (o.baseURL !== "http://127.0.0.1:11434/v1" || o.optionalKey !== true) {
  console.error("bad ollama cli.json entry: " + JSON.stringify(o));
  process.exit(1);
}' "$HUB_DIR/cli.json" || fail "cli.json ollama entry wrong (catalog fallback regression?)"

# check-hub-ready must pass end-to-end — this is the optionalKey regression:
# a keyless ollama install used to read NOT READY and block the first-run seed.
if ! bash "$HUB_DIR/scripts/check-hub-ready.sh" "$HUB_DIR" > "$WORK/ready.log" 2>&1; then
  cat "$WORK/ready.log" >&2
  fail "check-hub-ready.sh failed on the fresh ollama install"
fi
grep -q "READY" "$WORK/ready.log" || fail "check-hub-ready did not report READY"
grep -q "optional for ollama (keyless OK)" "$WORK/ready.log" \
  || fail "check-hub-ready did not apply the optionalKey skip"
grep -q "llmapi reachable at http://127.0.0.1:$LL_PORT" "$WORK/ready.log" \
  || fail "check-hub-ready did not see the llmapi stub as reachable"

# First-run seed written and NOT blocked.
[[ -f "$HUB_DIR/.bizagent/first-run-seeded" ]] || fail "first-run seed marker missing"
SEED_FILE="$(ls "$HUB_DIR/inbox"/*-install-first-run.md 2>/dev/null | head -n 1)"
[[ -n "$SEED_FILE" && -f "$SEED_FILE" ]] || fail "first-run seed mail missing"
if grep -q "first-run setup blocked" "$SEED_FILE"; then
  fail "first-run seed was written BLOCKED — hub was not ready at seed time"
fi

echo "  ok: install smoke (ollama, ports CP=$CP_PORT llmapi=$LL_PORT)"
