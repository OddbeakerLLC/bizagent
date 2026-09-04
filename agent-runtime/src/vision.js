'use strict';

/**
 * Vision image ingestion for bizagent-agent.
 *
 * The control plane marks image attachments in the ephemeral turn prompt:
 *
 *   <!-- bizagent-vision
 *   .bizagent/uploads/hub/<conversation>/<file>.png
 *   -->
 *
 * The runtime parses that marker, loads the files, and attaches them to the
 * initial user message as OpenAI-style image_url content blocks (base64 data
 * URL). This shape is accepted by OpenAI-compatible providers and by the
 * Anthropic OpenAI SDK compatibility layer, so it stays provider-agnostic.
 * Paths resolve against the process cwd: the hub runtime sandbox links
 * `.bizagent`, and product agents run from the hub root.
 */

const fs = require('fs');
const path = require('path');

/** Marker the control plane writes into turn prompts (hub-memory visionTurnBlock). */
const VISION_BLOCK_RE = /<!--\s*bizagent-vision\s*\r?\n([\s\S]*?)-->/;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Per-image raw-byte cap (Anthropic limits images to 5 MiB; stay under). */
const MAX_IMAGE_BYTES = Math.floor(4.5 * 1024 * 1024);
/** Max images attached to one turn (matches the control-plane cap). */
const MAX_IMAGES = 8;

/** Hub-relative image paths marked in the prompt text. */
function parseVisionPaths(promptText) {
  const match = String(promptText || '').match(VISION_BLOCK_RE);
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean);
}

function mimeFor(file) {
  return MIME_BY_EXT[path.extname(String(file)).toLowerCase()] || 'image/png';
}

/**
 * Load marked images as image_url content blocks. Soft-fails per image with a
 * console note (unreadable, empty, too large) so one bad file never kills the
 * turn. Returns [] when nothing usable remains.
 */
function loadVisionBlocks(paths) {
  const blocks = [];
  const list = Array.isArray(paths) ? paths.slice(0, MAX_IMAGES) : [];
  for (const rel of list) {
    const p = String(rel || '').trim();
    if (!p || p.includes('..')) continue;
    let data;
    try {
      data = fs.readFileSync(path.resolve(p));
    } catch (err) {
      console.log(`Vision: skipping unreadable image ${p} (${err.message || err})`);
      continue;
    }
    if (data.length === 0) continue;
    if (data.length > MAX_IMAGE_BYTES) {
      console.log(
        `Vision: skipping image ${p} (${(data.length / 1048576).toFixed(1)} MiB exceeds the ${MAX_IMAGE_BYTES / 1048576} MiB per-image limit)`,
      );
      continue;
    }
    blocks.push({
      type: 'image_url',
      image_url: { url: `data:${mimeFor(p)};base64,${data.toString('base64')}` },
    });
  }
  return blocks;
}

/**
 * Build the initial user message content: plain string when no images,
 * otherwise [text block, image blocks...] as chat content parts.
 */
function buildUserContent(text, imageBlocks) {
  if (!Array.isArray(imageBlocks) || imageBlocks.length === 0) {
    return String(text || '');
  }
  return [{ type: 'text', text: String(text || '') }, ...imageBlocks];
}

/**
 * Heuristic: does this provider error look like the model/provider refusing
 * image content? Used to soft-fail to a text-only retry instead of dying.
 * Auth/credit/rate-limit errors are deliberately NOT matched.
 */
function looksImageRelated(err) {
  const status = err && (err.status || err.statusCode);
  const text = String(
    (err && ((err.error && (err.error.message || err.error.type)) || err.message)) || err || '',
  ).toLowerCase();
  if (status === 413 || status === 415) return true;
  if (status === 400 && /image|vision|multimodal|block|base64|media|content/.test(text)) return true;
  return /(?:does not|doesn't|cannot|can't)\s+(?:support|accept|allow|handle)\s+[^.]{0,20}(?:image|vision|multimodal)|(?:image|vision|multimodal)\b[^.]{0,30}\bnot\s+(?:supported|allowed|enabled)\b|\bnot a multimodal\b|\bno (?:image|vision) (?:support|input)\b/.test(text);
}

module.exports = {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  buildUserContent,
  loadVisionBlocks,
  looksImageRelated,
  parseVisionPaths,
};
