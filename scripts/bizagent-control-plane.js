#!/usr/bin/env node
const { initAuth } = require('../control-plane/lib/auth');
const { appendMessage } = require('../control-plane/lib/conversations');
const { loadRuntimeConfig } = require('../control-plane/lib/config');
const { dispatchPendingAgents, ensureDispatchPrompt } = require('../control-plane/lib/dispatcher');
const { ensureHubRuntimePrompt } = require('../control-plane/lib/hub-memory');
const { routeOutboxes } = require('../control-plane/lib/mail');
const { start } = require('../control-plane/server');

function usage() {
  console.error('usage: bizagent-control-plane.js {serve|route-once|dispatch-once|ensure-prompts|append-hub-turn|auth-init} [--hub PATH] [--username USER --password PASS] [--conversation ID --content TEXT|--content-file PATH]');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { command: argv[2], hub: process.cwd() };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--hub') opts.hub = argv[++i];
    else if (arg === '--username') opts.username = argv[++i];
    else if (arg === '--password') opts.password = argv[++i];
    else if (arg === '--conversation') opts.conversation = argv[++i];
    else if (arg === '--content') opts.content = argv[++i];
    else if (arg === '--content-file') opts.contentFile = argv[++i];
    else usage();
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv);
  if (!opts.command) usage();
  if (opts.command === 'serve') return start(opts.hub);

  const config = loadRuntimeConfig(opts.hub);
  if (opts.command === 'route-once') {
    const result = routeOutboxes(config.hub);
    console.log(`control-plane route: ${result.delivered} delivered, ${result.warnings} warning(s)`);
    return null;
  }
  if (opts.command === 'dispatch-once') {
    routeOutboxes(config.hub);
    const result = dispatchPendingAgents(config);
    console.log(`control-plane dispatch: launched=${result.launched} skipped_locked=${result.skippedLocked} skipped_cap=${result.skippedCap}`);
    return null;
  }
  if (opts.command === 'ensure-prompts') {
    ensureHubRuntimePrompt(config.hub);
    console.log('ensured .bizagent/prompts/hub.md');
    for (const product of config.registry.products || []) {
      ensureDispatchPrompt(config.hub, product.slug);
      console.log(`ensured agents/${product.slug}/.dispatch.md`);
    }
    return null;
  }
  if (opts.command === 'append-hub-turn') {
    if (!opts.conversation) usage();
    const content = opts.contentFile
      ? require('fs').readFileSync(opts.contentFile, 'utf8')
      : opts.content || '';
    appendMessage(config.hub, opts.conversation, 'hub', content);
    console.log(`appended hub turn to ${opts.conversation}`);
    return null;
  }
  if (opts.command === 'auth-init') {
    initAuth(config.hub, opts.username, opts.password);
    console.log('auth initialized');
    return null;
  }
  usage();
  return null;
}

main();
