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
const { createClient, chatCompletion, sanitizeMessages } = require('./client');
const { resolveProvider, listProviders } = require('./providers');
const { TOOLS, DESTRUCTIVE_TOOLS, executeToolCall } = require('./tools');
const { buildSystemPrompt } = require('./system-prompt');
const { startMcpFromHub, stopMcp, getMcpSession } = require('./mcp-client');
const { buildUserContent, loadVisionBlocks, looksImageRelated, parseVisionPaths } = require('./vision');

// Provider-specific reasoning field names (verified for Venice, Grok; others from provider docs)
const REASONING_FIELDS = {
  venice: ['reasoning_content'],
  grok: ['reasoning_content', 'reasoning'],
  chatgpt: ['reasoning'],
  claude: ['thinking'],
  gemini: ['reasoning'],
  openrouter: ['reasoning'],
  ollama: [],
};

function extractReasoning(msg, provider) {
  const fields = REASONING_FIELDS[provider];
  if (fields === null) return null;
  const providerFields = fields || [];
  for (const field of providerFields) {
    const content = msg[field];
    if (typeof content === 'string' && content.trim()) {
      return content;
    }
  }
  // fallback for unknown providers: check known fields
  const known = ['reasoning_content', 'reasoning', 'thinking'];
  for (const field of known) {
    const content = msg[field];
    if (typeof content === 'string' && content.trim()) {
      return content;
    }
  }
  return null;
}

const MAX_ITERATIONS = Math.min(
  Math.max(Number(process.env.BIZAGENT_AGENT_MAX_ITERATIONS || 100), 5),
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

async function listToolsAndExit() {
  let mcpTools = [];
  try {
    const session = await startMcpFromHub();
    mcpTools = session.getOpenAiTools();
  } catch (err) {
    console.error(`[mcp] list-tools soft-fail: ${err.message || err}`);
  }
  for (const t of TOOLS) {
    console.log(`${t.function.name}\t${t.function.description.slice(0, 80)}`);
  }
  for (const t of mcpTools) {
    console.log(`${t.function.name}\t${t.function.description.slice(0, 80)}`);
  }
  await stopMcp().catch(() => {});
  process.exit(0);
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
      if (typeof name === 'string' && name.startsWith('mcp__')) {
        return `→ ${name}`;
      }
      return `→ ${name || 'tool'}`;
  }
}

function activeTools() {
  const session = getMcpSession();
  const mcpTools = session ? session.getOpenAiTools() : [];
  return mcpTools.length ? TOOLS.concat(mcpTools) : TOOLS;
}

module.exports = { extractReasoning };

if (require.main === module) {
  if (opts.listTools) {
    listToolsAndExit().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    let resolved;
    try {
      resolved = resolveProvider({
        provider: opts.provider,
        baseURL: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
      });
    } catch (err) {
      console.error(`Error: ${err.message || err}`);
      process.exit(1);
    }

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

    async function runAgent(userMessage, imageBlocks = []) {
      const session = getMcpSession();
      const mcpNames = session ? session.getOpenAiTools().map((t) => t.function.name) : [];
      const messages = [
        {
          role: 'system',
          content: buildSystemPrompt({
            cwd: process.cwd(),
            mcpToolNames: mcpNames,
          }),
        },
        { role: 'user', content: buildUserContent(userMessage, imageBlocks) },
      ];
      if (imageBlocks.length) {
        console.log(`Vision: attaching ${imageBlocks.length} image(s) to this turn`);
      }

      let iteration = 0;
      let consecutiveParseErrors = 0;
      const tools = activeTools();

      while (iteration < MAX_ITERATIONS) {
        iteration += 1;
        let completion;
        try {
          completion = await chatCompletion(
            client,
            resolved.model,
            messages,
            tools,
          );
        } catch (err) {
          // Soft-fail: provider/model can't take image content → one text-only
          // retry so the turn still completes and the operator gets told why.
          if (imageBlocks.length && iteration === 1 && looksImageRelated(err)) {
            console.error(
              `Vision: provider/model rejected the image(s) (${err.status || ''} ${(err.error && err.error.message) || err.message || err}).`.trim(),
            );
            imageBlocks = [];
            messages[1] = {
              role: 'user',
              content: `${String(userMessage)}\n\n[Control plane: the provider/model rejected the attached image(s), so this turn is text-only. If the operator asked about the image(s), tell them this model cannot view images.]`,
            };
            continue;
          }
          throw err;
        }
        const choice = completion.choices && completion.choices[0];
        if (!choice || !choice.message) {
          console.error('Error: empty model response');
          break;
        }
        const msg = choice.message;
        const reasoning = extractReasoning(msg, resolved.provider);
        if (reasoning) {
          reasoning.split('\n').forEach((line) => {
            if (line.trim()) console.log(`Thinking: ${line.trim()}`);
          });
        }

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
            const mcp = getMcpSession();
            if (mcp && mcp.isMcpTool(name)) {
              result = await mcp.callTool(name, args);
            } else {
              result = await executeToolCall(toolCall);
            }
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
            messages: sanitizeMessages(messages),
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
      let mcpStarted = false;
      try {
        // MCP soft-fails internally; never blocks built-ins.
        try {
          await startMcpFromHub();
          mcpStarted = true;
        } catch (err) {
          console.error(`[mcp] startup soft-fail: ${err.message || err}`);
        }
        const initialPrompt = await getInitialPrompt();
        if (initialPrompt) {
          // Images the control plane marked in the turn prompt (vision).
          const imageBlocks = loadVisionBlocks(parseVisionPaths(initialPrompt));
          await runAgent(initialPrompt, imageBlocks);
        } else {
          await interactiveLoop();
        }
      } catch (err) {
        // Prefer full provider body so control-plane can classify credits/auth/etc.
        const status =
          err &&
          (err.status || err.statusCode || (err.response && err.response.status));
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
        } else if (
          status === 401 ||
          /invalid.?api.?key|unauthorized|authentication/.test(lower)
        ) {
          console.error(
            'FATAL: LLM API authentication failed. Check the provider API key in `.bizagent/env`.',
          );
        } else if (status === 429 || /rate.?limit|too many requests/.test(lower)) {
          console.error(
            'FATAL: LLM API rate limit. Wait and retry, or reduce concurrency.',
          );
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
      if (mcpStarted) {
        try {
          await stopMcp();
        } catch (_e) {
          /* ignore */
        }
      }
    })();
  }
}

process.on('exit', () => {
  // Best-effort; async close may not finish on hard exit.
  const s = getMcpSession();
  if (s) {
    try {
      for (const [, entry] of s.servers) {
        try {
          entry.rpc._proc && entry.rpc._proc.kill('SIGTERM');
        } catch (_e) {
          /* ignore */
        }
      }
    } catch (_e) {
      /* ignore */
    }
  }
});
