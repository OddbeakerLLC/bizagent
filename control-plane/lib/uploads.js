'use strict';

/**
 * Operator chat upload drop zone.
 *
 * Layout:
 *   .bizagent/uploads/
 *     hub/<conversation_id>/<timestamp>-<safe-name>
 *     <slug>/<timestamp>-<safe-name>
 *
 * Nothing is permanent storage here. Hub/agents claim files and remove them.
 * Company/KS uploads still go through company-files.js.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appDir, ensureDir } = require('./config');
const { safeSegment, writeCompanyFile, ALLOWED_EXT, MAX_UPLOAD_BYTES } = require('./company-files');

const VALID_CONVERSATION_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+-[a-f0-9]{6}$/;
const VALID_SLUG = /^[A-Za-z0-9_-]+$/;

function uploadsRoot(hub) {
  return path.join(appDir(hub), 'uploads');
}

function ensureUploadsRoot(hub) {
  const root = uploadsRoot(hub);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function assertConversationId(id) {
  if (!VALID_CONVERSATION_ID.test(String(id || ''))) {
    throw new Error('invalid conversation id');
  }
  return String(id);
}

function assertSlug(slug) {
  const s = String(slug || '').trim();
  if (!VALID_SLUG.test(s) || s === 'hub' || s === 'user' || s === 'company') {
    throw new Error('invalid agent slug');
  }
  return s;
}

function stampPrefix() {
  const iso = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 15);
  const rnd = crypto.randomBytes(2).toString('hex');
  return `${iso}-${rnd}`;
}

function resolveUnderUploads(hub, relParts) {
  const root = ensureUploadsRoot(hub);
  const abs = path.resolve(root, ...relParts);
  const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootSep)) {
    throw new Error('path escapes uploads/');
  }
  return { root, abs, rel: path.relative(hub, abs).split(path.sep).join('/') };
}

/**
 * Write one file into the drop zone (or company/).
 * @param {object} opts
 * @param {'hub'|'company'|string} opts.to - hub | company | agent slug
 * @param {string} [opts.conversationId] - required when to=hub
 * @param {string} [opts.subdir] - company subdir only
 * @param {string} opts.filename
 * @param {Buffer} opts.buffer
 */
function writeUpload(hub, opts = {}) {
  const to = String(opts.to || 'hub').trim();
  const buffer = opts.buffer;
  if (!Buffer.isBuffer(buffer)) throw new Error('buffer required');
  if (buffer.length === 0) throw new Error('empty file');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`file too large (max ${MAX_UPLOAD_BYTES} bytes)`);
  }

  const filename = safeSegment(opts.filename || 'upload.bin');
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(
      `file type not allowed (${ext || 'no extension'}). Allowed: ${[...ALLOWED_EXT].join(', ')}`,
    );
  }

  if (to === 'company') {
    const written = writeCompanyFile(hub, {
      filename,
      subdir: opts.subdir || '',
      buffer,
      overwrite: !!opts.overwrite,
    });
    return {
      to: 'company',
      name: filename,
      path: `company/${written.path}`,
      size: written.size,
      mtime: written.mtime,
    };
  }

  const stampedName = `${stampPrefix()}-${filename}`;
  let relParts;
  let recipient = to;

  if (to === 'hub') {
    const cid = assertConversationId(opts.conversationId);
    relParts = ['hub', cid, stampedName];
    recipient = 'hub';
  } else {
    const slug = assertSlug(to);
    relParts = [slug, stampedName];
    recipient = slug;
  }

  const { abs, rel } = resolveUnderUploads(hub, relParts);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  const st = fs.statSync(abs);
  return {
    to: recipient,
    name: filename,
    path: rel,
    size: st.size,
    mtime: st.mtime.toISOString(),
    conversation_id: to === 'hub' ? String(opts.conversationId) : undefined,
  };
}

/** Remove hub-bound upload staging for a deleted conversation. */
function gcConversationUploads(hub, conversationId) {
  if (!conversationId || !VALID_CONVERSATION_ID.test(String(conversationId))) return false;
  const { abs } = resolveUnderUploads(hub, ['hub', String(conversationId)]);
  if (!fs.existsSync(abs)) return false;
  fs.rmSync(abs, { recursive: true, force: true });
  return true;
}

/**
 * Validate that a claimed attachment path is under an allowed root.
 * Returns normalized hub-relative path using forward slashes.
 */
function assertAllowedAttachmentPath(hub, relPath) {
  const raw = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('..')) throw new Error('invalid attachment path');
  const abs = path.resolve(hub, raw);
  const hubRoot = path.resolve(hub);
  const hubSep = hubRoot.endsWith(path.sep) ? hubRoot : hubRoot + path.sep;
  if (abs !== hubRoot && !abs.startsWith(hubSep)) {
    throw new Error('attachment path escapes hub');
  }
  const rel = path.relative(hubRoot, abs).split(path.sep).join('/');
  const allowed =
    rel.startsWith('.bizagent/uploads/') ||
    rel.startsWith('company/');
  if (!allowed) throw new Error('attachment path not under uploads/ or company/');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`attachment missing: ${rel}`);
  }
  return rel;
}

/**
 * Format attachment lines for hub inbox markdown.
 * @param {Array<{name?:string,path:string,to?:string}>} attachments
 */
function formatAttachmentsMarkdown(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return '';
  const lines = ['', 'Attachments:'];
  for (const a of list) {
    const name = a.name || path.basename(a.path || '');
    const to = a.to ? ` → ${a.to}` : '';
    lines.push(`- \`${a.path}\` (${name})${to}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  ALLOWED_EXT,
  MAX_UPLOAD_BYTES,
  assertAllowedAttachmentPath,
  ensureUploadsRoot,
  formatAttachmentsMarkdown,
  gcConversationUploads,
  uploadsRoot,
  writeUpload,
};
