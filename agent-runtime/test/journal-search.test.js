const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  journalSearch,
  buildIndex,
  listJournalFiles,
  DB_REL,
} = require('../src/journal-search');
const { TOOLS } = require('../src/tools');

let root;
let hub;

function write(rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-journal-'));
  hub = path.join(root, 'hub');

  // Fixture hub: registry with two fake products, journals on different dates.
  // Product paths are hub-relative ('../alpha' -> <root>/alpha) so everything
  // is inside the temp root and cleaned up afterwards.
  write(
    'hub/registry.json',
    JSON.stringify({
      products: [
        {
          slug: 'alpha',
          name: 'Alpha',
          projects: [{ name: 'alpha-web', path: '../alpha' }],
        },
        {
          slug: 'beta',
          name: 'Beta',
          projects: [{ name: 'beta-api', path: '../beta' }],
        },
      ],
    }),
  );
  write('hub/journal/2026-09-01.md', 'Hub note: disk-full survival drill went well.\n');
  write('alpha/.agent/journal/2026-08-20.md', 'Alpha learned the token fallback path needs a retry.\n');
  write('alpha/.agent/journal/2026-09-18.md', 'Alpha shipped the retry fix for token fallback.\n');
  write('beta/.agent/journal/2026-09-15.md', 'Beta hit a disk-full incident on the build box.\n');
  // Junk that must NOT be indexed.
  write('alpha/.agent/journal/notes.md.bak', 'token fallback bak\n');
  write('alpha/.agent/journal/huge.md', 'x'.repeat(1024 * 1024 + 1));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function dbFile() {
  return path.join(hub, DB_REL);
}

describe('journal search', () => {
  it('exposes the journal_search tool schema', () => {
    const names = TOOLS.map((t) => t.function.name);
    assert.ok(names.includes('journal_search'), 'missing journal_search in TOOLS');
  });

  it('finds an older hit in another product journal (hub scope)', async () => {
    const res = await journalSearch({
      query: 'token fallback',
      hubRoot: hub,
      scope: 'hub',
    });
    assert.equal(res.scope, 'hub');
    assert.ok(res.hits.length >= 2, `expected >=2 hits, got ${res.hits.length}`);
    const older = res.hits.find((h) => h.date === '2026-08-20');
    assert.ok(older, 'expected the 2026-08-20 hit');
    assert.match(older.path, /alpha/);
    assert.match(older.snippet, /token fallback/);
    assert.ok(res.text.includes('2026-08-20'), 'text includes date');
  });

  it('since/until exclude out-of-range files', async () => {
    const res = await journalSearch({
      query: 'token fallback',
      hubRoot: hub,
      scope: 'hub',
      since: '2026-09-01',
    });
    assert.ok(res.hits.length >= 1);
    assert.ok(res.hits.every((h) => h.date >= '2026-09-01'), 'hit before since');

    const res2 = await journalSearch({
      query: 'token fallback',
      hubRoot: hub,
      scope: 'hub',
      until: '2026-08-31',
    });
    assert.ok(res2.hits.every((h) => h.date <= '2026-08-31'), 'hit after until');
  });

  it('product scope isolation: alpha search never returns beta rows', async () => {
    const res = await journalSearch({
      query: 'disk full',
      hubRoot: hub,
      scope: 'product',
      product: 'alpha',
    });
    assert.ok(res.hits.every((h) => h.product === 'alpha'), 'leaked non-alpha row');
    // And the model asking for another product's slug is ignored in product scope.
    const res2 = await journalSearch({
      query: 'disk full',
      hubRoot: hub,
      scope: 'product',
      product: 'alpha',
      productSlug: 'beta',
    });
    assert.ok(res2.hits.every((h) => h.product === 'alpha'), 'cross-slug leak');
  });

  it('missing DB: first search rebuilds and still hits', async () => {
    fs.rmSync(dbFile(), { force: true });
    const res = await journalSearch({
      query: 'survival drill',
      hubRoot: hub,
      scope: 'hub',
    });
    assert.ok(fs.existsSync(dbFile()), 'DB not rebuilt');
    assert.equal(res.hits.length, 1);
    assert.match(res.hits[0].snippet, /survival drill/);
  });

  it('stale-on-query: newer journal mtime triggers incremental update', async () => {
    const res1 = await journalSearch({ query: 'brandnewtopic', hubRoot: hub, scope: 'hub' });
    assert.equal(res1.hits.length, 0);
    // Write a new journal after the index was built.
    const p = path.join(root, 'beta/.agent/journal/2026-10-01.md');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'Beta notes on brandnewtopic wiring.\n', 'utf8');
    const res2 = await journalSearch({ query: 'brandnewtopic', hubRoot: hub, scope: 'hub' });
    assert.equal(res2.hits.length, 1, 'stale index was not refreshed on query');
    assert.match(res2.hits[0].snippet, /brandnewtopic/);
  });

  it('incremental rebuild is idempotent and does not duplicate rows', async () => {
    const registry = JSON.parse(fs.readFileSync(path.join(hub, 'registry.json'), 'utf8'));    const corpus = listJournalFiles(hub, registry);
    await buildIndex(hub, corpus);
    await buildIndex(hub, corpus);
    const res = await journalSearch({ query: 'survival drill', hubRoot: hub, scope: 'hub' });
    assert.equal(res.hits.length, 1, 'duplicate rows after double rebuild');
  });

  it('no hits returns a clean zero-hit result, not an error', async () => {
    const res = await journalSearch({ query: 'zzznomatchzzz', hubRoot: hub, scope: 'hub' });
    assert.equal(res.hits.length, 0);
    assert.equal(res.text, 'no journal hits');
  });

  it('no embedding libraries required', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    );
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const banned = Object.keys(deps).filter((k) =>
      /embed|chroma|pinecone|vector|ollama|faiss|hnsw/i.test(k),
    );
    assert.deepEqual(banned, [], `banned deps present: ${banned.join(', ')}`);
  });
});
