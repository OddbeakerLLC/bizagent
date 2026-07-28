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

/**
 * Catalog defaults used by the installer to seed cli.json and by tests.
 * Runtime launch does NOT silently invent a CLI that is missing from cli.json.
 */
const CLI_CATALOG = {
  grok: {
    executable: "grok",
    promptFlag: "--prompt-file",
    flags: { extra: "--always-approve" },
  },
  claude: {
    executable: "claude",
    promptFlag: "-p",
    flags: { extra: "--dangerously-skip-permissions" },
  },
  codex: {
    executable: "codex",
    promptFlag: "--prompt",
    flags: { extra: "--full-auto" },
  },
  agy: {
    executable: "agy",
    promptFlag: "-p",
    flags: { extra: "--dangerously-skip-permissions" },
  },
};

// Back-compat export name used in tests.
const CLI_HEADLESS_DEFAULTS = Object.fromEntries(
  Object.entries(CLI_CATALOG).map(([k, v]) => [
    k,
    { promptFlag: v.promptFlag, extraArgs: (v.flags && v.flags.extra) || "" },
  ]),
);

function basenameCli(executable) {
  const base = String(executable || "")
    .split(/[/\\]/)
    .pop() || "";
  return base.replace(/\.exe$/i, "");
}

function cliJsonEntries(cliJson) {
  if (!cliJson || typeof cliJson !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(cliJson)) {
    if (k.startsWith("_")) continue;
    if (v && typeof v === "object") out[k] = v;
  }
  return out;
}

/**
 * Look up a CLI definition in cli.json. Throws if the name is not configured.
 * @returns {{ key: string, def: object }}
 */
function requireCliDef(cliJson, requestedName) {
  const entries = cliJsonEntries(cliJson);
  const names = Object.keys(entries);
  if (names.length === 0) {
    throw new Error(
      "cli.json is missing or empty. Copy cli.json.example → cli.json " +
        "(the installer does this). Every hub CLI and product cliName must be listed there.",
    );
  }
  const requested = String(requestedName || "").trim();
  if (!requested) {
    throw new Error(
      "CLI name is empty — set settings.hub_agent.cliName (or product cliName) in registry.json. " +
        "Legacy .cli is migration-only and is not used for flags.",
    );
  }
  const base = basenameCli(requested);
  if (entries[requested]) return { key: requested, def: entries[requested] };
  if (entries[base]) return { key: base, def: entries[base] };
  throw new Error(
    `cli.json has no entry for CLI "${requested}". ` +
      `Add a "${base}" block (see cli.json.example), or fix registry product cliName / hub_agent.cliName. ` +
      `Configured: ${names.join(", ")}`,
  );
}

/**
 * Resolve CLI launch settings for hub or a product agent.
 *
 * - **Name:** product cliName, else hub settings.hub_agent.cliName (config.cli).
 * - **Flags:** cli.json only (plus env overrides). Never from legacy .cli.
 * - **.cli:** migration-only — config may set hub name from CLI_CMD if registry omits cliName.
 */
function getCliSettings(hub, cliJson, cliFileSettings, cliName = "", modelOverride = "") {
  const file = cliFileSettings || {};
  const hubCli = file.hubCliName || file.cli || "";
  // Named product CLI wins; empty falls back to hub catalog name.
  const requested = (cliName && String(cliName).trim()) || String(hubCli || "").trim();
  if (!requested) {
    throw new Error(
      "CLI name is empty — set settings.hub_agent.cliName in registry.json " +
        "(installer writes this). Product agents may set cliName; empty uses the hub CLI.",
    );
  }

  const { def: cliDef } = requireCliDef(cliJson, requested);

  const executable =
    process.env.BIZAGENT_CLI ||
    cliDef.executable ||
    basenameCli(requested) ||
    requested;

  const exeBase = basenameCli(executable);

  let promptFlag =
    process.env.BIZAGENT_CLI_PROMPT_FLAG ||
    cliDef.promptFlag ||
    cliDef.prompt ||
    "";
  if (!promptFlag) {
    throw new Error(
      `cli.json entry "${basenameCli(requested)}" is missing promptFlag (e.g. -p or --prompt-file)`,
    );
  }

  // Safety net: never pass a file path via grok -p/--single.
  if (exeBase === "grok" && (promptFlag === "-p" || promptFlag === "--single")) {
    promptFlag = "--prompt-file";
  }

  let baseArgs = "";
  if (process.env.BIZAGENT_CLI_EXTRA_ARGS) {
    baseArgs = process.env.BIZAGENT_CLI_EXTRA_ARGS;
  } else if (cliDef.flags && Object.prototype.hasOwnProperty.call(cliDef.flags, "extra")) {
    baseArgs = cliDef.flags.extra || "";
  } else if (cliDef.extraArgs != null) {
    baseArgs = String(cliDef.extraArgs);
  } else {
    baseArgs = "";
  }

  // Grok headless needs auto tool approval or it exits without acting.
  if (exeBase === "grok") {
    if (!baseArgs) {
      baseArgs = "--always-approve";
    } else if (
      !/(^|\s)--always-approve(\s|$)/.test(baseArgs) &&
      !/(^|\s)--permission-mode[= ]\S+/.test(baseArgs)
    ) {
      baseArgs = `${baseArgs} --always-approve`.trim();
    }
  }

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

  return { cli: executable, promptFlag, extraArgs, cliName: basenameCli(requested) };
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
  CLI_CATALOG,
  CLI_HEADLESS_DEFAULTS,
  basenameCli,
  cliJsonEntries,
  cliJsonFile,
  cliJsonMtimeMs,
  compileAgentCommand,
  getCliSettings,
  loadCliJson,
  requireCliDef,
};
