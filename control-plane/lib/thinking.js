/**
 * In-flight "thinking" tracking for the web UI.
 *
 * When a hub or product-agent turn launches, we record which dispatch log is
 * producing output for a given conversation. The UI opens an SSE stream that
 * tails that log live (in place of the static "Working. Stand by..." launch
 * ack) and replaces it with the real reply when the turn completes.
 *
 * State is a small JSON file under .bizagent/ — never committed, best-effort.
 */
const fs = require('fs');
const path = require('path');
const { appDir } = require('./config');

function thinkingFile(hub) {
  return path.join(appDir(hub), 'thinking.json');
}

function readThinking(hub) {
  try {
    const data = JSON.parse(fs.readFileSync(thinkingFile(hub), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (_err) {
    return {};
  }
}

function writeThinking(hub, data) {
  try {
    fs.mkdirSync(appDir(hub), { recursive: true });
    fs.writeFileSync(thinkingFile(hub), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch (_err) {
    /* best-effort — thinking stream is a UX nicety, never critical */
  }
}

/**
 * Record an in-flight turn's thinking source for a conversation.
 * @param {string} hub
 * @param {string} conversationId
 * @param {string} slug - 'hub' or a product agent slug
 * @param {string} logFile - absolute path to the dispatch stdout log
 * @param {number} [logByteOffset] - byte offset into logFile where this turn
 *   begins, so the UI streams only the current turn's output (not the whole log)
 */
function recordThinking(hub, conversationId, slug, logFile, logByteOffset) {
  if (!conversationId || !slug) return;
  const data = readThinking(hub);
  data[conversationId] = {
    slug,
    logFile: String(logFile || ''),
    logByteOffset: Number(logByteOffset) || 0,
    startedAt: new Date().toISOString(),
  };
  writeThinking(hub, data);
}

function clearThinking(hub, conversationId) {
  if (!conversationId) return;
  const data = readThinking(hub);
  if (data[conversationId]) {
    delete data[conversationId];
    writeThinking(hub, data);
  }
}

function getThinking(hub, conversationId) {
  const data = readThinking(hub);
  return data[conversationId] || null;
}

module.exports = {
  clearThinking,
  getThinking,
  recordThinking,
  readThinking,
  thinkingFile,
  writeThinking,
};
