const OpenAI = require("openai");

function createClient({ apiKey, baseURL }) {
  return new OpenAI({
    apiKey,
    baseURL,
  });
}

async function chatCompletion(client, model, messages, tools) {
  return client.chat.completions.create({
    model,
    messages,
    tools,
    tool_choice: "auto",
    temperature: 0.7,
  });
}

module.exports = { createClient, chatCompletion };
