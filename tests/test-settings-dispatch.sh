#!/usr/bin/env bash
# test-settings-dispatch.sh — GET/POST /api/settings/dispatch (auth + persist)
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fail() { echo "  FAIL: $1"; exit 1; }

grep -q "/api/settings/dispatch" "$ROOT/control-plane/server.js" \
  || fail "server missing /api/settings/dispatch"
grep -q "allow_concurrency" "$ROOT/control-plane/lib/config.js" \
  || fail "config missing allow_concurrency"
grep -q "concurrencyToggle" "$ROOT/control-plane/public/index.html" \
  || fail "nav drawer missing Allow concurrency switch"
grep -q "Allow concurrency" "$ROOT/control-plane/public/index.html" \
  || fail "nav drawer missing Allow concurrency label"

if ! command -v node >/dev/null 2>&1; then
  echo "  ok: settings/dispatch wiring (live HTTP skipped; node not installed)"
  exit 0
fi

node - "$ROOT" <<'NODE' || exit 1
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const root = process.argv[2];
const { createServer } = require(path.join(root, 'control-plane/server'));
const { loadRuntimeConfig, refreshRuntimeConfig } = require(path.join(root, 'control-plane/lib/config'));
const { initAuth, createSession } = require(path.join(root, 'control-plane/lib/auth'));

function assert(cond, msg) {
  if (!cond) { console.error('  FAIL: ' + msg); process.exit(1); }
}

const prevEnv = process.env.BIZAGENT_ALLOW_CONCURRENCY;
delete process.env.BIZAGENT_ALLOW_CONCURRENCY;

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'bizagent-settings-dispatch-'));
fs.mkdirSync(path.join(hub, 'inbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'outbox'), { recursive: true });
fs.mkdirSync(path.join(hub, 'logs'), { recursive: true });
fs.mkdirSync(path.join(hub, '.bizagent'), { recursive: true });
fs.writeFileSync(path.join(hub, 'registry.json'), JSON.stringify({
  settings: { dispatch: { poll_seconds: 2, max_concurrency: 8, lock_lease_secs: 60 } },
  products: [],
}));
fs.writeFileSync(path.join(hub, 'cli.json'), JSON.stringify({
  _runtime: { executable: 'scripts/bizagent-agent', promptFlag: '-f', flags: { extra: '-y' } },
  grok: { baseURL: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', models: ['grok-4.5'] },
}));

initAuth(hub, 'operator', 's3cret-pass');
const sessionId = createSession(hub, 'operator');
const config = loadRuntimeConfig(hub);
assert(config.allowConcurrency === true, 'omit allow_concurrency should default true');

function request(port, { method, pathname, cookie, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_e) { json = { raw: data }; }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const server = createServer(config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const cookie = `bizagent_session=${sessionId}`;

  const unauthGet = await request(port, { method: 'GET', pathname: '/api/settings/dispatch' });
  assert(unauthGet.status === 401, `GET without auth should 401, got ${unauthGet.status}`);

  const unauthPost = await request(port, {
    method: 'POST',
    pathname: '/api/settings/dispatch',
    body: JSON.stringify({ allow_concurrency: false }),
  });
  assert(unauthPost.status === 401, `POST without auth should 401, got ${unauthPost.status}`);

  const getDefault = await request(port, { method: 'GET', pathname: '/api/settings/dispatch', cookie });
  assert(getDefault.status === 200, `authed GET should 200, got ${getDefault.status}`);
  assert(getDefault.json.allow_concurrency === true, 'GET default should be true');
  assert(getDefault.json.env_forced_off === false, 'env_forced_off should be false');

  const badPost = await request(port, {
    method: 'POST',
    pathname: '/api/settings/dispatch',
    cookie,
    body: JSON.stringify({ allow_concurrency: 'yes' }),
  });
  assert(badPost.status === 400, `non-boolean POST should 400, got ${badPost.status}`);

  const postOff = await request(port, {
    method: 'POST',
    pathname: '/api/settings/dispatch',
    cookie,
    body: JSON.stringify({ allow_concurrency: false }),
  });
  assert(postOff.status === 200, `POST false should 200, got ${postOff.status}`);
  assert(postOff.json.allow_concurrency === false, 'POST false should persist effective false');

  const registry = JSON.parse(fs.readFileSync(path.join(hub, 'registry.json'), 'utf8'));
  assert(registry.settings.dispatch.allow_concurrency === false, 'registry.json not updated');

  const getOff = await request(port, { method: 'GET', pathname: '/api/settings/dispatch', cookie });
  assert(getOff.json.allow_concurrency === false, 'GET after POST should be false');

  const postOn = await request(port, {
    method: 'POST',
    pathname: '/api/settings/dispatch',
    cookie,
    body: JSON.stringify({ allow_concurrency: true }),
  });
  assert(postOn.json.allow_concurrency === true, 'POST true should restore allow');

  process.env.BIZAGENT_ALLOW_CONCURRENCY = '0';
  refreshRuntimeConfig(config);
  const getForced = await request(port, { method: 'GET', pathname: '/api/settings/dispatch', cookie });
  assert(getForced.json.allow_concurrency === false, 'env=0 should force GET false');
  assert(getForced.json.env_forced_off === true, 'env=0 should set env_forced_off');

  const postWhileForced = await request(port, {
    method: 'POST',
    pathname: '/api/settings/dispatch',
    cookie,
    body: JSON.stringify({ allow_concurrency: true }),
  });
  assert(postWhileForced.json.allow_concurrency === false, 'env=0 should keep effective false after POST true');
  assert(postWhileForced.json.env_forced_off === true, 'env=0 POST should still report env_forced_off');
  const registryOn = JSON.parse(fs.readFileSync(path.join(hub, 'registry.json'), 'utf8'));
  assert(registryOn.settings.dispatch.allow_concurrency === true, 'POST should still write registry while env-forced');

  server.close();
  fs.rmSync(hub, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.BIZAGENT_ALLOW_CONCURRENCY;
  else process.env.BIZAGENT_ALLOW_CONCURRENCY = prevEnv;
})().catch((err) => {
  if (prevEnv === undefined) delete process.env.BIZAGENT_ALLOW_CONCURRENCY;
  else process.env.BIZAGENT_ALLOW_CONCURRENCY = prevEnv;
  console.error(err);
  process.exit(1);
});
NODE

echo "  ok: settings/dispatch API"
