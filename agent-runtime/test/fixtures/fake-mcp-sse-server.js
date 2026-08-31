#!/usr/bin/env node
/**
 * Minimal legacy HTTP+SSE MCP server for unit tests (protocol 2024-11-05).
 * - GET /sse → SSE stream; first event is `endpoint` with POST URL
 * - POST /message → accepts JSON-RPC; responses pushed on the SSE stream
 *
 * Prints "PORT <n>" to stdout when listening.
 */
'use strict';

const http = require('http');
const { URL } = require('url');

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

const args = process.argv.slice(2);
let port = 0;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--port' && args[i + 1]) {
    port = Number(args[++i]) || 0;
  }
}

/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set();

function broadcast(msg) {
  const data = `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch (_e) {
      sseClients.delete(res);
    }
  }
}

function handleRpc(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.method && msg.id === undefined) {
    return { notification: true };
  }
  if (!msg.method || msg.id === undefined) return null;

  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-sse', version: '0.0.1' },
      },
    };
  }

  if (msg.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: TOOLS },
    };
  }

  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const callArgs = (msg.params && msg.params.arguments) || {};
    if (name === 'echo') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: String(callArgs.text ?? '') }],
          isError: false,
        },
      };
    }
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      },
    };
  }

  if (msg.method === 'ping') {
    return { jsonrpc: '2.0', id: msg.id, result: {} };
  }

  return {
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1');

  if (req.method === 'GET' && u.pathname === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // endpoint event — relative path clients resolve against the SSE URL
    res.write(`event: endpoint\ndata: /message\n\n`);
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    // keep open
    return;
  }

  if (req.method === 'POST' && u.pathname === '/message') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_e) {
        res.writeHead(400);
        res.end();
        return;
      }
      const out = handleRpc(msg);
      res.writeHead(202);
      res.end();
      if (out && !out.notification) {
        // slight delay so POST returns before SSE delivers (mirrors real servers)
        setImmediate(() => broadcast(out));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(`PORT ${addr.port}\n`);
});

function shutdown() {
  for (const res of sseClients) {
    try {
      res.end();
    } catch (_e) {
      /* ignore */
    }
  }
  sseClients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref?.();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
