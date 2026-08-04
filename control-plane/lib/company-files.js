'use strict';

/**
 * Operator-controlled company/ tree helpers for Knowledge Stack inputs.
 * Used when the operator cannot reach the hub filesystem directly (remote PTL).
 */

const fs = require('fs');
const path = require('path');

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB
const ALLOWED_EXT = new Set([
  '.md',
  '.txt',
  '.markdown',
  '.pdf',
  '.csv',
  '.json',
  '.html',
  '.htm',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
]);

function companyRoot(hub) {
  return path.resolve(hub, 'company');
}

function ensureCompanyRoot(hub) {
  const root = companyRoot(hub);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Sanitize a single path segment (filename or one subdir level). */
function safeSegment(name, { allowDotfiles = false } = {}) {
  const raw = String(name || '').trim();
  if (!raw) throw new Error('empty name');
  if (raw.includes('\0')) throw new Error('invalid name');
  // Always take basename so "foo/bar" or "C:\\x" cannot sneak path seps through.
  let seg = path.basename(raw.replace(/\\/g, '/')).normalize('NFC');
  if (seg === '.' || seg === '..') throw new Error('invalid name');
  if (!allowDotfiles && seg.startsWith('.')) throw new Error('dotfiles not allowed');
  // Strip characters that are awkward on Windows/Linux or for URLs.
  seg = seg.replace(/[^A-Za-z0-9._()[\] +\-~']/g, '_').replace(/^_+/, '');
  if (!seg || seg === '.' || seg === '..') throw new Error('invalid name after sanitize');
  return seg.slice(0, 180);
}

/**
 * Resolve a path under company/. `rel` may be "file.md" or "news/file.md".
 * At most one subdirectory level for uploads (keeps tree simple).
 */
function resolveUnderCompany(hub, relPath, { mustExist = false } = {}) {
  const root = ensureCompanyRoot(hub);
  const parts = String(relPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('path required');
  if (parts.length > 2) throw new Error('at most one subdirectory under company/');
  const safeParts = parts.map((p) => safeSegment(p));
  const abs = path.resolve(root, ...safeParts);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error('path escapes company/');
  }
  if (mustExist && !fs.existsSync(abs)) throw new Error('not found');
  return { root, abs, rel: safeParts.join('/') };
}

function listCompanyFiles(hub, { subdir = '' } = {}) {
  const root = ensureCompanyRoot(hub);
  let start = root;
  let prefix = '';
  if (subdir) {
    const seg = safeSegment(subdir);
    start = path.join(root, seg);
    prefix = `${seg}/`;
    if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) {
      return [];
    }
  }

  const out = [];
  function walk(dir, relBase) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        // Only one level of nesting under company/.
        if (!relBase.includes('/')) walk(abs, rel);
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try {
        st = fs.statSync(abs);
      } catch (_err) {
        continue;
      }
      out.push({
        path: rel,
        name: ent.name,
        size: st.size,
        mtime_ms: st.mtimeMs,
        mtime: st.mtime.toISOString(),
      });
    }
  }
  // When listing a subdir, relBase should be that subdir name.
  const startRel = prefix ? prefix.replace(/\/$/, '') : '';
  walk(start, startRel);
  out.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return out;
}

function writeCompanyFile(hub, { filename, subdir = '', buffer, overwrite = false }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('buffer required');
  if (buffer.length === 0) throw new Error('empty file');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`file too large (max ${MAX_UPLOAD_BYTES} bytes)`);
  }

  const name = safeSegment(filename);
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(
      `file type not allowed (${ext || 'no extension'}). Allowed: ${[...ALLOWED_EXT].join(', ')}`,
    );
  }

  let rel = name;
  if (subdir) {
    const dir = safeSegment(subdir);
    rel = `${dir}/${name}`;
  }

  const { abs, root } = resolveUnderCompany(hub, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs) && !overwrite) {
    throw new Error(`file already exists: ${rel} (pass overwrite=true to replace)`);
  }
  fs.writeFileSync(abs, buffer);
  const st = fs.statSync(abs);
  return {
    path: rel,
    abs,
    size: st.size,
    mtime: st.mtime.toISOString(),
    root,
  };
}

/**
 * Minimal multipart/form-data parser for a single file field + text fields.
 * @returns {{ fields: Record<string,string>, file?: { filename: string, buffer: Buffer } }}
 */
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) throw new Error('multipart boundary missing');
  const boundary = m[1] || m[2];
  const sep = Buffer.from(`--${boundary}`);
  const fields = {};
  let file;

  let start = buffer.indexOf(sep);
  if (start < 0) throw new Error('invalid multipart body');
  start += sep.length;

  while (start < buffer.length) {
    if (buffer[start] === 45 && buffer[start + 1] === 45) break; // --
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;

    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd < 0) break;
    const header = buffer.slice(start, headerEnd).toString('utf8');
    let next = buffer.indexOf(sep, headerEnd + 4);
    if (next < 0) next = buffer.length;
    let bodyEnd = next;
    // trim trailing CRLF before boundary
    if (bodyEnd >= 2 && buffer[bodyEnd - 2] === 13 && buffer[bodyEnd - 1] === 10) {
      bodyEnd -= 2;
    }
    const body = buffer.slice(headerEnd + 4, bodyEnd);

    const nameMatch = /name="([^"]+)"/i.exec(header);
    const filenameMatch = /filename="([^"]*)"/i.exec(header);
    const name = nameMatch ? nameMatch[1] : '';
    if (filenameMatch && name) {
      const filename = path.basename(filenameMatch[1] || 'upload.bin');
      file = { field: name, filename, buffer: body };
    } else if (name) {
      fields[name] = body.toString('utf8');
    }

    start = next + sep.length;
  }

  return { fields, file };
}

function readRequestBuffer(req, limit = MAX_UPLOAD_BYTES + 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = {
  ALLOWED_EXT,
  MAX_UPLOAD_BYTES,
  companyRoot,
  ensureCompanyRoot,
  listCompanyFiles,
  parseMultipart,
  readRequestBuffer,
  resolveUnderCompany,
  safeSegment,
  writeCompanyFile,
};
