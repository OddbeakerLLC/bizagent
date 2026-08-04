#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$ROOT/control-plane/lib/library.js" ] || fail "library.js missing"
grep -q '/api/library' "$ROOT/control-plane/server.js" || fail "server missing /api/library"
grep -q 'libraryBtn' "$ROOT/control-plane/public/index.html" || fail "UI missing Library button"
grep -q "library/" "$ROOT/control-plane/lib/hub-memory.js" || fail "hub prompt missing library convention"

node - "$ROOT" <<'NODE' || fail "library unit checks failed"
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  addLibraryDocument,
  getLibraryEntry,
  listLibrary,
  resolveLibraryFile,
} = require(path.join(process.argv[2], 'control-plane/lib/library'));

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-lib-'));

let threw = false;
try { resolveLibraryFile(hub, '../etc/passwd'); } catch (_e) { threw = true; }
if (!threw) { console.error('escape'); process.exit(1); }

const e = addLibraryDocument(hub, {
  title: 'Test Plan',
  content: '# Test Plan\n\nDo the thing.\n',
  source: 'hub',
  tags: ['plan'],
});
if (!e.id || e.path.indexOf('.md') < 0) { console.error(e); process.exit(2); }

const listed = listLibrary(hub);
if (!listed.entries.some((x) => x.id === e.id)) {
  console.error('list', listed);
  process.exit(3);
}

const got = getLibraryEntry(hub, e.id);
if (!got.content.includes('Do the thing')) {
  console.error('get', got);
  process.exit(4);
}

// reject binary-ish ext via filename
threw = false;
try {
  addLibraryDocument(hub, {
    title: 'x',
    filename: 'x.exe',
    content: 'nope',
  });
} catch (err) {
  threw = /only markdown|not allowed|invalid/i.test(err.message);
}
if (!threw) { console.error('ext'); process.exit(5); }

fs.rmSync(hub, { recursive: true, force: true });
console.log('ok');
NODE

echo "  ok: library"
