'use strict';

/**
 * Weekly incident digest (2026-11-21 incident review, observability item).
 *
 * Buckets the last 7 days of structured-log error events by category with
 * counts, surfaced as one console card. Computed at most once per hour and
 * cached in .bizagent/incident-digest.json so /api/health stays cheap.
 *
 * Category = the event's `kind` when present (provider classification),
 * else the event name. Routine lifecycle events that only used to LOOK like
 * errors (control_plane_start retry storms) are logged with status "retry"
 * since the taxonomy fix and therefore never enter this digest.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { appDir } = require('./config');
const { writeJsonAtomic } = require('./atomic-state');

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DIGEST_TTL_MS = 60 * 60 * 1000;
const MAX_SCAN_BYTES = 8 * 1024 * 1024; // per log file — bounded work
const MAX_CATEGORIES = 8;

function digestFile(hub) {
  return path.join(appDir(hub), 'incident-digest.json');
}

function categorize(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const status = String(entry.status || 'ok').toLowerCase();
  if (status !== 'error') return null;
  const kind = String(entry.kind || '').trim();
  const event = String(entry.event || '').trim();
  if (!event) return null;
  // Low-signal infrastructure noise that is not an operator-actionable incident.
  if (event === 'control_plane_start' || event === 'control_plane_start_retry') return null;
  return kind || event;
}

function extractEntries(text, cutoffMs, out) {
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_err) { continue; }
    const ts = Date.parse(String(entry.ts || ''));
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    const category = categorize(entry);
    if (!category) continue;
    out.push({ ts, category });
  }
}

function readLogTailText(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) return '';
    const start = Math.max(0, stat.size - MAX_SCAN_BYTES);
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop partial line
    return text;
  } catch (_err) {
    return '';
  }
}

function readGzipTailText(file) {
  try {
    const raw = fs.readFileSync(file);
    const text = zlib.gunzipSync(raw).toString('utf8');
    // Only the tail matters (newest entries are at the end of rotated files).
    return text.length > MAX_SCAN_BYTES ? text.slice(-MAX_SCAN_BYTES) : text;
  } catch (_err) {
    return '';
  }
}

function computeDigest(hub) {
  const cutoffMs = Date.now() - WINDOW_MS;
  const hits = [];
  const logDir = path.join(hub, 'logs');
  extractEntries(readLogTailText(path.join(logDir, 'structured.log')), cutoffMs, hits);
  // Rotated generations (log-caps): structured.log.1(.gz) — newest entries at
  // the end, so the tail of one generation covers the rest of the window.
  for (const name of ['structured.log.1', 'structured.log.1.gz']) {
    const file = path.join(logDir, name);
    if (!fs.existsSync(file)) continue;
    const text = name.endsWith('.gz')
      ? readGzipTailText(file)
      : readLogTailText(file);
    extractEntries(text, cutoffMs, hits);
  }
  const byCategory = {};
  for (const hit of hits) {
    byCategory[hit.category] = (byCategory[hit.category] || 0) + 1;
  }
  const categories = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CATEGORIES)
    .map(([category, count]) => ({ category, count }));
  return {
    computed_at: new Date().toISOString(),
    window_days: 7,
    total: hits.length,
    categories,
  };
}

/** Cached digest for /api/health — recomputed at most once per hour. */
function weeklyIncidentDigest(hub) {
  try {
    const cached = JSON.parse(fs.readFileSync(digestFile(hub), 'utf8'));
    if (cached && cached.computed_at && Date.now() - Date.parse(cached.computed_at) < DIGEST_TTL_MS) {
      return cached;
    }
  } catch (_err) { /* recompute */ }
  let digest;
  try {
    digest = computeDigest(hub);
  } catch (_err) {
    return { computed_at: new Date().toISOString(), window_days: 7, total: 0, categories: [] };
  }
  try {
    fs.mkdirSync(path.dirname(digestFile(hub)), { recursive: true });
    writeJsonAtomic(digestFile(hub), digest);
  } catch (_err) { /* best-effort */ }
  return digest;
}

module.exports = {
  weeklyIncidentDigest,
  computeDigest,
  categorize,
};