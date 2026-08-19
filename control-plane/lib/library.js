'use strict';

/**
 * Operator-facing Library — browse hub curated dirs + registry project repos.
 *
 * Accordion roots:
 *   - Hub (hub root filtered to docs/, company/, reports/)
 *   - Each registry project repo (viewable-file tree)
 *
 * No library/manifest.json. Filesystem walk + inclusion filters only.
 *
 * File types:
 *   .md → markdown preview
 *   .puml → PlantUML render (on-demand SVG)
 *   .svg/.png → diagram image
 *   other allowed text → code/text preview
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

/** Top-level hub dirs included in the Hub accordion section (only these). */
const HUB_INCLUDE_DIRS = ['docs', 'company', 'reports'];
const HUB_INCLUDE_SET = new Set(HUB_INCLUDE_DIRS);

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
  'agents',
  'control-plane',
  'knowledge-stack',
  'library',
  'scripts',
  'templates',
  'user',
  'install',
  'tests',
  'agent-runtime',
]);

const MAX_TREE_NODES = 2500;
const MAX_TREE_DEPTH = 8;

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

function hubRoot(hub) {
  return path.resolve(hub);
}

/** @deprecated Prefer docs/ for operator deliverables. Kept for path helpers. */
function libraryRoot(hub) {
  return path.resolve(hub, 'library');
}

/**
 * Ensure hub curated browse dirs exist (docs/ always; company/reports optional).
 * Does not create or touch library/manifest.json.
 */
function ensureLibrary(hub) {
  const root = hubRoot(hub);
  const docs = path.join(root, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  const diagrams = path.join(docs, 'diagrams');
  fs.mkdirSync(diagrams, { recursive: true });
  // company/ and reports/ are optional — created when content lands.
  return root;
}

function safeFilename(name) {
  let base = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC');
  if (!base || base === '.' || base === '..') throw new Error('invalid filename');
  if (base.startsWith('.')) throw new Error('dotfiles not allowed');
  base = base.replace(/[^A-Za-z0-9._()[\] +\-~']/g, '_').replace(/^_+/, '');
  if (!base) throw new Error('invalid filename after sanitize');
  const ext = path.extname(base).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
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

/**
 * Read .accordion-ignore patterns (one basename or relative glob-ish name per line).
 * Supports exact basenames and simple suffix globs like "*.tmp".
 */
function loadAccordionIgnore(dirAbs) {
  const ignorePath = path.join(dirAbs, '.accordion-ignore');
  const patterns = new Set();
  try {
    if (!fs.existsSync(ignorePath)) return patterns;
    const text = fs.readFileSync(ignorePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      patterns.add(t);
    }
  } catch (_err) {
    /* ignore */
  }
  return patterns;
}

function matchesIgnore(name, patterns) {
  if (!patterns || !patterns.size) return false;
  if (patterns.has(name)) return true;
  for (const p of patterns) {
    if (p.startsWith('*.') && name.endsWith(p.slice(1))) return true;
  }
  return false;
}

/**
 * List accordion roots: Hub (filtered hub dirs) + registry project repos.
 * @returns {{ repos: Array<object> }}
 */
function listLibraryRepos(hub, registry) {
  const { resolveProjectPath, agentsFromRegistry } = require('./config');
  const repos = [];
  const seen = new Set();

  try {
    ensureLibrary(hub);
  } catch (_err) {
    /* still list entry */
  }

  // Hub root first — operator-facing curated dirs only (docs/company/reports).
  repos.push({
    id: 'hub',
    name: 'Hub',
    label: 'Hub',
    kind: 'hub',
    product: 'hub',
    product_name: 'BizAgent',
    path: '.',
    include: HUB_INCLUDE_DIRS.slice(),
    available: true,
  });
  seen.add(hubRoot(hub));

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

  // Legacy alias: old "hub-library" deep links → hub root browse.
  const normalizedId = id === 'hub-library' ? 'hub' : id;
  const hit = repos.find((r) => r.id === normalizedId);
  if (!hit) throw new Error('repo not found');

  if (hit.kind === 'hub') {
    return {
      ...hit,
      id: 'hub',
      rootAbs: hubRoot(hub),
      browseRootLabel: 'hub',
      includeOnly: HUB_INCLUDE_SET,
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
    includeOnly: null,
  };
}

/**
 * Build a filtered tree of viewable files + directories under a repo.
 * Only dirs that contain (recursively) at least one viewable file are kept.
 *
 * @param {string} rootAbs
 * @param {object} [opts]
 * @param {Set<string>|null} [opts.includeOnly] when set (hub), only these top-level dir names
 */
function buildViewableTree(rootAbs, {
  maxNodes = MAX_TREE_NODES,
  maxDepth = MAX_TREE_DEPTH,
  includeOnly = null,
} = {}) {
  let nodes = 0;
  const rootIgnore = loadAccordionIgnore(path.resolve(rootAbs));

  function walk(dirAbs, relBase, depth) {
    if (depth > maxDepth) return [];
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (_err) {
      return [];
    }
    const dirIgnore = loadAccordionIgnore(dirAbs);
    const ignore = new Set([...rootIgnore, ...dirIgnore]);

    const dirs = [];
    const files = [];
    for (const ent of entries) {
      if (!ent || !ent.name) continue;
      if (ent.name.startsWith('.')) continue;
      if (matchesIgnore(ent.name, ignore)) continue;
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
        // Hub root: only include allowlisted top-level directories.
        if (depth === 0 && includeOnly && !includeOnly.has(ent.name)) continue;
        dirs.push({ name: ent.name, abs, rel });
      } else if (st.isFile()) {
        // Hub root: never list loose files at hub root (NIGHTLY.md, registry.json, …).
        if (depth === 0 && includeOnly) continue;
        const ext = extOf(ent.name);
        if (!isViewableLibraryExt(ext)) continue;
        files.push({
          name: ent.name,
          abs,
          rel,
          ext,
          size: st.size,
          mtime: st.mtime.toISOString(),
        });
      }
    }
    // Sort: dirs first (already separate), alpha within each.
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
  const { tree, node_count, truncated } = buildViewableTree(repo.rootAbs, {
    includeOnly: repo.includeOnly || null,
  });
  return {
    repo: {
      id: repo.id,
      name: repo.name,
      label: repo.label || repo.name,
      kind: repo.kind,
      product: repo.product,
      product_name: repo.product_name,
      path: repo.path,
      include: repo.include || undefined,
      available: true,
    },
    tree,
    node_count,
    truncated,
  };
}

/**
 * Assert a hub browse path is under an included top-level dir.
 */
function assertHubPathAllowed(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length) throw new Error('path required');
  if (!HUB_INCLUDE_SET.has(parts[0])) {
    throw new Error('path not in hub Library include list (docs/, company/, reports/)');
  }
}

/**
 * Read a viewable file from a repo tree (or hub curated dirs) for Library preview.
 */
function getLibraryBrowseFile(hub, registry, repoId, relPath) {
  const repo = findRepoById(hub, registry, repoId);
  const { abs, rel } = resolveUnderRoot(repo.rootAbs, relPath);
  if (!rel) throw new Error('path required');
  if (repo.kind === 'hub') assertHubPathAllowed(rel);
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
    source: repo.kind === 'hub' ? 'hub' : 'repo',
    tags: [],
    created_at: st.mtime.toISOString(),
  };

  const enriched = enrichEntry(base, st);
  let source_content = null;
  if (IMAGE_EXT.has(ext)) {
    // Companion .puml next to rendered image (common convention).
    const stem = stemOf(path.basename(rel));
    const dir = path.dirname(rel);
    for (const pumlExt of ['.puml', '.plantuml']) {
      const candidate = dir && dir !== '.' ? `${dir}/${stem}${pumlExt}` : `${stem}${pumlExt}`;
      try {
        const src = resolveUnderRoot(repo.rootAbs, candidate);
        if (repo.kind === 'hub') {
          try {
            assertHubPathAllowed(candidate);
          } catch (_e) {
            continue;
          }
        }
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
  if (repo.kind === 'hub') assertHubPathAllowed(rel);
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

/**
 * List viewable files under hub include dirs (filesystem walk; no manifest).
 * Replaces former manifest-based listLibrary.
 */
function listLibrary(hub) {
  ensureLibrary(hub);
  const root = hubRoot(hub);
  const { tree } = buildViewableTree(root, { includeOnly: HUB_INCLUDE_SET });
  const entries = [];

  function walk(nodes) {
    for (const n of nodes || []) {
      if (n.type === 'file') {
        entries.push(
          enrichEntry(
            {
              id: `hub:${n.path}`,
              title: n.name,
              path: n.path,
              created_at: n.mtime,
              source: 'hub',
              tags: [],
            },
            { size: n.size, mtime: new Date(n.mtime) },
          ),
        );
      } else {
        walk(n.children);
      }
    }
  }
  walk(tree);
  entries.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return { root: 'hub/', include: HUB_INCLUDE_DIRS.slice(), entries };
}

/**
 * Legacy id/path lookup for old deep links.
 * Tries hub include dirs by relative path or basename; fails gracefully (throws not found).
 */
function getLibraryEntry(hub, idOrPath) {
  ensureLibrary(hub);
  const key = String(idOrPath || '').trim();
  if (!key) throw new Error('not found');

  // Strip legacy prefixes.
  let rel = key;
  if (rel.startsWith('hub:')) rel = rel.slice(4);
  if (rel.startsWith('hub-library:')) rel = rel.slice('hub-library:'.length);
  if (rel.startsWith('library/')) rel = rel.slice('library/'.length);

  // Direct path under include dirs.
  const candidates = [];
  if (rel.includes('/')) {
    candidates.push(rel);
  } else {
    // Basename search under include dirs (and docs/diagrams for migrated smoke files).
    for (const top of HUB_INCLUDE_DIRS) {
      candidates.push(`${top}/${rel}`);
      candidates.push(`${top}/diagrams/${rel}`);
    }
    // Legacy library/ location (excluded from accordion but still resolvable for old links).
    candidates.push(`library/${rel}`);
  }

  const root = hubRoot(hub);
  for (const c of candidates) {
    try {
      const parts = safeRelSegments(c);
      if (!parts.length) continue;
      const top = parts[0];
      // Allow legacy library/ only for this fallback path.
      if (!HUB_INCLUDE_SET.has(top) && top !== 'library') continue;
      const { abs, rel: resolved } = resolveUnderRoot(root, parts.join('/'));
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > MAX_BYTES) throw new Error('file too large to view');
      const ext = extOf(resolved);
      if (!isViewableLibraryExt(ext)) continue;
      const text = isTextLibraryExt(ext);
      const content = text ? fs.readFileSync(abs, 'utf8') : null;
      const enriched = enrichEntry(
        {
          id: key.startsWith('lib_') ? key : `hub:${resolved}`,
          title: path.basename(resolved),
          path: resolved,
          created_at: st.mtime.toISOString(),
          source: top === 'library' ? 'library-legacy' : 'hub',
          tags: [],
        },
        st,
      );
      let source_content = null;
      if (IMAGE_EXT.has(ext)) {
        const stem = stemOf(path.basename(resolved));
        const dir = path.dirname(resolved);
        for (const pumlExt of ['.puml', '.plantuml']) {
          const candidate = dir && dir !== '.' ? `${dir}/${stem}${pumlExt}` : `${stem}${pumlExt}`;
          try {
            const src = resolveUnderRoot(root, candidate);
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
    } catch (err) {
      if (/too large/i.test(err.message || '')) throw err;
      /* try next candidate */
    }
  }
  throw new Error('not found');
}

/**
 * Resolve a legacy library/ top-level file (for old id= download paths).
 * Prefers docs/diagrams then docs then library.
 */
function resolveLibraryFile(hub, relPath) {
  const raw = String(relPath || '').replace(/\\/g, '/');
  if (!raw || raw.includes('..') || raw.startsWith('/')) {
    throw new Error('path escapes library/');
  }
  // Nested paths: resolve under hub with include check (or library legacy).
  if (raw.includes('/')) {
    const root = hubRoot(hub);
    const { abs, rel } = resolveUnderRoot(root, raw);
    const top = rel.split('/')[0];
    if (!HUB_INCLUDE_SET.has(top) && top !== 'library') {
      throw new Error('path not allowed');
    }
    return { root, abs, rel };
  }
  const name = safeFilename(raw);
  const root = hubRoot(hub);
  const tryPaths = [
    path.join(root, 'docs', 'diagrams', name),
    path.join(root, 'docs', name),
    path.join(root, 'company', name),
    path.join(root, 'reports', name),
    path.join(root, 'library', name),
  ];
  for (const abs of tryPaths) {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      return { root, abs, rel };
    }
  }
  // Default write/read target for new top-level names: docs/
  const abs = path.join(root, 'docs', name);
  return { root, abs, rel: `docs/${name}` };
}

/**
 * Render PlantUML source to SVG next to a .puml path (under hub).
 * @returns {{ svgRel: string, svgAbs: string, svg: string }}
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
  const root = hubRoot(hub);
  const { abs: pumlAbs, rel: pumlResolved } = resolveUnderRoot(
    root,
    String(pumlRel || '').replace(/\\/g, '/'),
  );
  const dir = path.dirname(pumlAbs);
  const svgName = `${stemOf(path.basename(pumlResolved))}.svg`;
  const svgAbs = path.join(dir, svgName);
  const svgRel = path.relative(root, svgAbs).split(path.sep).join('/');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(svgAbs, String(svg), 'utf8');
  return { svgRel, svgAbs, svg: String(svg) };
}

/**
 * Write content into docs/ (operator-facing) without a manifest.
 * When filename is .puml/.plantuml, also renders SVG beside it.
 *
 * Default location: docs/ for markdown, docs/diagrams/ for diagrams.
 */
function addLibraryDocument(hub, opts = {}) {
  const title = String(opts.title || opts.filename || 'Untitled').trim() || 'Untitled';
  let buffer = opts.content;
  if (typeof buffer === 'string') buffer = Buffer.from(buffer, 'utf8');
  if (!Buffer.isBuffer(buffer)) throw new Error('content required');
  if (buffer.length === 0) throw new Error('empty content');
  if (buffer.length > MAX_BYTES) throw new Error(`file too large (max ${MAX_BYTES} bytes)`);

  ensureLibrary(hub);
  const root = hubRoot(hub);
  const day = new Date().toISOString().slice(0, 10);
  let filename = opts.filename
    ? safeFilename(opts.filename)
    : safeFilename(`${day}-${slugifyTitle(title)}.md`);

  const ext0 = extOf(filename);
  const isDiagramFile = PLANTUML_EXT.has(ext0) || IMAGE_EXT.has(ext0);
  const subdir = opts.subdir
    ? String(opts.subdir).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    : isDiagramFile
      ? 'docs/diagrams'
      : 'docs';
  // Only allow writes under include dirs.
  const top = subdir.split('/')[0];
  if (!HUB_INCLUDE_SET.has(top)) {
    throw new Error('subdir must be under docs/, company/, or reports/');
  }

  let rel = `${subdir}/${filename}`;
  let abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs) && !opts.overwrite) {
    const stem = filename.replace(/\.[^.]+$/, '');
    const ext = path.extname(filename) || '.md';
    filename = safeFilename(`${stem}-${crypto.randomBytes(2).toString('hex')}${ext}`);
    rel = `${subdir}/${filename}`;
    abs = path.join(root, ...rel.split('/'));
  }

  fs.writeFileSync(abs, buffer);
  const id = opts.id || newId();
  const ext = extOf(filename);
  const shouldRender = opts.render !== false && PLANTUML_EXT.has(ext);

  let entryPath = rel;
  let sourcePath = opts.source_path
    ? String(opts.source_path).replace(/\\/g, '/')
    : undefined;
  let kind = opts.kind || opts.type || null;
  let renderError = null;

  if (shouldRender) {
    try {
      const { svgRel } = renderPumlBeside(hub, rel, buffer.toString('utf8'));
      entryPath = svgRel;
      sourcePath = rel;
      kind = 'diagram';
    } catch (err) {
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

  const finalAbs = path.join(root, ...entryPath.split('/'));
  const st = fs.statSync(finalAbs);
  return enrichEntry(entry, st);
}

/**
 * Convenience: publish a PlantUML diagram under docs/diagrams/ (no manifest).
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
    subdir: opts.subdir || 'docs/diagrams',
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
  HUB_INCLUDE_DIRS,
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
  hubRoot,
  isDiagramLibraryExt,
  isTextLibraryExt,
  isViewableLibraryExt,
  kindForEntry,
  libraryRoot,
  listLibrary,
  listLibraryRepos,
  renderPumlBeside,
  resolveBrowseFile,
  resolveLibraryFile,
  resolveUnderRoot,
  safeFilename,
};
