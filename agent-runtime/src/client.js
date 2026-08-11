'use strict';

const OpenAI = require('openai');

function createClient({ apiKey, baseURL }) {
  return new OpenAI({
    apiKey,
    baseURL,
  });
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
    messages,
    tools,
    tool_choice: opts.tool_choice || 'auto',
    temperature,
  };

  // Some providers honor max_tokens; harmless if ignored
  const maxTokens = Number(process.env.BIZAGENT_AGENT_MAX_TOKENS || 0);
  if (maxTokens > 0) body.max_tokens = maxTokens;

  return client.chat.completions.create(body);
}

module.exports = { createClient, chatCompletion };
