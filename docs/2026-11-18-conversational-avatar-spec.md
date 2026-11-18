# Conversational Avatar Add-on — Spec + Feasibility Study

- **Date:** 2026-11-18
- **Status:** Proposal (research + writing only; no implementation in this pass)
- **Author:** Agent BA (bizagent), hub dispatch
- **Related:** `docs/TTS-CONSOLE.md` (existing Kokoro TTS path), 2026-11-18 mic-button work (oddbeaker-stt proxy)

## 1. Goal

Give the BizAgent console a real-time conversational avatar — voice in, animated face out — that is **much more responsive than Jobe AI**. Jobe's push-to-talk loop (batch ASR → LLM → batch TTS) leaves a noticeable dead gap between end-of-speech and the avatar's spoken reply. The BizAgent version targets **≤ 1.0 s from end-of-user-speech to first avatar audio** (stretch: ~600 ms), with the face visibly listening while the user talks and visibly speaking while the reply plays.

Everything here reuses BizAgent's existing architecture where possible: the console web UI (`control-plane/public/`), the authenticated proxy pattern (`tts-proxy.js`, `stt-proxy.js`), the llmapi provider layer (Venice, Ollama, OpenAI, …), and the oddbeaker-stt (:9202) / oddbeaker-tts (:9201) sidecar services.

## 2. UX spec

### 2.1 Conversation modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Push-to-talk** (default, v1) | Click/hold the existing `#micBtn` (or hold Space) | Record while held → streaming transcript appears live in the composer area → on release, endpoint is detected and the turn dispatches. Mirrors the shipped mic-button UX, so there is one learnable control. |
| **Hands-free** (opt-in toggle, later phase) | Avatar panel "hands-free" switch | Mic stays open; on-device VAD detects speech start/end; barge-in allowed while the avatar speaks. Requires echo cancellation (see §3.4). |

- **Live transcript:** while the user speaks, partial ASR text renders in a translucent overlay on the avatar panel (not the composer) so the composer keeps its existing no-auto-send semantics. On endpoint, the finalized text is submitted as a normal chat turn.
- **Reply path:** the hub/agent reply streams token-by-token as today; the avatar speaks from the first speakable sentence (same ` ```tts ` fence / TLDR / first-two-sentences selection rules as `TTS-CONSOLE.md`) instead of waiting for the full reply.
- **Interrupt:** any user speech in hands-free mode (barge-in), or a new user message in either mode, cancels in-flight TTS playback and aborts the in-flight LLM stream — same generation-bump pattern the TTS toggle already uses.
- **Mute/fallback:** the avatar is an overlay on the existing chat, never a replacement. If the voice stack is down, the console degrades to exactly today's text chat (mic greys out, TTS falls back per `TTS-CONSOLE.md`). No new failure mode can break the composer.

### 2.2 Avatar rendering

Three candidate approaches, in increasing cost/complexity:

1. **Procedural 2D face (recommended v1):** a canvas/SVG-drawn stylized face — head shape, eyes, brows, mouth. Mouth driven by **visemes**; eyes by tracked head/gaze; idle by a small behavior state machine. Zero new runtime dependencies, fully offline, trivially themeable, and it cannot look "uncanny" the way a photoreal model can.
2. **VRM 3D avatar (later option):** a `three.js` + VRM viewer with blendshape-driven visemes. Better "wow", but adds a multi-MB 3D stack, model assets, and mobile-GPU budget pressure. Keep as a follow-up skin behind the same viseme/gaze interface.
3. **Video-based face reenactment:** out of scope — heavy, latency-adding, and privacy-hostile.

**Mouth sync / visemes.** Kokoro (oddbeaker-tts) returns audio only — no viseme timeline. Options, cheapest first:

- **Amplitude-driven jaw flap (v1):** analyze the playing audio buffer (we already decode it into Web Audio for playback) with an AnalyserNode; map short-term RMS/low-band energy → mouth open amount, cycle open/close at ~8–12 Hz for speech-like motion. Looks good enough at conversational distance and costs ~0 CPU.
- **Phoneme/viseme timeline (v2):** if oddbeaker-tts can expose Kokoro's internal phoneme stream (it tokenizes to phonemes before synthesis), emit a `{t, phoneme}` track alongside the WAV and map phonemes → visemes (AI/E/O/U/MBP/etc.). Precise lip sync; requires a small oddbeaker-tts change (open question, §6).
- **Text-driven estimate:** align the known text to audio duration for rough timing — fallback if neither of the above lands.

**Eye tracking (client-side, camera-equipped devices).** MediaPipe **Face Landmarker** (`@mediapipe/tasks-vision`, WASM + GPU delegate) gives 478 3D landmarks + 52 blendshapes + a facial transformation matrix from the camera feed. From that we derive head pose (which way the user's head points) and approximate gaze; the avatar's eyes converge toward the user. Runs fully on-device (no camera pixels leave the browser); community experience puts modern phones at 15–30 fps with the GPU delegate (exact ms/frame unverified — treat as a perf-gate test, not an assumption). Camera is **explicit opt-in** per device; without a camera the avatar does a soft "attention drift" idle instead.

**Idle behavior (state machine):**

- `idle`: slow blink every 2–6 s (randomized), tiny saccades, subtle breathing bob; gaze drifts occasionally.
- `listening` (mic open / PTT held): eyes lock toward the user/camera, brows raise slightly on speech onset, head tilts a few degrees — "I'm with you."
- `thinking` (LLM streaming, before first audio): eyes glance up/side, occasional blink — buys perceived latency budget (a face that visibly "thinks" makes 800 ms feel intentional rather than dead).
- `speaking`: viseme-driven mouth, eyebrows accent on emphasized words (energy spikes), head nods subtly.
- `interrupted`: quick eye widen + mouth close on barge-in.

### 2.3 Integration with the existing console and llmapi

- **Server:** new authenticated proxy routes following the `stt-proxy`/`tts-proxy` pattern — `GET /api/avatar/health`, `WS /api/avatar/voice` (bidirectional audio + events). The control plane stays the only thing the browser talks to; sidecar services stay LAN-internal.
- **LLM path unchanged:** the voice turn is a normal chat turn — the transcript enters the conversation, the hub/agent answers through the existing llmapi provider layer (Venice included, tool calls included). The avatar add-on changes **transport and timing**, not the agent architecture. This is the key architectural difference from speech-to-speech APIs (§4, Option C).
- **Client:** new `avatar.js` module (panel + state machine + MediaPipe + audio analysis) loaded lazily only when the avatar panel is opened; reuses the existing Web Audio unlock/generation/interrupt machinery from the TTS work.
- **Feature gating:** avatar + hands-free are per-browser toggles (localStorage, like `bizagent.tts.enabled`); push-to-talk reuses `#micBtn`.

## 3. Latency budget

### 3.1 Where Jobe's delay comes from

The current batch pipeline serializes everything and waits for **complete** artifacts at each stage: record full utterance → VAD/endpoint → transcribe whole clip → LLM generates the **entire** reply → TTS synthesizes the **entire** WAV → playback starts. Each "wait for the whole thing" adds the full tail of that stage to the critical path. Typical end-to-end: **~2.5–4 s** after the user stops talking.

### 3.2 Target budget (streaming pipeline)

| # | Stage | Batch (today) | Target | Technique |
|---|-------|--------------|--------|-----------|
| 1 | VAD endpointing (speech-end detection) | 300–800 ms (silence-padding) | **120–250 ms** | On-device Silero-class VAD with an aggressive (but hysteresis-guarded) end-of-turn timer; optional semantic endpointing later |
| 2 | ASR finalization | 300–1500 ms (whole clip) | **~0–150 ms after endpoint** | Streaming ASR emits partials during speech; the final hypothesis is already ~complete when the endpoint fires |
| 3 | Turn dispatch + LLM **first token** | 500–2000 ms (full reply) | **150–500 ms** | Existing llmapi streaming; first token starts the reply clock. (See §3.3 for the queue caveat.) |
| 4 | TTS **first audio** | 300–1500 ms (full WAV) | **100–300 ms** | Chunked/streaming synthesis; speak sentence 1 as soon as it exists |
| 5 | Network (browser ↔ hub, LAN) | ~10–50 ms | **10–50 ms** | WebSocket already open; audio frames are small |
| 6 | Avatar reaction | n/a | **< 50 ms** | Mouth/eyes driven off the audio stream locally |
| | **End-to-end (speech-end → first audio)** | **~2.5–4 s** | **≤ 1.0 s (P50), ~600 ms stretch** | |

The single biggest conceptual win is not any one number: it is **overlapping** the stages (stream everything, start speaking from the first sentence) instead of serializing full artifacts.

### 3.3 BizAgent-specific risks to the budget

- **llmapi provider queues:** llmapi serializes per-provider calls (concurrency 1, 500 ms min interval) and the dispatcher adds backoff/holds. An interactive voice turn could queue behind background agent dispatches and blow the budget. Mitigation: a voice-turn priority lane (e.g. a dedicated small queue or a `priority` flag on `/v1/chat/completions`) — needs a small llmapi change; flagged as an open question.
- **First speakable sentence:** the existing summary rules (fence/TLDR/first-two-sentences) already define what to speak first — good. But if the model leads with a table or code fence, the speakable head may arrive late. Mitigation: voice-mode prompt hint ("lead with one short spoken sentence").
- **Kokoro first-audio latency:** Kokoro supports chunked synthesis (`split_pattern` per-chunk audio), but oddbeaker-tts currently returns one complete WAV; its per-chunk first-audio latency on the operator's hardware is **unverified** — this is the top measurement task of a Phase 1 spike.

### 3.4 Barge-in specifics

- Browser mic capture must use `echoCancellation: true` (and ideally `noiseSuppression`) so the avatar's own voice through speakers is not transcribed as user speech; WebRTC-style AEC is the reason realtime voice stacks prefer WebRTC transport in browsers. On the hub side a plain WebSocket is fine on LAN.
- On barge-in: bump the TTS play generation (existing pattern), abort the LLM stream, drain the ASR buffer of any echo-contaminated audio, and re-enter `listening`.

## 4. Feasibility — three architecture options

### Option A — Streaming cloud pipeline

Streaming cloud ASR (e.g. Deepgram, AssemblyAI) → existing llmapi LLM (Venice etc.) → streaming cloud TTS (e.g. ElevenLabs Turbo/Flash, Cartesia Sonic).

- **Latency:** ~700–1100 ms speech-end → first audio (vendor-claimed sub-300 ms ASR; TTS first-chunk typically 100–300 ms; LLM first token dominates).
- **Cost:** metered per minute/character. Verified 2026 reference points: AssemblyAI streaming ~$0.30–0.45/hr; Deepgram Voice Agent flat $4.50/hr; ElevenLabs/Cartesia per-character rates **unverified** (gated docs). A chatty hour ≈ a few dollars.
- **Hardware:** none beyond the hub.
- **Privacy:** all speech leaves the premises to 2–3 vendors; camera eye-tracking stays on-device either way.
- **Integration risk:** **medium.** New API keys + new proxy services; per-vendor WebSocket protocols; vendor latency varies by region. Agent architecture untouched.

### Option B — Local/self-hosted streaming pipeline (recommended)

On-device VAD (Silero-class, WASM) → streaming local ASR (faster-whisper / whisper.cpp small model, or oddbeaker-stt extended with a streaming endpoint) → existing llmapi LLM (Venice cloud or local Ollama) → **chunked Kokoro** via an oddbeaker-tts streaming endpoint.

- **Latency:** ~900–1500 ms speech-end → first audio on a decent host (GPU makes ASR+TTS comfortable; CPU-only adds ~300–800 ms). Local RTF figures vary widely by model size/hardware — **unverified**, must be measured in the Phase 1 spike.
- **Cost:** $0 marginal service cost; hardware: one GPU on the hub host is strongly recommended (it likely already runs Kokoro acceptably for batch).
- **Privacy:** best — audio never leaves the LAN (Venice LLM text is the only egress, same as today).
- **Integration risk:** **medium-low.** No new vendors or keys. The real work is two sidecar upgrades: a streaming endpoint on oddbeaker-tts (chunked Kokoro) and either a streaming mode on oddbeaker-stt or a browser-side VAD+batch-ASR hybrid for v1. Both are HTTP/WS surface changes on services BizAgent already owns the pattern for.

### Option C — Hosted realtime speech-to-speech API

OpenAI Realtime (WebRTC in browser; `gpt-realtime-2.1` audio $32/$64 per 1M tokens, or the new GPT-Live-1 sessions at $0.05/min) or Gemini Live (`gemini-3.8-live`, ~$0.005/min audio in + $0.018/min audio out; WebSocket-native, WebRTC via partners).

- **Latency:** lowest — voice-to-voice ~300–600 ms in practice (vendors publish no ms figure; **unverified**). Open-source S2S (Kyutai Moshi, ~200 ms on an L4, needs ~24 GB GPU) is research-grade with no tool-calling ecosystem — not practical here.
- **Cost:** predictable per-minute; cheapest of the cloud options per minute, but a new always-on spend line.
- **Privacy:** full raw audio to the vendor.
- **Integration risk:** **high for BizAgent specifically.** A speech-to-speech model owns the conversation loop — it bypasses llmapi and the provider catalog entirely (Venice is not reachable this way), and BizAgent's value is agent tool-calling through the hub. Bridging S2S output back into agent turns reintroduces an LLM hop and erodes the latency advantage. Keep as a possible future "turbo mode" for pure-chat sessions, not the architecture.

### Recommendation

**Option B**, built in phases, with Option A as an optional accelerator for weak hardware:

1. **Phase 1 — kill the TTS tail (biggest single win, smallest change):** streaming/chunked TTS + speak-from-first-sentence. Even with today's batch ASR, this roughly halves perceived latency.
2. **Phase 2 — streaming ASR + endpointing:** live partials, fast endpoint, dispatch on endpoint; barge-in behind echo cancellation.
3. **Phase 3 — avatar face:** procedural 2D face, amplitude mouth, MediaPipe eye tracking (opt-in camera), idle state machine.
4. **Phase 4 — hands-free mode** and, if ever wanted, an Option C turbo mode.

Phase 1 and Phase 3 are independently shippable; Phase 2 is where the deep latency work lives.

## 5. What this pass did NOT do

No code, no dependency installs, no API keys provisioned, no services started. Everything requiring a new key or paid service is listed as an open question below.

## 6. Open questions for the operator

1. **Target clients/devices:** desktop browser only, or camera-equipped mobile (phone QR flow) as a first-class target? Eye tracking and hands-free tuning differ per platform.
2. **Offline requirement:** must voice work with the WAN down (local Ollama + local ASR/TTS), or is Venice/cloud acceptable?
3. **Budget:** is $0-marginal-cost (Option B) the requirement, or is a few $/hour of cloud voice (Option A) acceptable for better quality/lower latency?
4. **New API keys:** if Option A is ever wanted, may I request keys via DGen form (Deepgram/AssemblyAI/ElevenLabs/Cartesia)? None provisioned now.
5. **Host hardware:** does the hub host have a GPU (and how busy is it)? Determines whether local streaming ASR+TTS hits the 1 s budget or needs the cloud assist.
6. **oddbeaker-tts changes:** is extending oddbeaker-tts with a chunked/streaming endpoint (and optionally a phoneme/viseme track) in scope for the Oddbeaker Framework side, or must BizAgent treat it as read-only?
7. **Voice identity:** same Kokoro voice as today (`BIZAGENT_TTS_VOICE`), or a distinct avatar voice?
8. **Barge-in default:** on by default in hands-free, or opt-in per session?
9. **Audio retention:** are voice recordings/transcripts kept (existing upload rules) or discarded after the turn?
10. **Avatar look:** any preference between the stylized 2D face and a VRM 3D model before Phase 3?
