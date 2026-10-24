#!/usr/bin/env bash
# test-llmapi.sh — llmapi.js REST API: health, validation, provider calls,
# per-provider queueing/serialization, 429/5xx retry paths, unreachable provider.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'kill $LLMAPI_PID $MOCK_PID 2>/dev/null; rm -rf "$TMP"' EXIT

PORT=18791        # scratch port; 8787 may be occupied by a live service
MOCKPORT=18792
BASE="http://127.0.0.1:$PORT"

# ---------------------------------------------------------------------------
# Mock OpenAI-compatible upstream. Behavior driven by a marker string in the
# first user message: "fail-429" (429 twice, then ok), "fail-500" (always 500),
# "slow" (300ms delay). Records concurrency + start spacing to a stats file.
# ---------------------------------------------------------------------------
cat > "$TMP/mock.js" <<EOF
const http = require('http');
const fs = require('fs');
let active = 0, lastStart = 0, lastSlowStart = 0, slowSpacings = [];
const stats = '$TMP/mock-stats.json';
const srv = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const now = Date.now();
      const isSlow = body.includes('slow');
      if (isSlow) { slowSpacings.push(now - (lastSlowStart || now)); lastSlowStart = now; }
      active++;
      const prev = JSON.parse(fs.existsSync(stats) ? fs.readFileSync(stats, 'utf8') : '{"maxActive":0,"minSpacing":null}');
      const maxActive = Math.max(active, prev.maxActive);
      const gaps = slowSpacings.slice(1);
      const minSpacing = gaps.length ? Math.min(...gaps) : null;
      fs.writeFileSync(stats, JSON.stringify({ maxActive, minSpacing }));
      const n429 = JSON.parse(fs.existsSync('$TMP/n429') ? fs.readFileSync('$TMP/n429', 'utf8') : '0');
      const marker = body.includes('fail-429') ? 'fail-429' : body.includes('fail-500') ? 'fail-500' : body.includes('slow') ? 'slow' : 'ok';
      const reply = (code, obj) => { active--; res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (marker === 'fail-429' && n429 < 2) {
        fs.writeFileSync('$TMP/n429', String(n429 + 1));
        return reply(429, { error: { message: 'rate limited' } });
      }
      if (marker === 'fail-500') return reply(500, { error: { message: 'upstream boom' } });
      const finish = () => reply(200, {
        id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'mock says hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
      });
      if (marker === 'slow') return setTimeout(finish, 300);
      finish();
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }, { id: 'mock-embed-model' }] }));
  }
  res.writeHead(404); res.end();
});
srv.listen($MOCKPORT, '127.0.0.1', () => console.log('mock ready'));
EOF

# Test provider catalog: "mock" -> mock upstream, "dead" -> closed port.
cat > "$TMP/cli.json" <<EOF
{
  "mock": { "label": "Mock", "baseURL": "http://127.0.0.1:$MOCKPORT/v1", "keyEnv": "MOCK_API_KEY", "models": ["mock-model"] },
  "dead": { "label": "Dead", "baseURL": "http://127.0.0.1:1/v1", "keyEnv": "MOCK_API_KEY", "models": ["dead-model"] }
}
EOF

node "$TMP/mock.js" & MOCK_PID=$!
LLMAPI_CONFIG="$TMP/cli.json" LLMAPI_PORT=$PORT LLMAPI_HOST=127.0.0.1 \
  LLMAPI_MIN_INTERVAL_MS=100 LLMAPI_MAX_RETRIES=2 LLMAPI_RETRY_BASE_MS=50 \
  LLMAPI_QUEUE_WARN_DEPTH=2 \
  MOCK_API_KEY=test-key node "$ROOT/llmapi.js" >"$TMP/llmapi.log" 2>&1 & LLMAPI_PID=$!

for i in $(seq 1 50); do curl -sf "$BASE/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "$BASE/health" >/dev/null || fail "llmapi did not come up on $BASE"

# 1. Health
h="$(curl -sf "$BASE/health")"
echo "$h" | grep -q '"ok":true' || fail "health not ok: $h"

# 2. Provider catalog
p="$(curl -sf "$BASE/v1/providers")"
echo "$p" | grep -q '"mock"' || fail "providers missing mock: $p"

# 3. Validation errors -> 400
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -d '{"model":"m","messages":[]}')"
[ "$code" = "400" ] || fail "missing provider should 400, got $code"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -d '{"provider":"mock"}')"
[ "$code" = "400" ] || fail "missing model/messages should 400, got $code"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' -d '{"provider":"nope","model":"m","messages":[{"role":"user","content":"x"}]}')"
[ "$code" = "400" ] || fail "unknown provider should 400, got $code"

# 4. Success path (OpenAI completion shape)
out="$(curl -sf -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
  -d '{"provider":"mock","model":"mock-model","messages":[{"role":"user","content":"hello"}]}')"
echo "$out" | grep -q '"mock says hi"' || fail "unexpected completion: $out"
echo "$out" | grep -q '"chat.completion"' || fail "not a chat.completion object: $out"

# 5. Malformed message junk is sanitized, not rejected
out="$(curl -sf -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
  -d '{"provider":"mock","model":"mock-model","messages":[{"role":"user","content":"hi","name":null},{"role":"bogus"}]}')"
echo "$out" | grep -q '"mock says hi"' || fail "sanitizeMessages path failed: $out"

# 6. 429 retried then succeeds (2 x 429, then ok; max_retries=2)
out="$(curl -sf -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
  -d '{"provider":"mock","model":"mock-model","messages":[{"role":"user","content":"fail-429"}]}')"
echo "$out" | grep -q '"mock says hi"' || fail "429 retry path did not recover: $out"

# 7. Persistent 500 exhausts retries -> 500 with provider_status
code="$(curl -s -o "$TMP/e500" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
  -d '{"provider":"mock","model":"mock-model","messages":[{"role":"user","content":"fail-500"}]}')"
[ "$code" = "500" ] || fail "persistent 500 should surface 500, got $code"
grep -q '"provider_status":500' "$TMP/e500" || fail "missing provider_status: $(cat "$TMP/e500")"

# 8. Unreachable provider -> 502 provider_unreachable
code="$(curl -s -o "$TMP/edead" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
  -d '{"provider":"dead","model":"dead-model","messages":[{"role":"user","content":"x"}]}')"
[ "$code" = "502" ] || fail "unreachable provider should 502, got $code"
grep -q 'provider_unreachable' "$TMP/edead" || fail "missing provider_unreachable type: $(cat "$TMP/edead")"

# 9. Queueing: 3 concurrent "slow" requests must serialize (max 1 in flight)
for i in 1 2 3; do
  curl -s -o /dev/null -X POST "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
    -d '{"provider":"mock","model":"mock-model","messages":[{"role":"user","content":"slow"}]}' &
done
wait $(jobs -p | grep -v "$LLMAPI_PID" | grep -v "$MOCK_PID") 2>/dev/null || wait
sleep 0.5
stats="$(cat "$TMP/mock-stats.json")"
echo "$stats" | grep -q '"maxActive":1' || fail "requests overlapped (queue not serializing): $stats"
minsp="$(node -e "console.log(JSON.parse(process.argv[1]).minSpacing)" "$stats")"
[ "${minsp:-0}" -ge 90 ] || fail "min spacing ${minsp}ms < 100ms interval: $stats"

# 10. Health reflects queue stats after traffic
h="$(curl -sf "$BASE/health")"
echo "$h" | grep -q '"mock"' || fail "health missing mock provider stats: $h"

# 11. Runtime client migration: agent-runtime createClient() in llmapi mode
# (BIZAGENT_LLMAPI_URL set) completes a chat through the REST API, no local key.
out="$(BIZAGENT_LLMAPI_URL="$BASE" node -e '
const { createClient, chatCompletion } = require(process.argv[1] + "/agent-runtime/src/client");
(async () => {
  const client = createClient({ apiKey: "", baseURL: "", provider: "mock" });
  const completion = await chatCompletion(client, "mock-model", [{ role: "user", content: "hello" }], []);
  console.log(JSON.stringify(completion));
})().catch((e) => { console.error(e.message); process.exit(1); });
' "$ROOT")"
echo "$out" | grep -q '"mock says hi"' || fail "runtime llmapi-mode client failed: $out"

# 12. Runtime llmapi-mode client surfaces provider errors with .status (429 exhaustion)
code="$(BIZAGENT_LLMAPI_URL="$BASE" node -e '
const { createClient, chatCompletion } = require(process.argv[1] + "/agent-runtime/src/client");
(async () => {
  const client = createClient({ apiKey: "", baseURL: "", provider: "mock" });
  try {
    await chatCompletion(client, "mock-model", [{ role: "user", content: "fail-500" }], []);
    console.log("no-error");
  } catch (e) {
    console.log(e.status || "no-status");
  }
})().catch(() => process.exit(1));
' "$ROOT")"
[ "$code" = "500" ] || fail "runtime llmapi-mode client should surface provider status 500, got: $code"

# 13. GET /v1/models (no provider) — catalog static lists for every provider
out="$(curl -sf "$BASE/v1/models")"
echo "$out" | grep -q '"object":"list"' || fail "models response not OpenAI-shaped: $out"
echo "$out" | grep -q '"mock-model"' || fail "catalog models missing mock-model: $out"
echo "$out" | grep -q '"dead-model"' || fail "catalog models missing dead-model: $out"

# 14. GET /v1/models?provider=mock — live fetch from the provider, chat-filtered
out="$(curl -sf "$BASE/v1/models?provider=mock")"
echo "$out" | grep -q '"source":"live"' || fail "provider models not live: $out"
echo "$out" | grep -q '"mock-model"' || fail "live models missing mock-model: $out"
echo "$out" | grep -q 'mock-embed-model' && fail "non-chat model not filtered: $out" || true

# 15. GET /v1/models?provider=dead — unreachable provider falls back to static list
out="$(curl -sf "$BASE/v1/models?provider=dead")"
echo "$out" | grep -q '"ok":false' || fail "dead provider should report ok:false: $out"
echo "$out" | grep -q '"source":"fallback"' || fail "dead provider should fall back: $out"
echo "$out" | grep -q '"dead-model"' || fail "fallback models missing dead-model: $out"

# 16. GET /v1/models?provider=nope — unknown provider -> 400
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/models?provider=nope")"
[ "$code" = "400" ] || fail "unknown provider models should 400, got $code"

# 17. Console picker migration: listProviderModels() in llmapi mode
# (BIZAGENT_LLMAPI_URL set) returns live models through the API, no direct
# provider call.
out="$(BIZAGENT_LLMAPI_URL="$BASE" node -e '
const { listProviderModels } = require(process.argv[1] + "/control-plane/lib/provider-models");
(async () => {
  const r = await listProviderModels({
    hub: process.argv[1],
    cliJson: { mock: { baseURL: "http://127.0.0.1:'$MOCKPORT'/v1", keyEnv: "MOCK_API_KEY", models: ["static-mock"] } },
    provider: "mock",
  });
  console.log(JSON.stringify(r));
})().catch((e) => { console.error(e.message); process.exit(1); });
' "$ROOT")"
echo "$out" | grep -q '"ok":true' || fail "picker llmapi-mode not ok: $out"
echo "$out" | grep -q '"source":"live"' || fail "picker llmapi-mode not live: $out"
echo "$out" | grep -q '"mock-model"' || fail "picker llmapi-mode missing mock-model: $out"

# 18. Picker llmapi-mode falls back to the static list when llmapi is unreachable
out="$(BIZAGENT_LLMAPI_URL="http://127.0.0.1:1" node -e '
const { listProviderModels } = require(process.argv[1] + "/control-plane/lib/provider-models");
(async () => {
  const r = await listProviderModels({
    hub: process.argv[1],
    cliJson: { mock: { baseURL: "http://127.0.0.1:'$MOCKPORT'/v1", keyEnv: "MOCK_API_KEY", models: ["static-mock"] } },
    provider: "mock",
  });
  console.log(JSON.stringify(r));
})().catch((e) => { console.error(e.message); process.exit(1); });
' "$ROOT")"
echo "$out" | grep -q '"ok":false' || fail "picker should fail when llmapi is down: $out"
echo "$out" | grep -q '"static-mock"' || fail "picker llmapi-down fallback missing static list: $out"

# 19. Ollama-fallback probe migration: probePaidProvider() in llmapi mode
# probes through the API (2xx + ok -> clear the fallback flag).
HUBTMP="$TMP/hub"
mkdir -p "$HUBTMP/.bizagent"
cat > "$HUBTMP/registry.json" <<EOF
{ "settings": { "hub_agent": { "provider": "mock" } }, "products": [] }
EOF
cat > "$HUBTMP/cli.json" <<EOF
{ "mock": { "label": "Mock", "baseURL": "http://127.0.0.1:$MOCKPORT/v1", "keyEnv": "MOCK_API_KEY", "models": ["mock-model"] } }
EOF
printf '{"active":true,"provider":"ollama","ts":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HUBTMP/.bizagent/ollama-fallback.json"
out="$(BIZAGENT_LLMAPI_URL="$BASE" node -e '
const { probePaidProvider } = require(process.argv[2] + "/control-plane/lib/ollama-fallback");
(async () => {
  const r = await probePaidProvider(process.argv[1]);
  const fs = require("fs");
  const flagGone = !fs.existsSync(process.argv[1] + "/.bizagent/ollama-fallback.json");
  console.log(JSON.stringify({ ...r, flagGone }));
})().catch((e) => { console.error(e.message); process.exit(1); });
' "$HUBTMP" "$ROOT")"
echo "$out" | grep -q '"ok":true' || fail "probe llmapi-mode should succeed: $out"
echo "$out" | grep -q '"flagGone":true' || fail "probe success should clear the fallback flag: $out"

# 20. Probe llmapi-mode reports failure when the paid provider is unreachable
cat > "$HUBTMP/cli.json" <<EOF
{ "dead": { "label": "Dead", "baseURL": "http://127.0.0.1:1/v1", "keyEnv": "MOCK_API_KEY", "models": ["dead-model"] } }
EOF
python3 - "$HUBTMP/registry.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["settings"]["hub_agent"]["provider"] = "dead"
json.dump(d, open(p, "w"))
PY
out="$(BIZAGENT_LLMAPI_URL="$BASE" node -e '
const { probePaidProvider } = require(process.argv[2] + "/control-plane/lib/ollama-fallback");
(async () => {
  const r = await probePaidProvider(process.argv[1]);
  console.log(JSON.stringify(r));
})().catch((e) => { console.error(e.message); process.exit(1); });
' "$HUBTMP" "$ROOT")"
echo "$out" | grep -q '"ok":false' || fail "probe llmapi-mode should fail for a dead provider: $out"

# 21. Significant-event logging: service_start / request in-out / provider
# selection / retries / mapped errors / queue saturation / service_stop, with
# no bodies or secrets in the log.
kill -TERM "$LLMAPI_PID" 2>/dev/null
for i in $(seq 1 30); do kill -0 "$LLMAPI_PID" 2>/dev/null || break; sleep 0.1; done
log="$TMP/llmapi.log"
[ -s "$log" ] || fail "llmapi log is empty"
grep -q '"event":"service_start"' "$log" || fail "no service_start event"
grep -q '"event":"request_in".*"route":"POST /v1/chat/completions"' "$log" || fail "no request_in for chat completions"
grep -q '"event":"request_out".*"provider":"mock".*"model":"mock-model".*"latency_ms"' "$log" || fail "no request_out with provider/model/latency"
grep -q '"event":"provider_selected"' "$log" || fail "no provider_selected event"
grep -q '"event":"provider_queue_created".*"provider":"mock".*"concurrency"' "$log" || fail "no provider_queue_created event (provider added to queue list)"
grep -q '"event":"provider_retry".*"delay_ms"' "$log" || fail "no provider_retry with backoff delay"
grep -q '"event":"request_error".*"status":500' "$log" || fail "no request_error with mapped status 500"
grep -q '"event":"request_error".*"status":502.*"type":"provider_unreachable"' "$log" || fail "no request_error with mapped 502 provider_unreachable"
grep -q '"event":"provider_fallback"' "$log" || fail "no provider_fallback event (models fallback)"
grep -q '"event":"queue_saturation"' "$log" || fail "no queue_saturation event (3 queued slows, warn depth 2)"
grep -q '"event":"service_stop".*"signal":"SIGTERM"' "$log" || fail "no service_stop on SIGTERM"
grep -q 'test-key' "$log" && fail "API key leaked into log" || true
grep -q '"content"' "$log" && fail "message body leaked into log" || true

echo "PASS: test-llmapi.sh"
