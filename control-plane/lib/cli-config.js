const fs = require("fs");
const path = require("path");

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

function getCliSettings(hub, cliJson, cliFileSettings, slug) {
  const bySlug = cliJson[slug] || {};
  const cli = process.env.BIZAGENT_CLI || bySlug.cli || cliFileSettings.cli || "claude";
  const promptFlag =
    process.env.BIZAGENT_CLI_PROMPT_FLAG || bySlug.promptFlag || cliFileSettings.promptFlag || "-p";
  const extraArgs =
    process.env.BIZAGENT_CLI_EXTRA_ARGS ||
    bySlug.flags?.extra ||
    bySlug.extraArgs ||
    cliFileSettings.extraArgs ||
    "";

  return { cli, promptFlag, extraArgs };
}

function compileAgentCommand(cliSettings, promptFilePath) {
  const { cli, promptFlag, extraArgs } = cliSettings;

  if (!promptFilePath) {
    throw new Error("Missing prompt file path");
  }

  const parts = [cli, promptFlag, promptFilePath];
  if (extraArgs) {
    parts.push(extraArgs);
  }
  return parts.join(" ");
}

module.exports = {
  cliJsonFile,
  cliJsonMtimeMs,
  compileAgentCommand,
  getCliSettings,
  loadCliJson,
};
