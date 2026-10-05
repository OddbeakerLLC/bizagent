#!/usr/bin/env node
'use strict';

/**
 * Journal search CLI (spec: docs/2026-10-05-journal-search-mvp-spec.md §9).
 *
 *   scripts/journal-search.js --query "disk full" [--product slug]
 *     [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit N] [--hub PATH]
 *     [--rebuild] [--json]
 *
 * Same engine as the agent tool `journal_search`. Exit 0 on no hits.
 * --rebuild just (incrementally) rebuilds the index and exits.
 */

const { journalSearch, buildIndex, listJournalFiles, resolveHubRoot, loadRegistry } = require('../agent-runtime/src/journal-search');

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'usage: journal-search.js --query "…" [--product slug] [--since YYYY-MM-DD]\n' +
        '  [--until YYYY-MM-DD] [--limit N] [--hub PATH] [--rebuild] [--json]',
    );
    process.exit(0);
  }

  const hubRoot = resolveHubRoot(argValue(argv, '--hub'));

  if (argv.includes('--rebuild')) {
    const registry = loadRegistry(hubRoot);
    const corpus = listJournalFiles(hubRoot, registry);
    const res = await buildIndex(hubRoot, corpus);
    console.log(
      `journal-index: ${corpus.length} file(s) indexed -> ${res.dbFile}` +
        (res.updated ? ' (updated)' : ' (up to date)'),
    );
    process.exit(0);
  }

  const query = argValue(argv, '--query') || argValue(argv, '-q') || '';
  const res = await journalSearch({
    query,
    productSlug: argValue(argv, '--product'),
    since: argValue(argv, '--since'),
    until: argValue(argv, '--until'),
    limit: argValue(argv, '--limit'),
    hubRoot,
    // Scope resolves from BIZAGENT_AGENT_SLUG (product agents stay in-product,
    // fail closed); unset env = operator/hub-side, all sources. --product
    // filters within hub scope.
  });

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ engine: res.engine, count: res.hits.length, hits: res.hits }, null, 2));
  } else {
    console.log(res.text);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`journal-search: ${err.message}`);
  process.exit(1);
});
