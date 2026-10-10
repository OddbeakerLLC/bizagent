#!/usr/bin/env node
// Crude SSH operator console: pick a conversation, chat with the hub.
// Talks to conversation files + hub inbox directly (no browser, no VPN).
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
  setActiveConversation,
  writeHubInboxMessage,
} = require('../../control-plane/lib/conversations');

const POLL_MS = 1000;
const HISTORY_DEFAULT = 24;

function usage(code = 2) {
  process.stderr.write(
    [
      'usage: chat.sh [--hub PATH] [--list] [--conversation ID] [--send TEXT]',
      '               [--history N] [--wait] [--timeout SECS]',
      '',
      'Interactive (SSH):  scripts/chat.sh',
      'List only:          scripts/chat.sh --list',
      'One-shot send:      scripts/chat.sh --conversation ID --send "hello"',
      '',
      'In chat: type a message and Enter. Commands: /list  /switch  /history  /quit',
    ].join('\n') + '\n',
  );
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    hub: process.env.BIZAGENT_HUB || '',
    list: false,
    conversation: '',
    send: null,
    history: HISTORY_DEFAULT,
    wait: false,
    timeoutSecs: 0,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--wait') opts.wait = true;
    else if (arg === '--hub') opts.hub = argv[++i] || '';
    else if (arg === '--conversation' || arg === '--conversation-id') {
      opts.conversation = argv[++i] || '';
    } else if (arg === '--send' || arg === '--body') opts.send = argv[++i] ?? '';
    else if (arg === '--history') opts.history = Number(argv[++i]) || HISTORY_DEFAULT;
    else if (arg === '--timeout') opts.timeoutSecs = Number(argv[++i]) || 0;
    else usage();
  }
  return opts;
}

function defaultHub() {
  return path.resolve(__dirname, '..', '..');
}

function die(msg, code = 1) {
  process.stderr.write(`chat: ${msg}\n`);
  process.exit(code);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().slice(11, 19);
}

function roleLabel(role) {
  const r = String(role || 'msg');
  if (r === 'user') return 'you ';
  if (r === 'hub') return 'hub ';
  if (r === 'status') return 'stat';
  return r.slice(0, 4).padEnd(4, ' ');
}

function formatMessage(msg) {
  const t = fmtTime(msg.created_at);
  const body = String(msg.content || '').replace(/\s+$/, '');
  const indent = '         ';
  const wrapped = body.split('\n').map((line, i) => (i === 0 ? line : indent + line)).join('\n');
  return `[${roleLabel(msg.role)} ${t}] ${wrapped}`;
}

function printMessages(conv, limit) {
  const msgs = Array.isArray(conv.messages) ? conv.messages : [];
  const slice = limit > 0 && msgs.length > limit ? msgs.slice(-limit) : msgs;
  if (msgs.length > slice.length) {
    process.stdout.write(`… ${msgs.length - slice.length} earlier message(s) omitted\n`);
  }
  for (const msg of slice) process.stdout.write(`${formatMessage(msg)}\n`);
}

function printConvList(convs, currentId) {
  if (!convs.length) {
    process.stdout.write('(no conversations)\n');
    return;
  }
  convs.forEach((c, i) => {
    const mark = c.id === currentId ? '*' : ' ';
    const when = (c.updated_at || '').replace('T', ' ').slice(0, 16);
    process.stdout.write(`${mark}${String(i + 1).padStart(3, ' ')}. ${c.name}  ${c.id}  ${when}\n`);
  });
}

function resolveConversation(convs, raw) {
  const q = String(raw || '').trim();
  if (!q) return null;
  if (/^\d+$/.test(q)) {
    const n = Number(q);
    if (n >= 1 && n <= convs.length) return convs[n - 1];
  }
  const exact = convs.find((c) => c.id === q);
  if (exact) return exact;
  const lower = q.toLowerCase();
  const named = convs.filter((c) => String(c.name || '').toLowerCase().includes(lower));
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    process.stderr.write(`chat: ambiguous name "${q}" — ${named.length} matches\n`);
    return null;
  }
  return null;
}

function sendMessage(hub, conversationId, content) {
  const text = String(content || '').replace(/\s+$/, '');
  if (!text) return null;
  writeHubInboxMessage(hub, text, conversationId);
  const conv = appendMessage(hub, conversationId, 'user', text);
  setActiveConversation(hub, conversationId);
  return conv;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastStamp(conv) {
  const msgs = (conv && conv.messages) || [];
  const last = msgs[msgs.length - 1];
  return last && last.created_at ? last.created_at : '';
}

async function waitForHubReply(hub, conversationId, sinceStamp, timeoutSecs) {
  const deadline = timeoutSecs > 0 ? Date.now() + timeoutSecs * 1000 : 0;
  process.stdout.write('waiting for hub… (Ctrl-C to stop waiting)\n');
  for (;;) {
    if (deadline && Date.now() > deadline) {
      process.stdout.write('timed out waiting for hub\n');
      return getConversation(hub, conversationId);
    }
    await sleep(POLL_MS);
    const conv = getConversation(hub, conversationId);
    if (!conv) return null;
    const msgs = conv.messages || [];
    const fresh = msgs.filter((m) => m.created_at > sinceStamp);
    const reply = [...fresh].reverse().find((m) => m.role === 'hub' || (m.role === 'status' && m.kind === 'error'));
    if (reply) {
      for (const m of fresh) process.stdout.write(`${formatMessage(m)}\n`);
      return conv;
    }
    if (fresh.some((m) => m.role === 'status')) {
      // Keep waiting; launch-ack / agent-completion are not the reply.
    }
  }
}

function question(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function pickConversation(rl, hub, currentId) {
  const convs = listConversations(hub);
  printConvList(convs, currentId);
  if (!convs.length) {
    const name = (await question(rl, 'New conversation name [Main]: ')).trim() || 'Main';
    return createConversation(hub, name);
  }
  const raw = await question(rl, currentId ? 'Conversation #, name, or id (Enter keeps current): ' : 'Conversation #, name, or id: ');
  if (!String(raw).trim()) {
    if (currentId) return getConversation(hub, currentId) || convs[0];
    return getConversation(hub, convs[0].id);
  }
  const picked = resolveConversation(convs, raw);
  if (!picked) {
    process.stderr.write('chat: not found\n');
    return pickConversation(rl, hub, currentId);
  }
  return getConversation(hub, picked.id);
}

async function interactive(hub, startId, history) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let conv = startId ? getConversation(hub, startId) : null;
  if (startId && !conv) die(`conversation not found: ${startId}`);
  if (!conv) conv = await pickConversation(rl, hub, '');
  setActiveConversation(hub, conv.id);

  const banner = () => {
    process.stdout.write(`\n== ${conv.name} ==  ${conv.id}\n`);
    printMessages(conv, history);
    process.stdout.write('(/list /switch /history /quit)\n');
  };
  banner();

  const onSigint = () => {
    process.stdout.write('\n');
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', onSigint);

  for (;;) {
    const line = await question(rl, `${conv.name}> `);
    const text = String(line || '').trim();
    if (!text) continue;
    if (text === '/quit' || text === '/exit' || text === '/q') break;
    if (text === '/list') {
      printConvList(listConversations(hub), conv.id);
      continue;
    }
    if (text === '/switch' || text === '/open') {
      const next = await pickConversation(rl, hub, conv.id);
      if (next) {
        conv = next;
        setActiveConversation(hub, conv.id);
        banner();
      }
      continue;
    }
    if (text === '/history') {
      conv = getConversation(hub, conv.id) || conv;
      printMessages(conv, history);
      continue;
    }
    if (text.startsWith('/')) {
      process.stdout.write('commands: /list  /switch  /history  /quit\n');
      continue;
    }
    const before = lastStamp(conv);
    try {
      conv = sendMessage(hub, conv.id, text);
    } catch (err) {
      process.stderr.write(`chat: send failed: ${err.message || err}\n`);
      continue;
    }
    process.stdout.write(`${formatMessage({ role: 'user', content: text, created_at: new Date().toISOString() })}\n`);
    try {
      conv = (await waitForHubReply(hub, conv.id, before, 0)) || conv;
    } catch (err) {
      if (err && err.message === 'canceled') continue;
      throw err;
    }
  }
  rl.close();
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) usage(0);
  const hub = path.resolve(opts.hub || defaultHub());
  if (!fs.existsSync(path.join(hub, 'registry.json'))) {
    die(`not a hub (no registry.json): ${hub}`);
  }

  if (opts.list) {
    printConvList(listConversations(hub), '');
    return;
  }

  if (opts.send != null) {
    if (!opts.conversation) die('--send requires --conversation ID');
    const conv = getConversation(hub, opts.conversation);
    if (!conv) die(`conversation not found: ${opts.conversation}`);
    const before = lastStamp(conv);
    sendMessage(hub, conv.id, opts.send);
    process.stdout.write(`sent to ${conv.id} (${conv.name})\n`);
    if (opts.wait) await waitForHubReply(hub, conv.id, before, opts.timeoutSecs);
    return;
  }

  if (!process.stdin.isTTY) {
    if (!opts.conversation) die('non-interactive send needs --conversation ID');
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const body = chunks.join('');
    if (!body.trim()) die('empty stdin');
    const conv = getConversation(hub, opts.conversation);
    if (!conv) die(`conversation not found: ${opts.conversation}`);
    sendMessage(hub, conv.id, body);
    process.stdout.write(`sent to ${conv.id} (${conv.name})\n`);
    return;
  }

  await interactive(hub, opts.conversation, opts.history);
}

main().catch((err) => {
  process.stderr.write(`chat: ${err.message || err}\n`);
  process.exit(1);
});
