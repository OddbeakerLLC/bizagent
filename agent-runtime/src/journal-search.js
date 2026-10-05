'use strict';

/**
 * Journal search (MVP spec: docs/2026-10-05-journal-search-mvp-spec.md).
 *
 * Keyword FTS over journals only — SQLite FTS5 via the sqlite3 CLI when
 * available, ripgrep fallback over the same corpus otherwise. No embeddings,
 * no vector DB, no KS/docs/sitemap indexing.
 *
 * Corpus:
 *   - hub notebook:        <hub>/journal/*.md            (source=hub)
 *   - product projects:    <registry products[].projects[].path>/.agent/journal/*.md
 *
 * Scope (mandatory, spec §8):
 *   - hub runtime (BIZAGENT_AGENT_SLUG unset or 'hub'): all sources; optional
 *     product_slug filter.
 *   - product agent (BIZAGENT_AGENT_SLUG=<slug>): that product's journals only.
 *     A requested product_slug for another product is ignored — never return
 *     another product's rows.
 *
 * Index file: <hub>/.bizagent/journal-fts.sqlite (local cache; safe to delete).
 * Stale-on-query: if the DB is missing or older than the newest journal
 * mtime among known roots, incrementally rebuild before searching.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

const MAX_FILE_BYTES = 1024 * 1024; // skip files > 1 MiB
const SNIPPET_CHARS = 240;
const MAX_OUTPUT_CHARS = 8000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const RECENCY_WEIGHT = 0.01; // light recency boost among similar bm25 scores

const DB_REL = path.join('.bizagent', 'journal-fts.sqlite');

function resolveHubRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.BIZAGENT_HUB) return path.resolve(process.env.BIZAGENT_HUB);
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, 'registry.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function loadRegistry(hubRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(hubRoot, 'registry.json'), 'utf8'));
  } catch (_err) {
    return {};
  }
}

function utcDateOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function journalDate(basename, mtimeMs) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(basename);
  return m ? m[1] : utcDateOf(mtimeMs);
}

/**
 * Walk the corpus. Regular files only (symlinks skipped), *.md only,
 * skip *.bak / editor junk, skip > 1 MiB and non-UTF-8.
 */
function listJournalFiles(hubRoot, registry) {
  const roots = [];

  roots.push({
    dir: path.join(hubRoot, 'journal'),
    source: 'hub',
    productSlug: '',
    projectName: '',
  });

  const products = Array.isArray(registry.products) ? registry.products : [];
  for (const product of products) {
    const slug = String((product && product.slug) || '').trim();
    if (!slug) continue;
    const projects = Array.isArray(product.projects) ? product.projects : [];
    for (const project of projects) {
      const rel = String((project && project.path) || '').trim();
      if (!rel) continue;
      const expanded = rel.startsWith('~') ? path.join(process.env.HOME || '', rel.slice(1)) : rel;
      const abs = path.isAbsolute(expanded) ? expanded : path.join(hubRoot, expanded);
      roots.push({
        dir: path.join(abs, '.agent', 'journal'),
        source: 'product',
        productSlug: slug,
        projectName: String((project && project.name) || '').trim(),
      });
    }
  }

  const files = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch (_err) {
      continue; // missing directory — skip
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue; // skips symlinks too (do not follow)
      const name = entry.name;
      if (!name.endsWith('.md')) continue;
      if (name.endsWith('.bak') || name.startsWith('.')) continue;
      if (name.endsWith('~') || /~$/.test(name)) continue;
      const abs = path.join(root.dir, name);
      let st;
      try {
        st = fs.statSync(abs);
      } catch (_err) {
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      let body;
      try {
        body = fs.readFileSync(abs, 'utf8');
      } catch (_err) {
        continue; // unreadable or not valid UTF-8
      }
      files.push({
        abs,
        rel: path.relative(hubRoot, abs),
        source: root.source,
        productSlug: root.productSlug,
        projectName: root.projectName,
        date: journalDate(name, st.mtimeMs),
        mtimeMs: Math.round(st.mtimeMs),
        size: st.size,
        body,
      });
    }
  }
  return files;
}

function sqlQuote(value) {
  return `'${String(value == null ? '' : value).replace(/\0/g, '').replace(/'/g, "''")}'`;
}

function runSqlite(dbFile, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', ['-batch', dbFile], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`sqlite3 exited ${code}: ${stderr.trim().slice(0, 400)}`));
    });
    child.stdin.end(sql);
  });
}

async function sqliteAvailable() {
  try {
    await runSqlite(':memory:', 'CREATE VIRTUAL TABLE t USING fts5(x);\nINSERT INTO t VALUES (\'ok\');\n');
    return true;
  } catch (_err) {
    return false;
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime_ms INTEGER, size INTEGER);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS j USING fts5(
  path UNINDEXED, source UNINDEXED, product_slug UNINDEXED,
  project_name UNINDEXED, date UNINDEXED, body
);
`;

/**
 * Incremental rebuild: reindex files whose size/mtime changed, drop vanished.
 * Idempotent.
 */
async function buildIndex(hubRoot, corpus) {
  const dbFile = path.join(hubRoot, DB_REL);
  await fsp.mkdir(path.dirname(dbFile), { recursive: true });

  const current = new Map(corpus.map((f) => [f.rel, f]));
  let known = new Map();
  try {
    const { stdout } = await runSqlite(
      dbFile,
      "SELECT path, mtime_ms, size FROM files;\n",
    );
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [p, m, s] = line.split('|');
      known.set(p, { mtimeMs: Number(m), size: Number(s) });
    }
  } catch (_err) {
    known = new Map(); // fresh/corrupt DB — reindex everything
  }

  const stmts = [];
  // Vanished files: drop rows.
  for (const p of known.keys()) {
    if (!current.has(p)) {
      stmts.push(`DELETE FROM files WHERE path=${sqlQuote(p)};`);
      stmts.push(`DELETE FROM j WHERE path=${sqlQuote(p)};`);
    }
  }
  // Changed/new files: reindex.
  for (const f of corpus) {
    const prev = known.get(f.rel);
    if (prev && prev.mtimeMs === f.mtimeMs && prev.size === f.size) continue;
    stmts.push(`DELETE FROM files WHERE path=${sqlQuote(f.rel)};`);
    stmts.push(`DELETE FROM j WHERE path=${sqlQuote(f.rel)};`);
    stmts.push(
      `INSERT INTO files VALUES (${sqlQuote(f.rel)}, ${f.mtimeMs}, ${f.size});`,
    );
    stmts.push(
      `INSERT INTO j VALUES (${sqlQuote(f.rel)}, ${sqlQuote(f.source)}, ` +
        `${sqlQuote(f.productSlug)}, ${sqlQuote(f.projectName)}, ` +
        `${sqlQuote(f.date)}, ${sqlQuote(f.body)});`,
    );
  }
  const newestMtime = corpus.reduce((acc, f) => Math.max(acc, f.mtimeMs), 0);
  stmts.push(
    `INSERT OR REPLACE INTO meta VALUES ('newest_mtime_ms', '${newestMtime}');`,
  );

  // Always run the schema (idempotent) so a fresh/empty corpus still yields a
  // queryable DB. `corpus` must be the FULL corpus — product filtering happens
  // at query time so a scoped rebuild never deletes other products' rows.
  await runSqlite(dbFile, SCHEMA_SQL + stmts.join('\n') + '\n');
  return { dbFile, updated: stmts.length > 0, newestMtime };
}

/**
 * Stale-on-query: rebuild when DB missing or older than newest journal mtime.
 */
async function ensureFresh(hubRoot, corpus) {
  const dbFile = path.join(hubRoot, DB_REL);
  const newestMtime = corpus.reduce((acc, f) => Math.max(acc, f.mtimeMs), 0);
  let stored = -1;
  try {
    const { stdout } = await runSqlite(
      dbFile,
      "SELECT value FROM meta WHERE key='newest_mtime_ms';\n",
    );
    stored = Number(stdout.trim().split('\n').filter(Boolean)[0] || -1);
  } catch (_err) {
    stored = -1;
  }
  if (!fs.existsSync(dbFile) || stored < newestMtime) {
    await buildIndex(hubRoot, corpus);
    return true;
  }
  return false;
}

function ftsQuery(query) {
  const tokens = String(query || '')
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!tokens.length) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' ');
}

function collapse(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function snippetAround(body, needle) {
  const flat = collapse(body);
  if (!needle) return flat.slice(0, SNIPPET_CHARS);
  const idx = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return flat.slice(0, SNIPPET_CHARS);
  const start = Math.max(0, idx - Math.floor((SNIPPET_CHARS - needle.length) / 2));
  return (start > 0 ? '…' : '') + flat.slice(start, start + SNIPPET_CHARS) +
    (start + SNIPPET_CHARS < flat.length ? '…' : '');
}

function inScope(hit, productSlug) {
  if (productSlug) return hit.productSlug === productSlug;
  return true; // hub scope: all sources
}

function inDateRange(hit, since, until) {
  if (since && hit.date < since) return false;
  if (until && hit.date > until) return false;
  return true;
}

/**
 * Ripgrep fallback: same result shape, same filters, no FTS5 required.
 */
async function ripgrepSearch(corpus, { query, productSlug, since, until, limit }) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  const candidates = corpus.filter(
    (f) => inScope(f, productSlug) && inDateRange(f, since, until),
  );
  let matched = new Set();
  try {
    const { stdout } = await execFileAsync(
      'rg',
      ['-l', '--no-messages', '-g', '*.md', query, ...candidates.map((f) => f.abs)],
      { timeout: 20000, maxBuffer: 5 * 1024 * 1024 },
    );
    matched = new Set(stdout.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch (err) {
    if (err && err.code === 1) matched = new Set();
    else throw err;
  }
  const hits = candidates
    .filter((f) => matched.has(f.abs))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit)
    .map((f, i) => ({
      product: f.source === 'hub' ? 'hub' : f.productSlug,
      project: f.projectName || '',
      date: f.date,
      path: f.abs,
      snippet: snippetAround(f.body, collapse(query)),
      score: i,
    }));
  return { engine: 'ripgrep', hits };
}

/**
 * Search journals. See module header for scope rules.
 *
 * opts:
 *   query          required keyword query
 *   productSlug    optional filter (hub scope only; ignored/overridden in product scope)
 *   since, until   optional inclusive YYYY-MM-DD
 *   limit          default 8, clamped 1..20
 *   hubRoot        explicit hub root (tests / CLI); else BIZAGENT_HUB / walk-up
 *   scope          explicit 'hub' | 'product' (tests / CLI); else from env
 *   product        explicit product slug for product scope (tests / CLI); else env
 */
async function journalSearch(opts = {}) {
  const query = String(opts.query || '').trim();
  const limit = Math.min(Math.max(Number(opts.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const since = opts.since ? String(opts.since) : '';
  const until = opts.until ? String(opts.until) : '';
  const hubRoot = resolveHubRoot(opts.hubRoot);

  // Scope resolution (spec §8). Fail closed: product agents stay in-product.
  const envSlug = String(process.env.BIZAGENT_AGENT_SLUG || '').trim();
  let scope;
  let productSlug;
  if (opts.scope === 'hub' || opts.scope === 'product') {
    scope = opts.scope;
  } else if (envSlug && envSlug !== 'hub') {
    scope = 'product';
  } else {
    scope = 'hub';
  }
  if (scope === 'product') {
    productSlug = opts.product || (envSlug && envSlug !== 'hub' ? envSlug : '') ||
      String(opts.productSlug || '');
    if (!productSlug) {
      return { engine: 'none', hits: [], text: 'no journal hits', scope, productSlug: '' };
    }
  } else {
    productSlug = String(opts.productSlug || opts.product || '').trim() || '';
  }

  if (!query) return { engine: 'none', hits: [], text: 'no journal hits', scope, productSlug };

  const registry = loadRegistry(hubRoot);
  const fullCorpus = listJournalFiles(hubRoot, registry);
  const scopedCorpus = productSlug
    ? fullCorpus.filter((f) => f.productSlug === productSlug)
    : fullCorpus;

  const useFts = await sqliteAvailable();
  let engine;
  let hits;

  if (useFts) {
    // Rebuild from the FULL corpus (shared DB); scope filters at query time.
    await ensureFresh(hubRoot, fullCorpus);
    const match = ftsQuery(query);
    if (!match) {
      return { engine: 'sqlite-fts5', hits: [], text: 'no journal hits', scope, productSlug };
    }
    const where = ['j MATCH ' + sqlQuote(match)];
    if (productSlug) {
      where.push('product_slug = ' + sqlQuote(productSlug));
    }
    if (since) {
      where.push('date >= ' + sqlQuote(since));
    }
    if (until) {
      where.push('date <= ' + sqlQuote(until));
    }
    const sql =
      `SELECT path, source, product_slug, project_name, date,` +
      ` replace(replace(snippet(j, 5, '>>', '<<', '…', 14), char(10), ' '), char(13), ' ') AS snip,` +
      ` bm25(j) AS score` +
      ` FROM j WHERE ${where.join(' AND ')}` +
      ` ORDER BY score + (julianday('now') - julianday(date)) * ${RECENCY_WEIGHT}` +
      ` LIMIT ${limit};`;
    try {
      const { stdout } = await runSqlite(path.join(hubRoot, DB_REL), sql);
      hits = stdout
        .split('\n')
        .filter((l) => l.trim())
        .map((line) => {
          // snippet may contain '|'; parse from the right for the score, then
          // fixed leading columns, remainder is the snippet.
          const parts = line.split('|');
          const score = Number(parts.pop());
          const snip = parts.slice(5).join('|');
          const [p, source, slug, project, date] = parts;
          return {
            product: source === 'hub' ? 'hub' : slug,
            project: project || '',
            date,
            path: path.join(hubRoot, p),
            snippet: collapse(snip.replace(/>>|<</g, '')).slice(0, SNIPPET_CHARS),
            score,
          };
        });
      engine = 'sqlite-fts5';
    } catch (_err) {
      const fb = await ripgrepSearch(scopedCorpus, { query, productSlug, since, until, limit });
      engine = fb.engine;
      hits = fb.hits;
    }
  } else {
    const fb = await ripgrepSearch(scopedCorpus, { query, productSlug, since, until, limit });
    engine = fb.engine;
    hits = fb.hits;
  }

  // Format compact text (spec §8) — not JSON-only soup.
  let text;
  if (!hits.length) {
    text = 'no journal hits';
  } else {
    const lines = hits.map(
      (h) =>
        `[${h.product}${h.project ? `/${h.project}` : ''}] ${h.date} ${h.path} (score ${Number(h.score).toFixed(2)})\n  ${h.snippet}`,
    );
    text = '';
    for (const line of lines) {
      if (text && text.length + line.length + 1 > MAX_OUTPUT_CHARS) {
        text += '\n…[truncated]';
        break;
      }
      text += (text ? '\n' : '') + line;
    }
  }
  return { engine, hits, text, scope, productSlug };
}

/** Tool entry point (agent-runtime built-in `journal_search`). */
async function journalSearchTool(args = {}) {
  const res = await journalSearch({
    query: args.query,
    productSlug: args.product_slug,
    since: args.since,
    until: args.until,
    limit: args.limit,
  });
  return {
    success: true,
    engine: res.engine,
    scope: res.scope,
    product_filter: res.productSlug,
    count: res.hits.length,
    text: res.text,
  };
}

module.exports = {
  journalSearch,
  journalSearchTool,
  resolveHubRoot,
  listJournalFiles,
  buildIndex,
  loadRegistry,
  DB_REL,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
