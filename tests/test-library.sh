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
grep -qE "docs/|company/|reports/" "$ROOT/control-plane/lib/hub-memory.js" || fail "hub prompt missing library hub-dir convention"
grep -qE "\.puml|ALLOWED_EXT.*puml|puml" "$ROOT/control-plane/lib/library.js" || fail "library.js missing .puml allowlist"
grep -q 'contentTypeForExt' "$ROOT/control-plane/lib/library.js" || fail "library.js missing contentTypeForExt"
grep -q 'listLibraryRepos\|getLibraryRepoTree\|getLibraryBrowseFile' "$ROOT/control-plane/lib/library.js" || fail "library.js missing repo tree browse helpers"
grep -q 'HUB_INCLUDE_DIRS\|includeOnly' "$ROOT/control-plane/lib/library.js" || fail "library.js missing hub include filters"
grep -q 'raw=1\|wantRaw\|raw ===' "$ROOT/control-plane/server.js" || fail "server missing library raw serve"
grep -q 'image/svg+xml\|contentTypeForExt' "$ROOT/control-plane/server.js" || fail "server missing svg content-type path"
# No manifest.json dependency (code must not read/write it; comments may mention removal)
if grep -E 'readManifest|writeManifest|manifestPath' "$ROOT/control-plane/lib/library.js" >/dev/null; then
  fail "library.js still has manifest read/write helpers"
fi
if [ -f "$ROOT/library/manifest.json" ]; then
  fail "library/manifest.json should be removed"
fi
[ -f "$ROOT/docs/diagrams/smoke-library-diagram.puml" ] || fail "smoke diagram not migrated to docs/diagrams/"

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
  HUB_INCLUDE_DIRS,
} = require(path.join(process.argv[2], 'control-plane/lib/library'));

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-lib-'));

// Path escape under resolveUnderRoot
let threw = false;
try { resolveUnderRoot(hub, '../etc/passwd'); } catch (_e) { threw = true; }
if (!threw) { console.error('escape'); process.exit(1); }

const e = addLibraryDocument(hub, {
  title: 'Test Plan',
  content: '# Test Plan\n\nDo the thing.\n',
  source: 'hub',
  tags: ['plan'],
});
if (!e.id || e.path.indexOf('.md') < 0 || !e.path.startsWith('docs/')) {
  console.error(e);
  process.exit(2);
}

const listed = listLibrary(hub);
if (!listed.entries.some((x) => x.path === e.path || x.id === e.id || x.path.endsWith(path.basename(e.path)))) {
  console.error('list', listed);
  process.exit(3);
}
if (!Array.isArray(listed.include) || !listed.include.includes('docs')) {
  console.error('list include', listed.include);
  process.exit(3);
}

const got = getLibraryEntry(hub, e.path);
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

// Store a pre-rendered SVG diagram under docs/diagrams
const svgBody = '<svg xmlns="http://www.w3.org/2000/svg"><text y="20">ok</text></svg>\n';
const pumlBody = '@startuml\nAlice -> Bob: hi\n@enduml\n';
fs.mkdirSync(path.join(hub, 'docs', 'diagrams'), { recursive: true });
fs.writeFileSync(path.join(hub, 'docs', 'diagrams', 'pair.puml'), pumlBody);
const diag = addLibraryDocument(hub, {
  title: 'Paired diagram',
  filename: 'pair.svg',
  content: svgBody,
  source: 'hub',
  source_path: 'docs/diagrams/pair.puml',
  kind: 'diagram',
  tags: ['diagram'],
  overwrite: true,
});
if (diag.path !== 'docs/diagrams/pair.svg' || diag.kind !== 'diagram') {
  console.error('diag entry', diag);
  process.exit(9);
}
const gotDiag = getLibraryEntry(hub, diag.path);
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
  if (rendered.path !== 'docs/diagrams/auto-render.svg' || rendered.kind !== 'diagram') {
    console.error('auto render entry', rendered);
    process.exit(12);
  }
  if (rendered.source_path !== 'docs/diagrams/auto-render.puml') {
    console.error('auto source_path', rendered);
    process.exit(13);
  }
  const svgPath = path.join(hub, 'docs', 'diagrams', 'auto-render.svg');
  if (!fs.existsSync(svgPath) || !fs.readFileSync(svgPath, 'utf8').includes('<svg')) {
    console.error('auto svg missing');
    process.exit(14);
  }
  const gotAuto = getLibraryEntry(hub, rendered.path);
  if (gotAuto.kind !== 'diagram' || !gotAuto.content.includes('<svg')) {
    console.error('gotAuto', gotAuto);
    process.exit(15);
  }
} else {
  console.log('(skip auto-render: PlantUML not installed)');
}

// Repo accordion browse: hub + project repo tree
const zebraRoot = path.join(hub, 'zebra-repo');
const alphaRoot = path.join(hub, 'alpha-repo');
const demoRoot = path.join(hub, 'demo-repo');
const registry = {
  products: [
    {
      slug: 'zebra',
      name: 'Zebra Product',
      projects: [
        {
          name: 'zebra-repo',
          path: zebraRoot,
          remote: 'ssh://example/zebra-repo.git',
        },
      ],
    },
    {
      slug: 'demo',
      name: 'Demo Product',
      projects: [
        {
          name: 'demo-repo',
          path: demoRoot,
          remote: 'ssh://example/demo-repo.git',
        },
        {
          name: 'alpha-repo',
          path: alphaRoot,
          remote: 'ssh://example/alpha-repo.git',
        },
      ],
    },
  ],
};
fs.mkdirSync(path.join(demoRoot, 'docs', 'diagrams'), { recursive: true });
fs.mkdirSync(zebraRoot, { recursive: true });
fs.mkdirSync(alphaRoot, { recursive: true });
fs.writeFileSync(path.join(demoRoot, 'README.md'), '# Demo\n\nHello repo.\n');
fs.writeFileSync(path.join(demoRoot, 'docs', 'plan.md'), '# Plan\n\nNested.\n');
fs.writeFileSync(
  path.join(demoRoot, 'docs', 'diagrams', 'flow.puml'),
  '@startuml\nA -> B\n@enduml\n',
);
fs.writeFileSync(path.join(demoRoot, 'secret.env'), 'NOPE=1\n');
fs.mkdirSync(path.join(demoRoot, 'node_modules', 'x'), { recursive: true });
fs.writeFileSync(path.join(demoRoot, 'node_modules', 'x', 'readme.md'), 'skip\n');
fs.writeFileSync(path.join(zebraRoot, 'README.md'), '# Zebra\n');
fs.writeFileSync(path.join(alphaRoot, 'README.md'), '# Alpha\n');

// Hub curated content for include filter checks
fs.mkdirSync(path.join(hub, 'company'), { recursive: true });
fs.writeFileSync(path.join(hub, 'company', 'mission.md'), '# Mission\n\nShip it.\n');
fs.writeFileSync(path.join(hub, 'NIGHTLY.md'), '# should not appear\n');
fs.writeFileSync(path.join(hub, 'registry.json'), '{}\n');
fs.mkdirSync(path.join(hub, 'agents', 'x'), { recursive: true });
fs.writeFileSync(path.join(hub, 'agents', 'x', 'agent.md'), '# no\n');
fs.mkdirSync(path.join(hub, 'library'), { recursive: true });
fs.writeFileSync(path.join(hub, 'library', 'legacy.md'), '# legacy only\n');

const { repos } = listLibraryRepos(hub, registry);
if (!repos.some((r) => r.id === 'hub' && r.kind === 'hub')) {
  console.error('missing hub', repos);
  process.exit(16);
}
if (repos.some((r) => r.id === 'hub-library')) {
  console.error('legacy hub-library still listed', repos);
  process.exit(16);
}
if (!repos.some((r) => r.id === 'repo:demo:demo-repo' && r.available)) {
  console.error('missing demo repo', repos);
  process.exit(17);
}
// Hub first, then product_name → project name (case-insensitive)
if (repos[0].id !== 'hub') {
  console.error('hub not first', repos.map((r) => r.id));
  process.exit(23);
}
const projectIds = repos.filter((r) => r.kind === 'project').map((r) => r.id);
const expectedOrder = ['repo:demo:alpha-repo', 'repo:demo:demo-repo', 'repo:zebra:zebra-repo'];
if (JSON.stringify(projectIds) !== JSON.stringify(expectedOrder)) {
  console.error('repo sort order', projectIds, 'expected', expectedOrder);
  process.exit(24);
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

const hubTree = getLibraryRepoTree(hub, registry, 'hub');
const hubFlat = [];
(function walk(nodes) {
  for (const n of nodes || []) {
    if (n.type === 'file') hubFlat.push(n.path);
    else walk(n.children);
  }
})(hubTree.tree);
if (!hubFlat.some((p) => p.startsWith('docs/')) || !hubFlat.includes('company/mission.md')) {
  console.error('hub tree missing include dirs', hubFlat);
  process.exit(22);
}
// Excluded paths must not appear
const banned = ['NIGHTLY.md', 'registry.json', 'agents/', 'library/', 'control-plane/'];
if (hubFlat.some((p) => banned.some((b) => p === b || p.startsWith(b)))) {
  console.error('hub tree leaked excluded paths', hubFlat);
  process.exit(23);
}
// Top-level tree nodes should only be include dirs
const topNames = (hubTree.tree || []).map((n) => n.name).sort();
for (const name of topNames) {
  if (!HUB_INCLUDE_DIRS.includes(name)) {
    console.error('hub tree top-level not in include list', topNames);
    process.exit(24);
  }
}

// Legacy hub-library repo id still works
const legacyTree = getLibraryRepoTree(hub, registry, 'hub-library');
if (!legacyTree.repo || legacyTree.repo.id !== 'hub') {
  console.error('hub-library alias', legacyTree.repo);
  process.exit(25);
}

// Legacy basename resolve for migrated smoke-style files
fs.writeFileSync(path.join(hub, 'docs', 'diagrams', 'smoke-library-diagram.puml'), '@startuml\nX\n@enduml\n');
const legacy = getLibraryEntry(hub, 'smoke-library-diagram.puml');
if (!legacy.path.includes('smoke-library-diagram.puml')) {
  console.error('legacy basename', legacy);
  process.exit(26);
}

// Hub browse must reject excluded paths
threw = false;
try {
  getLibraryBrowseFile(hub, registry, 'hub', 'NIGHTLY.md');
} catch (_e) {
  threw = true;
}
if (!threw) {
  console.error('hub browse should reject NIGHTLY.md');
  process.exit(27);
}

// No manifest.json created by ensure/add
if (fs.existsSync(path.join(hub, 'library', 'manifest.json'))) {
  console.error('manifest.json was created');
  process.exit(28);
}

fs.rmSync(hub, { recursive: true, force: true });
console.log('ok');
NODE

echo "  ok: library"
