const fs = require("fs");
const path = require("path");

/** Fixed agent binary — only runtime BizAgent launches. */
const RUNTIME_DEFAULTS = {
  executable: "scripts/bizagent-agent",
  promptFlag: "-f",
  flags: { extra: "-y" },
};

/**
 * Map legacy vendor-CLI catalog names (pre provider-only) → provider keys.
 */
const LEGACY_CLI_TO_PROVIDER = {
  "bizagent-agent": "",
  // Old coding-CLI names → LLM brands
  codex: "chatgpt",
  openai: "chatgpt",
  agy: "gemini",
  xai: "grok",
  openrouter: "claude",
  // Identity
  grok: "grok",
  chatgpt: "chatgpt",
  claude: "claude",
  gemini: "gemini",
  venice: "venice",
  ollama: "ollama",
};

/** Installer / fallback provider catalog (mirrors cli.json.example without _runtime). */
const PROVIDER_CATALOG = {
  grok: {
    label: "Grok",
    baseURL: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    models: ["grok-4.5"],
  },
  chatgpt: {
    label: "ChatGPT",
    baseURL: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    models: ["gpt-5.4", "gpt-5.4-mini", "gpt-4o"],
  },
  claude: {
    label: "Claude",
    // Anthropic OpenAI SDK compatibility layer (chat.completions + tools).
    baseURL: "https://api.anthropic.com/v1/",
    keyEnv: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-4-6", "claude-opus-5", "claude-sonnet-4"],
  },
  gemini: {
    label: "Gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    keyEnv: "GEMINI_API_KEY",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  },
  venice: {
    label: "Venice",
    baseURL: "https://api.venice.ai/api/v1",
    keyEnv: "VENICE_API_KEY",
    models: ["llama-3.3-70b", "kimi-k2-7-code"],
  },
  ollama: {
    label: "Ollama (local)",
    baseURL: "http://127.0.0.1:11434/v1",
    keyEnv: "OLLAMA_API_KEY",
    optionalKey: true,
    models: ["llama3.2"],
  },
};

// Back-compat name used in older tests/docs.
const CLI_CATALOG = {
  _runtime: { ...RUNTIME_DEFAULTS },
  ...PROVIDER_CATALOG,
};

const CLI_HEADLESS_DEFAULTS = {
  "bizagent-agent": { promptFlag: "-f", extraArgs: "-y" },
};

function cliJsonFile(hub) {
  return path.join(hub, "cli.json");
}

function loadCliJson(hub) {
  try {
    return JSON.parse(fs.readFileSync(cliJsonFile(hub), "utf8"));
  } catch (_err) {
    return {};
  }
}

function cliJsonMtimeMs(hub) {
  try {
    return fs.statSync(cliJsonFile(hub)).mtimeMs;
  } catch (_err) {
    return 0;
  }
}

function basenameCli(executable) {
  const base = String(executable || "")
    .split(/[/\\]/)
    .pop() || "";
  return base.replace(/\.exe$/i, "");
}

/** All non-meta object entries in cli.json (includes providers; may include legacy CLI shapes). */
function cliJsonEntries(cliJson) {
  if (!cliJson || typeof cliJson !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(cliJson)) {
    if (k.startsWith("_")) continue;
    if (v && typeof v === "object") out[k] = v;
  }
  return out;
}

function isProviderEntry(def) {
  if (!def || typeof def !== "object") return false;
  return !!(def.baseURL || def.baseUrl || def.keyEnv || Array.isArray(def.models));
}

/** Provider keys only (excludes pure legacy CLI engine blocks without baseURL). */
function providerEntries(cliJson) {
  const entries = cliJsonEntries(cliJson);
  const out = {};
  for (const [k, v] of Object.entries(entries)) {
    if (isProviderEntry(v)) out[k] = v;
  }
  // Fall back to built-in providers only when cli.json is missing/empty.
  if (Object.keys(out).length === 0) {
    const keys = cliJson && typeof cliJson === "object" ? Object.keys(cliJson) : [];
    if (keys.length === 0) {
      return { ...PROVIDER_CATALOG };
    }
  }
  return out;
}

function getRuntimeDef(cliJson) {
  const rt = cliJson && cliJson._runtime;
  if (rt && typeof rt === "object") {
    return {
      executable: rt.executable || RUNTIME_DEFAULTS.executable,
      promptFlag: rt.promptFlag || rt.prompt || RUNTIME_DEFAULTS.promptFlag,
      flags: rt.flags || RUNTIME_DEFAULTS.flags,
      extraArgs: rt.extraArgs,
    };
  }
  // Legacy: if bizagent-agent entry exists as executable block
  const ba = cliJson && cliJson["bizagent-agent"];
  if (ba && ba.executable) {
    return {
      executable: ba.executable,
      promptFlag: ba.promptFlag || "-f",
      flags: ba.flags || { extra: "-y" },
      extraArgs: ba.extraArgs,
    };
  }
  return { ...RUNTIME_DEFAULTS };
}

/**
 * Normalize a registry cliName/provider string to a provider key.
 */
function resolveProviderName(raw, cliJson) {
  let name = String(raw || "").trim();
  if (!name) return "";

  if (Object.prototype.hasOwnProperty.call(LEGACY_CLI_TO_PROVIDER, name)) {
    const mapped = LEGACY_CLI_TO_PROVIDER[name];
    name = mapped || "";
  }

  const providers = providerEntries(cliJson);
  if (name && providers[name]) return name;

  // basename path-style leftovers
  const base = basenameCli(name);
  if (base && providers[base]) return base;
  if (Object.prototype.hasOwnProperty.call(LEGACY_CLI_TO_PROVIDER, base)) {
    const mapped = LEGACY_CLI_TO_PROVIDER[base];
    if (mapped && providers[mapped]) return mapped;
  }

  return name;
}

/**
 * Look up a provider definition. Throws if missing.
 * @returns {{ key: string, def: object }}
 */
function requireCliDef(cliJson, requestedName) {
  const providers = providerEntries(cliJson);
  const names = Object.keys(providers);
  if (names.length === 0) {
    throw new Error(
      "cli.json has no LLM providers. Restore cli.json from cli.json.example " +
        "(keys are providers like grok, openai, venice).",
    );
  }
  const requested = String(requestedName || "").trim();
  if (!requested) {
    throw new Error(
      "Provider is empty — set settings.hub_agent.provider (or product provider) in registry.json.",
    );
  }
  const key = resolveProviderName(requested, cliJson) || requested;
  if (providers[key]) return { key, def: providers[key] };
  throw new Error(
    `cli.json has no provider "${requested}". ` +
      `Add it to cli.json or fix registry provider / hub_agent.provider. ` +
      `Configured: ${names.join(", ")}`,
  );
}

/**
 * Resolve launch settings: always bizagent-agent + provider/model flags.
 *
 * @param {string} hub
 * @param {object} cliJson
 * @param {object} cliFileSettings - config with hubCliName / hubProvider / cli
 * @param {string} providerName - product provider (or legacy cliName)
 * @param {string} modelOverride
 */
function getCliSettings(hub, cliJson, cliFileSettings, providerName = "", modelOverride = "") {
  const file = cliFileSettings || {};
  const hubProvider =
    file.hubProvider ||
    file.hubCliName ||
    file.cli ||
    "";
  const raw =
    (providerName && String(providerName).trim()) ||
    String(hubProvider || "").trim();

  if (!raw) {
    throw new Error(
      "Provider is empty — set settings.hub_agent.provider in registry.json " +
        "(or product provider). Installer writes this.",
    );
  }

  const { key: provider, def: providerDef } = requireCliDef(cliJson, raw);
  const runtime = getRuntimeDef(cliJson);

  const executable =
    process.env.BIZAGENT_CLI ||
    runtime.executable ||
    RUNTIME_DEFAULTS.executable;

  let promptFlag =
    process.env.BIZAGENT_CLI_PROMPT_FLAG ||
    runtime.promptFlag ||
    RUNTIME_DEFAULTS.promptFlag;
  if (!promptFlag) {
    throw new Error("cli.json _runtime is missing promptFlag (expected -f)");
  }

  let baseArgs = "";
  if (process.env.BIZAGENT_CLI_EXTRA_ARGS) {
    baseArgs = process.env.BIZAGENT_CLI_EXTRA_ARGS;
  } else if (runtime.flags && Object.prototype.hasOwnProperty.call(runtime.flags, "extra")) {
    baseArgs = runtime.flags.extra || "";
  } else if (runtime.extraArgs != null) {
    baseArgs = String(runtime.extraArgs);
  } else {
    baseArgs = "-y";
  }

  // Ensure auto-approve for headless dispatch.
  if (!/(^|\s)-y(\s|$)/.test(baseArgs) && !/(^|\s)--yes(\s|$)/.test(baseArgs)) {
    baseArgs = `${baseArgs} -y`.trim();
  }

  // Strip any prior provider/model/base-url before re-adding.
  baseArgs = baseArgs
    .replace(/--provider[= ]\S+/g, "")
    .replace(/--base-url[= ]\S+/g, "")
    .replace(/--model[= ]\S+/g, "")
    .replace(/-m[= ]\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const parts = [baseArgs, `--provider ${provider}`].filter(Boolean);
  const baseURL = providerDef.baseURL || providerDef.baseUrl || "";
  if (baseURL) {
    if (!/^[A-Za-z0-9._:~/%+=@-]+$/.test(baseURL)) {
      throw new Error(`Invalid provider baseURL for ${provider}`);
    }
    parts.push(`--base-url ${baseURL}`);
  }

  if (modelOverride) {
    if (!/^[A-Za-z0-9._:/-]+$/.test(modelOverride)) {
      throw new Error(`Invalid model name: ${modelOverride}`);
    }
    parts.push(`--model ${modelOverride}`);
  }

  const extraArgs = parts.join(" ").replace(/\s{2,}/g, " ").trim();

  return {
    cli: executable,
    promptFlag,
    extraArgs,
    cliName: provider,
    provider,
    baseURL,
    keyEnv: providerDef.keyEnv || "",
  };
}

function compileAgentCommand(cliSettings, promptFilePath) {
  const { cli, promptFlag, extraArgs } = cliSettings;

  if (!promptFilePath) {
    throw new Error("Missing prompt file path");
  }

  // Match dispatcher shell order: cli, promptFlag, promptFile, extra
  const parts = [cli, promptFlag, promptFilePath];
  if (extraArgs) parts.push(extraArgs);
  return parts.join(" ");
}

module.exports = {
  CLI_CATALOG,
  CLI_HEADLESS_DEFAULTS,
  LEGACY_CLI_TO_PROVIDER,
  PROVIDER_CATALOG,
  RUNTIME_DEFAULTS,
  basenameCli,
  cliJsonEntries,
  cliJsonFile,
  cliJsonMtimeMs,
  compileAgentCommand,
  getCliSettings,
  getRuntimeDef,
  isProviderEntry,
  loadCliJson,
  providerEntries,
  requireCliDef,
  resolveProviderName,
};
