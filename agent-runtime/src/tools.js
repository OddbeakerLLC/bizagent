'use strict';

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execFile, exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const MAX_READ_CHARS = 120000;
const MAX_SHELL_CHARS = 80000;
const MAX_GREP_MATCHES = 50;
const MAX_GLOB_RESULTS = 200;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description:
        'List files and subdirectories in a path (non-recursive). Prefer this before guessing filenames.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path (default ".")',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_files',
      description:
        'Find files by glob pattern under a root (e.g. "**/*.js", "tests/**/*.sh"). Uses find; respects max results.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob-like pattern; ** and * supported via find heuristics',
          },
          root: {
            type: 'string',
            description: 'Search root (default ".")',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description:
        'Search file contents for a regex/string (ripgrep if available, else grep -R). Returns matching lines with paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or fixed string' },
          path: {
            type: 'string',
            description: 'File or directory to search (default ".")',
          },
          glob: {
            type: 'string',
            description: 'Optional file filter e.g. "*.js" (rg --glob)',
          },
          case_insensitive: { type: 'boolean' },
          fixed_string: {
            type: 'boolean',
            description: 'Treat pattern as literal string',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 file. For large files use offset (1-based line) and limit (line count).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: {
            type: 'number',
            description: '1-based start line (optional)',
          },
          limit: {
            type: 'number',
            description: 'Max lines to return (optional)',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a file. Prefer search_replace for existing files. Creates parent dirs.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_replace',
      description:
        'Edit a file by replacing an exact string. old_string must appear exactly once unless replace_all is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence (default false)',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_shell_command',
      description:
        'Run a shell command. Use for tests, git status/diff, builds. Avoid destructive git unless the task requires it. Output is truncated if huge.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout: {
            type: 'number',
            description: 'Timeout ms (default 60000, max 300000)',
          },
          cwd: {
            type: 'string',
            description: 'Working directory (default process cwd)',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'HTTP GET a URL; returns text body (truncated).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
];

const DESTRUCTIVE_TOOLS = new Set([
  'write_file',
  'delete_file',
  'search_replace',
  'execute_shell_command',
]);

function truncate(str, max) {
  const s = String(str || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

async function listDirectoryTool(dirPath = '.') {
  const resolved = path.resolve(dirPath || '.');
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const items = entries
    .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
    .slice(0, 500)
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file',
    }));
  return { success: true, path: resolved, count: items.length, entries: items };
}

/**
 * Convert simple globs to find -name / -path patterns.
 * "**\/foo*.js" → find with -name 'foo*.js'
 * "src/**\/*.ts" → path prefix src
 */
async function globFilesTool(pattern, root = '.') {
  const resolvedRoot = path.resolve(root || '.');
  const pat = String(pattern || '').trim();
  if (!pat) throw new Error('pattern required');

  // Prefer rg --files -g if available
  try {
    const args = ['--files', '-g', pat, resolvedRoot];
    const { stdout } = await execFileAsync('rg', args, {
      timeout: 20000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const files = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, MAX_GLOB_RESULTS);
    return {
      success: true,
      root: resolvedRoot,
      pattern: pat,
      count: files.length,
      files,
      truncated: files.length >= MAX_GLOB_RESULTS,
    };
  } catch (_rgErr) {
    /* fall through to find */
  }

  // find heuristic: take last path segment as -name
  const namePart = pat.includes('/') ? pat.split('/').pop() : pat;
  const nameGlob = namePart.replace(/\*\*/g, '*') || '*';
  const { stdout } = await execFileAsync(
    'find',
    [
      resolvedRoot,
      '-type',
      'f',
      '!',
      '-path',
      '*/node_modules/*',
      '!',
      '-path',
      '*/.git/*',
      '-name',
      nameGlob,
    ],
    { timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
  );
  const files = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_GLOB_RESULTS);
  return {
    success: true,
    root: resolvedRoot,
    pattern: pat,
    count: files.length,
    files,
    truncated: files.length >= MAX_GLOB_RESULTS,
    via: 'find',
  };
}

async function grepSearchTool({
  pattern,
  path: searchPath = '.',
  glob,
  case_insensitive: ci,
  fixed_string: fixed,
}) {
  const resolved = path.resolve(searchPath || '.');
  const pat = String(pattern || '');
  if (!pat) throw new Error('pattern required');

  // Try ripgrep first
  try {
    const args = ['-n', '--no-heading', '--color', 'never'];
    if (ci) args.push('-i');
    if (fixed) args.push('-F');
    if (glob) args.push('-g', String(glob));
    args.push('--max-count', '20');
    args.push(pat, resolved);
    const { stdout } = await execFileAsync('rg', args, {
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const lines = stdout
      .split('\n')
      .filter(Boolean)
      .slice(0, MAX_GREP_MATCHES);
    return {
      success: true,
      matches: lines,
      count: lines.length,
      truncated: lines.length >= MAX_GREP_MATCHES,
      engine: 'rg',
    };
  } catch (err) {
    // rg exits 1 when no matches
    if (err && err.code === 1) {
      return { success: true, matches: [], count: 0, engine: 'rg' };
    }
  }

  const grepArgs = ['-RIn', '--exclude-dir=node_modules', '--exclude-dir=.git'];
  if (ci) grepArgs.push('-i');
  if (fixed) grepArgs.push('-F');
  grepArgs.push(pat, resolved);
  try {
    const { stdout } = await execFileAsync('grep', grepArgs, {
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const lines = stdout
      .split('\n')
      .filter(Boolean)
      .slice(0, MAX_GREP_MATCHES);
    return {
      success: true,
      matches: lines,
      count: lines.length,
      truncated: lines.length >= MAX_GREP_MATCHES,
      engine: 'grep',
    };
  } catch (err) {
    if (err && err.code === 1) {
      return { success: true, matches: [], count: 0, engine: 'grep' };
    }
    throw err;
  }
}

async function readFileTool(filePath, offset, limit) {
  const resolved = path.resolve(filePath);
  const raw = await fs.readFile(resolved, 'utf8');
  const lines = raw.split('\n');
  const totalLines = lines.length;

  let start = 0;
  let end = totalLines;
  if (offset != null && Number(offset) > 0) {
    start = Math.max(0, Math.floor(Number(offset)) - 1);
  }
  if (limit != null && Number(limit) > 0) {
    end = Math.min(totalLines, start + Math.floor(Number(limit)));
  }

  let slice = lines.slice(start, end);
  let content = slice.join('\n');
  let truncated = false;
  if (content.length > MAX_READ_CHARS) {
    content = content.slice(0, MAX_READ_CHARS);
    truncated = true;
  }

  return {
    success: true,
    path: resolved,
    content,
    total_lines: totalLines,
    start_line: start + 1,
    end_line: start + slice.length,
    truncated: truncated || end < totalLines,
  };
}

async function writeFileTool(filePath, content) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, 'utf8');
  return {
    success: true,
    message: `Wrote ${resolved}`,
    bytes: Buffer.byteLength(String(content), 'utf8'),
  };
}

async function searchReplaceTool(filePath, oldString, newString, replaceAll = false) {
  const resolved = path.resolve(filePath);
  let content = await fs.readFile(resolved, 'utf8');
  if (oldString === '') throw new Error('old_string must not be empty');
  if (!content.includes(oldString)) {
    throw new Error(
      `old_string not found in ${filePath}. Re-read the file and use an exact contiguous snippet.`,
    );
  }

  const parts = content.split(oldString);
  const occurrences = parts.length - 1;
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string matched ${occurrences} times in ${filePath}. Use a more unique old_string or set replace_all=true.`,
    );
  }

  const next = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);

  await fs.writeFile(resolved, next, 'utf8');
  return {
    success: true,
    message: `Edited ${resolved}`,
    replacements: replaceAll ? occurrences : 1,
  };
}

async function deleteFileTool(filePath) {
  const resolved = path.resolve(filePath);
  await fs.unlink(resolved);
  return { success: true, message: `Deleted ${resolved}` };
}

async function executeShellCommandTool(command, timeout = 60000, cwd) {
  const t = Math.min(Math.max(Number(timeout) || 60000, 1000), 300000);
  const options = {
    timeout: t,
    maxBuffer: 5 * 1024 * 1024,
    cwd: cwd ? path.resolve(cwd) : process.cwd(),
  };
  try {
    const { stdout, stderr } = await execAsync(command, options);
    return {
      success: true,
      exit_code: 0,
      stdout: truncate((stdout || '').trimEnd(), MAX_SHELL_CHARS),
      stderr: truncate((stderr || '').trimEnd(), MAX_SHELL_CHARS / 2),
      cwd: options.cwd,
    };
  } catch (err) {
    // Non-zero exit still returns useful output to the model
    return {
      success: false,
      exit_code: typeof err.code === 'number' ? err.code : 1,
      error: err.message,
      stdout: truncate((err.stdout || '').toString().trimEnd(), MAX_SHELL_CHARS),
      stderr: truncate((err.stderr || '').toString().trimEnd(), MAX_SHELL_CHARS / 2),
      cwd: options.cwd,
    };
  }
}

async function fetchUrlTool(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; BizAgentAgent/0.2)',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  return { success: true, content: text.slice(0, 100000), truncated: text.length > 100000 };
}

function truncateToolResult(result) {
  const json = JSON.stringify(result);
  if (json.length <= 100000) return result;
  return {
    success: result.success,
    error: 'tool result too large; truncated',
    preview: json.slice(0, 80000),
  };
}

async function executeToolCall(toolCall) {
  const args =
    typeof toolCall.function.arguments === 'string'
      ? JSON.parse(toolCall.function.arguments || '{}')
      : toolCall.function.arguments || {};

  let result;
  switch (toolCall.function.name) {
    case 'list_directory':
      result = await listDirectoryTool(args.path);
      break;
    case 'glob_files':
      result = await globFilesTool(args.pattern, args.root);
      break;
    case 'grep_search':
      result = await grepSearchTool(args);
      break;
    case 'read_file':
      result = await readFileTool(args.path, args.offset, args.limit);
      break;
    case 'write_file':
      result = await writeFileTool(args.path, args.content);
      break;
    case 'search_replace':
      result = await searchReplaceTool(
        args.path,
        args.old_string,
        args.new_string,
        !!args.replace_all,
      );
      break;
    case 'delete_file':
      result = await deleteFileTool(args.path);
      break;
    case 'execute_shell_command':
      result = await executeShellCommandTool(args.command, args.timeout, args.cwd);
      break;
    case 'fetch_url':
      result = await fetchUrlTool(args.url);
      break;
    default:
      throw new Error(`Unknown tool: ${toolCall.function.name}`);
  }
  return truncateToolResult(result);
}

module.exports = {
  TOOLS,
  DESTRUCTIVE_TOOLS,
  executeToolCall,
  // exported for tests
  searchReplaceTool,
  readFileTool,
  grepSearchTool,
};
