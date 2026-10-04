#!/usr/bin/env bash
# test-enterprise-connect.sh
#
# Enterprise Server connect client (public hub side):
#   - connect with URL + token (per-product opt-in only; empty selection valid)
#   - Ask Enterprise agent provisioned (registry + agents/ask-enterprise/agent.md)
#   - weekly KS refresh disabled while connected, enabled after disconnect
#   - company/ push, later opt-in/opt-out, disconnect cleanup
# Runs against a mock enterprise server (same API contract as the real box).
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

CLIENT="$ROOT/control-plane/lib/enterprise-server-client.js"
[ -f "$CLIENT" ] || fail "enterprise-server-client.js missing"
[ -f "$ROOT/templates/ask-enterprise.agent.md" ] || fail "ask-enterprise agent template missing"
[ -f "$ROOT/scripts/enterprise-ask.js" ] || fail "enterprise-ask.js missing"
[ -f "$ROOT/scripts/enterprise-sync.sh" ] || fail "enterprise-sync.sh missing"
[ -f "$ROOT/control-plane/public/enterprise.html" ] || fail "enterprise picker UI missing"
grep -q "enterprise-server.json" "$ROOT/scripts/weekly-refresh.sh" \
  || fail "weekly-refresh.sh missing enterprise connected guard"
grep -q "enterprise-server.json" "$ROOT/scripts/weekly.sh" \
  || fail "weekly.sh missing enterprise connected guard"
grep -q "enterprise-sync.sh" "$ROOT/scripts/nightly.sh" \
  || fail "nightly.sh missing enterprise-sync hook"
grep -q "api/enterprise/status" "$ROOT/control-plane/server.js" \
  || fail "control-plane enterprise routes missing"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HUB="$TMP/hub"
mkdir -p "$HUB/.bizagent" "$HUB/company" "$HUB/scripts" "$HUB/control-plane/lib" "$HUB/templates"
cp "$CLIENT" "$HUB/control-plane/lib/"
cp "$ROOT/control-plane/lib/config.js" "$HUB/control-plane/lib/"
cp "$ROOT/control-plane/lib/cli-config.js" "$HUB/control-plane/lib/"
cp "$ROOT/scripts/enterprise-ask.js" "$HUB/scripts/"
cp "$ROOT/scripts/enterprise-sync.js" "$HUB/scripts/"
cp "$ROOT/templates/ask-enterprise.agent.md" "$HUB/templates/"
cp "$ROOT/scripts/weekly-refresh.sh" "$HUB/scripts/"
cp "$ROOT/scripts/weekly.sh" "$HUB/scripts/"
mkdir -p "$HUB/scripts/lib" && cp "$ROOT/scripts/lib/log-ts.sh" "$HUB/scripts/lib/" 2>/dev/null || true

cat > "$HUB/registry.json" <<'JSON'
{
  "hub": { "name": "Test Hub" },
  "settings": {},
  "knowledge_stack": { "enabled": true },
  "products": [
    { "slug": "widgets", "name": "Widgets", "projects": [ { "name": "widgets-web", "path": "../w", "remote": "https://git.example.com/widgets-web.git" } ] },
    { "slug": "platform", "name": "Platform", "projects": [ { "name": "platform-core", "path": "../p", "remote": "" } ] }
  ]
}
JSON
echo "company mission doc" > "$HUB/company/mission.md"

# --- mock enterprise server ---------------------------------------------------
PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
node - "$PORT" "$TMP/mock-state.json" <<'NODE' &
const http = require('http');
const fs = require('fs');
const port = Number(process.argv[2]);
const stateFile = process.argv[3];
const TOKEN = 'test-shared-token';
const state = { hubs: {}, remotes: {}, uploads: {} };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
function body(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(e); } });
  });
}
http.createServer(async (req, res) => {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  const send = (code, json) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(json)); };
  if (req.url === '/health') return send(200, { ok: true });
  if (auth !== TOKEN) return send(401, { error: 'invalid token' });
  if (req.url === '/api/connect' && req.method === 'POST') {
    const b = await body(req);
    state.hubs[b.hub_id] = { name: b.hub_name, products: b.products };
    state.remotes[b.hub_id] = b.products;
    save();
    return send(200, { ok: true, hub_id: b.hub_id, inference_url: 'http://lb:11434', ks: { list: '/api/ks', file: '/api/ks/file?name=', ask: '/api/ask' } });
  }
  if (req.url === '/api/remotes' && req.method === 'POST') {
    const b = await body(req);
    if (!state.hubs[b.hub_id]) return send(404, { error: 'hub not connected' });
    state.remotes[b.hub_id] = b.products; save();
    return send(200, { ok: true });
  }
  if (req.url === '/api/upload-company' && req.method === 'POST') {
    const b = await body(req);
    if (!state.hubs[b.hub_id]) return send(404, { error: 'hub not connected' });
    state.uploads[b.hub_id] = (b.files || []).map((f) => f.path); save();
    return send(200, { ok: true, files_stored: (b.files || []).length });
  }
  if (req.url === '/api/ks' && req.method === 'GET') return send(200, { ok: true, files: ['company--x--mission.md'] });
  if (req.url === '/api/ask' && req.method === 'POST') return send(200, { ok: true, answer: 'mock answer', results: [] });
  if (req.url === '/api/disconnect' && req.method === 'POST') {
    const b = await body(req);
    delete state.hubs[b.hub_id]; delete state.remotes[b.hub_id]; delete state.uploads[b.hub_id]; save();
    return send(200, { ok: true, removed: true });
  }
  send(404, { error: 'not found' });
}).listen(port, '127.0.0.1');
NODE
MOCK_PID=$!
for i in $(seq 1 50); do
  if curl -s "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -s "http://127.0.0.1:$PORT/health" >/dev/null || fail "mock enterprise server did not start"

run_client() {
  node - "$HUB" "$PORT" "$3" "${4:-}" <<'NODE'
const hub = process.argv[2];
const port = process.argv[3];
const op = process.argv[4];
const arg = process.argv[5] ? JSON.parse(process.argv[5]) : undefined;
const client = require(hub + '/control-plane/lib/enterprise-server-client');
(async () => {
  if (op === 'connect') {
    const conn = await client.connect(hub, { url: `http://127.0.0.1:${port}`, token: 'test-shared-token', products: arg.products });
    console.log(JSON.stringify({ selected: conn.selected_products, inference: conn.inference_url, hub_id: conn.hub_id }));
  } else if (op === 'remotes') {
    const conn = await client.updateRemotes(hub, arg.products);
    console.log(JSON.stringify({ selected: conn.selected_products }));
  } else if (op === 'disconnect') {
    console.log(JSON.stringify(await client.disconnect(hub)));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
NODE
}

# --- connect: only opted-in product registered; empty selection valid --------
OUT="$(run_client "$HUB" "$PORT" connect '{"products":["widgets"]}')" || fail "connect failed: $OUT"
echo "$OUT" | grep -q '"selected":\["widgets"\]' || fail "connect selection wrong: $OUT"
echo "$OUT" | grep -q '"inference":"http://lb:11434"' || fail "inference URL not persisted: $OUT"
[ -f "$HUB/.bizagent/enterprise-server.json" ] || fail "connection not persisted"
python3 -c "import json;c=json.load(open('$HUB/.bizagent/enterprise-server.json'));assert c['connected'] and c['token']=='test-shared-token'" || fail "connection file malformed"

# Ask Enterprise provisioned
python3 -c "
import json
r = json.load(open('$HUB/registry.json'))
p = [x for x in r['products'] if x['slug'] == 'ask-enterprise']
assert len(p) == 1, 'ask-enterprise not in registry'
assert p[0]['agent_name'] == 'Ask Enterprise'
" || fail "ask-enterprise registry entry wrong"
[ -f "$HUB/agents/ask-enterprise/agent.md" ] || fail "ask-enterprise agent.md not provisioned"
[ -d "$HUB/agents/ask-enterprise/inbox" ] || fail "ask-enterprise mailbox missing"

# Server saw exactly the opted-in remote (platform has empty remote → ineligible)
python3 -c "
import json
s = json.load(open('$TMP/mock-state.json'))
remotes = s['remotes']
hubs = list(remotes.keys())
assert len(hubs) == 1, hubs
entries = remotes[hubs[0]]
assert len(entries) == 1 and entries[0]['product_slug'] == 'widgets', entries
" || fail "server remote registry wrong (bulk dump or wrong product)"

# Company upload happened at connect
python3 -c "
import json
s = json.load(open('$TMP/mock-state.json'))
hubs = list(s['uploads'].keys())
assert len(hubs) == 1 and s['uploads'][hubs[0]] == ['mission.md'], s['uploads']
" || fail "company upload at connect missing"

# --- weekly KS refresh disabled while connected -------------------------------
OUT="$("$HUB/scripts/weekly-refresh.sh" 2>&1)" || true
echo "$OUT" | grep -qi "Enterprise Server" || fail "weekly-refresh not disabled while connected: $OUT"
OUT="$("$HUB/scripts/weekly.sh" 2>&1)" || true
echo "$OUT" | grep -qi "Enterprise Server" || fail "weekly.sh not disabled while connected: $OUT"

# --- later opt-in/opt-out ------------------------------------------------------
OUT="$(run_client "$HUB" "$PORT" remotes '{"products":["widgets"]}')" || fail "remotes update failed"
OUT="$(run_client "$HUB" "$PORT" remotes '{"products":[]}')" || fail "remotes opt-out failed"
echo "$OUT" | grep -q '"selected":\[\]' || fail "opt-out selection wrong: $OUT"
python3 -c "
import json
s = json.load(open('$TMP/mock-state.json'))
hubs = list(s['remotes'].keys())
assert len(s['remotes'][hubs[0]]) == 0, s['remotes']
" || fail "opt-out not applied on server"

# --- disconnect ----------------------------------------------------------------
run_client "$HUB" "$PORT" disconnect >/dev/null || fail "disconnect failed"
[ ! -f "$HUB/.bizagent/enterprise-server.json" ] || fail "connection file not removed"
python3 -c "
import json
s = json.load(open('$TMP/mock-state.json'))
assert not s['hubs'] and not s['remotes'] and not s['uploads'], s
" || fail "server did not clean up hub data"
OUT="$("$HUB/scripts/weekly-refresh.sh" 2>&1)" || true
echo "$OUT" | grep -qi "Enterprise Server" && fail "weekly-refresh still disabled after disconnect"

# --- enterprise-ask CLI reports disconnected clearly ---------------------------
OUT="$(node "$HUB/scripts/enterprise-ask.js" test 2>&1)" || true
echo "$OUT" | grep -qi "not connected" || fail "enterprise-ask disconnected message wrong: $OUT"

kill "$MOCK_PID" 2>/dev/null || true
echo "enterprise connect tests passed"
