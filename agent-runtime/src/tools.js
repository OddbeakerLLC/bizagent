const fs = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Returns UTF-8 text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute file path" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file. Creates parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_replace",
      description: "Edit a file by replacing one exact string with another.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_shell_command",
      description: "Run a shell command and return stdout/stderr. Use with care.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default 30000)",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch raw text/HTML from a URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
    },
  },
];

const DESTRUCTIVE_TOOLS = new Set([
  "write_file",
  "delete_file",
  "search_replace",
  "execute_shell_command",
]);

async function readFileTool(filePath) {
  const resolved = path.resolve(filePath);
  const content = await fs.readFile(resolved, "utf8");
  return { success: true, content };
}

async function writeFileTool(filePath, content) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf8");
  return { success: true, message: `Wrote ${resolved}` };
}

async function searchReplaceTool(filePath, oldString, newString) {
  const resolved = path.resolve(filePath);
  let content = await fs.readFile(resolved, "utf8");
  if (!content.includes(oldString)) {
    throw new Error(`old_string not found in ${filePath}`);
  }
  content = content.replace(oldString, newString);
  await fs.writeFile(resolved, content, "utf8");
  return { success: true, message: `Edited ${resolved}` };
}

async function deleteFileTool(filePath) {
  const resolved = path.resolve(filePath);
  await fs.unlink(resolved);
  return { success: true, message: `Deleted ${resolved}` };
}

async function executeShellCommandTool(command, timeout = 30000) {
  const { stdout, stderr } = await execAsync(command, { timeout });
  return {
    success: true,
    stdout: (stdout || "").trim(),
    stderr: (stderr || "").trim(),
  };
}

async function fetchUrlTool(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; BizAgentAgent/0.1)",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  return { success: true, content: text.slice(0, 100000) };
}

async function executeToolCall(toolCall) {
  const args =
    typeof toolCall.function.arguments === "string"
      ? JSON.parse(toolCall.function.arguments)
      : toolCall.function.arguments || {};

  switch (toolCall.function.name) {
    case "read_file":
      return readFileTool(args.path);
    case "write_file":
      return writeFileTool(args.path, args.content);
    case "search_replace":
      return searchReplaceTool(args.path, args.old_string, args.new_string);
    case "delete_file":
      return deleteFileTool(args.path);
    case "execute_shell_command":
      return executeShellCommandTool(args.command, args.timeout);
    case "fetch_url":
      return fetchUrlTool(args.url);
    default:
      throw new Error(`Unknown tool: ${toolCall.function.name}`);
  }
}

module.exports = {
  TOOLS,
  DESTRUCTIVE_TOOLS,
  executeToolCall,
};
