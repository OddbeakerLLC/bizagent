const fs = require('fs');
const path = require('path');
const { agentsFromRegistry, appDir, loadRegistry } = require('./config');
const { recordUserInboxDelivery, userInbox } = require('./conversations');
const { appendLog } = require('./log');

function frontmatterValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return match ? match[1].trim() : '';
}

function inboxFor(hub, slug) {
  if (slug === 'user') return userInbox(hub);
  return slug === 'hub' ? path.join(hub, 'inbox') : path.join(hub, 'agents', slug, 'inbox');
}

function recipientSlugs(hub) {
  return new Set(['hub', 'user', ...agentsFromRegistry(loadRegistry(hub)).map((agent) => agent.slug)]);
}

function safeInboxFor(hub, slug) {
  if (!recipientSlugs(hub).has(slug)) return null;
  const hubRoot = path.resolve(hub);
  const inbox = path.resolve(inboxFor(hub, slug));
  if (inbox !== path.join(hubRoot, 'inbox') && !inbox.startsWith(`${hubRoot}${path.sep}`)) {
    throw new Error(`invalid inbox path for ${slug}`);
  }
  return inbox;
}

function outboxes(hub) {
  const boxes = [path.join(hub, 'outbox')];
  const agentsDir = path.join(hub, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const slug of fs.readdirSync(agentsDir)) {
      const dir = path.join(agentsDir, slug, 'outbox');
      if (fs.existsSync(dir)) boxes.push(dir);
    }
  }
  return boxes;
}

function canRouteToUser(hub, outbox) {
  return path.resolve(outbox) === path.resolve(path.join(hub, 'outbox'));
}

function markdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(dir, name));
}

function writeFileUnique(dir, basename, source) {
  const ext = path.extname(basename);
  const stem = basename.slice(0, basename.length - ext.length);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${Math.random().toString(16).slice(2, 8)}`;
    const dest = path.join(dir, `${stem}${suffix}${ext}`);
    try {
      fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(source);
      return dest;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`could not allocate unique delivery filename for ${basename}`);
}

function quarantineDir(hub) {
  return path.join(appDir(hub), 'quarantine');
}

/**
 * Move a stuck/invalid outbox file into .bizagent/quarantine/ so it no longer
 * spams WARN every poll tick. One log line per quarantine action.
 */
function quarantineOutboxFile(hub, file, reason) {
  const destDir = quarantineDir(hub);
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(file);
  let dest = path.join(destDir, base);
  if (fs.existsSync(dest)) {
    dest = path.join(destDir, `${Date.now()}-${base}`);
  }
  try {
    fs.renameSync(file, dest);
  } catch (_err) {
    try {
      fs.copyFileSync(file, dest);
      fs.unlinkSync(file);
    } catch (copyErr) {
      appendLog(hub, `WARN quarantine failed for ${base}: ${copyErr.message}`);
      return null;
    }
  }
  appendLog(hub, `quarantine ${base} reason=${reason} dest=${path.relative(hub, dest)}`);
  return dest;
}

function isMultiRecipient(to) {
  if (!to) return false;
  // Single slug only: letters, digits, underscore, hyphen. Comma/space = multi-to (invalid).
  return /[,\s]/.test(to);
}

function routeOutboxes(hub) {
  let delivered = 0;
  let warnings = 0;
  let quarantined = 0;
  const tRoute = new Date().toISOString();
  for (const outbox of outboxes(hub)) {
    for (const file of markdownFiles(outbox)) {
      const text = fs.readFileSync(file, 'utf8');
      const to = frontmatterValue(text, 'to');
      const base = path.basename(file);

      if (isMultiRecipient(to)) {
        quarantineOutboxFile(hub, file, `multi-to:${to}`);
        quarantined += 1;
        warnings += 1;
        continue;
      }

      if (to === 'user' && !canRouteToUser(hub, outbox)) {
        warnings += 1;
        appendLog(hub, `WARN user recipient is only allowed from hub outbox in ${base}`);
        continue;
      }
      if (!to) {
        warnings += 1;
        appendLog(hub, `WARN no to field in ${base}`);
        continue;
      }
      const dest = safeInboxFor(hub, to);
      if (!dest || !fs.existsSync(dest)) {
        if (to === 'user' && dest) fs.mkdirSync(dest, { recursive: true });
      }
      if (!dest || !fs.existsSync(dest)) {
        // Unknown single recipient: leave in place + WARN (operator may fix `to:`).
        // Multi-to is already quarantined above; do not auto-quarantine path tricks.
        warnings += 1;
        appendLog(hub, `WARN unknown recipient ${to} in ${base}`);
        continue;
      }
      const deliveredFile = writeFileUnique(dest, base, file);
      if (to === 'user') recordUserInboxDelivery(hub, deliveredFile);
      delivered += 1;
      appendLog(hub, `route file=${base} to=${to} t=${tRoute}`);
      appendLog(hub, `routed ${base} -> ${to}`);
    }
  }
  return { delivered, warnings, quarantined };
}

function pendingMail(hub, slug) {
  return markdownFiles(inboxFor(hub, slug));
}

function agentMailStatus(hub, agents) {
  return agents.map((agent) => ({
    ...agent,
    hasMail: pendingMail(hub, agent.slug).length > 0,
    pending: pendingMail(hub, agent.slug).length,
  }));
}

module.exports = {
  agentMailStatus,
  canRouteToUser,
  frontmatterValue,
  inboxFor,
  isMultiRecipient,
  pendingMail,
  quarantineDir,
  quarantineOutboxFile,
  recipientSlugs,
  routeOutboxes,
  safeInboxFor,
  writeFileUnique,
};
