const fs = require('fs');
const path = require('path');
const { appDir, ensureDir, readJson } = require('./config');

const MAX_DISPLAY_NAME = 80;

function profilePath(hub) {
  return path.join(appDir(hub), 'profile.json');
}

function normalizeDisplayName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_NAME);
}

/**
 * Operator profile for console display / session attribution.
 * display_name is empty until first-use setup (or settings).
 */
function getProfile(hub) {
  const data = readJson(profilePath(hub), null) || {};
  return {
    display_name: normalizeDisplayName(data.display_name),
    updated_at: data.updated_at || null,
  };
}

function setProfile(hub, patch = {}) {
  const current = getProfile(hub);
  const nextName = patch.display_name !== undefined
    ? normalizeDisplayName(patch.display_name)
    : current.display_name;
  if (!nextName) {
    throw new Error('display name is required');
  }
  const data = {
    display_name: nextName,
    updated_at: new Date().toISOString(),
  };
  ensureDir(appDir(hub));
  fs.writeFileSync(profilePath(hub), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return data;
}

/** Label for the human side of a chat turn (never Operator/CEO). */
function userDisplayName(hub) {
  const name = getProfile(hub).display_name;
  return name || 'You';
}

module.exports = {
  getProfile,
  MAX_DISPLAY_NAME,
  normalizeDisplayName,
  profilePath,
  setProfile,
  userDisplayName,
};
