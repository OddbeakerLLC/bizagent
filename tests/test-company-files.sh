#!/usr/bin/env bash
# company/ upload helpers + API path safety
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$ROOT/control-plane/lib/company-files.js" ] || fail "company-files.js missing"
grep -q 'company/files' "$ROOT/control-plane/server.js" || fail "server missing /api/company/files"
grep -q 'companyFilesBtn' "$ROOT/control-plane/public/index.html" || fail "UI missing Company button"

node - "$ROOT" <<'NODE' || fail "company-files unit checks failed"
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  listCompanyFiles,
  writeCompanyFile,
  resolveUnderCompany,
  parseMultipart,
  MAX_UPLOAD_BYTES,
} = require(path.join(process.argv[2], 'control-plane/lib/company-files'));

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-company-'));
fs.mkdirSync(path.join(hub, 'company'), { recursive: true });

// path escape rejected
let threw = false;
try { resolveUnderCompany(hub, '../etc/passwd'); } catch (e) { threw = true; }
if (!threw) { console.error('expected escape reject'); process.exit(1); }

// write + list
const w = writeCompanyFile(hub, {
  filename: 'mission.md',
  subdir: 'uploads',
  buffer: Buffer.from('# Mission\n\nShip it.\n', 'utf8'),
});
if (w.path !== 'uploads/mission.md') { console.error('path', w); process.exit(2); }
const files = listCompanyFiles(hub);
if (!files.some((f) => f.path === 'uploads/mission.md')) {
  console.error('list missing file', files);
  process.exit(3);
}

// overwrite required
threw = false;
try {
  writeCompanyFile(hub, {
    filename: 'mission.md',
    subdir: 'uploads',
    buffer: Buffer.from('x', 'utf8'),
  });
} catch (e) {
  threw = /already exists/i.test(e.message);
}
if (!threw) { console.error('expected exists error'); process.exit(4); }

writeCompanyFile(hub, {
  filename: 'mission.md',
  subdir: 'uploads',
  buffer: Buffer.from('y', 'utf8'),
  overwrite: true,
});

// multipart parse
const boundary = '----BaBoundary7';
const body = [
  `--${boundary}`,
  'Content-Disposition: form-data; name="subdir"',
  '',
  'news',
  `--${boundary}`,
  'Content-Disposition: form-data; name="file"; filename="note.txt"',
  'Content-Type: text/plain',
  '',
  'hello company',
  `--${boundary}--`,
  '',
].join('\r\n');
const parsed = parseMultipart(Buffer.from(body, 'utf8'), `multipart/form-data; boundary=${boundary}`);
if (!parsed.file || parsed.file.buffer.toString() !== 'hello company') {
  console.error('multipart file', parsed);
  process.exit(5);
}
if (parsed.fields.subdir !== 'news') {
  console.error('multipart fields', parsed.fields);
  process.exit(6);
}

// reject huge
threw = false;
try {
  writeCompanyFile(hub, {
    filename: 'big.bin',
    buffer: Buffer.alloc(MAX_UPLOAD_BYTES + 1),
  });
} catch (e) {
  threw = /too large/i.test(e.message);
}
if (!threw) { console.error('expected too large'); process.exit(7); }

// reject bad ext
threw = false;
try {
  writeCompanyFile(hub, {
    filename: 'x.exe',
    buffer: Buffer.from('MZ'),
  });
} catch (e) {
  threw = /not allowed/i.test(e.message);
}
if (!threw) { console.error('expected ext reject'); process.exit(8); }

fs.rmSync(hub, { recursive: true, force: true });
console.log('ok');
NODE

echo "  ok: company-files"
