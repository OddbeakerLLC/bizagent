#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$ROOT/control-plane/lib/library.js" ] || fail "library.js missing"
grep -q '/api/library' "$ROOT/control-plane/server.js" || fail "server missing /api/library"
grep -q '/api/library/repos' "$ROOT/control-plane/server.js" || fail "server missing /api/library/repos"
grep -q '/api/library/tree' "$ROOT/control-plane/server.js" || fail "server missing /api/library/tree"
grep -q 'libraryBtn' "$ROOT/control-plane/public/index.html" || fail "UI missing Library button"
grep -q 'bizagent-library\|openLibraryTab' "$ROOT/control-plane/public/app.js" || fail "UI missing named Library tab open"
[ -f "$ROOT/control-plane/public/library.html" ] || fail "library.html missing"
[ -f "$ROOT/control-plane/public/library.js" ] || fail "library.js (page) missing"
grep -q 'library-accordion\|libraryAccordion' "$ROOT/control-plane/public/library.html" || fail "library page missing accordion root"
grep -q 'library-diagram\|libraryEntryKind\|render=1\|render:' "$ROOT/control-plane/public/library.js" || fail "library page missing diagram preview path"
grep -q "library/" "$ROOT/control-plane/lib/hub-memory.js" || fail "hub prompt missing library convention"
grep -qE "\.puml|ALLOWED_EXT.*puml|puml" "$ROOT/control-plane/lib/library.js" || fail "library.js missing .puml allowlist"
grep -q 'contentTypeForExt' "$ROOT/control-plane/lib/library.js" || fail "library.js missing contentTypeForExt"
grep -q 'listLibraryRepos\|getLibraryRepoTree\|getLibraryBrowseFile' "$ROOT/control-plane/lib/library.js" || fail "library.js missing repo tree browse helpers"
grep -q 'raw=1\|wantRaw\|raw ===' "$ROOT/control-plane/server.js" || fail "server missing library raw serve"
grep -q 'image/svg+xml\|contentTypeForExt' "$ROOT/control-plane/server.js" || fail "server missing svg content-type path"

node - "$ROOT" <<'NODE' || fail "library unit checks failed"
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  addLibraryDocument,
  addLibraryDiagram,
  contentTypeForExt,
  getLibraryBrowseFile,
  getLibraryEntry,
  getLibraryRepoTree,
  listLibrary,
  listLibraryRepos,
  resolveLibraryFile,
  resolveUnderRoot,
  ALLOWED_EXT,
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
  threw = /only markdown|not allowed|invalid|library allows/i.test(err.message);
}
if (!threw) { console.error('ext'); process.exit(5); }

// allow diagram extensions
for (const ext of ['.puml', '.svg', '.png']) {
  if (!ALLOWED_EXT.has(ext)) {
    console.error('missing allow', ext);
    process.exit(6);
  }
}
if (contentTypeForExt('.svg') !== 'image/svg+xml; charset=utf-8') {
  console.error('ct svg', contentTypeForExt('.svg'));
  process.exit(7);
}
if (contentTypeForExt('.png') !== 'image/png') {
  console.error('ct png', contentTypeForExt('.png'));
  process.exit(8);
}

// Store a pre-rendered SVG diagram entry
const svgBody = '<svg xmlns="http://www.w3.org/2000/svg"><text y="20">ok</text></svg>\n';
const pumlBody = '@startuml\nAlice -> Bob: hi\n@enduml\n';
fs.writeFileSync(path.join(hub, 'library', 'pair.puml'), pumlBody);
const diag = addLibraryDocument(hub, {
  title: 'Paired diagram',
  filename: 'pair.svg',
  content: svgBody,
  source: 'hub',
  source_path: 'pair.puml',
  kind: 'diagram',
  tags: ['diagram'],
  overwrite: true,
});
if (diag.path !== 'pair.svg' || diag.kind !== 'diagram') {
  console.error('diag entry', diag);
  process.exit(9);
}
const gotDiag = getLibraryEntry(hub, diag.id);
if (!gotDiag.content.includes('<svg') || gotDiag.binary) {
  console.error('gotDiag', gotDiag);
  process.exit(10);
}
if (!gotDiag.source_content || !gotDiag.source_content.includes('@startuml')) {
  console.error('source_content', gotDiag.source_content);
  process.exit(11);
}

// Try PlantUML auto-render if available (best-effort; skip if missing)
let plantumlOk = false;
try {
  const { findPlantUml } = require(path.join(process.argv[2], 'control-plane/lib/plantuml'));
  plantumlOk = !!findPlantUml();
} catch (_err) {
  plantumlOk = false;
}
if (plantumlOk) {
  const rendered = addLibraryDiagram(hub, {
    title: 'Auto render',
    filename: 'auto-render.puml',
    content: '@startuml\nBob -> Alice: yo\n@enduml\n',
    source: 'hub',
    overwrite: true,
  });
  if (rendered.path !== 'auto-render.svg' || rendered.kind !== 'diagram') {
    console.error('auto render entry', rendered);
    process.exit(12);
  }
  if (rendered.source_path !== 'auto-render.puml') {
    console.error('auto source_path', rendered);
    process.exit(13);
  }
  const svgPath = path.join(hub, 'library', 'auto-render.svg');
  if (!fs.existsSync(svgPath) || !fs.readFileSync(svgPath, 'utf8').includes('<svg')) {
    console.error('auto svg missing');
    process.exit(14);
  }
  const gotAuto = getLibraryEntry(hub, rendered.id);
  if (gotAuto.kind !== 'diagram' || !gotAuto.content.includes('<svg')) {
    console.error('gotAuto', gotAuto);
    process.exit(15);
  }
} else {
  console.log('(skip auto-render: PlantUML not installed)');
}

// Repo accordion browse: hub-library tree + nested path read
const registry = {
  products: [
    {
      slug: 'demo',
      name: 'Demo Product',
      projects: [
        {
          name: 'demo-repo',
          path: path.join(hub, 'demo-repo'),
          remote: 'ssh://example/demo-repo.git',
        },
      ],
    },
  ],
};
const demoRoot = path.join(hub, 'demo-repo');
fs.mkdirSync(path.join(demoRoot, 'docs', 'diagrams'), { recursive: true });
fs.writeFileSync(path.join(demoRoot, 'README.md'), '# Demo\n\nHello repo.\n');
fs.writeFileSync(path.join(demoRoot, 'docs', 'plan.md'), '# Plan\n\nNested.\n');
fs.writeFileSync(
  path.join(demoRoot, 'docs', 'diagrams', 'flow.puml'),
  '@startuml\nA -> B\n@enduml\n',
);
fs.writeFileSync(path.join(demoRoot, 'secret.env'), 'NOPE=1\n');
fs.mkdirSync(path.join(demoRoot, 'node_modules', 'x'), { recursive: true });
fs.writeFileSync(path.join(demoRoot, 'node_modules', 'x', 'readme.md'), 'skip\n');

const { repos } = listLibraryRepos(hub, registry);
if (!repos.some((r) => r.id === 'hub-library')) {
  console.error('missing hub-library', repos);
  process.exit(16);
}
if (!repos.some((r) => r.id === 'repo:demo:demo-repo' && r.available)) {
  console.error('missing demo repo', repos);
  process.exit(17);
}

const tree = getLibraryRepoTree(hub, registry, 'repo:demo:demo-repo');
const flat = [];
(function walk(nodes) {
  for (const n of nodes || []) {
    if (n.type === 'file') flat.push(n.path);
    else walk(n.children);
  }
})(tree.tree);
if (!flat.includes('README.md') || !flat.includes('docs/plan.md') || !flat.includes('docs/diagrams/flow.puml')) {
  console.error('tree missing viewable files', flat);
  process.exit(18);
}
if (flat.some((p) => p.includes('node_modules') || p.endsWith('.env') || p.includes('secret'))) {
  console.error('tree leaked noise', flat);
  process.exit(19);
}

const nested = getLibraryBrowseFile(hub, registry, 'repo:demo:demo-repo', 'docs/plan.md');
if (!nested.content.includes('Nested') || nested.path !== 'docs/plan.md') {
  console.error('browse nested', nested);
  process.exit(20);
}

// Path escape must fail
threw = false;
try {
  resolveUnderRoot(demoRoot, '../etc/passwd');
} catch (_e) {
  threw = true;
}
if (!threw) {
  console.error('browse escape');
  process.exit(21);
}

const hubTree = getLibraryRepoTree(hub, registry, 'hub-library');
const hubFlat = [];
(function walk(nodes) {
  for (const n of nodes || []) {
    if (n.type === 'file') hubFlat.push(n.path);
    else walk(n.children);
  }
})(hubTree.tree);
if (!hubFlat.includes('README.md') && !hubFlat.some((p) => p.endsWith('.md'))) {
  console.error('hub library tree empty', hubFlat);
  process.exit(22);
}

fs.rmSync(hub, { recursive: true, force: true });
console.log('ok');
NODE

echo "  ok: library"
