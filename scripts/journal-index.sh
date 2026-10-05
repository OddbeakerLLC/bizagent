#!/usr/bin/env bash
# journal-index.sh — (re)build the journal FTS index. Idempotent + incremental
# (reindexes files whose size/mtime changed; drops vanished files).
# Spec: docs/2026-10-05-journal-search-mvp-spec.md §7
#
#   scripts/journal-index.sh [--hub PATH]
#
# Index file: <hub>/.bizagent/journal-fts.sqlite (local cache; safe to delete).
# Called nightly by scripts/nightly.sh; also run stale-on-query before searches.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/journal-search.js" --rebuild "$@"
