const fs = require('fs');
const path = require('path');

function hubPath(input) {
  return path.resolve(input || process.env.BIZAGENT_HUB || path.join(__dirname, '..', '..'));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return fallback;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadRegistry(hub) {
  return readJson(path.join(hub, 'registry.json'), { settings: {}, products: [] });
}

function readCliFile(hub) {
  const file = path.join(hub, '.cli');
  const result = {};
  if (!fs.existsSync(file)) return result;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function loadRuntimeConfig(hubInput) {
  const hub = hubPath(hubInput);
  const registry = loadRegistry(hub);
  const dispatch = (registry.settings && registry.settings.dispatch) || {};
  const cliFile = readCliFile(hub);
  const cli = process.env.BIZAGENT_CLI || cliFile.CLI || cliFile.CLI_CMD || 'claude';
  const promptFlag = process.env.BIZAGENT_CLI_PROMPT_FLAG || cliFile.CLI_PROMPT_FLAG || '-p';
  const extraArgs = process.env.BIZAGENT_CLI_EXTRA_ARGS
    || (cliFile.CLI_EXTRA_ARGS !== undefined ? cliFile.CLI_EXTRA_ARGS : cliFile.CLI_YOLO_FLAG)
    || '';
  const port = Number(process.env.BIZAGENT_PORT || (registry.settings && registry.settings.control_plane && registry.settings.control_plane.port) || 8787);
  const host = process.env.BIZAGENT_HOST || (registry.settings && registry.settings.control_plane && registry.settings.control_plane.host) || '0.0.0.0';

  const hubAgent = (registry.settings && registry.settings.hub_agent) || {};
  const models = (registry.settings && registry.settings.models) || {};

  return {
    hub,
    registry,
    cli,
    promptFlag,
    extraArgs,
    port,
    host,
    maxConcurrency: Number(process.env.BIZAGENT_MAX_CONCURRENCY || dispatch.max_concurrency || 4),
    lockLeaseSecs: Number(process.env.BIZAGENT_LOCK_LEASE_SECS || dispatch.lock_lease_secs || 1800),
    dryRun: process.env.BIZAGENT_DRY_RUN === '1',
    hubModel: process.env.BIZAGENT_HUB_MODEL || hubAgent.model || '',
    agentDefaultModel: process.env.BIZAGENT_AGENT_DEFAULT_MODEL || models.agent_default || '',
  };
}

function agentsFromRegistry(registry) {
  return (registry.products || []).map((product) => ({
    slug: product.slug,
    name: product.name || product.slug,
    agentName: product.agent_name || product.name || product.slug,
    model: product.model || '',
  })).filter((agent) => agent.slug);
}

function appDir(hub) {
  return path.join(hub, '.bizagent');
}

module.exports = {
  appDir,
  agentsFromRegistry,
  ensureDir,
  hubPath,
  loadRegistry,
  loadRuntimeConfig,
  readJson,
};
