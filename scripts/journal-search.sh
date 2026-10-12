#!/usr/bin/env bash
# journal-search.sh — CLI for journal keyword search (SQLite FTS5, ripgrep fallback).
# See docs/ARCHITECTURE.md, "Journal search".
#
#   scripts/journal-search.sh --query "disk full" [--product slug] \
#     [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit N] [--hub PATH] [--json]
#
# Exit 0 on no hits.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/journal-search.js" "$@"
