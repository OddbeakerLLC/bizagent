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
 *      LLMAPI_TIMEOUT_MS, LLMAPI_CONFIG)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const PQueueMod = require('p-queue');
const PQueue = PQueueMod.default || PQueueMod;
const OpenAI = require('openai');
const { sanitizeMessages } = require('./agent-runtime/src/client');

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
  if (err.name === 'APIConnectionError' || err.name === 'APIConnectionTimeoutError') return true;
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
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, backoffDelay(attempt - 1, lastErr)));
    }
    try {
      return await client.openai.chat.completions.create(body);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === MAX_RETRIES) throw err;
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

  return client.queue.add(() => callWithRetry(client, body));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Optional shared-token auth for /v1/* when LLMAPI_TOKEN is set.
app.use('/v1', (req, res, next) => {
  const token = process.env.LLMAPI_TOKEN;
  if (!token) return next();
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${token}`) return next();
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

// POST /v1/chat/completions — body: { provider, model, messages, tools?, ...opts }
app.post('/v1/chat/completions', async (req, res) => {
  const { provider, model, messages, tools, ...opts } = req.body || {};
  if (!provider || typeof provider !== 'string') {
    return res.status(400).json({ error: { message: 'provider is required', type: 'invalid_request_error' } });
  }
  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: { message: 'model and messages[] are required', type: 'invalid_request_error' } });
  }
  try {
    const client = createClient(provider);
    const completion = await chatCompletion(client, model, messages, tools, opts);
    res.json(completion);
  } catch (err) {
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
  const port = Number(process.env.LLMAPI_PORT || 0) || 8787;
  const host = process.env.LLMAPI_HOST || '127.0.0.1';
  app.listen(port, host, () => {
    console.log(`llmapi listening on http://${host}:${port} (concurrency=${CONCURRENCY}/provider, min_interval=${MIN_INTERVAL_MS}ms, max_retries=${MAX_RETRIES})`);
  });
}

module.exports = { app, createClient, chatCompletion, getProviderConfig };
