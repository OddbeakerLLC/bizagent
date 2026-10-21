const fs = require("fs");
const path = require("path");
const { cliJsonMtimeMs, loadCliJson } = require("./cli-config");

function hubPath(input) {
  return path.resolve(
    input || process.env.BIZAGENT_HUB || path.join(__dirname, "..", ".."),
  );
}

/**
 * Load KEY=value pairs from hub/.bizagent/env into process.env.
 * Does not override vars already set in the environment.
 * Safe for secrets: never logs values. Returns how many keys were applied.
 */
function loadHubEnv(hub) {
  const envFile = path.join(hubPath(hub), ".bizagent", "env");
  let applied = 0;
  try {
    if (!fs.existsSync(envFile)) return { applied, path: envFile, found: false };
    const text = fs.readFileSync(envFile, "utf8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // Strip optional surrounding quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = val;
        applied += 1;
      }
    }
    return { applied, path: envFile, found: true };
  } catch (_err) {
    return { applied: 0, path: envFile, found: false, error: _err.message };
  }
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

/** Atomic-ish registry write (temp + rename). Preserves formatting with trailing newline. */
function writeRegistry(hub, registry) {
  const file = registryFile(hub);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(registry, null, 2)}\n`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
  return registry;
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

/**
 * Basename of a CLI command (path-safe). Local to config to avoid circular requires.
 */
function cliBasename(name) {
  const base = String(name || "")
    .split(/[/\\]/)
    .pop() || "";
  return base.replace(/\.exe$/i, "");
}

/**
 * Hub default **provider** (LLM) name.
 * Priority: env → hub_agent.provider → hub_agent.cliName (legacy) → legacy .cli CLI_CMD.
 */
function resolveHubCliName(registry, legacyCliFile = {}) {
  const hubAgent =
    (registry && registry.settings && registry.settings.hub_agent) || {};
  const fromRegistry =
    hubAgent.provider ||
    hubAgent.cliName ||
    (typeof hubAgent.cli === "string" ? hubAgent.cli : "") ||
    "";
  const fromLegacy = cliBasename(
    legacyCliFile.CLI_CMD || legacyCliFile.CLI || "",
  );
  return (
    process.env.BIZAGENT_HUB_PROVIDER ||
    process.env.BIZAGENT_HUB_CLI ||
    String(fromRegistry || "").trim() ||
    fromLegacy ||
    ""
  );
}

/**
 * Apply hub provider onto config after registry / .cli reloads.
 * hubCliName / hubProvider / cli are the same provider key (legacy field names kept).
 */
function applyHubCliName(config) {
  const legacy = readCliFile(config.hub);
  const name = resolveHubCliName(config.registry || {}, legacy);
  config.hubCliName = name;
  config.hubProvider = name;
  // getCliSettings falls back to config.cli when product provider is empty.
  config.cli = name;
  const hubAgent = ((config.registry || {}).settings || {}).hub_agent || {};
  config._hubCliFromLegacyDotCli = !!(
    name &&
    legacy.CLI_CMD &&
    !hubAgent.provider &&
    !hubAgent.cliName
  );
  return config;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// Fields derived from registry.json that should stay in sync with the file
// on disk for the lifetime of a long-running process (e.g. the control-plane
// server), without requiring a process restart. See refreshRegistry().
function deriveRegistrySettings(registry) {
  const dispatch = (registry.settings && registry.settings.dispatch) || {};
  const hubAgent = (registry.settings && registry.settings.hub_agent) || {};
  const models = (registry.settings && registry.settings.models) || {};

  // Poll interval: honor settings.dispatch.poll_seconds (was ignored; server hard-coded 2s).
  // Clamp 1–30s. Default 2. Env BIZAGENT_POLL_SECONDS wins when set.
  const pollSeconds = clampInt(
    process.env.BIZAGENT_POLL_SECONDS || dispatch.poll_seconds || 2,
    1,
    30,
    2,
  );

  // Concurrency tiers (Phase 2): hub and product agents have separate slot pools
  // so a long hub turn does not starve a multi-agent fanout (and vice versa).
  // max_concurrency remains the product-agent pool size (default raised 4 → 8).
  // agent_slots overrides that when set; hub_slots defaults to 1.
  const maxConcurrency = clampInt(
    process.env.BIZAGENT_MAX_CONCURRENCY || dispatch.max_concurrency || 8,
    1,
    32,
    8,
  );
  const hubSlots = clampInt(
    process.env.BIZAGENT_HUB_SLOTS || dispatch.hub_slots || 1,
    1,
    4,
    1,
  );
  const agentSlots = clampInt(
    process.env.BIZAGENT_AGENT_SLOTS || dispatch.agent_slots || maxConcurrency,
    1,
    32,
    maxConcurrency,
  );

  return {
    pollSeconds,
    maxConcurrency,
    hubSlots,
    agentSlots,
    lockLeaseSecs: clampInt(
      process.env.BIZAGENT_LOCK_LEASE_SECS || dispatch.lock_lease_secs || 1800,
      60,
      86400,
      1800,
    ),
    hubModel:
      process.env.BIZAGENT_HUB_MODEL ||
      hubAgent.model ||
      models.orchestrator ||
      "",
    // LLM provider key in cli.json (runtime is always bizagent-agent).
    hubCliName:
      process.env.BIZAGENT_HUB_PROVIDER ||
      process.env.BIZAGENT_HUB_CLI ||
      hubAgent.provider ||
      hubAgent.cliName ||
      (typeof hubAgent.cli === "string" ? hubAgent.cli : "") ||
      "",
    hubProvider:
      process.env.BIZAGENT_HUB_PROVIDER ||
      process.env.BIZAGENT_HUB_CLI ||
      hubAgent.provider ||
      hubAgent.cliName ||
      (typeof hubAgent.cli === "string" ? hubAgent.cli : "") ||
      "",
    agentDefaultModel:
      process.env.BIZAGENT_AGENT_DEFAULT_MODEL || models.agent_default || "",
  };
}

function loadRuntimeConfig(hubInput) {
  const hub = hubPath(hubInput);
  // Load .bizagent/env into process.env so CLI children inherit API keys.
  loadHubEnv(hub);
  // Read the mtime before the content so a concurrent edit can only make us
  // reload again on the next refresh, never miss a change (see refreshRegistry).
  const registryMtime = registryMtimeMs(hub);
  const registry = loadRegistry(hub);
  const cliMtime = cliMtimeMs(hub);
  const cliJsonMtime = cliJsonMtimeMs(hub);
  const cliJson = loadCliJson(hub);
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

  const config = {
    hub,
    registry,
    port,
    host,
    dryRun: process.env.BIZAGENT_DRY_RUN === "1",
    ...deriveRegistrySettings(registry),
    _registryMtimeMs: registryMtime,
    _cliMtimeMs: cliMtime,
    _cliJsonMtimeMs: cliJsonMtime,
    _cliJson: cliJson,
  };
  applyHubCliName(config);
  return config;
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
  applyHubCliName(config);
  return config;
}

// Re-reads cli.json and legacy .cli when either has changed on disk.
// cli.json holds engine flags; .cli is migration-only for hub CLI *name*.
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
  applyHubCliName(config);
  return config;
}

// Picks up registry.json, cli.json, and legacy .cli edits without a restart.
function refreshRuntimeConfig(config) {
  refreshRegistry(config);
  refreshCliConfig(config);
  return config;
}

/** Expand leading ~ to $HOME. */
function expandUserPath(projectPath) {
  const s = String(projectPath || "");
  if (s === "~") return process.env.HOME || s;
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    return path.join(process.env.HOME || "", s.slice(2));
  }
  return s;
}

/**
 * Resolve a registry project path relative to the hub root.
 * Absolute paths and ~/… are preserved after expansion.
 */
function resolveProjectPath(hub, projectPath) {
  const expanded = expandUserPath(projectPath);
  if (!expanded) return "";
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  if (!hub) return path.resolve(expanded);
  return path.resolve(hub, expanded);
}

/**
 * True when `absPath` is a git working tree (`.git` dir or worktree file).
 * Nested monorepo subfolders without their own .git are not projects.
 */
function isGitWorkTree(absPath) {
  if (!absPath) return false;
  try {
    const gitPath = path.join(absPath, ".git");
    const st = fs.lstatSync(gitPath);
    return st.isDirectory() || st.isFile();
  } catch (_err) {
    return false;
  }
}

/**
 * A UI "project" is a git-backed directory:
 * - has a non-empty `remote` (cloneable / deferred), or
 * - the path on disk is its own git work tree.
 * Subdirectories of a monorepo that are not separate repos are excluded.
 */
function isGitBackedProject(hub, project) {
  if (!project || typeof project !== "object") return false;
  if (String(project.remote || "").trim()) return true;
  return isGitWorkTree(resolveProjectPath(hub, project.path));
}

function projectSummaries(projects, hub = "") {
  if (!Array.isArray(projects)) return [];
  return projects
    .map((p) => {
      if (!p || typeof p !== "object") return null;
      const name = String(p.name || "").trim();
      if (!name) return null;
      if (!isGitBackedProject(hub, p)) return null;
      return {
        name,
        path: String(p.path || ""),
        remote: String(p.remote || ""),
      };
    })
    .filter(Boolean);
}

function productProvider(product) {
  if (!product || typeof product !== "object") return "";
  return String(product.provider || product.cliName || product.cli || "").trim();
}

function agentsFromRegistry(registry, hub = "") {
  return (registry.products || [])
    .map((product) => {
      const provider = productProvider(product);
      return {
        slug: product.slug,
        name: product.name || product.slug,
        agentName: product.agent_name || product.name || product.slug,
        model: product.model || "",
        // provider is primary; cliName kept as alias for older UI/API clients.
        provider,
        cliName: provider,
        projects: projectSummaries(product.projects, hub),
      };
    })
    .filter((agent) => agent.slug);
}

/**
 * Update hub or product agent provider/model in registry.json.
 * @param {string} hub
 * @param {string} slug - "hub" or a product slug
 * @param {{ provider?: string, cliName?: string, model?: string }} patch
 *   cliName is accepted as an alias for provider (legacy API body).
 */
function updateAgentConfig(hub, slug, patch = {}) {
  const cleanSlug = String(slug || "").trim();
  if (!cleanSlug || !/^[a-zA-Z0-9._-]+$/.test(cleanSlug)) {
    throw new Error("invalid agent slug");
  }

  const nextProviderRaw =
    patch.provider !== undefined && patch.provider !== null
      ? String(patch.provider).trim()
      : patch.cliName !== undefined && patch.cliName !== null
        ? String(patch.cliName).trim()
        : undefined;
  const nextModel =
    patch.model !== undefined && patch.model !== null
      ? String(patch.model).trim()
      : undefined;

  if (nextProviderRaw !== undefined) {
    if (!nextProviderRaw) throw new Error("provider is required");
    if (!/^[A-Za-z0-9._-]+$/.test(nextProviderRaw)) {
      throw new Error(`Invalid provider name: ${nextProviderRaw}`);
    }
  }
  if (nextModel !== undefined) {
    if (nextModel && !/^[A-Za-z0-9._:/-]+$/.test(nextModel)) {
      throw new Error(`Invalid model name: ${nextModel}`);
    }
  }
  if (nextProviderRaw === undefined && nextModel === undefined) {
    throw new Error("provide provider and/or model");
  }

  const registry = loadRegistry(hub);

  if (cleanSlug === "hub") {
    registry.settings = registry.settings || {};
    registry.settings.hub_agent = registry.settings.hub_agent || {};
    if (nextProviderRaw !== undefined) {
      registry.settings.hub_agent.provider = nextProviderRaw;
      // Keep cliName in sync for older readers; value is the provider key.
      registry.settings.hub_agent.cliName = nextProviderRaw;
    }
    if (nextModel !== undefined) registry.settings.hub_agent.model = nextModel;
    writeRegistry(hub, registry);
    const p =
      registry.settings.hub_agent.provider ||
      registry.settings.hub_agent.cliName ||
      "";
    return {
      slug: "hub",
      provider: p,
      cliName: p,
      model: registry.settings.hub_agent.model || "",
    };
  }

  const products = registry.products || [];
  const product = products.find((p) => p && p.slug === cleanSlug);
  if (!product) throw new Error(`agent not found: ${cleanSlug}`);
  if (nextProviderRaw !== undefined) {
    product.provider = nextProviderRaw;
    product.cliName = nextProviderRaw;
  }
  if (nextModel !== undefined) product.model = nextModel;
  // Drop legacy inline cli object if present.
  if (Object.prototype.hasOwnProperty.call(product, "cli") && typeof product.cli !== "string") {
    delete product.cli;
  }
  writeRegistry(hub, registry);
  const p = productProvider(product);
  return {
    slug: cleanSlug,
    provider: p,
    cliName: p,
    model: product.model || "",
  };
}

function appDir(hub) {
  return path.join(hub, ".bizagent");
}

module.exports = {
  appDir,
  agentsFromRegistry,
  applyHubCliName,
  ensureDir,
  hubPath,
  loadCliJson,
  loadHubEnv,
  loadRegistry,
  loadRuntimeConfig,
  expandUserPath,
  isGitBackedProject,
  isGitWorkTree,
  projectSummaries,
  readCliFile,
  readJson,
  refreshCliConfig,
  refreshRegistry,
  refreshRuntimeConfig,
  resolveProjectPath,
  updateAgentConfig,
  writeRegistry,
  registryMtimeMs,
  resolveHubCliName,
};
