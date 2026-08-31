#!/usr/bin/env node
/**
 * Minimal stdio MCP server for unit tests.
 * Implements initialize + tools/list + tools/call (echo).
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 */
'use strict';

const readline = require('readline');

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the text argument',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo' },
      },
      required: ['text'],
    },
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  // notifications (no id)
  if (msg.method && msg.id === undefined) {
    return;
  }
  if (!msg.method || msg.id === undefined) return;

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-server', version: '0.0.1' },
      },
    });
    return;
  }

  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: TOOLS },
    });
    return;
  }

  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (name === 'echo') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: String(args.text ?? '') }],
          isError: false,
        },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      },
    });
    return;
  }

  if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (err) {
    // ignore bad lines
  }
});
rl.on('close', () => {
  process.exit(0);
});
