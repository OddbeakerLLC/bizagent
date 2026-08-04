'use strict';

/**
 * Operator-facing Library — curated markdown deliverables (plans, specs, reports).
 * Viewable in the control-plane UI without hub filesystem access.
 *
 * Layout:
 *   library/
 *     README.md
 *     manifest.json
 *     <files>.md
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB text
const ALLOWED_EXT = new Set(['.md', '.markdown', '.txt']);

function libraryRoot(hub) {
  return path.resolve(hub, 'library');
}

function manifestPath(hub) {
  return path.join(libraryRoot(hub), 'manifest.json');
}

function ensureLibrary(hub) {
  const root = libraryRoot(hub);
  fs.mkdirSync(root, { recursive: true });
  const readme = path.join(root, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      [
        '# Library',
        '',
        'Operator-facing documents produced for you (plans, specs, reports).',
        'Browse them in the BizAgent UI under **Library**.',
        '',
        'PTL and product agents should write deliverables here (or register them)',
        'so you can open them without SSH access to the hub.',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  const mpath = manifestPath(hub);
  if (!fs.existsSync(mpath)) {
    writeManifest(hub, {
      version: 1,
      entries: [
        {
          id: 'lib_readme',
          title: 'Library README',
          path: 'README.md',
          created_at: new Date().toISOString(),
          source: 'system',
          tags: ['meta'],
        },
      ],
    });
  } else {
    // One-time: ensure README indexed without recursion
    try {
      const man = JSON.parse(fs.readFileSync(mpath, 'utf8'));
      if (man && Array.isArray(man.entries) && !man.entries.some((e) => e.path === 'README.md')) {
        man.entries.unshift({
          id: 'lib_readme',
          title: 'Library README',
          path: 'README.md',
          created_at: new Date().toISOString(),
          source: 'system',
          tags: ['meta'],
        });
        writeManifest(hub, man);
      }
    } catch (_err) {
      /* ignore corrupt; readManifest will reset */
    }
  }
  return root;
}

function readManifest(hub) {
  ensureLibrary(hub);
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(hub), 'utf8'));
    if (!raw || typeof raw !== 'object') return { version: 1, entries: [] };
    if (!Array.isArray(raw.entries)) raw.entries = [];
    raw.version = raw.version || 1;
    return raw;
  } catch (_err) {
    return { version: 1, entries: [] };
  }
}

function writeManifest(hub, man) {
  const root = libraryRoot(hub);
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, `.manifest.${process.pid}.tmp`);
  const body = `${JSON.stringify(man, null, 2)}\n`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, manifestPath(hub));
}

function safeFilename(name) {
  let base = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC');
  if (!base || base === '.' || base === '..') throw new Error('invalid filename');
  if (base.startsWith('.')) throw new Error('dotfiles not allowed');
  base = base.replace(/[^A-Za-z0-9._()[\] +\-~']/g, '_').replace(/^_+/, '');
  if (!base) throw new Error('invalid filename after sanitize');
  const ext = path.extname(base).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    // default to .md
    if (!ext) base = `${base}.md`;
    else throw new Error(`only markdown/text allowed in library (${[...ALLOWED_EXT].join(', ')})`);
  }
  return base.slice(0, 180);
}

function slugifyTitle(title) {
  return String(title || 'document')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'document';
}

function newId() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rnd = crypto.randomBytes(4).toString('hex');
  return `lib_${day}_${rnd}`;
}

function resolveLibraryFile(hub, relPath) {
  const root = ensureLibrary(hub);
  const raw = String(relPath || '').replace(/\\/g, '/');
  if (!raw || raw.includes('..') || raw.startsWith('/') || raw.includes('/')) {
    // v1: top-level names only (no subdirs, no traversal)
    if (raw.includes('..') || raw.startsWith('/')) {
      throw new Error('path escapes library/');
    }
    if (raw.includes('/')) {
      throw new Error('library files must be top-level under library/');
    }
  }
  const name = safeFilename(raw);
  const abs = path.resolve(root, name);
  const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootSep)) {
    throw new Error('path escapes library/');
  }
  if (path.dirname(abs) !== root) {
    throw new Error('library files must be top-level under library/');
  }
  return { root, abs, rel: name };
}

function listLibrary(hub) {
  const man = readManifest(hub);
  // Drop missing files from listing (keep manifest for audit; soft-filter)
  const entries = [];
  for (const e of man.entries) {
    try {
      const { abs } = resolveLibraryFile(hub, e.path);
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      entries.push({
        ...e,
        size: st.size,
        mtime: st.mtime.toISOString(),
      });
    } catch (_err) {
      /* skip bad entries */
    }
  }
  entries.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return { root: 'library/', entries };
}

function getLibraryEntry(hub, idOrPath) {
  const man = readManifest(hub);
  const key = String(idOrPath || '').trim();
  let entry = man.entries.find((e) => e.id === key);
  if (!entry) {
    entry = man.entries.find((e) => e.path === key || e.path === safeFilename(key));
  }
  if (!entry) throw new Error('not found');
  const { abs, rel } = resolveLibraryFile(hub, entry.path);
  if (!fs.existsSync(abs)) throw new Error('file missing on disk');
  const st = fs.statSync(abs);
  if (st.size > MAX_BYTES) throw new Error('file too large to view');
  const content = fs.readFileSync(abs, 'utf8');
  return {
    ...entry,
    path: rel,
    size: st.size,
    mtime: st.mtime.toISOString(),
    content,
  };
}

/**
 * Write content into library/ and index it.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string|Buffer} opts.content
 * @param {string} [opts.filename]
 * @param {string} [opts.source] upload|hub|agent|system
 * @param {string[]} [opts.tags]
 * @param {boolean} [opts.overwrite]
 */
function addLibraryDocument(hub, opts = {}) {
  const title = String(opts.title || opts.filename || 'Untitled').trim() || 'Untitled';
  let buffer = opts.content;
  if (typeof buffer === 'string') buffer = Buffer.from(buffer, 'utf8');
  if (!Buffer.isBuffer(buffer)) throw new Error('content required');
  if (buffer.length === 0) throw new Error('empty content');
  if (buffer.length > MAX_BYTES) throw new Error(`file too large (max ${MAX_BYTES} bytes)`);

  const day = new Date().toISOString().slice(0, 10);
  let filename = opts.filename
    ? safeFilename(opts.filename)
    : safeFilename(`${day}-${slugifyTitle(title)}.md`);

  const root = ensureLibrary(hub);
  let abs = path.join(root, filename);
  if (fs.existsSync(abs) && !opts.overwrite) {
    const stem = filename.replace(/\.[^.]+$/, '');
    const ext = path.extname(filename) || '.md';
    filename = safeFilename(`${stem}-${crypto.randomBytes(2).toString('hex')}${ext}`);
    abs = path.join(root, filename);
  }

  fs.writeFileSync(abs, buffer);
  const id = opts.id || newId();
  const entry = {
    id,
    title,
    path: filename,
    created_at: new Date().toISOString(),
    source: opts.source || 'upload',
    tags: Array.isArray(opts.tags) ? opts.tags.map(String).slice(0, 12) : [],
  };

  const man = readManifest(hub);
  // Replace same path or same id
  man.entries = man.entries.filter((e) => e.id !== id && e.path !== filename);
  man.entries.unshift(entry);
  writeManifest(hub, man);

  const st = fs.statSync(abs);
  return { ...entry, size: st.size, mtime: st.mtime.toISOString() };
}

module.exports = {
  ALLOWED_EXT,
  MAX_BYTES,
  addLibraryDocument,
  ensureLibrary,
  getLibraryEntry,
  libraryRoot,
  listLibrary,
  readManifest,
  resolveLibraryFile,
  safeFilename,
};
