#!/usr/bin/env node
/**
 * Minimal Streamable HTTP MCP server for unit tests.
 * Single MCP endpoint: POST JSON-RPC → application/json response.
 * Optional Mcp-Session-Id on initialize.
 * Implements initialize + tools/list + tools/call (echo).
 *
 * Usage: node fake-mcp-http-server.js [--port 0] [--sse-response]
 * Prints "PORT <n>" to stdout when listening.
 */
'use strict';

const http = require('http');

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
let sseResponse = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--port' && args[i + 1]) {
    port = Number(args[++i]) || 0;
  } else if (args[i] === '--sse-response') {
    sseResponse = true;
  }
}

function handleRpc(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.method && msg.id === undefined) {
    // notification — no response body
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
        serverInfo: { name: 'fake-mcp-http', version: '0.0.1' },
      },
      session: true,
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

const sessions = new Set();

const server = http.createServer((req, res) => {
  if (req.method === 'DELETE') {
    const sid = req.headers['mcp-session-id'];
    if (sid) sessions.delete(sid);
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(405, { Allow: 'POST, DELETE' });
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad json' }));
      return;
    }

    const out = handleRpc(msg);
    if (!out) {
      res.writeHead(400);
      res.end();
      return;
    }
    if (out.notification) {
      res.writeHead(202);
      res.end();
      return;
    }

    const headers = { 'Content-Type': sseResponse ? 'text/event-stream' : 'application/json' };
    if (out.session) {
      const sid = `test-session-${Date.now()}`;
      sessions.add(sid);
      headers['Mcp-Session-Id'] = sid;
    }
    // strip internal flag
    const { session: _s, ...rpcMsg } = out;

    if (sseResponse) {
      res.writeHead(200, headers);
      res.write(`event: message\ndata: ${JSON.stringify(rpcMsg)}\n\n`);
      res.end();
      return;
    }

    res.writeHead(200, headers);
    res.end(JSON.stringify(rpcMsg));
  });
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(`PORT ${addr.port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref?.();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
