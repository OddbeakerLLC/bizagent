'use strict';

/**
 * enterprise-sync.js — push the hub's company/ tree to the Enterprise Server.
 * Invoked by scripts/enterprise-sync.sh (nightly + manual). No-op-safe: the
 * caller checks the connection file first; this script re-checks anyway.
 */

const path = require('path');
const client = require(path.join(__dirname, '..', 'control-plane', 'lib', 'enterprise-server-client'));

const HUB = path.resolve(__dirname, '..');

async function main() {
  const conn = client.loadConnection(HUB);
  if (!conn) {
    console.log('enterprise-sync: not connected, skipping');
    return;
  }
  const result = await client.pushCompany(HUB, conn);
  console.log(
    `enterprise-sync: pushed company/ to ${conn.url} (${result.files_stored} files stored)`,
  );
}

main().catch((err) => {
  console.error(`enterprise-sync failed: ${err.message}`);
  process.exit(1);
});
