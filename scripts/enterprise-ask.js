#!/usr/bin/env node
'use strict';

/**
 * enterprise-ask.js — CLI for the Ask Enterprise agent (and operators).
 *
 * Queries the connected Enterprise Server's combined knowledge stack:
 *   node scripts/enterprise-ask.js "zephyr rollout"     # keyword search
 *   node scripts/enterprise-ask.js --list               # list KS files
 *   node scripts/enterprise-ask.js --file <name>        # print one KS file
 *
 * Reads the connection (URL + token) from .bizagent/enterprise-server.json.
 * Exits 2 with a clear message when the hub is not connected.
 */

const fs = require('fs');
const path = require('path');

const HUB = path.resolve(__dirname, '..');

function loadConnection() {
  try {
    const conn = JSON.parse(
      fs.readFileSync(path.join(HUB, '.bizagent', 'enterprise-server.json'), 'utf8'),
    );
    if (conn && conn.connected && conn.url && conn.token) return conn;
  } catch (_err) { /* fallthrough */ }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const client = require(path.join(HUB, 'control-plane', 'lib', 'enterprise-server-client'));
  const conn = loadConnection();
  if (!conn) {
    console.error('Not connected to an Enterprise Server (no .bizagent/enterprise-server.json).');
    process.exit(2);
  }

  let res;
  if (args[0] === '--list') {
    res = await client.request('GET', conn.url, conn.ks?.list || '/api/ks', conn.token);
    if (res.status !== 200) fail(res);
    console.log(res.json.files.join('\n') || '(enterprise knowledge stack is empty)');
    return;
  }

  if (args[0] === '--file') {
    const name = args[1] || '';
    if (!name) {
      console.error('usage: enterprise-ask.js --file <name>');
      process.exit(2);
    }
    res = await client.request(
      'GET',
      conn.url,
      `${conn.ks?.file || '/api/ks/file?name='}${encodeURIComponent(name)}`,
      conn.token,
    );
    if (res.status !== 200) fail(res);
    process.stdout.write(res.text);
    return;
  }

  const q = args.join(' ').trim();
  if (!q) {
    console.error('usage: enterprise-ask.js "question terms" | --list | --file <name>');
    process.exit(2);
  }
  res = await client.request('POST', conn.url, conn.ks?.ask || '/api/ask', conn.token, { q });
  if (res.status !== 200) fail(res);
  console.log(res.json.answer || '(no results)');
  if (res.json.results && res.json.results.length) {
    console.log('\nFiles:');
    for (const r of res.json.results) console.log(`- ${r.file} (score ${r.score})`);
  }
}

function fail(res) {
  console.error(`enterprise server error: ${res.status} ${res.text.slice(0, 200)}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`enterprise ask failed: ${err.message}`);
  process.exit(1);
});
