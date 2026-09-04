'use strict';

const OpenAI = require('openai');

function createClient({ apiKey, baseURL }) {
  return new OpenAI({
    apiKey,
    baseURL,
  });
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

  return client.chat.completions.create(body);
}

module.exports = { createClient, chatCompletion, sanitizeMessages };
