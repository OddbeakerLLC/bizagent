#!/usr/bin/env node
/**
 * bizagent-agent — OpenAI-compatible tool-calling agent for BizAgent dispatch.
 *
 * Flags align with control-plane launches:
 *   -f / --prompt-file  prompt path (dispatch uses this)
 *   -p / --prompt       inline prompt
 *   -y / --yes          auto-approve destructive tools
 *   -m / --model        model id
 *   --provider          grok | chatgpt | claude | gemini | venice | ollama | …
 *   --base-url          override API base URL
 *   -k / --api-key      override API key
 */
'use strict';

const { program } = require('commander');
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const { createClient, chatCompletion } = require('./client');
const { resolveProvider, listProviders } = require('./providers');
const { TOOLS, DESTRUCTIVE_TOOLS, executeToolCall } = require('./tools');
const { buildSystemPrompt } = require('./system-prompt');

const MAX_ITERATIONS = Math.min(
  Math.max(Number(process.env.BIZAGENT_AGENT_MAX_ITERATIONS || 50), 5),
  120,
);

program
  .name('bizagent-agent')
  .description('BizAgent OpenAI-compatible coding agent runtime')
  .option('-m, --model <model>', 'Model id')
  .option('-p, --prompt <prompt>', 'Single prompt string')
  .option('-f, --prompt-file <file>', 'Path to a file containing the prompt')
  .option('-k, --api-key <key>', 'API key (else provider key env)')
  .option(
    '--provider <name>',
    `Provider: ${listProviders().join('|')} (or set BIZAGENT_AGENT_PROVIDER)`,
  )
  .option('--base-url <url>', 'OpenAI-compatible base URL override')
  .option('-y, --yes', 'Auto-confirm destructive tool actions')
  .option('--list-providers', 'Print built-in providers and exit')
  .option('--list-tools', 'Print tool names and exit')
  .parse();

const opts = program.opts();

if (opts.listProviders) {
  const { PROVIDERS } = require('./providers');
  for (const [name, p] of Object.entries(PROVIDERS)) {
    console.log(
      `${name}\t${p.baseURL}\tkey=${p.keyEnv}\tdefault=${p.defaultModel}`,
    );
  }
  process.exit(0);
}

if (opts.listTools) {
  for (const t of TOOLS) {
    console.log(`${t.function.name}\t${t.function.description.slice(0, 80)}`);
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
  console.error(`Provider=${resolved.provider} baseURL=${resolved.baseURL}`);
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
    return fs.readFile(path.resolve(opts.promptFile), 'utf8');
  }
  return null;
}

async function confirm(toolName, args) {
  if (opts.yes) return true;
  const summary = `${toolName}: ${JSON.stringify(args).slice(0, 200)}`;
  const answer = await ask(`Allow? [y/N] ${summary} `);
  return answer.trim().toLowerCase() === 'y';
}

function parseToolArgs(toolCall) {
  try {
    const raw = toolCall.function.arguments || '{}';
    return typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
  } catch (err) {
    return { __parse_error: err.message, __raw: String(toolCall.function.arguments || '').slice(0, 500) };
  }
}

/** One-line human progress for dispatch logs (stdout → dispatch-<slug>.log). */
function toolProgressLine(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'read_file':
      return `→ read_file ${a.path || ''}`.trim();
    case 'write_file':
      return `→ write_file ${a.path || ''}`.trim();
    case 'search_replace':
      return `→ search_replace ${a.path || ''}`.trim();
    case 'delete_file':
      return `→ delete_file ${a.path || ''}`.trim();
    case 'list_directory':
      return `→ list_directory ${a.path || '.'}`.trim();
    case 'glob_files':
      return `→ glob_files ${a.pattern || ''}`.trim();
    case 'grep_search':
      return `→ grep_search ${JSON.stringify(a.pattern || '').slice(0, 60)}`.trim();
    case 'execute_shell_command':
      return `→ shell ${String(a.command || '').slice(0, 100)}`.trim();
    case 'fetch_url':
      return `→ fetch_url ${String(a.url || '').slice(0, 80)}`.trim();
    default:
      return `→ ${name || 'tool'}`;
  }
}

async function runAgent(userMessage) {
  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt({ cwd: process.cwd() }),
    },
    { role: 'user', content: userMessage },
  ];

  let iteration = 0;
  let consecutiveParseErrors = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration += 1;
    const completion = await chatCompletion(
      client,
      resolved.model,
      messages,
      TOOLS,
    );
    const choice = completion.choices && completion.choices[0];
    if (!choice || !choice.message) {
      console.error('Error: empty model response');
      break;
    }
    const msg = choice.message;

    if (msg.content) {
      console.log(msg.content);
    }

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      break;
    }

    messages.push(msg);

    for (const toolCall of msg.tool_calls) {
      const args = parseToolArgs(toolCall);
      const name = toolCall.function && toolCall.function.name;

      if (args.__parse_error) {
        consecutiveParseErrors += 1;
        messages.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          content: JSON.stringify({
            success: false,
            error: `Invalid JSON in tool arguments: ${args.__parse_error}`,
            hint: 'Retry the tool call with valid JSON arguments.',
            raw_preview: args.__raw,
          }),
        });
        if (consecutiveParseErrors >= 3) {
          console.error('Error: too many tool-argument parse failures; stopping');
          return;
        }
        continue;
      }
      consecutiveParseErrors = 0;

      if (DESTRUCTIVE_TOOLS.has(name)) {
        const allowed = await confirm(name, args);
        if (!allowed) {
          messages.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            content: JSON.stringify({
              success: false,
              error: 'User denied this action.',
            }),
          });
          continue;
        }
      }

      // Always show tool activity on stdout so dispatch-*.log is watchable even
      // when the model emits tool_calls with no assistant prose ("thinking").
      const progress = toolProgressLine(name, args);
      console.log(progress);

      let result;
      try {
        result = await executeToolCall(toolCall);
      } catch (err) {
        result = {
          success: false,
          error: err.message || String(err),
          hint: 'Fix the error or try a different approach; re-read files if paths were wrong.',
        };
      }

      const ok =
        result &&
        (result.success === true ||
          (result.success !== false && !result.error));
      if (!ok) {
        const errMsg = (result && (result.error || result.message)) || 'failed';
        console.log(`  ↳ fail: ${String(errMsg).slice(0, 200)}`);
      } else if (process.env.BIZAGENT_AGENT_VERBOSE === '1') {
        console.log('  ↳ ok');
      }

      messages.push({
        tool_call_id: toolCall.id,
        role: 'tool',
        content: JSON.stringify(result),
      });
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    console.error(
      `Warning: stopped after ${MAX_ITERATIONS} tool iterations (set BIZAGENT_AGENT_MAX_ITERATIONS to raise)`,
    );
    // One last chance for a text summary without tools
    try {
      messages.push({
        role: 'user',
        content:
          'You hit the tool iteration limit. Stop using tools. Summarize what you completed, what is left, and any blockers.',
      });
      const final = await client.chat.completions.create({
        model: resolved.model,
        messages,
        temperature: 0.2,
      });
      const text =
        final.choices &&
        final.choices[0] &&
        final.choices[0].message &&
        final.choices[0].message.content;
      if (text) console.log(text);
    } catch (_err) {
      /* ignore summary failure */
    }
  }
}

async function interactiveLoop() {
  console.log(
    `bizagent-agent (${resolved.provider} / ${resolved.model}). Type "exit" to quit.`,
  );
  while (true) {
    const input = await ask('\n> ');
    if (input.trim().toLowerCase() === 'exit') break;
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
    // Prefer full provider body so control-plane can classify credits/auth/etc.
    const status = err && (err.status || err.statusCode || (err.response && err.response.status));
    const body =
      (err && err.error && (err.error.message || JSON.stringify(err.error))) ||
      (err && err.message) ||
      String(err);
    const line = status ? `Error: ${status} ${body}` : `Error: ${body}`;
    console.error(line);
    // Operator-facing one-liner (also lands in dispatch-*.stderr for CP alerts).
    const lower = String(body).toLowerCase();
    if (
      /used all available credits|spending limit|purchase more credits|insufficient.?credit|payment required|usage balance exhausted/.test(
        lower,
      )
    ) {
      console.error(
        'FATAL: LLM API credits / spending limit exhausted. Top up or raise the limit at the provider console, then retry.',
      );
    } else if (status === 401 || /invalid.?api.?key|unauthorized|authentication/.test(lower)) {
      console.error(
        'FATAL: LLM API authentication failed. Check the provider API key in `.bizagent/env`.',
      );
    } else if (status === 429 || /rate.?limit|too many requests/.test(lower)) {
      console.error('FATAL: LLM API rate limit. Wait and retry, or reduce concurrency.');
    }
    try {
      rl.close();
    } catch (_e) {
      /* ignore */
    }
    process.exit(1);
  }
  try {
    rl.close();
  } catch (_e) {
    /* ignore */
  }
})();
