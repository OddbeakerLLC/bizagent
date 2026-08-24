/**
 * Proxy helpers for the shared oddbeaker-tts HTTP service (Kokoro).
 *
 * Default: http://127.0.0.1:9201 (one daemon per host — do not start a second
 * if Jobe already owns 9201). Override with BIZAGENT_TTS_URL.
 *
 * BizAgent does not embed the model; it only HTTP-proxies to the local service.
 * Browser speechSynthesis remains the client fallback when the service is down.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const DEFAULT_TTS_URL = "http://127.0.0.1:9201";
const DEFAULT_TIMEOUT_MS = 20000;

function ttsBaseUrl() {
  const raw = (process.env.BIZAGENT_TTS_URL || DEFAULT_TTS_URL).trim();
  return raw.replace(/\/+$/, "") || DEFAULT_TTS_URL;
}

function ttsDefaultVoice() {
  const v = (process.env.BIZAGENT_TTS_VOICE || "").trim();
  return v || null;
}

function ttsTimeoutMs() {
  const n = Number(process.env.BIZAGENT_TTS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * Low-level request to the oddbeaker-tts service.
 * @returns {Promise<{ status: number, headers: object, body: Buffer }>}
 */
function requestTts(method, pathAndQuery, opts = {}) {
  const base = ttsBaseUrl();
  let target;
  try {
    target = new URL(pathAndQuery.startsWith("http") ? pathAndQuery : `${base}${pathAndQuery}`);
  } catch (err) {
    return Promise.reject(new Error(`invalid TTS URL: ${err.message}`));
  }

  const isHttps = target.protocol === "https:";
  const lib = isHttps ? https : http;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : ttsTimeoutMs();
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
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
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
      req.destroy(new Error(`TTS request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function ttsHealth() {
  try {
    const res = await requestTts("GET", "/health", { timeoutMs: 2500 });
    if (res.status !== 200) {
      return {
        ok: false,
        available: false,
        status: res.status,
        url: ttsBaseUrl(),
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
      url: ttsBaseUrl(),
      voice: ttsDefaultVoice(),
      engine_loaded: !!json.engine_loaded,
      upstream: json,
    };
  } catch (err) {
    return {
      ok: false,
      available: false,
      url: ttsBaseUrl(),
      voice: ttsDefaultVoice(),
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * POST /synthesize on oddbeaker-tts.
 * @param {{ text: string, voice?: string, speed?: number, raw?: boolean }} payload
 */
async function ttsSynthesize(payload) {
  const text = payload && payload.text != null ? String(payload.text) : "";
  if (!text.trim()) {
    const err = new Error("text required");
    err.code = "bad_request";
    throw err;
  }
  const body = {
    text,
    speed: payload.speed != null ? Number(payload.speed) : 1.0,
    raw: !!payload.raw,
  };
  const voice = (payload.voice && String(payload.voice).trim()) || ttsDefaultVoice();
  if (voice) body.voice = voice;

  const res = await requestTts("POST", "/synthesize", { body });
  let json = {};
  try {
    json = JSON.parse(res.body.toString("utf8") || "{}");
  } catch (_) {
    json = { detail: res.body.toString("utf8").slice(0, 200) };
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(
      (json && (json.detail || json.error)) || `TTS synthesize failed (${res.status})`,
    );
    err.code = "upstream";
    err.status = res.status;
    err.upstream = json;
    throw err;
  }
  return json;
}

/**
 * Fetch a cached WAV from oddbeaker-tts GET /tts/{filename}.
 * @param {string} filename basename only (e.g. abcd.wav)
 */
async function ttsFetchAudio(filename) {
  const name = String(filename || "");
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..") || !name.endsWith(".wav")) {
    const err = new Error("invalid audio filename");
    err.code = "bad_request";
    throw err;
  }
  const res = await requestTts("GET", `/tts/${encodeURIComponent(name)}`);
  if (res.status === 404) {
    const err = new Error("audio not found");
    err.code = "not_found";
    throw err;
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`TTS audio fetch failed (${res.status})`);
    err.code = "upstream";
    err.status = res.status;
    throw err;
  }
  return {
    buffer: res.body,
    contentType: res.headers["content-type"] || "audio/wav",
  };
}

/** Rewrite upstream audio_url (/tts/x.wav) to control-plane path. */
function rewriteAudioUrl(upstreamUrl) {
  if (!upstreamUrl || typeof upstreamUrl !== "string") return null;
  const m = upstreamUrl.match(/\/tts\/([^/?#]+\.wav)$/i);
  if (!m) return null;
  return `/api/tts/audio/${encodeURIComponent(m[1])}`;
}

module.exports = {
  DEFAULT_TTS_URL,
  ttsBaseUrl,
  ttsDefaultVoice,
  ttsHealth,
  ttsSynthesize,
  ttsFetchAudio,
  rewriteAudioUrl,
  requestTts,
};
