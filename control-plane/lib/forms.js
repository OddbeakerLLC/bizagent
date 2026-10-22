'use strict';

/**
 * DGen form requests — agents ask the operator for sensitive input (API keys,
 * passwords, tokens) through a modal dialog that bypasses chat history.
 *
 * Flow:
 *   1. Agent writes an outbox message with `kind: form-request` and a ```dgen
 *      fenced block (Jobe dialect: rows `<{...}>`, fields `[T:...]`).
 *   2. mail.js routeOutboxes intercepts it, parses the markup server-side
 *      (lib/forms.js parseDgen), and appends a `kind: form-request` status
 *      message to the originating conversation. The outbox file is consumed —
 *      the raw markup never becomes mail.
 *   3. The console renders the message as a card; "Provide information" opens
 *      a modal built from the parsed form JSON (the browser never sees DGen).
 *   4. On submit the browser POSTs /api/forms/submit. The server writes the
 *      values to `.bizagent/forms/<form_id>.json` (0600) and drops a
 *      secret-free pointer mail into the requesting agent's inbox.
 *   5. The agent claims the response (scripts/form-answer.sh <id> prints it
 *      and deletes the file). Unclaimed files are swept after FORM_TTL_MS.
 *
 * Nothing sensitive persists: values live only in the 0600 response file
 * until claimed/expired, never in chat history, session memory, or logs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appDir, ensureDir, loadRegistry, agentsFromRegistry } = require('./config');
const { writeFileAtomic } = require('./atomic-state');

const FORM_ID_RE = /^[a-f0-9]{12}$/;
const FORM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FIELD_VALUE_CHARS = 8192;
const MAX_FIELDS = 50;

// --- DGen parsing (Jobe dialect + [P:] password extension) ------------------

const FIELD_RE = /\[([A-Za-z])\s*:\s*([^\]]*)\]/g;

function splitParams(paramsStr) {
  return String(paramsStr || '')
    .split(',')
    .map((s) => s.trim());
}

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseOption(raw) {
  const s = String(raw || '').trim();
  const idx = s.indexOf('|');
  if (idx > 0) {
    return { value: s.slice(0, idx), label: s.slice(idx + 1) || s.slice(0, idx) };
  }
  return { value: s, label: s };
}

function cleanLabel(text) {
  return String(text || '')
    .replace(/\{|\}/g, '')
    .replace(/[:：]\s*$/, '')
    .trim();
}

/**
 * Parse one field token `[Type:params=default]`.
 * Everything after the first `=` (until `]`) is the default value.
 */
function parseFieldToken(typeCode, paramsStr, label, inline) {
  const eq = paramsStr.indexOf('=');
  const paramsPart = eq >= 0 ? paramsStr.slice(0, eq) : paramsStr;
  const defaultRaw = eq >= 0 ? paramsStr.slice(eq + 1) : '';
  const params = splitParams(paramsPart);
  const base = { label: label || '', inline: inline || '' };

  switch (typeCode) {
    case 'T':
      return { type: 'text', id: params[0], maxlen: toInt(params[1], 0) || undefined, default: defaultRaw, ...base };
    case 'P':
      return { type: 'password', id: params[0], maxlen: toInt(params[1], 0) || undefined, default: defaultRaw, ...base };
    case 'A':
      return { type: 'textarea', id: params[0], rows: toInt(params[1], 3) || 3, default: defaultRaw, ...base };
    case 'N':
      return {
        type: 'number',
        id: params[0],
        min: params[1] === '' || params[1] === undefined ? undefined : toInt(params[1], undefined),
        max: params[2] === '' || params[2] === undefined ? undefined : toInt(params[2], undefined),
        default: defaultRaw,
        ...base,
      };
    case 'X':
      return { type: 'checkbox', id: params[0], default: defaultRaw === '1', ...base };
    case 'D':
      return {
        type: 'dropdown',
        id: params[0],
        options: params.slice(1).filter(Boolean).map(parseOption),
        default: defaultRaw,
        ...base,
      };
    case 'L':
      return { type: 'link', id: params[0], label: params[0] || 'Link', default: defaultRaw };
    case 'B':
      return { type: 'button', id: params[0], label: params[1] || params[0] };
    default:
      // Lenient: unknown type codes degrade to text inputs.
      return { type: 'text', id: params[0], default: defaultRaw, ...base };
  }
}

/**
 * Parse DGen markup into the JSON structure the console renders.
 * Lenient by design (LLMs mangle markup): unparseable rows/fields are skipped;
 * throws only when no usable rows or no fields/buttons exist at all.
 */
function parseDgen(markup) {
  const lines = String(markup || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\s*<\{.*\}>\s*$/.test(l))
    .map((l) => l.replace(/^\s*<\{/, '').replace(/\}>\s*$/, ''));

  if (lines.length === 0) throw new Error('no dgen rows found');

  const form = { title: '', description: '', fields: [], buttons: [] };
  const rows = [];

  for (const content of lines) {
    // Collect field tokens in order with their positions.
    const tokens = [];
    let m;
    FIELD_RE.lastIndex = 0;
    while ((m = FIELD_RE.exec(content)) !== null) {
      tokens.push({ code: m[1].toUpperCase(), params: m[2], start: m.index, end: m.index + m[0].length });
    }

    if (tokens.length === 0) {
      rows.push({ kind: 'text', text: content.replace(/\{|\}/g, '').trim() });
      continue;
    }

    const hasButton = tokens.some((t) => t.code === 'B');
    if (hasButton) {
      for (const t of tokens) {
        if (t.code !== 'B') continue; // lenient: ignore non-buttons on a button row
        const f = parseFieldToken(t.code, t.params, '', '');
        if (f.id) form.buttons.push({ id: f.id, label: f.label });
      }
      continue;
    }

    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      const prevEnd = i === 0 ? 0 : tokens[i - 1].end;
      const label = cleanLabel(content.slice(prevEnd, t.start));
      const after = content.slice(t.end);
      const inline = after.replace(/\{|\}/g, '').trim();
      const f = parseFieldToken(t.code, t.params, label, inline);
      if (!f.id) continue; // lenient: drop nameless fields
      form.fields.push(f);
    }
  }

  // First text row = title; later text rows = description.
  const textRows = rows.filter((r) => r.text);
  if (textRows.length > 0) {
    form.title = textRows[0].text;
    form.description = textRows.slice(1).map((r) => r.text).join(' ');
  }

  if (form.fields.length === 0 && form.buttons.length === 0) {
    throw new Error('no dgen fields found');
  }
  if (form.fields.length === 0) {
    throw new Error('no dgen input fields found');
  }
  return form;
}

/**
 * Extract a DGen markup block from a message body: a ```dgen fenced block
 * preferred, else a contiguous run of `<{...}>` lines.
 */
function extractDgenMarkup(body) {
  const text = String(body || '');
  const fenced = text.match(/```dgen\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1];
  const lines = text.split(/\r?\n/);
  const run = [];
  for (const line of lines) {
    if (/^\s*<\{.*\}>\s*$/.test(line)) {
      run.push(line.trim());
    } else if (run.length > 0) {
      break;
    }
  }
  return run.length > 0 ? run.join('\n') : '';
}

/**
 * Parse a form-request outbox message into { form } (parsed JSON) or throw.
 */
function parseFormRequestMessage(bodyText) {
  const markup = extractDgenMarkup(bodyText);
  if (!markup) throw new Error('no dgen block in form-request message');
  return parseDgen(markup);
}

// --- Response store (ephemeral by design) -----------------------------------

function formsRoot(hub) {
  return path.join(appDir(hub), 'forms');
}

function assertFormId(formId) {
  const id = String(formId || '').trim();
  if (!FORM_ID_RE.test(id)) throw new Error('invalid form id');
  return id;
}

function assertAgentSlug(hub, slug) {
  const s = String(slug || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('invalid agent slug');
  const known = new Set(['hub', ...agentsFromRegistry(loadRegistry(hub)).map((a) => a.slug)]);
  if (!known.has(s)) throw new Error(`unknown agent slug: ${s}`);
  return s;
}

function sanitizeFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('fields must be an object');
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) throw new Error('fields must not be empty');
  if (keys.length > MAX_FIELDS) throw new Error('too many fields');
  const out = {};
  for (const key of keys) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new Error(`invalid field id: ${key}`);
    const v = fields[key];
    if (typeof v === 'boolean') {
      out[key] = v;
      continue;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[key] = v;
      continue;
    }
    if (typeof v !== 'string') throw new Error(`invalid value for field ${key}`);
    if (v.length > MAX_FIELD_VALUE_CHARS) throw new Error(`value too large for field ${key}`);
    out[key] = v;
  }
  return out;
}

/**
 * Persist a submitted form response. Values are written once to a 0600 file
 * under .bizagent/forms/ and deleted on claim (or TTL sweep) — never logged,
 * never appended to a conversation.
 */
function saveFormResponse(hub, { formId, agent, button, fields }) {
  const id = assertFormId(formId);
  const slug = assertAgentSlug(hub, agent);
  const clean = sanitizeFields(fields);
  const root = formsRoot(hub);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `${id}.json`);
  const payload = {
    form_id: id,
    agent: slug,
    button: String(button || 'submit').slice(0, 64),
    fields: clean,
    submitted_at: new Date().toISOString(),
  };
  // Atomic but deliberately no .bak: form values are secrets, so no second
  // copy may outlive the claim-once delete.
  writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
  try { fs.chmodSync(root, 0o700); } catch (_e) { /* best effort */ }
  return file;
}

/**
 * Claim-once read: return the response and delete the file, so values do not
 * outlive the requesting agent's use of them.
 */
function claimFormResponse(hub, formId) {
  const id = assertFormId(formId);
  const file = path.join(formsRoot(hub), `${id}.json`);
  if (!fs.existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fs.unlinkSync(file);
    throw new Error(`form response unreadable (deleted): ${err.message}`);
  }
  fs.unlinkSync(file);
  return data;
}

/** Delete unclaimed response files older than ttlMs. Returns count removed. */
function sweepExpiredFormResponses(hub, ttlMs = FORM_TTL_MS) {
  const root = formsRoot(hub);
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(root).filter((n) => n.endsWith('.json'));
  } catch (_err) {
    return 0;
  }
  const cutoff = Date.now() - ttlMs;
  for (const name of entries) {
    const file = path.join(root, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch (_err) { /* best effort */ }
  }
  return removed;
}

function newFormId() {
  return crypto.randomBytes(6).toString('hex');
}

module.exports = {
  FORM_ID_RE,
  FORM_TTL_MS,
  assertAgentSlug,
  assertFormId,
  claimFormResponse,
  extractDgenMarkup,
  formsRoot,
  newFormId,
  parseDgen,
  parseFormRequestMessage,
  sanitizeFields,
  saveFormResponse,
  sweepExpiredFormResponses,
};