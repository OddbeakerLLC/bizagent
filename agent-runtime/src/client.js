'use strict';

const OpenAI = require('openai');

/**
 * Base URL of the llmapi.js REST API (Phase 2: callers go through the API
 * instead of hitting LLM providers directly). Set BIZAGENT_LLMAPI_URL (or
 * LLMAPI_URL) to enable; unset = legacy direct-provider behavior.
 */
function llmApiBase() {
  return String(process.env.BIZAGENT_LLMAPI_URL || process.env.LLMAPI_URL || '').trim().replace(/\/+$/, '');
}

function isLlmApiMode() {
  return !!llmApiBase();
}

/**
 * HTTP client that mirrors the OpenAI SDK surface used here
 * (client.chat.completions.create(body)) but POSTs to the llmapi REST API.
 * Errors are shaped like OpenAI SDK errors (.status, .error, .headers) so
 * existing classification (credits/auth/429) keeps working unchanged.
 */
function createLlmApiClient(provider) {
  const base = llmApiBase();
  return {
    __llmapi: true,
    provider,
    chat: {
      completions: {
        async create(body) {
          const headers = { 'Content-Type': 'application/json' };
          const token = process.env.BIZAGENT_LLMAPI_TOKEN || process.env.LLMAPI_TOKEN;
          if (token) headers.Authorization = `Bearer ${token}`;
          const timeoutMs = Math.max(
            1000,
            Number(process.env.BIZAGENT_LLMAPI_TIMEOUT_MS || 600000),
          );
          let res;
          try {
            res = await fetch(`${base}/v1/chat/completions`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ provider, ...body }),
              signal: AbortSignal.timeout(timeoutMs),
            });
          } catch (err) {
            const e = new Error(`llmapi unreachable at ${base}: ${err && err.message || err}`);
            e.status = 502;
            e.error = { message: e.message, type: 'provider_unreachable' };
            throw e;
          }
          const text = await res.text();
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch (_e) { /* non-JSON error body */ }
          if (!res.ok) {
            const apiErr = (parsed && parsed.error) || {};
            const e = new Error(apiErr.message || `llmapi HTTP ${res.status}`);
            e.status = res.status;
            e.error = apiErr;
            const ra = res.headers && res.headers.get && res.headers.get('retry-after');
            e.headers = ra != null ? { 'retry-after': ra } : {};
            throw e;
          }
          if (!parsed) {
            const e = new Error('llmapi returned a non-JSON response');
            e.status = 502;
            e.error = { message: e.message, type: 'api_error' };
            throw e;
          }
          return parsed;
        },
      },
    },
  };
}

function createClient({ apiKey, baseURL, provider }) {
  if (isLlmApiMode()) {
    return createLlmApiClient(provider || '');
  }
  // maxRetries: 0 — the SDK's built-in retries fire ~0.5s/1s apart and exhaust
  // in ~2s (operator report 2026-10-24: 502 retries "exhaust almost instantly").
  // Transient-error retries with real backoff live in chatCompletion() below.
  const client = new OpenAI({
    apiKey,
    baseURL,
    maxRetries: 0,
  });
  // Remember the provider name for Ollama-specific routing (thinking control).
  try { client.__provider = provider || ''; } catch (_e) { /* non-fatal */ }
  return client;
}

/**
 * Transient-error retry with real exponential backoff.
 *
 * Retries 429 / 5xx / network-level failures with exponential backoff + jitter
 * (base delay defaults to 5s, so the full cycle — maxRetries attempts after the
 * first failure — spans roughly 30–60s before giving up instead of exhausting
 * in a couple of seconds). Honors a provider Retry-After header when present.
 *
 * Env:
 *   BIZAGENT_AGENT_MAX_RETRIES   extra attempts after the first (default 3)
 *   BIZAGENT_AGENT_RETRY_BASE_MS base delay, doubled per attempt (default 5000)
 */
function isTransientError(err) {
  if (!err) return false;
  const status = err.status != null ? err.status : err.statusCode;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  if (isConnectionError(err)) return true;
  const code = err.code || '';
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);
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
  // Current SDK versions leave the instance's own `name` as "Error" while the
  // class is APIConnectionError — check both the name and the constructor.
  const names = [err.name, err.constructor && err.constructor.name];
  if (names.includes('APIConnectionError') || names.includes('APIConnectionTimeoutError')) return true;
  const causeCode = (err.cause && err.cause.code) || '';
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(causeCode);
}

function retryDelayMs(attempt, err) {
  const base = Math.max(250, Number(process.env.BIZAGENT_AGENT_RETRY_BASE_MS || 5000));
  let ms = base * Math.pow(2, attempt) + Math.floor(Math.random() * base);
  const headers = (err && err.headers) || {};
  const ra = Number(headers.get ? headers.get('retry-after') : headers['retry-after']);
  if (Number.isFinite(ra) && ra >= 0) ms = Math.max(ms, ra * 1000);
  return Math.min(ms, 60000);
}

function agentMaxRetries() {
  const raw = process.env.BIZAGENT_AGENT_MAX_RETRIES;
  return Math.max(0, Number(raw != null && raw !== '' ? raw : 3));
}

/**
 * Normalize one message for the wire.
 *
 * Providers occasionally return assistant messages with junk fields (e.g.
 * `name: null`, stray nulls, `reasoning` vs `reasoning_content`). Replayed
 * in the next request those fail strict validation (400: name must be a
 * string). Keep only known fields with valid types, preserve the reasoning
 * payload when present (Venice expects it echoed back), and drop invalid
 * tool_calls entries.
 */
function sanitizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const role = typeof msg.role === 'string' ? msg.role : '';
  if (!role) return null;

  if (role === 'tool') {
    return {
      role,
      tool_call_id: typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '',
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content == null ? '' : msg.content),
    };
  }

  const out = {
    role,
    content: sanitizeContent(msg.content),
  };

  if (typeof msg.name === 'string' && msg.name.trim()) out.name = msg.name;

  if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    const calls = [];
    for (const tc of msg.tool_calls) {
      if (!tc || typeof tc !== 'object') continue;
      const fn = tc.function || {};
      if (typeof fn.name !== 'string' || !fn.name) continue;
      let args = fn.arguments;
      if (typeof args !== 'string') args = JSON.stringify(args == null ? {} : args);
      calls.push({
        id: typeof tc.id === 'string' && tc.id ? tc.id : `call_${Math.random().toString(16).slice(2)}`,
        type: 'function',
        function: { name: fn.name, arguments: args },
      });
    }
    if (calls.length) out.tool_calls = calls;
  }

  // Preserve the reasoning payload under whichever field the provider used.
  for (const field of ['reasoning_content', 'reasoning', 'thinking']) {
    if (typeof msg[field] === 'string' && msg[field].trim()) {
      out[field] = msg[field];
      break;
    }
  }

  return out;
}

/**
 * Content sanitizer. Plain strings pass through (JSON-stringifying junk
 * objects as before). Arrays are treated as chat content parts and reduced to
 * valid text + image_url blocks (vision); anything else in the array is
 * dropped, and an unusable array degrades to ''.
 */
function sanitizeContent(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return JSON.stringify(content);
  const blocks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (
      block.type === 'image_url' &&
      block.image_url &&
      typeof block.image_url.url === 'string' &&
      /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(block.image_url.url)
    ) {
      blocks.push({ type: 'image_url', image_url: { url: block.image_url.url } });
    }
  }
  return blocks.length ? blocks : '';
}

/** Drop malformed entries and normalize every message before it is sent. */
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(sanitizeMessage).filter(Boolean);
}

/**
 * Ollama returns 500 "no user query found in messages" when the request's
 * message history contains no user message (verified 2026-11-14: [system,
 * assistant] -> 500; any user message present, even empty content -> OK).
 * Some turns legitimately produce such a history, so append a neutral user
 * message at the request layer instead of failing the turn.
 */
function ensureUserMessage(messages) {
  if (!Array.isArray(messages)) return messages;
  if (messages.some((m) => m && m.role === 'user')) return messages;
  messages.push({ role: 'user', content: '(continue)' });
  return messages;
}

/**
 * Ollama thinking control.
 *
 * The model thinks by default (response carries a populated `reasoning`
 * field, `content` often empty). The NATIVE API (POST /api/chat) honors
 * `"think": false|true`, but the OpenAI-compatible endpoint
 * (/v1/chat/completions) IGNORES it, and a model variant created with
 * `parameters: {think:false}` is ignored at request time too. So when a
 * thinking level is configured for an Ollama provider, the request must go
 * through the native API.
 */

/** Is this baseURL an Ollama server? (default port 11434, local or remote) */
function isOllamaBaseURL(url) {
  return /:11434(\/|$)/.test(String(url || ''));
}

/** Provider catalog keys that mean Ollama (cli.json "ollama" / "localhost"). */
const OLLAMA_PROVIDER_NAMES = ['ollama', 'localhost'];

/**
 * Ollama detection for the thinking-control route: by provider name (works
 * even when the baseURL port differs, e.g. a proxied/test Ollama) or by the
 * default port on the baseURL.
 */
function isOllamaProvider(provider, baseURL) {
  if (OLLAMA_PROVIDER_NAMES.includes(String(provider || '').trim().toLowerCase())) return true;
  return isOllamaBaseURL(baseURL);
}

/** Native-API origin for an Ollama OpenAI-compatible baseURL (strip /v1). */
function ollamaOrigin(baseURL) {
  return String(baseURL || '')
    .replace(/\/v1\/?$/, '')
    .replace(/\/+$/, '');
}

/**
 * Map a thinking level to the Ollama native `think` flag.
 * "low"/"off" -> false (no thinking), "medium"/"on"/"high" -> true.
 * Returns null when no level is set (or unrecognized) — the request then
 * keeps the provider's default behavior.
 */
function thinkingLevelToThink(level) {
  const l = String(level || '').trim().toLowerCase();
  if (['off', 'low', 'false', '0', 'no'].includes(l)) return false;
  if (['on', 'medium', 'high', 'true', '1', 'yes'].includes(l)) return true;
  return null;
}

/** OpenAI content (string or parts array) -> Ollama native {content, images}. */
function toOllamaContent(content) {
  if (typeof content === 'string') return { content, images: null };
  if (!Array.isArray(content)) {
    return { content: content == null ? '' : JSON.stringify(content), images: null };
  }
  let text = '';
  const images = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text += (text ? '\n' : '') + block.text;
    } else if (
      block.type === 'image_url' &&
      block.image_url &&
      typeof block.image_url.url === 'string'
    ) {
      const m = block.image_url.url.match(/^data:image\/[a-z0-9.+-]+;base64,(.*)$/i);
      if (m) images.push(m[1]);
    }
  }
  return { content: text, images: images.length ? images : null };
}

/** OpenAI messages -> Ollama native /api/chat messages. */
function toOllamaMessages(messages) {
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const { content, images } = toOllamaContent(msg.content);
    const entry = { role: msg.role, content };
    if (images) entry.images = images;
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      // OpenAI shape {function:{name, arguments:"json string"}} ->
      // Ollama shape {function:{name, arguments: object}}.
      entry.tool_calls = msg.tool_calls.map((tc) => {
        const fn = (tc && tc.function) || {};
        let args = {};
        if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
          try { args = JSON.parse(fn.arguments); } catch (_e) { args = {}; }
        } else if (fn.arguments && typeof fn.arguments === 'object') {
          args = fn.arguments;
        }
        return { function: { name: fn.name || '', arguments: args } };
      });
    }
    out.push(entry);
  }
  return out;
}

/** Ollama native /api/chat response -> OpenAI chat.completion shape. */
function fromOllamaResponse(resp, model) {
  const msg = (resp && resp.message) || {};
  const message = { role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '' };
  let finish = 'stop';
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    message.tool_calls = msg.tool_calls.map((tc) => {
      const fn = (tc && tc.function) || {};
      const args = fn.arguments == null ? {} : fn.arguments;
      return {
        id: `call_${Math.random().toString(16).slice(2)}`,
        type: 'function',
        function: {
          name: fn.name || '',
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        },
      };
    });
    finish = 'tool_calls';
  }
  // Preserve the reasoning payload under whichever field the provider used
  // (extractReasoning in index.js checks the same fields).
  for (const field of ['reasoning_content', 'reasoning', 'thinking']) {
    if (typeof msg[field] === 'string' && msg[field].trim()) {
      message[field] = msg[field];
      break;
    }
  }
  if (resp && resp.done_reason === 'length') finish = 'length';
  const promptTokens = Number(resp && resp.prompt_eval_count) || 0;
  const completionTokens = Number(resp && resp.eval_count) || 0;
  return {
    id: `chatcmpl-ollama-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * One chat completion through the Ollama NATIVE API (POST /api/chat).
 * `think` is the boolean thinking control the OpenAI-compatible endpoint
 * ignores. Returns an OpenAI-shaped completion so callers are unchanged.
 */
async function ollamaNativeChatCompletion({
  origin, apiKey, model, messages, tools, temperature, maxTokens, think, timeoutMs,
}) {
  const body = {
    model,
    messages: toOllamaMessages(messages),
    stream: false,
    think,
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  const options = {};
  if (temperature != null) options.temperature = temperature;
  if (Number(maxTokens) > 0) options.num_predict = Number(maxTokens);
  if (Object.keys(options).length) body.options = options;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs || 600000))),
    });
  } catch (err) {
    const e = new Error(`ollama native API unreachable at ${origin}: ${(err && err.message) || err}`);
    e.status = 502;
    e.error = { message: e.message, type: 'provider_unreachable' };
    throw e;
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { /* non-JSON error body */ }
  if (!res.ok) {
    // Ollama error bodies are {"error": "..."} (string) or {"error": {...}}.
    const raw = parsed && parsed.error;
    const msgText = typeof raw === 'string' ? raw : (raw && raw.message) || `ollama HTTP ${res.status}`;
    const e = new Error(msgText);
    e.status = res.status;
    e.error = { message: msgText, type: 'api_error' };
    throw e;
  }
  if (!parsed) {
    const e = new Error('ollama native API returned a non-JSON response');
    e.status = 502;
    e.error = { message: e.message, type: 'api_error' };
    throw e;
  }
  return fromOllamaResponse(parsed, model);
}

/**
 * @param {import('openai').OpenAI} client
 * @param {string} model
 * @param {object[]} messages
 * @param {object[]} tools
 * @param {object} [opts]
 */
async function chatCompletion(client, model, messages, tools, opts = {}) {
  const temperature =
    opts.temperature != null
      ? opts.temperature
      : Number(process.env.BIZAGENT_AGENT_TEMPERATURE || 0.2);

  const body = {
    model,
    messages: ensureUserMessage(sanitizeMessages(messages)),
    tools,
    tool_choice: opts.tool_choice || 'auto',
    temperature,
  };

  // Some providers honor max_tokens; harmless if ignored
  const maxTokens = Number(process.env.BIZAGENT_AGENT_MAX_TOKENS || 0);
  if (maxTokens > 0) body.max_tokens = maxTokens;

  // Thinking control (Ollama). The OpenAI-compatible endpoint ignores
  // think:false, so when a level is configured for an Ollama provider the
  // request goes through the native /api/chat instead. In llmapi mode the
  // decision is made server-side — pass the level through and let llmapi
  // route it (it also applies per-provider/per-model cli.json config).
  const think = thinkingLevelToThink(opts.thinking);
  const nativeOllama =
    think !== null &&
    !client.__llmapi &&
    isOllamaProvider(client.__provider || client.provider, client.baseURL);
  if (client.__llmapi && opts.thinking != null && opts.thinking !== '') {
    body.thinking = opts.thinking;
  }

  const send = () =>
    nativeOllama
      ? ollamaNativeChatCompletion({
          origin: ollamaOrigin(client.baseURL),
          apiKey: client.apiKey || '',
          model,
          messages: body.messages,
          tools: body.tools,
          temperature,
          maxTokens,
          think,
        })
      : client.chat.completions.create(body);

  const maxRetries = agentMaxRetries();
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await send();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === maxRetries) throw err;
      const delay = retryDelayMs(attempt, err);
      console.error(
        `LLM call failed (attempt ${attempt + 1}/${maxRetries + 1}, transient: ${err.status || err.code || err.name || 'error'}); retrying in ${Math.round(delay / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr; // unreachable
}

module.exports = {
  createClient,
  chatCompletion,
  sanitizeMessages,
  ensureUserMessage,
  isLlmApiMode,
  isTransientError,
  isConnectionError,
  retryDelayMs,
  agentMaxRetries,
  isOllamaBaseURL,
  isOllamaProvider,
  ollamaOrigin,
  thinkingLevelToThink,
  ollamaNativeChatCompletion,
};
