'use strict';

/**
 * Operator-facing Library — curated deliverables (plans, specs, reports, diagrams).
 * Viewable in the control-plane UI without hub filesystem access.
 *
 * Layout:
 *   library/
 *     README.md
 *     manifest.json
 *     <files>.md | .puml | .svg | .png
 *
 * Diagrams: write foo.puml (via addLibraryDocument / addLibraryDiagram); PlantUML
 * renders foo.svg beside it. Manifest entry path points at the image; source_path
 * keeps the .puml. Operator click shows the rendered image.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
/** Text/markdown plus diagram sources and rendered images for Library preview. */
const ALLOWED_EXT = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.puml',
  '.plantuml',
  '.svg',
  '.png',
]);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.puml', '.plantuml', '.svg']);
const DIAGRAM_EXT = new Set(['.puml', '.plantuml', '.svg', '.png']);
const PLANTUML_EXT = new Set(['.puml', '.plantuml']);
const IMAGE_EXT = new Set(['.svg', '.png']);

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

function isTextLibraryExt(ext) {
  return TEXT_EXT.has(String(ext || '').toLowerCase());
}

function isDiagramLibraryExt(ext) {
  return DIAGRAM_EXT.has(String(ext || '').toLowerCase());
}

function contentTypeForExt(ext) {
  switch (String(ext || '').toLowerCase()) {
    case '.md':
    case '.markdown':
      return 'text/markdown; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.puml':
    case '.plantuml':
      return 'text/plain; charset=utf-8';
    case '.svg':
      return 'image/svg+xml; charset=utf-8';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

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
        'Operator-facing documents and diagrams produced for you (plans, specs, reports).',
        'Browse them in the BizAgent UI under **Library**.',
        '',
        'PTL and product agents should write deliverables here (or register them)',
        'so you can open them without SSH access to the hub.',
        '',
        '## Diagrams (PlantUML)',
        '',
        '1. Write `library/<name>.puml` (PlantUML source).',
        '2. Render to SVG beside it (`plantuml.sh` / `renderPlantUml`) → `library/<name>.svg`.',
        '3. Register in `library/manifest.json` with `path` = the `.svg` (what the UI shows),',
        '   `source_path` = the `.puml`, `type`/`kind` = `diagram`, plus id/title/source/tags.',
        '',
        'Or call `addLibraryDocument` / `addLibraryDiagram` from hub code — they render and index.',
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
    else {
      throw new Error(
        `library allows ${[...ALLOWED_EXT].join(', ')} (got ${ext || 'no ext'})`,
      );
    }
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

function stemOf(filename) {
  return String(filename || '').replace(/\.[^.]+$/, '');
}

function kindForEntry(entry, filePath) {
  if (entry && (entry.kind === 'diagram' || entry.type === 'diagram')) return 'diagram';
  const ext = extOf(filePath || (entry && entry.path) || '');
  if (IMAGE_EXT.has(ext)) return 'diagram';
  if (PLANTUML_EXT.has(ext)) return 'plantuml';
  return 'document';
}

function enrichEntry(entry, st) {
  const filePath = entry.path || '';
  const ext = extOf(filePath);
  const kind = kindForEntry(entry, filePath);
  const out = {
    ...entry,
    ext,
    kind,
    content_type: contentTypeForExt(ext),
  };
  if (st) {
    out.size = st.size;
    out.mtime = st.mtime.toISOString();
  }
  return out;
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
      entries.push(enrichEntry(e, st));
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
  const ext = extOf(rel);
  const text = isTextLibraryExt(ext);
  const content = text ? fs.readFileSync(abs, 'utf8') : null;
  const enriched = enrichEntry({ ...entry, path: rel }, st);
  // Optional companion source (.puml) for diagram entries
  let source_content = null;
  if (entry.source_path) {
    try {
      const src = resolveLibraryFile(hub, entry.source_path);
      if (fs.existsSync(src.abs) && isTextLibraryExt(extOf(src.rel))) {
        source_content = fs.readFileSync(src.abs, 'utf8');
      }
    } catch (_err) {
      /* ignore missing companion */
    }
  }
  return {
    ...enriched,
    // Binary (e.g. PNG): content omitted; UI uses ?raw=1 image URL.
    content: content == null ? '' : content,
    binary: !text,
    source_content,
  };
}

/**
 * Render PlantUML source to SVG next to a .puml path under library/.
 * @returns {{ svgRel: string, svgAbs: string }}
 */
function renderPumlBeside(hub, pumlRel, sourceText) {
  let renderPlantUml;
  try {
    ({ renderPlantUml } = require('./plantuml'));
  } catch (err) {
    throw new Error(`PlantUML module unavailable: ${err.message}`);
  }
  const svg = renderPlantUml(String(sourceText || ''), 'svg');
  if (!svg || !String(svg).trim()) {
    throw new Error('PlantUML produced empty SVG');
  }
  const svgName = safeFilename(`${stemOf(pumlRel)}.svg`);
  const { abs: svgAbs, rel: svgRel } = resolveLibraryFile(hub, svgName);
  fs.writeFileSync(svgAbs, String(svg), 'utf8');
  return { svgRel, svgAbs, svg: String(svg) };
}

/**
 * Write content into library/ and index it.
 * When filename is .puml/.plantuml, also renders SVG beside it and indexes the
 * diagram entry with path=*.svg and source_path=*.puml (click shows image).
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string|Buffer} opts.content
 * @param {string} [opts.filename]
 * @param {string} [opts.source] upload|hub|agent|system
 * @param {string[]} [opts.tags]
 * @param {boolean} [opts.overwrite]
 * @param {boolean} [opts.render=true] render PlantUML when adding .puml
 * @param {string} [opts.source_path] companion .puml when adding a pre-rendered image
 * @param {string} [opts.kind] force kind (diagram|document|plantuml)
 * @param {string} [opts.type] alias of kind for manifest consumers
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
  const ext = extOf(filename);
  const shouldRender = opts.render !== false && PLANTUML_EXT.has(ext);

  let entryPath = filename;
  let sourcePath = opts.source_path ? safeFilename(opts.source_path) : undefined;
  let kind = opts.kind || opts.type || null;
  let renderError = null;

  if (shouldRender) {
    try {
      const { svgRel } = renderPumlBeside(hub, filename, buffer.toString('utf8'));
      entryPath = svgRel;
      sourcePath = filename;
      kind = 'diagram';
    } catch (err) {
      // Keep the .puml entry viewable; UI can still on-demand render.
      kind = 'plantuml';
      renderError = err.message || String(err);
    }
  } else if (IMAGE_EXT.has(ext)) {
    kind = kind || 'diagram';
  } else if (PLANTUML_EXT.has(ext)) {
    kind = kind || 'plantuml';
  } else {
    kind = kind || 'document';
  }

  const entry = {
    id,
    title,
    path: entryPath,
    created_at: new Date().toISOString(),
    source: opts.source || 'upload',
    tags: Array.isArray(opts.tags) ? opts.tags.map(String).slice(0, 12) : [],
    kind,
    type: kind === 'diagram' ? 'diagram' : (opts.type || kind),
  };
  if (sourcePath) entry.source_path = sourcePath;
  if (renderError) entry.render_error = renderError;

  const man = readManifest(hub);
  // Replace same id, primary path, or companion source path
  const dropPaths = new Set([entryPath, filename, sourcePath].filter(Boolean));
  man.entries = man.entries.filter(
    (e) => e.id !== id && !dropPaths.has(e.path) && !dropPaths.has(e.source_path),
  );
  man.entries.unshift(entry);
  writeManifest(hub, man);

  const { abs: finalAbs } = resolveLibraryFile(hub, entryPath);
  const st = fs.statSync(finalAbs);
  return enrichEntry(entry, st);
}

/**
 * Convenience: publish a PlantUML diagram (source + rendered SVG + manifest).
 * Equivalent to addLibraryDocument with a .puml filename.
 */
function addLibraryDiagram(hub, opts = {}) {
  const title = String(opts.title || 'Diagram').trim() || 'Diagram';
  const day = new Date().toISOString().slice(0, 10);
  const filename = opts.filename
    ? safeFilename(opts.filename)
    : safeFilename(`${day}-${slugifyTitle(title)}.puml`);
  const ext = extOf(filename);
  if (!PLANTUML_EXT.has(ext)) {
    throw new Error('addLibraryDiagram requires a .puml / .plantuml filename');
  }
  return addLibraryDocument(hub, {
    ...opts,
    title,
    filename,
    tags: Array.isArray(opts.tags)
      ? Array.from(new Set([...opts.tags.map(String), 'diagram'])).slice(0, 12)
      : ['diagram'],
    render: true,
  });
}

module.exports = {
  ALLOWED_EXT,
  DIAGRAM_EXT,
  IMAGE_EXT,
  MAX_BYTES,
  PLANTUML_EXT,
  TEXT_EXT,
  addLibraryDiagram,
  addLibraryDocument,
  contentTypeForExt,
  ensureLibrary,
  extOf,
  getLibraryEntry,
  isDiagramLibraryExt,
  isTextLibraryExt,
  kindForEntry,
  libraryRoot,
  listLibrary,
  readManifest,
  renderPumlBeside,
  resolveLibraryFile,
  safeFilename,
  writeManifest,
};
