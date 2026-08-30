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

**Preferred:** the BizAgent installer and `scripts/upgrade.sh` call
`scripts/install-oddbeaker-tts.sh`, which clones/installs the package (venv +
`[runtime]` extras), starts a user systemd unit or nohup daemon on
`127.0.0.1:9201`, prompts for a voice, and writes `BIZAGENT_TTS_VOICE` into
hub `.bizagent/env` (never clobbers an existing voice unless `--force-voice`).

```bash
# Fresh install (automatic during install.sh after clone)
# Non-interactive:
#   BIZAGENT_TTS_VOICE=af_heart BIZAGENT_NONINTERACTIVE=1 bash install.sh
# Skip TTS:
#   BIZAGENT_SKIP_TTS=1 bash install.sh

# Manual / repair on an existing hub:
scripts/install-oddbeaker-tts.sh --hub /path/to/hub --prompt-voice
# Upgrade path (offers install when :9201 unhealthy):
scripts/upgrade.sh --hub /path/to/hub --with-tts
```

Source resolution order: `BIZAGENT_TTS_SOURCE` → existing
`~/.bizagent/oddbeaker-tts` → sibling `../oddbeaker-tts` checkouts → SSH
`OddbeakerLLC/oddbeaker-tts` (HTTPS may 404 while the repo is private).

**One daemon per host on port 9201.** If Jobe (or another product) already owns
`127.0.0.1:9201`, the helper detects `/health` and does **not** start a second
process — BizAgent shares it.

```bash
# Manual start only if nothing is listening on 9201:
~/.bizagent/oddbeaker-tts/.venv/bin/oddbeaker-tts --host 127.0.0.1 --port 9201
# or: systemctl --user enable --now oddbeaker-tts.service
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
- **Full hub reply always renders in the console UI** (markdown unchanged).
- **TTS speaks the complete first sentence only** — never a mid-sentence word/char clip, never a multi-sentence summary, never the full body:
  - Light scrub of markdown/noise (fences, tables, paths, filenames, SHAs, backticks) **inside** that sentence is OK; the grammatical sentence stays whole.
  - Sentence boundary = real `.` `!` `?` end (no em-dash / word-count / char-budget cuts for the spoken unit).
  - Hub replies should put the big-picture summary in sentence 1; TTS honors that contract.
- No usable first sentence → minimal fallback *“Reply ready — see the console.”* (never dumps full text, never a partial sentence). Toggle confirmation still uses `raw: true` (“Text to speech on.”).
- Client helpers: `buildSpokenSummary` + `ensureSpokenSentence` (hub replies) + retained `buildSpokenText` / `cleanLineForSpeech` (lighter Jobe-style path kept for non-summary callers). `clipSpokenHeadline` removed.
- Server path sends **preprocessed** text with `raw: true` so oddbeaker-tts does not double-process. (Upstream can still preprocess if `raw` is false.)
- Jobe is unchanged; BizAgent first-sentence mode is console-only (`speakTtsText(..., { summary: true })`).

## Interrupt behavior

- New speakable hub reply cancels any in-flight utterance **and** HTMLAudio / Web Audio playback, then speaks the new text.
- Turning TTS **off** hard-stops immediately: bumps play generation, cancels synth **without** resume, stops BufferSource / HTMLAudio, and **suspends** the AudioContext so a late `source.start()` after an in-flight decode cannot be heard. `ttsEnabled` is cleared first so async synthesize/play paths bail before starting audio. No browser `speechSynthesis` fallback while disabled.
- Turning TTS **on** resumes AudioContext under the click gesture and speaks the confirmation phrase.
- Sending a user message cancels in-flight speech (avoids talking over the next turn).
- Persistence: OFF removes `bizagent.tts.enabled`; ON sets `"1"`. Hard-refresh restores the chosen state (still needs one off→on click after reload to re-unlock autoplay if ON was restored).

## Multi-reply reliability (Kokoro + browser)

**Root cause (2026-08-24 silence after toggle):** when a hub turn finished, the thinking SSE `done` handler called `loadConversation()`, which always reset `ttsPrimed` and `stopTtsSpeech()`. The new hub reply was then treated as the baseline (not spoken), and any in-flight Kokoro WAV was cancelled. Toggle confirmation still worked because it does not go through that path.

**Fix:** thinking `done` / stop use `softReloadConversation()` → `applyConversation()` only (no TTS baseline reset, no forced stop). Hard `loadConversation()` still baselines on open/switch so history is not read aloud.

## Unwanted browser fallback (2026-08-26)

**Root cause:** when oddbeaker-tts was healthy, `POST /api/tts/synthesize` succeeded and returned a proxied WAV URL, but async hub replies (and often the toggle confirmation after the network round-trip) called `HTMLAudioElement.play()` **outside** the original user-gesture window. Chrome rejected play (`NotAllowedError` / autoplay). `speakTtsText` treated that as “server failed” and fell through to `speechSynthesis` — so the operator heard the built-in browser voice even though Kokoro had already synthesized audio. A secondary footgun: `bindTtsToggle()` probed `/api/tts/health` before login (401), which could sticky-cache `ttsServerAvailable = false` and skip Kokoro entirely until reload.

**Fix (client only — oddbeaker-tts unchanged):**

1. **Web Audio unlock** on toggle ON (`AudioContext.resume()` under the click).
2. **Fetch WAV as ArrayBuffer** (cookie’d) and play via **`decodeAudioData` + BufferSource** (gesture-unlocked context survives async synthesize). HTMLAudio blob URL is secondary.
3. **No `speechSynthesis` after successful synthesize** — play-only failures stay on the Kokoro path (silent + one console warn) instead of switching engines mid-session.
4. **Browser fallback only** on real transport/API failure (health down, synthesize 5xx, network).
5. **Probe after session** (`boot` / toggle ON), not at script bind; sticky-false **re-probes after 15s**.

## Last-word cutoff (2026-08-29)

**Symptom:** operator heard every word of the spoken utterance except the final one.

**Causes (client only — oddbeaker-tts WAV already contained the last word + ~500ms tail silence):**

1. **`scrubDenseSpeechTokens`** stripped a lone trailing connector (`on` / `for` / `in` / …) before synthesize, so phrases like “Text to speech on.” became “Text to speech.”
2. **Web Audio `BufferSource`** could still clip the final phoneme at `onended` on some Chromium builds; playback now pads ~200ms of silence after the decoded buffer.
3. **Browser `speechSynthesis` fallback** pads a trailing pause so Chrome does not eat the last syllable.

First-sentence selection is unchanged by the pad (still the complete sentence 1 only).

## Multi-reply reliability (browser fallback)

Chrome `speechSynthesis` historically went silent after the first hub reply. Mitigations in `app.js` (fallback path only):

1. **Retain utterance objects** (`ttsCurrentUtterance` / `ttsUtteranceQueue`) so GC cannot kill mid-session speech.
2. **`resume()` after every `cancel()`** and before every `speak()` (cancel leaves `paused=true`).
3. **Chunk long text** (~180 chars at sentence boundaries) and queue chunks with retained refs.
4. **Keepalive** every 4s: if `speaking && paused`, call `resume()` (Chrome long-utterance stall).
5. **Idle retry:** if `speak()` leaves the synth idle, re-`speak` once after 50ms.
6. **Debug:** `localStorage.setItem('bizagent.tts.debug','1')` then reload → `[bizagent TTS]` console traces (enabled/paused/speaking/voices/gen/server).

## Autoplay / unlock

Browsers often block both `speechSynthesis.speak()` and `HTMLAudioElement.play()` without a user gesture. Console TTS:

1. **On toggle ON (click):** cancel/resume synth, **resume AudioContext**, play a tiny silent WAV, then speak “Text to speech on.” via Kokoro (Web Audio). Browser `speechSynthesis` only if `:9201` / proxy is actually down.
2. **Hub replies (async):** same Web Audio path — no gesture required after toggle unlock.
3. **Missing engines:** button title explains; first failure logs once to the browser console (includes synth snapshot). Toggle title shows `· oddbeaker-tts` when server path is preferred.

Restoring TTS from `localStorage` on reload does **not** auto-prime (no gesture yet). Click the TTS button off→on once after reload if speech is silent. After that, **every** new hub reply should speak via Kokoro without re-toggling when `:9201` is up.

## Verify

```bash
# 1. Service up (shared host port)
curl -sS http://127.0.0.1:9201/health
# → {"status":"ok","engine_loaded":true|false}

# 2. Control plane proxy (must be logged in — use browser session cookie)
curl -sS -b 'bizagent_session=…' http://127.0.0.1:8787/api/tts/health
# → {"ok":true,"available":true,"url":"http://127.0.0.1:9201",...}

# 3. UI: hard-refresh console → enable TTS → hear Kokoro confirmation (not OS voice).
#    Toggle title should include "oddbeaker-tts". Send a message → hub reply also Kokoro.
#    Debug: localStorage.setItem('bizagent.tts.debug','1'); reload → look for
#    "[bizagent TTS] server webaudio play" (not "server speak failed → browser").
# 4. Stop oddbeaker-tts → next speak uses browser speechSynthesis; restart service
#    → within ~15s or toggle OFF/ON, Kokoro is preferred again.
```

## Browser / OS limits (fallback only)

- Requires `window.speechSynthesis` and at least one installed system/browser voice when the server path is down.
- Remote desktop, locked-down VMs, headless, or some Linux installs may report an empty voice list.
- Quality and voice choice vary by OS when falling back; Kokoro quality is consistent when oddbeaker-tts is up.
- Tab must stay open; background-tab throttling can delay or pause speech.
- Edge case: if Web Audio decode/play fails after a good synthesize (corrupt WAV, suspended context never unlocked), console stays silent rather than switching to browser voice — re-toggle TTS ON to re-unlock.
