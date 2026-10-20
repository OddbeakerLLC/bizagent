'use strict';

const OpenAI = require('openai');

// ---------------------------------------------------------------------------
// Circuit breaker state (per baseURL)
// ---------------------------------------------------------------------------
const circuitState = new Map(); // baseURL -> { failures, openedAt, halfOpen }

function circuitBreakerConfig() {
  return {
    threshold: Math.max(1, Number(process.env.BIZAGENT_AGENT_CIRCUIT_THRESHOLD || 3)),
    cooldownMs: Math.max(1000, Number(process.env.BIZAGENT_AGENT_CIRCUIT_COOLDOWN_MS || 30000)),
  };
}

function getCircuitKey(client) {
  return client && client.baseURL ? client.baseURL : '__default__';
}

/**
 * Check whether the circuit is open for a given client.
 * Returns true (open — fail fast) or false (closed/half-open — allow).
 * Auto-transitions half-open → closed on success via recordSuccess.
 */
function isCircuitOpen(client) {
  const key = getCircuitKey(client);
  const state = circuitState.get(key);
  if (!state) return false;
  const { threshold, cooldownMs } = circuitBreakerConfig();
  if (state.failures < threshold) return false;
  // Circuit is open — check if cooldown has elapsed
  if (Date.now() - state.openedAt >= cooldownMs) {
    // Transition to half-open: allow one probe request
    state.halfOpen = true;
    return false;
  }
  return true;
}

function recordFailure(client) {
  const key = getCircuitKey(client);
  const { threshold } = circuitBreakerConfig();
  let state = circuitState.get(key);
  if (!state) {
    state = { failures: 0, openedAt: 0, halfOpen: false };
    circuitState.set(key, state);
  }
  state.failures += 1;
  if (state.failures >= threshold) {
    state.openedAt = Date.now();
    state.halfOpen = false;
  }
}

function recordSuccess(client) {
  const key = getCircuitKey(client);
  circuitState.delete(key); // full reset on success
}

// ---------------------------------------------------------------------------
// Transient error classification
// ---------------------------------------------------------------------------

/**
 * Returns true if the error is transient and worth retrying.
 * Transient: 429 (rate limit), 5xx (server errors), network/timeout errors.
 */
function isTransientError(err) {
  if (!err) return false;
  const status =
    err.status ||
    err.statusCode ||
    (err.response && err.response.status) ||
    0;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  const msg = String(err.message || err.code || '');
  return /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|fetch failed|socket hang up|network|eai_again|request timed out/i.test(
    msg,
  );
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff + jitter
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute delay for a given attempt (0-based).
 * Exponential backoff: baseDelay * 2^attempt + random jitter up to 25%.
 */
function backoffDelay(attempt, baseDelayMs) {
  const exp = baseDelayMs * Math.pow(2, attempt);
  const jitter = exp * 0.25 * Math.random();
  return Math.round(exp + jitter);
}

/**
 * Wrap an async function with retry logic.
 *
 * @param {Function} fn - async function to retry
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=3] - max retry attempts (0 = no retry)
 * @param {number} [opts.baseDelayMs=1000] - base backoff delay in ms
 * @param {Function} [opts.shouldRetry] - optional custom classifier, defaults to isTransientError
 * @param {Function} [opts.onRetry] - optional callback (attempt, error, delayMs)
 * @returns {Promise<any>} - result of fn
 */
async function retryWithBackoff(fn, opts = {}) {
  const maxRetries = Math.max(
    0,
    Number(opts.maxRetries != null ? opts.maxRetries : process.env.BIZAGENT_AGENT_MAX_RETRIES || 3),
  );
  const baseDelayMs = Math.max(
    100,
    Number(opts.baseDelayMs != null ? opts.baseDelayMs : process.env.BIZAGENT_AGENT_RETRY_BASE_MS || 1000),
  );
  const shouldRetry = opts.shouldRetry || isTransientError;
  const onRetry = opts.onRetry || null;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && shouldRetry(err)) {
        const delay = backoffDelay(attempt, baseDelayMs);
        if (onRetry) {
          try {
            onRetry(attempt, err, delay);
          } catch (_) {
            /* ignore callback errors */
          }
        }
        console.error(
          `[retry] attempt ${attempt + 1}/${maxRetries} failed: ${err.status || ''} ${(err.error && err.error.message) || err.message || err}. Retrying in ${delay}ms...`,
        );
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  throw lastError; // unreachable but satisfies static analysis
}

// ---------------------------------------------------------------------------
// Client creation
// ---------------------------------------------------------------------------

function createClient({ apiKey, baseURL }) {
  return new OpenAI({
    apiKey,
    baseURL,
  });
}

// ---------------------------------------------------------------------------
// Message sanitization
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Chat completion with retry + circuit breaker
// ---------------------------------------------------------------------------

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
    messages: sanitizeMessages(messages),
    tools,
    tool_choice: opts.tool_choice || 'auto',
    temperature,
  };

  // Some providers honor max_tokens; harmless if ignored
  const maxTokens = Number(process.env.BIZAGENT_AGENT_MAX_TOKENS || 0);
  if (maxTokens > 0) body.max_tokens = maxTokens;

  // Circuit breaker: fast-fail if the provider is down
  if (isCircuitOpen(client)) {
    const key = getCircuitKey(client);
    const state = circuitState.get(key);
    const err = new Error(
      `LLM API circuit breaker open for ${key}: ${state ? state.failures : '?'} consecutive failures. ` +
        `Cooldown active. Set BIZAGENT_AGENT_CIRCUIT_COOLDOWN_MS to adjust (default 30000ms).`,
    );
    err.status = 503;
    err.code = 'CIRCUIT_OPEN';
    throw err;
  }

  const doRequest = () => client.chat.completions.create(body);

  try {
    const result = await retryWithBackoff(doRequest, {
      onRetry: (_attempt, _err, _delay) => {
        // Each retry attempt is a failure for circuit breaker purposes
        recordFailure(client);
      },
    });
    // Success resets the circuit breaker
    recordSuccess(client);
    return result;
  } catch (err) {
    // Record the final failure for circuit breaker
    recordFailure(client);
    // Enhance the error message for graceful degradation
    if (isTransientError(err)) {
      const enhanced = new Error(
        `LLM API request failed after retries: ${err.status || ''} ${(err.error && err.error.message) || err.message || err}. ` +
          `All retries exhausted. Check provider status and network connectivity.`,
      );
      enhanced.status = err.status || 0;
      enhanced.code = 'RETRIES_EXHAUSTED';
      enhanced.originalError = err;
      throw enhanced;
    }
    // Non-transient errors pass through as-is
    throw err;
  }
}

module.exports = {
  createClient,
  chatCompletion,
  sanitizeMessages,
  // Exported for testing
  isTransientError,
  retryWithBackoff,
  backoffDelay,
  isCircuitOpen,
  recordFailure,
  recordSuccess,
  circuitState,
};
