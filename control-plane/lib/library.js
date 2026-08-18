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

/** Directories never shown in Library tree browse (noise / secrets / huge trees). */
const BROWSE_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.bizagent',
  'logs',
  'inbox',
  'outbox',
  'archive',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'tmp',
  'temp',
]);

const MAX_TREE_NODES = 2500;
const MAX_TREE_DEPTH = 8;

function isViewableLibraryExt(ext) {
  return ALLOWED_EXT.has(String(ext || '').toLowerCase());
}

function safeRelSegments(relPath) {
  const parts = String(relPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..' || p.includes('\0'))) {
    throw new Error('path escapes root');
  }
  if (parts.some((p) => p.startsWith('.'))) {
    throw new Error('dotfiles not allowed');
  }
  return parts;
}

/**
 * Resolve a relative path under an absolute root (no escape).
 * Empty rel → root itself.
 */
function resolveUnderRoot(rootAbs, relPath) {
  const root = path.resolve(rootAbs);
  const parts = safeRelSegments(relPath);
  const abs = parts.length ? path.resolve(root, ...parts) : root;
  const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootSep)) {
    throw new Error('path escapes root');
  }
  return { root, abs, rel: parts.join('/') };
}

function titleFromManifest(hub) {
  const map = new Map();
  try {
    const man = readManifest(hub);
    for (const e of man.entries || []) {
      if (!e || !e.path) continue;
      const key = String(e.path).replace(/\\/g, '/');
      map.set(key, e);
      if (e.source_path) map.set(String(e.source_path).replace(/\\/g, '/'), e);
      if (e.id) map.set(`id:${e.id}`, e);
    }
  } catch (_err) {
    /* ignore */
  }
  return map;
}

/**
 * List registry project repos (+ hub library entry) for Library accordion nav.
 * @returns {{ repos: Array<object> }}
 */
function listLibraryRepos(hub, registry) {
  const { resolveProjectPath, agentsFromRegistry } = require('./config');
  const repos = [];
  const seen = new Set();

  // Hub curated library/ first — operator-facing deliverables.
  try {
    ensureLibrary(hub);
  } catch (_err) {
    /* still list entry */
  }
  repos.push({
    id: 'hub-library',
    name: 'Hub library',
    label: 'Hub library',
    kind: 'hub-library',
    product: 'hub',
    product_name: 'BizAgent',
    path: 'library/',
    available: true,
  });
  seen.add(path.resolve(libraryRoot(hub)));

  const agents = agentsFromRegistry(registry || {}, hub);
  for (const agent of agents) {
    const projects = Array.isArray(agent.projects) ? agent.projects : [];
    for (const proj of projects) {
      const name = String(proj.name || '').trim();
      if (!name) continue;
      const abs = resolveProjectPath(hub, proj.path);
      if (!abs) continue;
      const key = path.resolve(abs);
      if (seen.has(key)) continue;
      seen.add(key);
      let available = false;
      try {
        available = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
      } catch (_err) {
        available = false;
      }
      repos.push({
        id: `repo:${agent.slug}:${name}`,
        name,
        label: name,
        kind: 'project',
        product: agent.slug,
        product_name: agent.name || agent.slug,
        path: String(proj.path || ''),
        remote: String(proj.remote || ''),
        available,
      });
    }
  }

  return { repos };
}

function findRepoById(hub, registry, repoId) {
  const { repos } = listLibraryRepos(hub, registry);
  const id = String(repoId || '').trim();
  const hit = repos.find((r) => r.id === id);
  if (!hit) throw new Error('repo not found');
  if (hit.kind === 'hub-library') {
    return {
      ...hit,
      rootAbs: libraryRoot(hub),
      browseRootLabel: 'library',
    };
  }
  const { resolveProjectPath } = require('./config');
  const rootAbs = resolveProjectPath(hub, hit.path);
  if (!rootAbs || !fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
    throw new Error('repo path not available on disk');
  }
  return {
    ...hit,
    rootAbs,
    browseRootLabel: hit.name,
  };
}

/**
 * Build a filtered tree of viewable files + directories under a repo.
 * Only dirs that contain (recursively) at least one viewable file are kept.
 */
function buildViewableTree(rootAbs, { maxNodes = MAX_TREE_NODES, maxDepth = MAX_TREE_DEPTH } = {}) {
  let nodes = 0;

  function walk(dirAbs, relBase, depth) {
    if (depth > maxDepth) return [];
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (_err) {
      return [];
    }
    const dirs = [];
    const files = [];
    for (const ent of entries) {
      if (!ent || !ent.name) continue;
      if (ent.name.startsWith('.')) continue;
      if (ent.isSymbolicLink && ent.isSymbolicLink()) continue;
      const abs = path.join(dirAbs, ent.name);
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch (_err) {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (BROWSE_SKIP_DIRS.has(ent.name)) continue;
        dirs.push({ name: ent.name, abs, rel });
      } else if (st.isFile()) {
        const ext = extOf(ent.name);
        if (!isViewableLibraryExt(ext)) continue;
        files.push({ name: ent.name, abs, rel, ext, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    const children = [];
    for (const d of dirs) {
      if (nodes >= maxNodes) break;
      const kids = walk(d.abs, d.rel, depth + 1);
      if (!kids.length) continue; // drop empty / noise-only dirs
      nodes += 1;
      children.push({
        type: 'dir',
        name: d.name,
        path: d.rel,
        children: kids,
      });
    }
    for (const f of files) {
      if (nodes >= maxNodes) break;
      nodes += 1;
      children.push({
        type: 'file',
        name: f.name,
        path: f.rel,
        ext: f.ext,
        size: f.size,
        mtime: f.mtime,
        kind: kindForEntry(null, f.rel),
      });
    }
    return children;
  }

  const tree = walk(path.resolve(rootAbs), '', 0);
  return { tree, node_count: nodes, truncated: nodes >= maxNodes };
}

function getLibraryRepoTree(hub, registry, repoId) {
  const repo = findRepoById(hub, registry, repoId);
  const { tree, node_count, truncated } = buildViewableTree(repo.rootAbs);
  return {
    repo: {
      id: repo.id,
      name: repo.name,
      label: repo.label || repo.name,
      kind: repo.kind,
      product: repo.product,
      product_name: repo.product_name,
      path: repo.path,
      available: true,
    },
    tree,
    node_count,
    truncated,
  };
}

/**
 * Read a viewable file from a repo tree (or hub library/) for Library preview.
 * Supports nested paths. Manifest metadata applied when path matches hub library/.
 */
function getLibraryBrowseFile(hub, registry, repoId, relPath) {
  const repo = findRepoById(hub, registry, repoId);
  const { abs, rel } = resolveUnderRoot(repo.rootAbs, relPath);
  if (!rel) throw new Error('path required');
  if (!fs.existsSync(abs)) throw new Error('not found');
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > MAX_BYTES) throw new Error('file too large to view');
  const ext = extOf(rel);
  if (!isViewableLibraryExt(ext)) throw new Error('file type not viewable in Library');

  const text = isTextLibraryExt(ext);
  const content = text ? fs.readFileSync(abs, 'utf8') : null;
  const base = {
    id: `${repo.id}:${rel}`,
    title: path.basename(rel),
    path: rel,
    repo_id: repo.id,
    repo_name: repo.name,
    source: repo.kind === 'hub-library' ? 'library' : 'repo',
    tags: [],
    created_at: st.mtime.toISOString(),
  };

  // Overlay hub library/manifest metadata when browsing hub-library.
  if (repo.kind === 'hub-library') {
    const man = titleFromManifest(hub);
    const hit = man.get(rel);
    if (hit) {
      if (hit.id) base.manifest_id = hit.id;
      if (hit.title) base.title = hit.title;
      if (hit.source) base.source = hit.source;
      if (Array.isArray(hit.tags)) base.tags = hit.tags;
      if (hit.created_at) base.created_at = hit.created_at;
      if (hit.source_path) base.source_path = hit.source_path;
      if (hit.kind) base.kind = hit.kind;
      if (hit.type) base.type = hit.type;
    }
  }

  const enriched = enrichEntry(base, st);
  let source_content = null;
  if (base.source_path) {
    try {
      const src = resolveUnderRoot(repo.rootAbs, base.source_path);
      if (fs.existsSync(src.abs) && isTextLibraryExt(extOf(src.rel))) {
        source_content = fs.readFileSync(src.abs, 'utf8');
      }
    } catch (_err) {
      /* ignore */
    }
  } else if (IMAGE_EXT.has(ext)) {
    // Companion .puml next to rendered image (common convention).
    const stem = stemOf(path.basename(rel));
    const dir = path.dirname(rel);
    for (const pumlExt of ['.puml', '.plantuml']) {
      const candidate = dir && dir !== '.' ? `${dir}/${stem}${pumlExt}` : `${stem}${pumlExt}`;
      try {
        const src = resolveUnderRoot(repo.rootAbs, candidate);
        if (fs.existsSync(src.abs)) {
          source_content = fs.readFileSync(src.abs, 'utf8');
          enriched.source_path = candidate;
          break;
        }
      } catch (_err) {
        /* ignore */
      }
    }
  }

  return {
    ...enriched,
    content: content == null ? '' : content,
    binary: !text,
    source_content,
  };
}

/** Resolve absolute path for a browse file (raw/download/render). */
function resolveBrowseFile(hub, registry, repoId, relPath) {
  const repo = findRepoById(hub, registry, repoId);
  const { abs, rel } = resolveUnderRoot(repo.rootAbs, relPath);
  if (!rel) throw new Error('path required');
  if (!fs.existsSync(abs)) throw new Error('not found');
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('not a file');
  const ext = extOf(rel);
  if (!isViewableLibraryExt(ext)) throw new Error('file type not viewable in Library');
  return { repo, abs, rel, ext, st };
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
  BROWSE_SKIP_DIRS,
  DIAGRAM_EXT,
  IMAGE_EXT,
  MAX_BYTES,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  PLANTUML_EXT,
  TEXT_EXT,
  addLibraryDiagram,
  addLibraryDocument,
  buildViewableTree,
  contentTypeForExt,
  ensureLibrary,
  extOf,
  findRepoById,
  getLibraryBrowseFile,
  getLibraryEntry,
  getLibraryRepoTree,
  isDiagramLibraryExt,
  isTextLibraryExt,
  isViewableLibraryExt,
  kindForEntry,
  libraryRoot,
  listLibrary,
  listLibraryRepos,
  readManifest,
  renderPumlBeside,
  resolveBrowseFile,
  resolveLibraryFile,
  resolveUnderRoot,
  safeFilename,
  writeManifest,
};
