'use strict';

/**
 * llmapi.js — stubbed REST API for LLM provider calls.
 *
 * Exposes the provider-call surface agents use today (see
 * agent-runtime/src/client.js) as HTTP routes, with stubbed function bodies.
 * Signatures are identical to the runtime functions; only the bodies are
 * placeholders. Not wired into the runtime dispatcher or control-plane —
 * integration is decided later; keep the structure flat and easy to extend.
 *
 * Run: node llmapi.js   (env: LLMAPI_PORT || LLMAPI_HOST)
 */

const express = require('express');

const app = express();
app.use(express.json({ limit: '25mb' }));

// ---------------------------------------------------------------------------
// Stubbed provider-call functions (signatures mirror agent-runtime/src/client.js)
// ---------------------------------------------------------------------------

/**
 * Create a provider client.
 * Mirrors: createClient({ apiKey, baseURL }) -> OpenAI client instance.
 * Stub: returns an inert marker object; no network calls.
 *
 * @param {{ apiKey?: string, baseURL?: string }} params
 */
function createClient({ apiKey, baseURL } = {}) {
  // TODO: replace stub with real provider client construction.
  return { _stub: true, apiKey, baseURL };
}

/**
 * Send one chat completion request.
 * Mirrors: chatCompletion(client, model, messages, tools, opts) -> completion.
 * Stub: returns a fixed placeholder completion shape; no network calls.
 *
 * @param {object} client   client from createClient()
 * @param {string} model
 * @param {object[]} messages
 * @param {object[]} tools
 * @param {object} [opts]   { temperature, tool_choice, ... }
 */
async function chatCompletion(client, model, messages, tools, opts = {}) {
  // TODO: replace stub with real provider call (sanitize + client.chat.completions.create).
  return {
    id: 'stub-' + Date.now().toString(16),
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '' },
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    _stub: true,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ ok: true, stub: true });
});

// POST /v1/chat/completions — body: { model, messages, tools?, ...opts }
app.post('/v1/chat/completions', async (req, res) => {
  const { model, messages, tools, ...opts } = req.body || {};
  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: { message: 'model and messages[] are required', type: 'invalid_request_error' } });
  }
  try {
    const client = createClient({});
    const completion = await chatCompletion(client, model, messages, tools, opts);
    res.json(completion);
  } catch (err) {
    res.status(500).json({ error: { message: String(err && err.message || err), type: 'api_error' } });
  }
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

if (require.main === module) {
  const port = Number(process.env.LLMAPI_PORT || 0) || 8787;
  const host = process.env.LLMAPI_HOST || '127.0.0.1';
  app.listen(port, host, () => {
    console.log(`llmapi stub listening on http://${host}:${port}`);
  });
}

module.exports = { app, createClient, chatCompletion };
