'use strict';

/**
 * Classify LLM provider / bizagent-agent failures for operator-facing messages.
 */

/**
 * @param {string} text - stderr and/or stdout snippet
 * @returns {{ kind: string, title: string, fix: string, summary: string } | null}
 */
function classifyProviderError(text) {
  const t = String(text || '');
  if (!t.trim()) return null;

  // xAI / OpenAI-style credit & billing
  if (
    /used all available credits|reached its monthly spending limit|purchase more credits|raise your spending limit/i.test(
      t,
    ) ||
    /usage balance exhausted|402\s*Payment Required|payment required|insufficient.?credits|billing|out of credits/i.test(
      t,
    )
  ) {
    return {
      kind: 'credits',
      title: 'LLM API credits / spending limit exhausted',
      summary:
        'The model provider rejected the request because the account is out of credits or hit its spending cap.',
      fix:
        'Top up or raise the limit at the provider console (e.g. xAI console), or switch provider/model in the agent rail, then retry.',
    };
  }

  if (/no user query found in messages/i.test(t)) {
    return {
      kind: 'request',
      title: 'LLM request rejected — no user query',
      summary:
        'The model server rejected the request: the message payload contained no user query (Ollama 500 "no user query found in messages").',
      fix:
        'Retry the dispatch. If it recurs, check the conversation history / prompt assembly being sent to the model (a turn with only system/assistant messages).',
    };
  }

  if (
    /429|rate.?limit|too many requests|slow down/i.test(t) &&
    !/credits|spending limit/i.test(t)
  ) {
    return {
      kind: 'rate_limit',
      title: 'LLM API rate limit',
      summary: 'The provider rate-limited the request (HTTP 429 or equivalent).',
      fix:
        'Hub paused dispatches for this provider until the cooldown expires (auto-resumes); agents on other providers keep running. Reduce concurrency or raise rate limits with the provider if this keeps happening.',
    };
  }

  if (
    /401|invalid.?api.?key|incorrect api key|authentication|not signed in|unauthorized|XAI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY/i.test(
      t,
    ) &&
    !/credits|spending limit/i.test(t)
  ) {
    return {
      kind: 'auth',
      title: 'LLM API authentication failed',
      summary: 'The provider rejected the API key or the agent is not authenticated.',
      fix:
        'Check `.bizagent/env` for the correct key for this provider, then `scripts/control-plane.sh restart` (and hub-daemon if used).',
    };
  }

  if (/unknown model|couldn't set model|model.?not.?found|invalid model/i.test(t)) {
    return {
      kind: 'model',
      title: 'LLM model rejected',
      summary: 'The configured model id is not accepted by the provider.',
      fix: 'Pick a valid model in the agent rail (provider catalog in cli.json) and retry.',
    };
  }

  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|fetch failed|socket hang up/i.test(t)) {
    return {
      kind: 'network',
      title: 'LLM API network error',
      summary: 'Could not reach the model provider.',
      fix: 'Check network/DNS/firewall from the hub host, then retry.',
    };
  }

  return null;
}

/**
 * Name the provider in a rate-limit classification (2026-10-22 per-provider
 * cooldowns): the error card should say WHICH provider hit the 429. Returns
 * the classification unchanged when the provider is unknown.
 */
function nameProviderInClassification(classified, provider) {
  if (!classified || classified.kind !== 'rate_limit' || !provider) return classified;
  return {
    ...classified,
    summary: `The \`${provider}\` provider rate-limited the request (HTTP 429 or equivalent).`,
    fix: `Hub paused \`${provider}\` dispatches until the cooldown expires (auto-resumes); agents on other providers keep running. Reduce concurrency or raise rate limits with the provider if this keeps happening.`,
  };
}

/**
 * Build a short operator-facing markdown body.
 */
function formatProviderFailureMessage({ slug, exitCode, text, classified }) {
  const c = classified || classifyProviderError(text);
  const lines = [];
  if (c) {
    lines.push(`**${c.title}**`);
    lines.push('');
    lines.push(c.summary);
    if (slug) lines.push('');
    if (slug) lines.push(`Agent: \`${slug}\`${exitCode != null ? ` (exit ${exitCode})` : ''}`);
    lines.push('');
    lines.push(`**Fix:** ${c.fix}`);
  } else {
    lines.push(`**Agent failure**${slug ? `: \`${slug}\`` : ''}${exitCode != null ? ` (exit ${exitCode})` : ''}`);
    lines.push('');
    lines.push('The run ended without a clean success.');
  }
  // Operator request (2026-10-18): failure notices state that an error
  // occurred but never inline raw log output — it reads like agent thinking
  // in the console. Full output stays in the dispatch logs on disk.
  lines.push('');
  lines.push(`Logs: \`logs/dispatch-${slug || 'hub'}.log\` / \`.stderr\``);
  return lines.join('\n');
}

module.exports = {
  classifyProviderError,
  formatProviderFailureMessage,
  nameProviderInClassification,
};
