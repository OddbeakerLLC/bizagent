# Console TTS

Optional text-to-speech for hub→operator console replies.

## Switch

- **Where:** Topbar auth controls — `TTS` toggle button (next to Library / Company).
- **Default:** OFF.
- **Persistence:** `localStorage` key `bizagent.tts.enabled` (`"1"` / absent).
- **Scope:** Browser-local only (no registry/server setting for the toggle).

## Engine

Preferred path (when the local service is up):

1. Browser → control plane `POST /api/tts/synthesize` (auth cookie).
2. Control plane → **oddbeaker-tts** HTTP service (`POST http://127.0.0.1:9201/synthesize`).
3. Browser plays the returned WAV via `GET /api/tts/audio/<file>.wav` (proxied from oddbeaker-tts cache).

Fallback (service down / synthesize error):

- Browser `speechSynthesis` (same preprocess + interrupt rules).

Package: **oddbeaker-tts** (Oddbeaker Framework, Kokoro). Import `oddbeaker_tts`; CLI `oddbeaker-tts` / `ob-tts`. BizAgent does **not** embed the model in Node — HTTP client only.

## Install / run oddbeaker-tts

Until a private package index exists, install editable from the monorepo:

```bash
# From a checkout that contains oddbeaker-framework
cd /path/to/oddbeaker-framework/packages/oddbeaker-tts
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[runtime]"
# torch: use the index for your GPU/CPU if needed
```

**One daemon per host on port 9201.** If Jobe (or another product) already owns `127.0.0.1:9201`, do **not** start a second process — BizAgent shares it.

```bash
# Only if nothing is listening on 9201:
oddbeaker-tts
# or: oddbeaker-tts --host 127.0.0.1 --port 9201
```

### Cache

| Environment | `ODDBEAKER_TTS_CACHE_DIR` |
|-------------|---------------------------|
| Appliance   | `/var/cache/oddbeaker-tts` |
| Dev default | `~/.cache/oddbeaker-tts` |

### BizAgent env knobs (hub `.bizagent/env` or process env)

| Variable | Default | Purpose |
|----------|---------|---------|
| `BIZAGENT_TTS_URL` | `http://127.0.0.1:9201` | oddbeaker-tts base URL |
| `BIZAGENT_TTS_VOICE` | _(service default, usually `af_heart`)_ | Optional voice id override |
| `BIZAGENT_TTS_TIMEOUT_MS` | `20000` | Upstream synthesize timeout |

oddbeaker-tts itself also honors `ODDBEAKER_TTS_HOST`, `ODDBEAKER_TTS_PORT`, `ODDBEAKER_TTS_CONFIG`, `ODDBEAKER_TTS_CACHE_DIR`.

## Control-plane API (authenticated)

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/api/tts/health` | `{ available, url, engine_loaded, ... }` — never 5xx solely because upstream is down |
| `POST` | `/api/tts/synthesize` | Body `{ text, voice?, speed?, raw? }` → `{ audio_url, duration_ms, text_spoken, ... }` |
| `GET` | `/api/tts/audio/<file>.wav` | Proxied WAV from oddbeaker-tts cache |

`audio_url` is rewritten to the control-plane path so the browser never talks to :9201 directly.

## What is spoken

- New **hub** replies only (`role === 'hub'`), after the conversation view is primed.
- Skips user messages, status/launch-ack/thinking, and empty bodies.
- Initial conversation load and conversation switches **do not** read history aloud.
- Client preprocess (Jobe-style): skip fenced code (announce snippet), summarize tables, shorten long lists/prose, strip markdown/URLs/emoji.
- Server path sends **preprocessed** text with `raw: true` so oddbeaker-tts does not double-process. (Upstream can still preprocess if `raw` is false.)

## Interrupt behavior

- New speakable hub reply cancels any in-flight utterance **and** HTMLAudio playback, then speaks the new text.
- Turning TTS off cancels speech immediately.
- Sending a user message cancels in-flight speech (avoids talking over the next turn).

## Autoplay / unlock

Browsers often block both `speechSynthesis.speak()` and `HTMLAudioElement.play()` without a user gesture. Console TTS:

1. **On toggle ON (click):** cancel/resume synth, play a tiny silent WAV to unlock audio elements, then speak “Text to speech on.” (server preferred, browser fallback).
2. **Before browser speak:** if the synth is `paused` (common after `cancel()`), call `resume()`.
3. **Missing engines:** button title explains; first failure logs once to the browser console.

Restoring TTS from `localStorage` on reload does **not** auto-prime (no gesture yet). Click the TTS button off→on once after reload if speech is silent.

## Verify

```bash
# 1. Service up (shared host port)
curl -sS http://127.0.0.1:9201/health
# → {"status":"ok","engine_loaded":true|false}

# 2. Control plane proxy (must be logged in — use browser session cookie)
curl -sS -b 'bizagent_session=…' http://127.0.0.1:8787/api/tts/health
# → {"ok":true,"available":true,"url":"http://127.0.0.1:9201",...}

# 3. UI: enable TTS toggle → hear confirmation; send a hub-bound message → hear reply.
# 4. Stop oddbeaker-tts → toggle still works via browser speechSynthesis.
```

## Browser / OS limits (fallback only)

- Requires `window.speechSynthesis` and at least one installed system/browser voice when the server path is down.
- Remote desktop, locked-down VMs, headless, or some Linux installs may report an empty voice list.
- Quality and voice choice vary by OS when falling back; Kokoro quality is consistent when oddbeaker-tts is up.
- Tab must stay open; background-tab throttling can delay or pause speech.
