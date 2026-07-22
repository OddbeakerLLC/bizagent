const fs = require("fs");
const path = require("path");
const { cliJsonMtimeMs, loadCliJson } = require("./cli-config");

function hubPath(input) {
  return path.resolve(
    input || process.env.BIZAGENT_HUB || path.join(__dirname, "..", ".."),
  );
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_err) {
    return fallback;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function registryFile(hub) {
  return path.join(hub, "registry.json");
}

function loadRegistry(hub) {
  return readJson(registryFile(hub), {
    settings: {},
    products: [],
  });
}

function registryMtimeMs(hub) {
  try {
    return fs.statSync(registryFile(hub)).mtimeMs;
  } catch (_err) {
    return 0;
  }
}

function cliFile(hub) {
  return path.join(hub, ".cli");
}

function readCliFile(hub) {
  const file = cliFile(hub);
  const result = {};
  if (!fs.existsSync(file)) return result;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) result[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return result;
}

function cliMtimeMs(hub) {
  try {
    return fs.statSync(cliFile(hub)).mtimeMs;
  } catch (_err) {
    return 0;
  }
}

// CLI-launch fields derived from cli.json and .cli file (with env-var overrides).
// Kept in a function so a long-running process can re-derive them when either
// file changes on disk, without a restart. See refreshCliConfig().
function deriveCliSettings(cli, cliJson) {
  const globalCliJson = cliJson || {};
  return {
    cli:
      process.env.BIZAGENT_CLI ||
      globalCliJson.cli ||
      cli.CLI ||
      cli.CLI_CMD ||
      "claude",
    promptFlag:
      process.env.BIZAGENT_CLI_PROMPT_FLAG ||
      globalCliJson.promptFlag ||
      cli.CLI_PROMPT_FLAG ||
      "-p",
    extraArgs:
      process.env.BIZAGENT_CLI_EXTRA_ARGS ||
      globalCliJson.flags?.extra ||
      globalCliJson.extraArgs ||
      (cli.CLI_EXTRA_ARGS !== undefined
        ? cli.CLI_EXTRA_ARGS
        : cli.CLI_YOLO_FLAG) ||
      "",
  };
}

// Fields derived from registry.json that should stay in sync with the file
// on disk for the lifetime of a long-running process (e.g. the control-plane
// server), without requiring a process restart. See refreshRegistry().
function deriveRegistrySettings(registry) {
  const dispatch = (registry.settings && registry.settings.dispatch) || {};
  const hubAgent = (registry.settings && registry.settings.hub_agent) || {};
  const models = (registry.settings && registry.settings.models) || {};

  return {
    maxConcurrency: Number(
      process.env.BIZAGENT_MAX_CONCURRENCY || dispatch.max_concurrency || 4,
    ),
    lockLeaseSecs: Number(
      process.env.BIZAGENT_LOCK_LEASE_SECS || dispatch.lock_lease_secs || 1800,
    ),
    hubModel:
      process.env.BIZAGENT_HUB_MODEL ||
      hubAgent.model ||
      models.orchestrator ||
      "",
    // Same resolution as product agents: cliName preferred, legacy `cli` string accepted.
    hubCliName:
      process.env.BIZAGENT_HUB_CLI ||
      hubAgent.cliName ||
      (typeof hubAgent.cli === "string" ? hubAgent.cli : "") ||
      "",
    agentDefaultModel:
      process.env.BIZAGENT_AGENT_DEFAULT_MODEL || models.agent_default || "",
  };
}

function loadRuntimeConfig(hubInput) {
  const hub = hubPath(hubInput);
  // Read the mtime before the content so a concurrent edit can only make us
  // reload again on the next refresh, never miss a change (see refreshRegistry).
  const registryMtime = registryMtimeMs(hub);
  const registry = loadRegistry(hub);
  const cliMtime = cliMtimeMs(hub);
  const cliJsonMtime = cliJsonMtimeMs(hub);
  const cliJson = loadCliJson(hub);
  const cliSettings = deriveCliSettings(readCliFile(hub), cliJson);
  const port = Number(
    process.env.BIZAGENT_PORT ||
      (registry.settings &&
        registry.settings.control_plane &&
        registry.settings.control_plane.port) ||
      8787,
  );
  const host =
    process.env.BIZAGENT_HOST ||
    (registry.settings &&
      registry.settings.control_plane &&
      registry.settings.control_plane.host) ||
    "0.0.0.0";

  return {
    hub,
    registry,
    ...cliSettings,
    port,
    host,
    dryRun: process.env.BIZAGENT_DRY_RUN === "1",
    ...deriveRegistrySettings(registry),
    _registryMtimeMs: registryMtime,
    _cliMtimeMs: cliMtime,
    _cliJsonMtimeMs: cliJsonMtime,
    _cliJson: cliJson,
  };
}

// Re-reads registry.json when it has changed on disk and refreshes the
// registry-derived fields on `config` in place. Cheap to call on every API
// request or dispatch tick (a single stat call) so long-running processes
// (the control-plane server) pick up newly added agents, dispatch settings,
// and model overrides without a restart.
function refreshRegistry(config) {
  const mtimeMs = registryMtimeMs(config.hub);
  if (mtimeMs === config._registryMtimeMs) return config;
  config._registryMtimeMs = mtimeMs;
  config.registry = loadRegistry(config.hub);
  Object.assign(config, deriveRegistrySettings(config.registry));
  return config;
}

// Re-reads .cli and cli.json when either has changed on disk and refreshes
// the CLI-launch fields (cli, promptFlag, extraArgs) on `config` in place.
// Cheap to call on every tick (a single stat call) so the control-plane server
// picks up CLI command/flag/permission changes without a restart.
function refreshCliConfig(config) {
  const cliMtime = cliMtimeMs(config.hub);
  const cliJsonMtime = cliJsonMtimeMs(config.hub);
  if (
    cliMtime === config._cliMtimeMs &&
    cliJsonMtime === config._cliJsonMtimeMs
  ) {
    return config;
  }
  config._cliMtimeMs = cliMtime;
  config._cliJsonMtimeMs = cliJsonMtime;
  config._cliJson = loadCliJson(config.hub);
  Object.assign(
    config,
    deriveCliSettings(readCliFile(config.hub), config._cliJson),
  );
  return config;
}

// Picks up both registry.json and .cli edits without a process restart.
function refreshRuntimeConfig(config) {
  refreshRegistry(config);
  refreshCliConfig(config);
  return config;
}

function agentsFromRegistry(registry) {
  return (registry.products || [])
    .map((product) => ({
      slug: product.slug,
      name: product.name || product.slug,
      agentName: product.agent_name || product.name || product.slug,
      model: product.model || "",
      cliName: product.cliName || product.cli || "claude",
    }))
    .filter((agent) => agent.slug);
}

function appDir(hub) {
  return path.join(hub, ".bizagent");
}

module.exports = {
  appDir,
  agentsFromRegistry,
  ensureDir,
  hubPath,
  loadCliJson,
  loadRegistry,
  loadRuntimeConfig,
  readJson,
  refreshCliConfig,
  refreshRegistry,
  refreshRuntimeConfig,
  registryMtimeMs,
};
