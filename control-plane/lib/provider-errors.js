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

  // 429 must stand alone as a token (HTTP status, "Error 429", "code 429") —
  // a bare "429" substring matched unrelated numbers in paths/timestamps and
  // produced false rate-limit cards (operator report 2026-10-23). Real
  // rate-limit phrasing still matches on its own.
  if (
    (/\b429\b/.test(t) || /rate.?limit|too many requests|slow down/i.test(t)) &&
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

  // Model-server failures (2026-11-21 incident review): 404 model-not-found,
  // 503 model-load and 400 context-overflow are NON-transient — retrying the
  // same turn against the same model just burns dispatch slots. They get
  // dedicated cards with one-click actions instead of a retry loop.
  if (
    (/\b404\b/.test(t) && /model/i.test(t)) ||
    /model.?not.?found|no endpoints found for model|model .{0,40}does not exist/i.test(t)
  ) {
    return {
      kind: 'model_missing',
      title: 'Model not available on this endpoint',
      summary: 'The provider answered 404 — the configured model id does not exist on this endpoint (or was renamed/removed).',
      fix: 'Pick a valid model for this agent in the agent rail (one-click "Switch model" on this card), then run the agent again.',
    };
  }
  if (
    /\b503\b/.test(t) && /model|load/i.test(t) ||
    /model.?load|failed to load model|model is loading/i.test(t)
  ) {
    return {
      kind: 'model_load',
      title: 'Model server could not load the model',
      summary: 'The model server answered 503 — it could not load the model right now (often local Ollama still loading, or the model was unloaded).',
      fix: 'Check the model server (e.g. ollama list / logs), then run the agent again. No automatic retry — this failure is not transient.',
    };
  }
  if (
    /context (length|window|overflow)|maximum context|too many tokens|token limit|input length exceeds|prompt is too long/i.test(t)
  ) {
    return {
      kind: 'context_overflow',
      title: 'Conversation too long for the model (context overflow)',
      summary: 'The provider rejected the request with 400 — the conversation history no longer fits the model context window.',
      fix: 'The hub auto-compacts the conversation history and retries once. If it recurs, start a fresh conversation or switch to a larger-context model.',
    };
  }
  if (/unknown model|couldn't set model|invalid model/i.test(t)) {
    return {
      kind: 'model',
      title: 'LLM model rejected',
      summary: 'The configured model id is not accepted by the provider.',
      fix: 'Pick a valid model in the agent rail (provider catalog in cli.json) and retry.',
    };
  }

  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|fetch failed|socket hang up|connection error/i.test(t)) {
    return {
      kind: 'network',
      title: 'LLM API network error',
      summary: 'Could not reach the model provider.',
      fix: 'Check network/DNS/firewall from the hub host, then retry.',
    };
  }

  // Provider flakiness (2026-11-21 incident review): malformed / truncated
  // model responses are transient — the provider rotates to the next one
  // instead of retry-looping the same endpoint.
  if (/parse error|invalid json|unexpected (token|end of json)|malformed|failed to parse|unexpected character/i.test(t)) {
    return {
      kind: 'parse',
      title: 'Provider returned a malformed response',
      summary: 'The model server answered, but the response could not be parsed (truncated or invalid output).',
      fix: 'Transient — dispatch automatically rotates to the next configured provider. If one provider keeps failing, check its status page.',
    };
  }

  return null;
}

/**
 * Kinds that must NOT be auto-retried (2026-11-21 incident review): retrying
 * the same turn against the same broken model / missing key / oversized
 * history only burns dispatch slots. These hold the mail and surface an
 * actionable card instead of entering the failure-backoff ladder.
 */
const NON_TRANSIENT_KINDS = ['model_missing', 'model_load', 'context_overflow', 'auth'];

function isNonTransientKind(kind) {
  return NON_TRANSIENT_KINDS.includes(String(kind || ''));
}

/**
 * Kinds treated as transient provider flakiness: the dispatch rotates to the
 * next configured provider and only escalates to an operator card after N
 * consecutive failures (single blips stay log-only).
 */
const TRANSIENT_KINDS = ['rate_limit', 'network', 'parse'];

function isTransientKind(kind) {
  return TRANSIENT_KINDS.includes(String(kind || ''));
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
  isNonTransientKind,
  isTransientKind,
  NON_TRANSIENT_KINDS,
  TRANSIENT_KINDS,
};
