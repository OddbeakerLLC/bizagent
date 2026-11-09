'use strict';

/**
 * Local-time formatting helpers for user-visible timestamps.
 *
 * Storage/ordering fields (created_at, updated_at, ts, ...) stay ISO-UTC so
 * existing sorting and diffing keep working; anything the operator SEES
 * (mail frontmatter dates, message filenames, upload/library filename stamps,
 * journal day files, CLI chat clocks) is generated here in the host's local
 * timezone so it matches `date` output on the machine.
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

/**
 * Local calendar date as YYYY-MM-DD.
 */
function localDateString(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Local compact stamp YYYYMMDDHHMMSSmmm (17 chars — same shape as the old
 * ISO-derived stamp in conversations.writeHubInboxMessage).
 */
function localCompactStamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}${pad3(d.getMilliseconds())}`
  );
}

/**
 * Local compact stamp YYYYMMDDHHMMSS (14 chars — same shape as the old
 * ISO-derived stamp in uploads.stampPrefix).
 */
function localCompactStampSecs(d = new Date()) {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

/**
 * Local HH:MM:SS (24h) — CLI chat clock.
 */
function localTimeString(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

module.exports = {
  localDateString,
  localCompactStamp,
  localCompactStampSecs,
  localTimeString,
};