#!/usr/bin/env node
/**
 * bizagent-agent — OpenAI-compatible tool-calling agent for BizAgent dispatch.
 *
 * Flags align with control-plane launches:
 *   -f / --prompt-file  prompt path (dispatch uses this)
 *   -p / --prompt       inline prompt
 *   -y / --yes          auto-approve destructive tools
 *   -m / --model        model id
 *   --provider          xai | openai | venice | openrouter | ollama
 *   --base-url          override API base URL
 *   -k / --api-key      override API key
 */
const { program } = require("commander");
const fs = require("fs").promises;
const path = require("path");
const readline = require("readline");
const { createClient, chatCompletion } = require("./client");
const { resolveProvider, listProviders } = require("./providers");
const { TOOLS, DESTRUCTIVE_TOOLS, executeToolCall } = require("./tools");

const MAX_ITERATIONS = 30;

program
  .name("bizagent-agent")
  .description("BizAgent OpenAI-compatible coding agent runtime")
  .option("-m, --model <model>", "Model id")
  .option("-p, --prompt <prompt>", "Single prompt string")
  .option("-f, --prompt-file <file>", "Path to a file containing the prompt")
  .option("-k, --api-key <key>", "API key (else provider key env)")
  .option(
    "--provider <name>",
    `Provider: ${listProviders().join("|")} (or set BIZAGENT_AGENT_PROVIDER)`,
  )
  .option("--base-url <url>", "OpenAI-compatible base URL override")
  .option("-y, --yes", "Auto-confirm destructive tool actions")
  .option("--list-providers", "Print built-in providers and exit")
  .parse();

const opts = program.opts();

if (opts.listProviders) {
  const { PROVIDERS } = require("./providers");
  for (const [name, p] of Object.entries(PROVIDERS)) {
    console.log(
      `${name}\t${p.baseURL}\tkey=${p.keyEnv}\tdefault=${p.defaultModel}`,
    );
  }
  process.exit(0);
}

const resolved = resolveProvider({
  provider: opts.provider,
  baseURL: opts.baseUrl,
  apiKey: opts.apiKey,
  model: opts.model,
});

if (!resolved.apiKey) {
  console.error(
    `Error: API key required. Pass -k, set ${resolved.keyEnv}, or BIZAGENT_AGENT_API_KEY.`,
  );
  console.error(
    `Provider=${resolved.provider} baseURL=${resolved.baseURL}`,
  );
  process.exit(1);
}

const client = createClient({
  apiKey: resolved.apiKey,
  baseURL: resolved.baseURL,
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(q) {
  return new Promise((resolve) => rl.question(q, (answer) => resolve(answer)));
}

async function getInitialPrompt() {
  if (opts.prompt) return opts.prompt;
  if (opts.promptFile) {
    return fs.readFile(path.resolve(opts.promptFile), "utf8");
  }
  return null;
}

async function confirm(toolName, args) {
  if (opts.yes) return true;
  const summary = `${toolName}: ${JSON.stringify(args).slice(0, 200)}`;
  const answer = await ask(`Allow? [y/N] ${summary} `);
  return answer.trim().toLowerCase() === "y";
}

async function runAgent(userMessage) {
  const messages = [
    {
      role: "system",
      content:
        "You are bizagent-agent, an autonomous coding assistant for BizAgent product work. " +
        "You have tools for file operations, shell commands, and web access. " +
        "Prefer search_replace for edits. Be concise. Finish when the task is done.",
    },
    { role: "user", content: userMessage },
  ];

  let iteration = 0;
  while (iteration < MAX_ITERATIONS) {
    iteration += 1;
    const completion = await chatCompletion(
      client,
      resolved.model,
      messages,
      TOOLS,
    );
    const msg = completion.choices[0].message;

    if (msg.content) {
      console.log(msg.content);
    }

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      break;
    }

    messages.push(msg);

    for (const toolCall of msg.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch (_err) {
        args = {};
      }

      if (DESTRUCTIVE_TOOLS.has(toolCall.function.name)) {
        const allowed = await confirm(toolCall.function.name, args);
        if (!allowed) {
          messages.push({
            tool_call_id: toolCall.id,
            role: "tool",
            content: JSON.stringify({
              success: false,
              error: "User denied this action.",
            }),
          });
          continue;
        }
      }

      let result;
      try {
        result = await executeToolCall(toolCall);
      } catch (err) {
        result = { success: false, error: err.message };
      }

      messages.push({
        tool_call_id: toolCall.id,
        role: "tool",
        content: JSON.stringify(result),
      });
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    console.error(`Warning: stopped after ${MAX_ITERATIONS} tool iterations`);
  }
}

async function interactiveLoop() {
  console.log(
    `bizagent-agent (${resolved.provider} / ${resolved.model}). Type "exit" to quit.`,
  );
  while (true) {
    const input = await ask("\n> ");
    if (input.trim().toLowerCase() === "exit") break;
    if (!input.trim()) continue;
    await runAgent(input);
  }
}

(async () => {
  try {
    const initialPrompt = await getInitialPrompt();
    if (initialPrompt) {
      await runAgent(initialPrompt);
    } else {
      await interactiveLoop();
    }
  } catch (err) {
    console.error(`Error: ${err.message || err}`);
    try { rl.close(); } catch (_e) { /* ignore */ }
    process.exit(1);
  }
  try { rl.close(); } catch (_e) { /* ignore */ }
})();
