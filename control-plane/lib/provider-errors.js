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

  if (
    /429|rate.?limit|too many requests|slow down/i.test(t) &&
    !/credits|spending limit/i.test(t)
  ) {
    return {
      kind: 'rate_limit',
      title: 'LLM API rate limit',
      summary: 'The provider rate-limited the request (HTTP 429 or equivalent).',
      fix: 'Wait and retry, reduce concurrency, or raise rate limits with the provider.',
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
    lines.push('The run ended without a clean success. See details below.');
  }
  const snip = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^Warning:\s*The 'NO_COLOR'/i.test(l) && !/^\(node:\d+\)/i.test(l))
    .join('\n')
    .trim();
  if (snip) {
    lines.push('');
    lines.push('```');
    lines.push(snip.length > 800 ? snip.slice(-800) : snip);
    lines.push('```');
  }
  lines.push('');
  lines.push(`Logs: \`logs/dispatch-${slug || 'hub'}.log\` / \`.stderr\``);
  return lines.join('\n');
}

module.exports = {
  classifyProviderError,
  formatProviderFailureMessage,
};
