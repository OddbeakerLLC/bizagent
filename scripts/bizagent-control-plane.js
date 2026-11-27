#!/usr/bin/env node
const { initAuth } = require('../control-plane/lib/auth');
const { appendMessage } = require('../control-plane/lib/conversations');
const { loadRuntimeConfig } = require('../control-plane/lib/config');
const { dispatchPendingAgents, ensureDispatchPrompt } = require('../control-plane/lib/dispatcher');
const { ensureHubRuntimePrompt } = require('../control-plane/lib/hub-memory');
const { routeOutboxes, writeOutboxMessage } = require('../control-plane/lib/mail');
const { start } = require('../control-plane/server');

function usage() {
  console.error([
    'usage: bizagent-control-plane.js {serve|route-once|dispatch-once|ensure-prompts|append-hub-turn|write-message|auth-init}',
    '  common: --hub PATH',
    '  auth-init: --username USER (password via BIZAGENT_ADMIN_PASSWORD env or stdin; --password legacy)',
    '  append-hub-turn: --conversation ID --content TEXT|--content-file PATH',
    '  write-message: --to SLUG --subject TEXT [--from SLUG] [--conversation ID]',
    '                 [--kind KIND] [--requesting-agent SLUG] [--content TEXT|--content-file PATH]  (body also via stdin)',
    '                 [--allow-stale-body-file]  (a content-file older than ~15 min is refused',
    '  form-answer:   FORM_ID — print a submitted form response (JSON) and delete it',
    '  form-sweep:    delete unclaimed form responses older than 24h',
    '  enterprise-init: requires settings.enterprise.enabled; delegates to package',
  ].join('\n'));
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { command: argv[2], hub: process.cwd() };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--hub') opts.hub = argv[++i];
    else if (arg === '--username') opts.username = argv[++i];
    else if (arg === '--password') opts.password = argv[++i];
    else if (arg === '--conversation' || arg === '--conversation-id') opts.conversation = argv[++i];
    else if (arg === '--content' || arg === '--body') opts.content = argv[++i];
    else if (arg === '--content-file' || arg === '--body-file') opts.contentFile = argv[++i];
    else if (arg === '--allow-stale-body-file') opts.allowStaleBodyFile = true;
    else if (arg === '--to') opts.to = argv[++i];
    else if (arg === '--from') opts.from = argv[++i];
    else if (arg === '--subject') opts.subject = argv[++i];
    else if (arg === '--kind') opts.kind = argv[++i];
    else if (arg === '--requesting-agent') opts.requestingAgent = argv[++i];
    else if (!arg.startsWith('--')) {
      if (!Array.isArray(opts.positional)) opts.positional = [];
      opts.positional.push(arg);
    }
    else if (arg === '--user-id' || arg === '--user_id') opts.userId = argv[++i];
    else usage();
  }
  return opts;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// Stale-body-file guard (2026-11-19 cross-conversation leak): agents of every
// product share the host /tmp. An agent that passes --content-file pointing at
// a file it did not just write can silently mail another conversation's content
// under its own subject; the router then delivers it to the sender's bound chat
// and the operator sees a foreign report in the middle of an unrelated thread.
// Refuse body files older than the window unless the caller opts out.
const DEFAULT_BODY_FILE_MAX_AGE_SECS = 15 * 60;

function assertFreshContentFile(file, opts, label) {
  if (!file || (opts && opts.allowStaleBodyFile)) return;
  let maxAgeSecs = Number.parseInt(process.env.BIZAGENT_BODY_FILE_MAX_AGE_SECS || '', 10);
  if (!Number.isFinite(maxAgeSecs) || maxAgeSecs <= 0) maxAgeSecs = DEFAULT_BODY_FILE_MAX_AGE_SECS;
  let stat;
  try {
    stat = require('fs').statSync(file);
  } catch (_err) {
    return; // missing file: the subsequent read fails with its own clear error
  }
  const ageSecs = Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000));
  if (ageSecs <= maxAgeSecs) return;
  const mins = Math.max(1, Math.round(ageSecs / 60));
  console.error([
    `${label}: --content-file ${file} is ~${mins} min old (limit ${Math.round(maxAgeSecs / 60)} min).`,
    'A body file this old was likely written by a DIFFERENT agent/session (host /tmp is shared) —',
    'sending it would deliver another conversation\'s content under your subject.',
    'Fix: write the body file fresh in this turn and re-run, pipe the body via stdin,',
    'or pass --allow-stale-body-file if the old file really is what you meant to send.',
  ].join('\n'));
  process.exit(1);
}

async function main() {
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
    console.log(`control-plane dispatch: launched=${result.launched} skipped_locked=${result.skippedLocked} skipped_cap=${result.skippedCap} skipped_suspended=${result.skippedSuspended || 0}`);
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
    assertFreshContentFile(opts.contentFile, opts, 'append-hub-turn');
    const content = opts.contentFile
      ? require('fs').readFileSync(opts.contentFile, 'utf8')
      : opts.content || '';
    appendMessage(config.hub, opts.conversation, 'hub', content);
    console.log(`appended hub turn to ${opts.conversation}`);
    return null;
  }
  if (opts.command === 'write-message') {
    if (!opts.to || !opts.subject) usage();
    assertFreshContentFile(opts.contentFile, opts, 'write-message');
    let body = '';
    if (opts.contentFile) {
      body = require('fs').readFileSync(opts.contentFile, 'utf8');
    } else if (opts.content != null) {
      body = opts.content;
    } else {
      body = await readStdin();
    }
    const from = opts.from || process.env.BIZAGENT_FROM || 'hub';
    const result = writeOutboxMessage(config.hub, {
      from,
      to: opts.to,
      subject: opts.subject,
      body,
      conversationId: opts.conversation || '',
      userId: opts.userId || '',
      kind: opts.kind || '',
      requestingAgent: opts.requestingAgent || '',
    });
    console.log(`wrote ${result.file}`);
    return null;
  }
  if (opts.command === 'form-sweep') {
    const { sweepExpiredFormResponses } = require('../control-plane/lib/forms');
    const removed = sweepExpiredFormResponses(config.hub);
    console.log(`form-sweep: removed ${removed} expired response(s)`);
    return null;
  }
  if (opts.command === 'form-answer') {
    const formId = (opts.positional && opts.positional[0]) || '';
    if (!formId) usage();
    const { claimFormResponse } = require('../control-plane/lib/forms');
    let data;
    try {
      data = claimFormResponse(config.hub, formId);
    } catch (err) {
      console.error(`form-answer: ${err.message}`);
      process.exit(1);
    }
    if (!data) {
      console.error(`form-answer: no response for form ${formId} (already claimed or expired)`);
      process.exit(1);
    }
    console.log(JSON.stringify(data, null, 2));
    return null;
  }
  if (opts.command === 'auth-init') {
    // Password sources, safest first (CR 2026-11-21 major 2): BIZAGENT_ADMIN_PASSWORD
    // env, stdin (pipe), then --password (legacy; lands on the child argv, visible
    // in /proc/<pid>/cmdline to every local user — avoid on multi-user servers).
    const password = opts.password
      || process.env.BIZAGENT_ADMIN_PASSWORD
      || (await readStdin()).trim();
    if (!password) {
      console.error('auth-init: no password — set BIZAGENT_ADMIN_PASSWORD, pipe it via stdin, or pass --password (argv-visible; avoid on shared hosts)');
      process.exit(1);
    }
    initAuth(config.hub, opts.username, password);
    console.log('auth initialized');
    return null;
  }

  usage();
  return null;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
