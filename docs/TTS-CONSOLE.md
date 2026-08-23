# Console TTS (v1)

Optional text-to-speech for hub→operator console replies.

## Switch

- **Where:** Topbar auth controls — `TTS` toggle button (next to Library / Company).
- **Default:** OFF.
- **Persistence:** `localStorage` key `bizagent.tts.enabled` (`"1"` / absent).
- **Scope:** Browser-local only (no registry/server setting).

## Engine

- **v1:** Browser `speechSynthesis` (no server dependency, works offline after page load).
- **Tradeoffs vs Jobe Kokoro:** lower quality / OS-voice variance; zero deploy surface; fine for operator console.
- Future: optional server Kokoro path can reuse the same preprocess + toggle.

## What is spoken

- New **hub** replies only (`role === 'hub'`), after the conversation view is primed.
- Skips user messages, status/launch-ack/thinking, and empty bodies.
- Initial conversation load and conversation switches **do not** read history aloud.
- Preprocess (from Jobe PWA patterns): skip fenced code (announce snippet), summarize tables, shorten long lists/prose, strip markdown/URLs/emoji.

## Interrupt behavior

- New speakable hub reply cancels any in-flight utterance, then speaks the new text.
- Turning TTS off cancels speech immediately.
- Sending a user message cancels in-flight speech (avoids talking over the next turn).

## Autoplay / unlock

Browsers (Chrome/Edge) often drop `speechSynthesis.speak()` when it is not tied to a user gesture. Console TTS handles this by:

1. **On toggle ON (click handler):** `cancel()` + `resume()` if paused, then speak a short confirmation (“Text to speech on.”) so the gesture unlocks later speaks in the same tab session.
2. **Before every speak:** if the synth is `paused` (common after `cancel()`), call `resume()`.
3. **Missing engine / empty voices:** button `title` shows “No browser voice …”; first speak failure logs once to the browser console.

Restoring TTS from `localStorage` on reload does **not** auto-prime (no gesture yet). Click the TTS button off→on once after reload if speech is silent.

## Browser / OS limits

- Requires a browser with `window.speechSynthesis` and at least one installed system/browser voice.
- Remote desktop, locked-down VMs, headless, or some Linux installs may report an empty voice list — TTS cannot work until OS voices are installed.
- Quality and voice choice vary by OS (e.g. Google voices in Chrome, Samantha/Daniel on macOS).
- Tab must stay open; background-tab throttling can delay or pause speech.
- No server fallback in v1 — purely client-side.
