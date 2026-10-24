'use strict';

/**
 * llmapi.js — REST API for LLM provider calls.
 *
 * Exposes the provider-call surface agents use today (see
 * agent-runtime/src/client.js) as HTTP routes so callers never hit LLM
 * providers directly. Every provider gets its own p-queue (serialized by
 * default, with a minimum spacing between request starts) so per-provider
 * rate limits are respected; transient provider failures (429/5xx/network)
 * are retried with exponential backoff + jitter before an error is returned.
 *
 * Provider catalog (baseURL + keyEnv per provider) comes from cli.json
 * (override path with LLMAPI_CONFIG); API keys come from the environment.
 *
 * Run: node llmapi.js   (env: LLMAPI_PORT, LLMAPI_HOST, LLMAPI_TOKEN,
 *      LLMAPI_CONCURRENCY, LLMAPI_MIN_INTERVAL_MS, LLMAPI_MAX_RETRIES,
 *      LLMAPI_TIMEOUT_MS, LLMAPI_RETRY_BASE_MS, LLMAPI_QUEUE_WARN_DEPTH,
 *      LLMAPI_LOG_LEVEL, LLMAPI_CONFIG)
 *
 * Default port 8788 — 8787 is the control plane's default. A second instance
 * started while one is already listening exits cleanly (cron-safe).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const PQueueMod = require('p-queue');
const PQueue = PQueueMod.default || PQueueMod;
const OpenAI = require('openai');
const { sanitizeMessages } = require('./agent-runtime/src/client');
// Models-list helpers shared with the console picker (same normalization:
// chat-model filtering, display names, pricing; anthropic pagination).
const {
  providerModelsStyle,
  modelsUrlFor,
  fetchOpenAiStyleModels,
  fetchAnthropicModels,
  normalizeModels,
  staticModelsFor,
} = require('./control-plane/lib/provider-models');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

// ---------------------------------------------------------------------------
// Per-provider clients + queues (keyed by provider name)
// ---------------------------------------------------------------------------
const clients = Object.create(null);

const CONCURRENCY = Math.max(1, Number(process.env.LLMAPI_CONCURRENCY || 1));
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.LLMAPI_MIN_INTERVAL_MS || 500));
const MAX_RETRIES = Math.max(0, Number(process.env.LLMAPI_MAX_RETRIES != null ? process.env.LLMAPI_MAX_RETRIES : 2));
const TIMEOUT_MS = Math.max(1000, Number(process.env.LLMAPI_TIMEOUT_MS || 120000));
const RETRY_BASE_MS = Math.max(50, Number(process.env.LLMAPI_RETRY_BASE_MS || 500));
const QUEUE_WARN_DEPTH = Math.max(1, Number(process.env.LLMAPI_QUEUE_WARN_DEPTH || 5));

// ---------------------------------------------------------------------------
// Structured event logging — one JSON line per event on stdout (the service
// unit / scripts/llmapi.sh sends it to logs/llmapi.log). Significant events
// only: request in/out, provider selection/fallback, retries + backoff,
// errors with mapped status, queue saturation, service start/stop. Never logs
// message bodies, API keys, or auth headers. LLMAPI_LOG_LEVEL=debug adds
// per-request detail (health polls, catalog reads).
// ---------------------------------------------------------------------------
const LOG_LEVEL = String(process.env.LLMAPI_LOG_LEVEL || 'info').toLowerCase();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function logEvent(level, event, fields = {}) {
  if ((LEVELS[level] || 20) < (LEVELS[LOG_LEVEL] || 20)) return;
  const rec = { ts: new Date().toISOString(), level, event, ...fields };
  try {
    process.stdout.write(JSON.stringify(rec) + '\n');
  } catch (_) {
    /* logging must never take the API down */
  }
}

/** Short reason tag for a retryable error (no message bodies). */
function retryReason(err) {
  if (!err) return 'unknown';
  if (err.status) return `status:${err.status}`;
  if (isConnectionError(err)) {
    const causeCode = err.cause && err.cause.code;
    return `code:${causeCode || 'connection'}`;
  }
  if (err.code) return `code:${err.code}`;
  if (err.name) return `name:${err.name}`;
  return 'unknown';
}

/**
 * Is this a connection-level failure (stale keep-alive socket, refused/reset
 * connection, DNS)? The OpenAI SDK wraps these in APIConnectionError, but in
 * current SDK versions the instance's own `name` is "Error" and `code` is
 * undefined (the raw code sits on `err.cause`) — so classification must not
 * rely on `err.name`/`err.code` alone.
 */
function isConnectionError(err) {
  if (!err) return false;
  if (err instanceof OpenAI.APIConnectionError) return true;
  const cname = (err.constructor && err.constructor.name) || '';
  if (cname === 'APIConnectionError' || cname === 'APIConnectionTimeoutError') return true;
  const causeCode = (err.cause && err.cause.code) || '';
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(causeCode);
}

/** Is this error a request timeout (as opposed to other failures)? */
function isTimeoutError(err) {
  if (!err) return false;
  if (err.name === 'APIConnectionTimeoutError') return true;
  if (err.code === 'ETIMEDOUT') return true;
  return !err.status && !err.statusCode && /timed? ?out/i.test(String(err.message || ''));
}

function loadProviderCatalog() {
  const cfgPath = process.env.LLMAPI_CONFIG || path.join(__dirname, 'cli.json');
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

/** Error carrying an HTTP status + OpenAI-style type, for the route layer. */
function httpError(status, message, type) {
  const err = new Error(message);
  err.statusCode = status;
  err.type = type || 'invalid_request_error';
  return err;
}

// ---------------------------------------------------------------------------
// Provider-call functions (mirror agent-runtime/src/client.js surface)
// ---------------------------------------------------------------------------

/**
 * Resolve one provider's config from the catalog + environment.
 * @param {string} provider
 * @returns {{ apiKey: string, baseURL: string }}
 */
function getProviderConfig(provider) {
  const catalog = loadProviderCatalog();
  const entry = catalog[provider];
  if (!entry || !entry.baseURL) {
    throw httpError(400, `unknown provider "${provider}"`, 'invalid_request_error');
  }
  const apiKey = entry.keyEnv ? process.env[entry.keyEnv] : undefined;
  if (!apiKey && !entry.optionalKey) {
    throw httpError(400, `API key for provider "${provider}" not found in environment variable "${entry.keyEnv}"`, 'invalid_request_error');
  }
  return { apiKey: apiKey || '', baseURL: entry.baseURL };
}

/**
 * Create (or reuse) the client record for a provider: OpenAI-compatible HTTP
 * client plus that provider's own p-queue. Mirrors createClient() in
 * agent-runtime/src/client.js, keyed by provider name.
 *
 * @param {string} provider
 */
function createClient(provider) {
  if (!clients[provider]) {
    const { apiKey, baseURL } = getProviderConfig(provider);
    const queueOpts = { concurrency: CONCURRENCY };
    if (MIN_INTERVAL_MS > 0) {
      // At most CONCURRENCY starts per interval => min spacing between
      // request starts, protecting per-provider rate limits.
      queueOpts.interval = MIN_INTERVAL_MS;
      queueOpts.intervalCap = CONCURRENCY;
    }
    clients[provider] = {
      provider,
      openai: new OpenAI({ apiKey, baseURL, timeout: TIMEOUT_MS, maxRetries: 0 }),
      queue: new PQueue(queueOpts),
    };
  }
  return clients[provider];
}

/** Is this error transient (worth retrying)? */
function isTransient(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  if (typeof err.status === 'number' && err.status >= 500) return true;
  // OpenAI SDK connection errors / timeouts / raw network codes
  if (isConnectionError(err)) return true;
  const code = err.code || '';
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);
}

/** Sleep ms, honoring a provider Retry-After hint when present. */
function backoffDelay(attempt, err) {
  let ms = RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * RETRY_BASE_MS);
  const ra = Number(err && err.headers && (err.headers.get ? err.headers.get('retry-after') : err.headers['retry-after']));
  if (Number.isFinite(ra) && ra >= 0) ms = Math.max(ms, ra * 1000);
  return Math.min(ms, 30000);
}

/**
 * One provider call with retry on transient failures.
 * @param {object} client  client from createClient()
 * @param {object} body    OpenAI-shaped request body
 */
async function callWithRetry(client, body) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.openai.chat.completions.create(body);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === MAX_RETRIES) throw err;
      const delay = backoffDelay(attempt, err);
      logEvent('warn', 'provider_retry', {
        provider: client.provider,
        model: body.model,
        attempt: attempt + 1,
        max_retries: MAX_RETRIES,
        delay_ms: delay,
        reason: retryReason(err),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr; // unreachable
}

/**
 * Send one chat completion request through the provider's queue.
 * Mirrors: chatCompletion(client, model, messages, tools, opts) -> completion.
 *
 * @param {object} client   client from createClient()
 * @param {string} model
 * @param {object[]} messages
 * @param {object[]} tools
 * @param {object} [opts]   { temperature, tool_choice, ... }
 */
async function chatCompletion(client, model, messages, tools, opts = {}) {
  const temperature =
    opts.temperature != null
      ? opts.temperature
      : Number(process.env.BIZAGENT_AGENT_TEMPERATURE || 0.2);

  const body = {
    model,
    messages: sanitizeMessages(messages),
    tools,
    tool_choice: opts.tool_choice || 'auto',
    temperature,
  };

  // Some providers honor max_tokens; harmless if ignored
  const maxTokens = Number(process.env.BIZAGENT_AGENT_MAX_TOKENS || 0);
  if (maxTokens > 0) body.max_tokens = maxTokens;

  // Queue saturation watch: warn once when depth crosses the threshold, and
  // log recovery when it drains back below (so the log brackets the pileup).
  const depth = client.queue.size + client.queue.pending;
  if (depth >= QUEUE_WARN_DEPTH && !client.queueWarned) {
    client.queueWarned = true;
    logEvent('warn', 'queue_saturation', { provider: client.provider, depth, threshold: QUEUE_WARN_DEPTH });
  } else if (depth < QUEUE_WARN_DEPTH && client.queueWarned) {
    client.queueWarned = false;
    logEvent('info', 'queue_recovered', { provider: client.provider, depth });
  }

  return client.queue.add(() => callWithRetry(client, body));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Request in/out logging: one line on arrival, one on completion (route,
// provider/model when known, mapped status, latency). /health polls are
// debug-level so the log stays readable at info.
let reqSeq = 0;
app.use((req, res, next) => {
  req.llm = { id: ++reqSeq, start: Date.now() };
  const level = req.path === '/health' ? 'debug' : 'info';
  logEvent(level, 'request_in', { req_id: req.llm.id, route: `${req.method} ${req.path}` });
  res.on('finish', () => {
    logEvent(level, 'request_out', {
      req_id: req.llm.id,
      route: `${req.method} ${req.path}`,
      provider: req.llm.provider,
      model: req.llm.model,
      status: res.statusCode,
      latency_ms: Date.now() - req.llm.start,
    });
  });
  next();
});

// Optional shared-token auth for /v1/* when LLMAPI_TOKEN is set.
app.use('/v1', (req, res, next) => {
  const token = process.env.LLMAPI_TOKEN;
  if (!token) return next();
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${token}`) return next();
  logEvent('warn', 'auth_rejected', { req_id: req.llm.id, route: `${req.method} ${req.path}` });
  return res.status(401).json({ error: { message: 'missing or invalid bearer token', type: 'authentication_error' } });
});

app.get('/health', (req, res) => {
  const providers = {};
  for (const [name, c] of Object.entries(clients)) {
    providers[name] = { queued: c.queue.size, running: c.queue.pending };
  }
  res.json({ ok: true, providers, uptime_secs: Math.floor(process.uptime()) });
});

// GET /v1/providers — catalog (names, labels, models; never keys)
app.get('/v1/providers', (req, res) => {
  try {
    const catalog = loadProviderCatalog();
    const providers = Object.entries(catalog)
      .filter(([name]) => !name.startsWith('_'))
      .map(([name, e]) => ({ name, label: e.label || name, models: e.models || [] }));
    res.json({ providers });
  } catch (err) {
    res.status(500).json({ error: { message: String(err && err.message || err), type: 'api_error' } });
  }
});

// GET /v1/models — OpenAI-shaped model list.
//   ?provider=x  live fetch of that provider's models endpoint (server-side
//                key), normalized to chat models; falls back to the provider's
//                curated static list with ok:false + error when it fails.
//   no provider  catalog static model lists for every provider (no network).
// Shape: { object: "list", ok, source, provider?, error?, data: [{ id, object: "model", name, pricing?, provider? }] }
app.get('/v1/models', async (req, res) => {
  const providerParam = String(req.query.provider || '').trim();
  try {
    const catalog = loadProviderCatalog();
    if (!providerParam) {
      const data = [];
      for (const [name, entry] of Object.entries(catalog)) {
        if (name.startsWith('_')) continue;
        for (const m of staticModelsFor(entry)) {
          data.push({ id: m.id, object: 'model', name: m.name, provider: name });
        }
      }
      return res.json({ object: 'list', ok: true, source: 'catalog', data });
    }

    const entry = catalog[providerParam];
    if (!entry || !entry.baseURL) {
      return res.status(400).json({ error: { message: `unknown provider "${providerParam}"`, type: 'invalid_request_error' } });
    }
    const fallbackData = staticModelsFor(entry).map((m) => ({ id: m.id, object: 'model', name: m.name, pricing: null }));
    const fail = (error) => {
      logEvent('warn', 'provider_fallback', { req_id: req.llm.id, provider: providerParam, reason: String(error).slice(0, 200) });
      return res.json({ object: 'list', ok: false, source: 'fallback', provider: providerParam, error, data: fallbackData });
    };

    let apiKey;
    try {
      apiKey = getProviderConfig(providerParam).apiKey;
    } catch (err) {
      // Missing key (non-optionalKey provider): same semantics as the console
      // picker today — static fallback + human-readable error, not a 4xx.
      return fail(String(err && err.message || err));
    }

    try {
      const url = modelsUrlFor(entry);
      const raw = providerModelsStyle(entry) === 'anthropic'
        ? await fetchAnthropicModels(url, apiKey)
        : await fetchOpenAiStyleModels(url, apiKey);
      const models = normalizeModels(raw);
      if (models.length === 0) {
        return fail('models list empty or no chat-capable models');
      }
      return res.json({
        object: 'list',
        ok: true,
        source: 'live',
        provider: providerParam,
        data: models.map((m) => ({ id: m.id, object: 'model', name: m.name, pricing: m.pricing })),
      });
    } catch (err) {
      return fail(String((err && err.message) || err || 'failed to list models'));
    }
  } catch (err) {
    res.status(500).json({ error: { message: String(err && err.message || err), type: 'api_error' } });
  }
});

// POST /v1/chat/completions — body: { provider, model, messages, tools?, ...opts }
app.post('/v1/chat/completions', async (req, res) => {
  const { provider, model, messages, tools, ...opts } = req.body || {};
  if (!provider || typeof provider !== 'string') {
    logEvent('warn', 'request_error', { req_id: req.llm.id, route: 'POST /v1/chat/completions', status: 400, type: 'invalid_request_error', error: 'provider is required' });
    return res.status(400).json({ error: { message: 'provider is required', type: 'invalid_request_error' } });
  }
  if (!model || !Array.isArray(messages)) {
    logEvent('warn', 'request_error', { req_id: req.llm.id, route: 'POST /v1/chat/completions', provider, status: 400, type: 'invalid_request_error', error: 'model and messages[] are required' });
    return res.status(400).json({ error: { message: 'model and messages[] are required', type: 'invalid_request_error' } });
  }
  req.llm.provider = provider;
  req.llm.model = model;
  try {
    const client = createClient(provider);
    logEvent('info', 'provider_selected', { req_id: req.llm.id, provider, model });
    const completion = await chatCompletion(client, model, messages, tools, opts);
    res.json(completion);
  } catch (err) {
    // Mapped status: 4xx from validation/unknown-provider/missing-key, provider
    // HTTP status passed through, 502 for network-level failures.
    const mappedStatus = err.statusCode || err.status || 502;
    const mappedType = err.statusCode ? err.type : err.status ? (err.type || 'api_error') : 'provider_unreachable';
    logEvent('error', 'request_error', {
      req_id: req.llm.id,
      provider,
      model,
      status: mappedStatus,
      provider_status: err.status || undefined,
      type: mappedType,
      timeout: isTimeoutError(err) || undefined,
      error: String(err.message || err).slice(0, 300),
    });
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: { message: String(err.message || err), type: err.type } });
    }
    if (err.status) {
      // Provider returned an HTTP error (retries exhausted for transient ones).
      const payload = { error: { message: String(err.message || err), type: err.type || 'api_error', provider_status: err.status } };
      if (err.status === 429) {
        const ra = Number(err.headers && (err.headers.get ? err.headers.get('retry-after') : err.headers['retry-after']));
        if (Number.isFinite(ra)) payload.error.retry_after_secs = ra;
        res.set('Retry-After', String(Number.isFinite(ra) ? ra : 5));
      }
      return res.status(err.status).json(payload);
    }
    // Network-level failure (connection refused/reset, timeout, DNS...)
    return res.status(502).json({ error: { message: String(err && err.message || err), type: 'provider_unreachable' } });
  }
});

// JSON body parse errors -> 400 (not the default HTML 500)
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  res.status(err.status || 500).json({ error: { message: err.message || 'internal error', type: err.status === 400 ? 'invalid_request_error' : 'api_error' } });
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

if (require.main === module) {
  const port = Number(process.env.LLMAPI_PORT || 0) || 8788;
  const host = process.env.LLMAPI_HOST || '127.0.0.1';
  const server = app.listen(port, host, () => {
    logEvent('info', 'service_start', {
      host,
      port,
      concurrency: CONCURRENCY,
      min_interval_ms: MIN_INTERVAL_MS,
      max_retries: MAX_RETRIES,
      timeout_ms: TIMEOUT_MS,
      queue_warn_depth: QUEUE_WARN_DEPTH,
      auth: Boolean(process.env.LLMAPI_TOKEN),
      pid: process.pid,
    });
    console.log(`llmapi listening on http://${host}:${port} (concurrency=${CONCURRENCY}/provider, min_interval=${MIN_INTERVAL_MS}ms, max_retries=${MAX_RETRIES})`);
  });
  // Cron-safe: when a previous instance already owns the port, exit 0 so a
  // cron re-run does not spam failures (systemd restarts handle real crashes).
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      logEvent('info', 'service_skip_port_in_use', { port });
      console.log(`llmapi: port ${port} already in use — another instance is running; exiting`);
      process.exit(0);
    }
    logEvent('error', 'service_error', { error: String((err && err.message) || err).slice(0, 300) });
    console.error(`llmapi: server error: ${err && err.message}`);
    process.exit(1);
  });
  // Graceful stop (systemd sends SIGTERM): log, close the listener, exit.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      logEvent('info', 'service_stop', { signal: sig, uptime_secs: Math.floor(process.uptime()) });
      server.close(() => process.exit(0));
      // Hard exit if lingering connections keep close() pending.
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

module.exports = { app, createClient, chatCompletion, getProviderConfig, isTransient, isConnectionError };
