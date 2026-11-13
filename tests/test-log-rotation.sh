#!/usr/bin/env bash
# test-log-rotation.sh — nightly log rotation/size caps (log-caps.rotateLogs +
# scripts/log-rotate.js + the nightly.sh step): oversized logs rotate to a
# gzip archive (older generations dropped), the fresh active file keeps a
# line-aligned tail, small files are untouched, and the run is idempotent.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

command -v node >/dev/null || fail "node not available"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HUB="$TMP/hub"
mkdir -p "$HUB/logs"

rot() { node "$ROOT/scripts/log-rotate.js" --hub "$HUB" "$@"; }

# --- 1. Oversized .log rotates to .1.gz; active file keeps a line-aligned tail
node -e '
const fs = require("fs");
const lines = [];
for (let i = 0; i < 20000; i++) lines.push(JSON.stringify({ ts: "t" + i, event: "hub_turn", n: i }));
fs.writeFileSync(process.argv[1], lines.join("\n") + "\n");
' "$HUB/logs/structured.log"
BIG_MD5_BEFORE="$(md5sum "$HUB/logs/structured.log" | cut -d' ' -f1)"

OUT="$(rot --json)"
echo "$OUT" | grep -q '"rotated": 1' || fail "expected 1 rotated file, got: $OUT"
echo "$OUT" | grep -q 'structured.log' || fail "structured.log not in rotated files: $OUT"

[ -f "$HUB/logs/structured.log" ] || fail "active structured.log missing after rotation"
[ -f "$HUB/logs/structured.log.1.gz" ] || fail "archive structured.log.1.gz missing"
[ ! -f "$HUB/logs/structured.log.1" ] || fail "uncompressed archive should not exist when compress is on"

ACTIVE_SIZE="$(stat -c%s "$HUB/logs/structured.log")"
[ "$ACTIVE_SIZE" -le $((64 * 1024)) ] || fail "active file larger than keepTailBytes: $ACTIVE_SIZE"

# Archive gunzips to the exact original content.
gunzip -c "$HUB/logs/structured.log.1.gz" > "$TMP/unpacked.log"
echo "$BIG_MD5_BEFORE" = "$(md5sum "$TMP/unpacked.log" | cut -d' ' -f1)" | grep -q "=" || true
[ "$(md5sum "$TMP/unpacked.log" | cut -d' ' -f1)" = "$BIG_MD5_BEFORE" ] || fail "archive content differs from original"

# Tail is line-aligned and the last event is intact JSON.
node -e '
const fs = require("fs");
const text = fs.readFileSync(process.argv[1], "utf8");
const lines = text.trim().split("\n");
const last = JSON.parse(lines[lines.length - 1]);
if (last.event !== "hub_turn" || last.n !== 19999) { console.error("FAIL: tail last event wrong: " + text.slice(-200)); process.exit(1); }
' "$HUB/logs/structured.log" || fail "active tail not line-aligned/intact"

# --- 2. Small files untouched; .stderr and .jsonl rotate when oversized
echo "tiny" > "$HUB/logs/control-plane-server.log"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],"x".repeat(600*1024));' "$HUB/logs/dispatch-hub.stderr"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],"y".repeat(600*1024));' "$HUB/logs/sessions.jsonl"

OUT="$(rot --json)"
echo "$OUT" | grep -q '"rotated": 2' || fail "expected 2 rotated (stderr+jsonl), got: $OUT"
[ "$(cat "$HUB/logs/control-plane-server.log")" = "tiny" ] || fail "small file was modified"
[ -f "$HUB/logs/dispatch-hub.stderr.1.gz" ] || fail "stderr archive missing"
[ -f "$HUB/logs/sessions.jsonl.1.gz" ] || fail "jsonl archive missing"

# --- 3. Old generations dropped (keep-generations default 1)
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],"old-gen-1");' "$HUB/logs/dispatch-hub.stderr.1"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],"old-gen-2");' "$HUB/logs/dispatch-hub.stderr.2"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],"x".repeat(600*1024));' "$HUB/logs/dispatch-hub.stderr"
rot >/dev/null
[ -f "$HUB/logs/dispatch-hub.stderr.2" ] && fail "generation 2 archive not dropped"
node -e '
const fs = require("fs"), zlib = require("zlib");
const gz = fs.readFileSync(process.argv[1]);
const text = zlib.gunzipSync(gz).toString("utf8");
if (text.length < 600 * 1024) { console.error("FAIL: new archive is the stale one"); process.exit(1); }
' "$HUB/logs/dispatch-hub.stderr.1.gz" || fail "archive did not replace the stale generation"

# --- 4. Idempotent: second run rotates nothing new
OUT="$(rot --json)"
echo "$OUT" | grep -q '"rotated": 0' || fail "rotation not idempotent: $OUT"

# --- 5. --no-compress produces a plain .1 archive
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],"z".repeat(600*1024));' "$HUB/logs/plain.log"
rot --no-compress >/dev/null
[ -f "$HUB/logs/plain.log.1" ] || fail "--no-compress did not produce plain .1"
[ ! -f "$HUB/logs/plain.log.1.gz" ] || fail "--no-compress produced a .gz"

# --- 6. keep-generations=2 shifts .1 -> .2
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],"gen-one-marker");' "$HUB/logs/shift.log.1"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],"w".repeat(600*1024));' "$HUB/logs/shift.log"
rot --no-compress --keep-generations 2 >/dev/null
[ "$(cat "$HUB/logs/shift.log.2")" = "gen-one-marker" ] || fail "keep-generations=2 did not shift .1 -> .2"
[ -f "$HUB/logs/shift.log.1" ] || fail "new generation 1 missing after shift"

# --- 7. nightly.sh wires the rotation step
grep -q 'log-rotate.js' "$ROOT/scripts/nightly.sh" || fail "nightly.sh missing log-rotate step"
grep -q 'rotateLogs' "$ROOT/control-plane/lib/log-caps.js" || fail "log-caps.js missing rotateLogs"

# --- 8. capLogs still works alongside (no regression)
ROOT="$ROOT" HUB="$HUB" node -e '
const path = require("path");
const { capLogs } = require(path.join(process.env.ROOT, "control-plane/lib/log-caps"));
const r = capLogs(process.env.HUB, { keepBytes: 1024 });
if (r.files < 1) { console.error("FAIL: capLogs capped nothing"); process.exit(1); }
' || fail "capLogs regression"

echo "PASS: test-log-rotation.sh"
