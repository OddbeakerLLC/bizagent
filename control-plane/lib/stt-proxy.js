/**
 * Proxy helpers for the shared oddbeaker-stt HTTP service (speech-to-text).
 *
 * Default: http://127.0.0.1:9202 (one daemon per host). Override with
 * BIZAGENT_STT_URL.
 *
 * BizAgent does not embed the model; it only HTTP-proxies to the local service.
 * The console mic button sends the recorded audio here; when the service is
 * down the mic greys out and chat input keeps working untouched.
 *
 * API (oddbeaker-stt v1): GET /health, POST /transcribe (multipart audio →
 * JSON { verbatim, cleaned, corrections[] }).
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const DEFAULT_STT_URL = "http://127.0.0.1:9202";
const DEFAULT_TIMEOUT_MS = 60000;

function sttBaseUrl() {
  const raw = (process.env.BIZAGENT_STT_URL || DEFAULT_STT_URL).trim();
  return raw.replace(/\/+$/, "") || DEFAULT_STT_URL;
}

function sttTimeoutMs() {
  const n = Number(process.env.BIZAGENT_STT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * Low-level request to the oddbeaker-stt service.
 * @returns {Promise<{ status: number, headers: object, body: Buffer }>}
 */
function requestStt(method, pathAndQuery, opts = {}) {
  const base = sttBaseUrl();
  let target;
  try {
    target = new URL(pathAndQuery.startsWith("http") ? pathAndQuery : `${base}${pathAndQuery}`);
  } catch (err) {
    return Promise.reject(new Error(`invalid STT URL: ${err.message}`));
  }

  const isHttps = target.protocol === "https:";
  const lib = isHttps ? https : http;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : sttTimeoutMs();
  const bodyBuf =
    opts.body == null
      ? null
      : Buffer.isBuffer(opts.body)
        ? opts.body
        : Buffer.from(
            typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
            "utf8",
          );

  const headers = { ...(opts.headers || {}) };
  if (bodyBuf) {
    headers["Content-Length"] = bodyBuf.length;
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search || ""}`,
        method: method || "GET",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`STT request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function sttHealth() {
  try {
    const res = await requestStt("GET", "/health", { timeoutMs: 2500 });
    if (res.status !== 200) {
      return {
        ok: false,
        available: false,
        status: res.status,
        url: sttBaseUrl(),
        error: `upstream status ${res.status}`,
      };
    }
    let json = {};
    try {
      json = JSON.parse(res.body.toString("utf8") || "{}");
    } catch (_) {
      json = {};
    }
    return {
      ok: true,
      available: true,
      url: sttBaseUrl(),
      upstream: json,
    };
  } catch (err) {
    return {
      ok: false,
      available: false,
      url: sttBaseUrl(),
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * POST /transcribe on oddbeaker-stt. The caller passes an already-encoded
 * multipart body (forwarded verbatim from the browser) plus its Content-Type
 * (with boundary).
 * @param {{ body: Buffer, contentType: string }} opts
 * @returns {{ text: string, cleaned: string, verbatim: string, corrections: Array }}
 */
async function sttTranscribe(opts) {
  const body = opts && Buffer.isBuffer(opts.body) ? opts.body : null;
  const contentType = (opts && opts.contentType) || "";
  if (!body || !body.length) {
    const err = new Error("audio body required");
    err.code = "bad_request";
    throw err;
  }
  if (!/^multipart\/form-data/i.test(contentType)) {
    const err = new Error("multipart/form-data required");
    err.code = "bad_request";
    throw err;
  }

  const res = await requestStt("POST", "/transcribe", {
    body,
    headers: { "Content-Type": contentType },
  });
  let json = {};
  try {
    json = JSON.parse(res.body.toString("utf8") || "{}");
  } catch (_) {
    json = { detail: res.body.toString("utf8").slice(0, 200) };
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(
      (json && (json.detail || json.error)) || `STT transcribe failed (${res.status})`,
    );
    err.code = "upstream";
    err.status = res.status;
    err.upstream = json;
    throw err;
  }
  const verbatim = typeof json.verbatim === "string" ? json.verbatim : "";
  const cleaned = typeof json.cleaned === "string" ? json.cleaned : "";
  const corrections = Array.isArray(json.corrections) ? json.corrections : [];
  // Prefer the cleaned text; fall back to verbatim (or a bare `text` field).
  const text = cleaned || verbatim || (typeof json.text === "string" ? json.text : "");
  return { text, cleaned, verbatim, corrections };
}

module.exports = {
  DEFAULT_STT_URL,
  sttBaseUrl,
  sttHealth,
  sttTranscribe,
  requestStt,
};
