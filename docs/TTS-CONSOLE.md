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
