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

function getCliSettings(hub, cliJson, cliFileSettings, cliName = "", modelOverride = "") {
  const cliName_ = cliName || cliFileSettings.cli || "claude";
  const cliDef = cliJson[cliName_] || {};

  const executable = process.env.BIZAGENT_CLI || cliDef.executable || cliFileSettings.cli || cliName_;
  const promptFlag = process.env.BIZAGENT_CLI_PROMPT_FLAG || cliDef.prompt || cliFileSettings.promptFlag || "-p";

  // Build extraArgs from cliDef.flags, .cli file, and env vars; apply model override
  let baseArgs = process.env.BIZAGENT_CLI_EXTRA_ARGS || cliDef.flags?.extra || cliFileSettings.extraArgs || "";
  let extraArgs = baseArgs;
  if (modelOverride) {
    if (!/^[A-Za-z0-9._:-]+$/.test(modelOverride)) {
      throw new Error(`Invalid model name: ${modelOverride}`);
    }
    const stripped = baseArgs
      .replace(/--model[= ]\S+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    extraArgs = stripped ? `${stripped} --model ${modelOverride}` : `--model ${modelOverride}`;
  }

  return { cli: executable, promptFlag, extraArgs };
}

function compileAgentCommand(cliSettings, promptFilePath) {
  const { cli, promptFlag, extraArgs } = cliSettings;

  if (!promptFilePath) {
    throw new Error("Missing prompt file path");
  }

  const parts = [cli];
  if (extraArgs) {
    parts.push(extraArgs);
  }
  parts.push(promptFlag, promptFilePath);
  return parts.join(" ");
}

module.exports = {
  cliJsonFile,
  cliJsonMtimeMs,
  compileAgentCommand,
  getCliSettings,
  loadCliJson,
};
