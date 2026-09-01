/**
 * OpenAI-compatible provider catalog (defaults).
 * cli.json is the hub source of truth; --base-url / --provider override these.
 */

const PROVIDERS = {
  grok: {
    baseURL: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    defaultModel: "grok-4.5",
  },
  xai: {
    baseURL: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    defaultModel: "grok-4.5",
  },
  chatgpt: {
    baseURL: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
  },
  claude: {
    // Anthropic's official OpenAI SDK compatibility layer
    baseURL: "https://api.anthropic.com/v1/",
    keyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-6",
  },
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    keyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
  },
  venice: {
    baseURL: "https://api.venice.ai/api/v1",
    keyEnv: "VENICE_API_KEY",
    defaultModel: "llama-3.3-70b",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4",
  },
  ollama: {
    baseURL: "http://127.0.0.1:11434/v1",
    keyEnv: "OLLAMA_API_KEY",
    defaultModel: "llama3.2",
    optionalKey: true,
    fallbackKey: "ollama",
  },
};

function listProviders() {
  return ["grok", "chatgpt", "claude", "gemini", "venice", "ollama"];
}

/**
 * Resolve provider connection settings.
 * @param {{ provider?: string, baseURL?: string, apiKey?: string, model?: string }} opts
 */
function resolveProvider(opts = {}) {
  const name = String(
    opts.provider || process.env.BIZAGENT_AGENT_PROVIDER || "",
  )
    .trim()
    .toLowerCase();

  let base = (name && PROVIDERS[name]) || null;

  if (!base && !opts.baseURL && !process.env.BIZAGENT_AGENT_BASE_URL) {
    for (const key of listProviders()) {
      const p = PROVIDERS[key];
      if (process.env[p.keyEnv]) {
        base = p;
        break;
      }
    }
  }
  if (!base) {
    base = PROVIDERS.grok;
  }

  let providerName =
    name && PROVIDERS[name]
      ? name
      : Object.keys(PROVIDERS).find((k) => PROVIDERS[k] === base) || "custom";
  if (providerName === "xai") providerName = "grok";
  if (providerName === "openai") providerName = "chatgpt";

  const baseURL =
    opts.baseURL ||
    process.env.BIZAGENT_AGENT_BASE_URL ||
    base.baseURL;

  const keyEnv = base.keyEnv || "OPENAI_API_KEY";
  let apiKey =
    opts.apiKey ||
    process.env.BIZAGENT_AGENT_API_KEY ||
    process.env[keyEnv] ||
    "";

  // Gemini also accepts GOOGLE_API_KEY
  if (!apiKey && keyEnv === "GEMINI_API_KEY" && process.env.GOOGLE_API_KEY) {
    apiKey = process.env.GOOGLE_API_KEY;
  }

  if (!apiKey && base.optionalKey) {
    apiKey = base.fallbackKey || "local";
  }

  const model = String(
    opts.model || process.env.BIZAGENT_AGENT_MODEL || "",
  ).trim();
  if (!model) {
    // Fail-clear: never silently fall back to a hardcoded provider default
    // (e.g. Venice llama-3.3-70b) while the hub UI shows a different model.
    throw new Error(
      "Model is required: pass --model / -m, or set BIZAGENT_AGENT_MODEL. " +
        "Hub operators: set settings.models.agent_default or a per-product " +
        "model in registry.json (hub: settings.hub_agent.model).",
    );
  }

  return {
    provider: providerName,
    baseURL,
    apiKey,
    model,
    keyEnv,
  };
}

module.exports = {
  PROVIDERS,
  listProviders,
  resolveProvider,
};
