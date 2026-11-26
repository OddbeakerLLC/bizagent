/* BizAgent Library — named-tab repo accordion browser */
'use strict';

let libraryRepos = [];
let libraryTrees = Object.create(null); // repoId -> tree payload
let libraryExpandedId = ''; // expanded project repo id (or hub)
let libraryExpandedProduct = ''; // expanded product slug ('' when only hub open)
let librarySelected = null; // { repoId, path, id }
let libraryFilterTimer = null;

// H5 (2026-11-15 review): SVG/document content is untrusted — repo files and
// agent-written docs can carry <script>, event handlers, or foreignObject.
// Sanitize before any innerHTML injection; unparseable/non-SVG input is dropped.
function sanitizeSvg(svg) {
  try {
    const doc = new DOMParser().parseFromString(String(svg || ''), 'image/svg+xml');
    if (doc.getElementsByTagName('parsererror').length) return '';
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg') return '';
    doc.querySelectorAll('script, foreignObject, iframe, embed, object, use').forEach((n) => n.remove());
    doc.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (/^on/.test(name)) el.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'xlink:href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    });
    return new XMLSerializer().serializeToString(root);
  } catch (_err) {
    return '';
  }
}

// --- Listen (TTS) in the document viewer ---
// Server TTS only (oddbeaker-tts via the control-plane /api/tts proxy) — the
// same install-time voice preference (BIZAGENT_TTS_VOICE) the console speaks
// with. Browser speechSynthesis is deliberately NOT used and NOT a fallback:
// if the service or the configured voice is missing, Listen fails with a
// visible error instead of silently reading in the built-in browser voice.
// Reading starts at the first text visible in the viewport at click time
// (nearest text-node boundary), never from the top of the document. The first
// TWO sentences are synthesized as ONE clip and played as a seamless lead-in
// unit (no internal gap by construction); after that, text is chunked into
// sentence-sized pieces and the next chunk is fully preloaded (synthesized AND
// its WAV fetched) while the current one plays, so playback continues with
// zero load wait between sentences. If synthesis ever falls behind playback,
// the reader pauses briefly with a "buffering" note rather than skipping text.
let librarySpeechText = ''; // raw markdown/text of the viewed document ('' = nothing speakable)
let librarySpeechActive = false;
let librarySpeechToken = 0;
let librarySpeechAudio = null; // active HTMLAudioElement (paused on Stop/navigate)
let librarySpeechObjectUrl = null; // blob URL of the active audio (revoked after play)
let libraryTtsStatusOk = null; // cached health probe { available, voice } (only fully-OK results)

/** Strip markdown formatting noise so text reads naturally aloud. */
function libraryMarkdownToSpeechText(md) {
  let text = String(md || '').replace(/\r\n?/g, '\n');
  // Fenced code blocks: reading code aloud is noise — drop them entirely.
  text = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
  // Images: keep alt text when present, drop the URL.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => (alt || '').trim());
  // Links: keep the link text, drop the URL (inline, reference, and autolink).
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, (_m, label) => label);
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, (_m, label) => label);
  text = text.replace(/<https?:\/\/[^>\s]+>/g, '');
  // Reference-link definitions at line start: drop.
  text = text.replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gm, '');
  // Headings / blockquotes / list markers: keep the words, drop the markers.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^(\s{0,3})([-*+]|\d+[.)])\s+/gm, '$1');
  // Table separator rows and pipe dividers.
  text = text.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '');
  text = text.replace(/\|/g, ' ');
  // Emphasis / strikethrough / inline code: keep inner text.
  text = text.replace(/(\*\*\*|\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  text = text.replace(/(\*|_)(?=\S)([^*_]*\S)\1/g, '$2');
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  text = text.replace(/`([^`]*)`/g, '$1');
  // Stray HTML tags.
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  // Bare URLs left in prose: drop (they read as letter soup).
  text = text.replace(/\bhttps?:\/\/\S+/g, '');
  // Collapse whitespace runs; keep paragraph breaks.
  text = text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** Split clean text into sentence/paragraph-sized chunks for reliable playback. */
function libraryChunkSpeechText(text) {
  const chunks = [];
  const maxChunk = 220;
  const paragraphs = String(text || '').split(/\n{2,}/);
  for (const para of paragraphs) {
    const clean = para.replace(/\n+/g, ' ').trim();
    if (!clean) continue;
    const sentences = clean.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [clean];
    let current = '';
    for (const rawSentence of sentences) {
      let sentence = rawSentence.trim();
      if (!sentence) continue;
      // Oversized single sentence: hard-split on word boundaries.
      while (sentence.length > maxChunk * 2) {
        let cut = sentence.lastIndexOf(' ', maxChunk * 2);
        if (cut < maxChunk) cut = maxChunk * 2;
        chunks.push(sentence.slice(0, cut).trim());
        sentence = sentence.slice(cut).trim();
      }
      if (!sentence) continue;
      if (current && (current.length + sentence.length + 1) > maxChunk) {
        chunks.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

/**
 * Split the leading two sentences off for the seamless lead-in clip (hub work
 * order 2026-11-25): the first two sentences are synthesized as ONE request
 * and played as one unit, so there is no internal gap by construction. The
 * remainder (rest of the second sentence's paragraph onward) goes back through
 * the normal chunker for the rolling one-ahead queue. Returns { lead, rest };
 * lead is '' only when the text is empty.
 */
function librarySplitLeadIn(text) {
  const paragraphs = String(text || '').split(/\n{2,}/);
  const picked = [];
  const rest = [];
  for (const para of paragraphs) {
    const clean = para.replace(/\n+/g, ' ').trim();
    if (!clean) continue;
    const sentences = clean.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [clean];
    let remainder = '';
    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim();
      if (!sentence) continue;
      if (picked.length < 2) {
        picked.push(sentence);
      } else {
        remainder = remainder ? `${remainder} ${sentence}` : sentence;
      }
    }
    if (remainder) rest.push(remainder);
  }
  return { lead: picked.join(' '), rest: rest.join('\n\n') };
}

/** Escape a string for literal use inside a RegExp. */
function libraryEscapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
}

/**
 * Find `needle` in `text` ignoring whitespace-run differences (the speech text
 * is whitespace-collapsed; DOM text is not). Returns the match index of the
 * first needle word, or -1 when absent.
 */
function libraryLooseFind(text, needle) {
  const words = String(needle || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return -1;
  let re;
  try {
    re = new RegExp(words.map(libraryEscapeRegExp).join('\\s+'));
  } catch (_err) {
    return -1;
  }
  const m = re.exec(String(text));
  return m ? m.index : -1;
}

function libraryListenBtn() {
  return document.getElementById('libraryListenBtn');
}

function setLibraryListenEnabled(on) {
  const btn = libraryListenBtn();
  if (!btn) return;
  // Server TTS, not browser speechSynthesis — availability is checked per
  // click against /api/tts/health, so no client capability gate here.
  btn.hidden = !on;
  btn.disabled = !on;
}

function setLibraryListenSpeaking(speaking) {
  const btn = libraryListenBtn();
  if (!btn) return;
  btn.textContent = speaking ? 'Stop' : 'Listen';
  btn.title = speaking
    ? 'Stop reading aloud'
    : 'Read aloud from the top of the screen';
}

function stopLibrarySpeech() {
  librarySpeechToken += 1;
  librarySpeechActive = false;
  if (librarySpeechAudio) {
    try { librarySpeechAudio.pause(); } catch (_) { /* ignore */ }
    try { librarySpeechAudio.removeAttribute('src'); } catch (_) { /* ignore */ }
    librarySpeechAudio = null;
  }
  if (librarySpeechObjectUrl) {
    try { URL.revokeObjectURL(librarySpeechObjectUrl); } catch (_) { /* ignore */ }
    librarySpeechObjectUrl = null;
  }
  setLibraryListenSpeaking(false);
}

/**
 * Health/voice probe for the install-time TTS preference. Fully-OK results are
 * cached for the page session; anything else re-probes on the next click so a
 * service/voice fix is picked up without a reload.
 */
async function libraryTtsStatus() {
  if (libraryTtsStatusOk) return libraryTtsStatusOk;
  const data = await api('/api/tts/health');
  const status = {
    available: !!(data && data.available),
    voice: String((data && data.voice) || '').trim(),
  };
  if (status.available && status.voice) libraryTtsStatusOk = status;
  return status;
}

/** Synthesize one speech chunk via the control-plane proxy (install voice). */
function librarySynthesizeChunk(text) {
  const p = api('/api/tts/synthesize', {
    method: 'POST',
    body: JSON.stringify({ text, raw: true }),
  }).then((data) => {
    if (!data || !data.audio_url) throw new Error('TTS service returned no audio');
    return data.audio_url;
  });
  // A stop can discard an in-flight prefetch; swallow that rejection so it is
  // never unhandled, while the original promise still rejects for awaiters.
  p.catch(() => {});
  return p;
}

/**
 * Fully preload one speech chunk while the previous one plays: synthesize it
 * AND fetch its WAV into a ready-to-play Blob, so when the current clip ends
 * the next one starts with zero load wait (hub dispatch 2026-11-25 — the
 * synthesize-only prefetch still left the audio fetch latency between
 * sentences). Never blocks playback start: the caller awaits this before
 * playing the chunk, so a slow preload simply delays that chunk's start (the
 * old load-then-play behavior) instead of stuttering or going silent.
 */
function libraryPreloadChunk(text, token) {
  const p = (async () => {
    const audioUrl = await librarySynthesizeChunk(text);
    const res = await fetch(audioUrl, { credentials: 'same-origin' });
    if (token !== librarySpeechToken) return null;
    if (!res.ok) throw new Error(`TTS audio fetch failed (HTTP ${res.status})`);
    return await res.blob();
  })();
  // A stop can discard an in-flight prefetch; swallow that rejection so it is
  // never unhandled, while the original promise still rejects for awaiters.
  p.catch(() => {});
  return p;
}

/**
 * Play one preloaded WAV Blob. Resolves when playback ends OR when the
 * generation token is superseded (Stop / navigation); rejects on real failures.
 */
function libraryPlayWav(blob, token) {
  return new Promise((resolve, reject) => {
    if (token !== librarySpeechToken) { resolve(); return; }
    const url = URL.createObjectURL(blob);
    librarySpeechObjectUrl = url;
    const audio = new Audio(url);
    librarySpeechAudio = audio;
    let settled = false;
    let watch = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (watch) { try { clearInterval(watch); } catch (_) { /* ignore */ } }
      if (librarySpeechAudio === audio) librarySpeechAudio = null;
      if (librarySpeechObjectUrl === url) {
        try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
        librarySpeechObjectUrl = null;
      }
      if (err) reject(err);
      else resolve();
    };
    // Poll so Stop cuts audio immediately instead of at the next event.
    watch = setInterval(() => {
      if (token !== librarySpeechToken) {
        try { audio.pause(); } catch (_) { /* ignore */ }
        finish();
      }
    }, 100);
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error('audio playback failed'));
    const played = audio.play();
    if (played && typeof played.catch === 'function') {
      played.catch((err) => finish(err instanceof Error ? err : new Error('playback blocked')));
    }
  });
}

/**
 * Text nodes of the preview body whose box intersects the visible viewport of
 * the scroll container, in document order.
 */
function libraryVisibleTextNodes() {
  const root = document.getElementById('libraryPreviewBody');
  if (!root) return [];
  const box = root.getBoundingClientRect();
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.nodeValue && node.nodeValue.trim())
      ? NodeFilter.FILTER_ACCEPT
      : NodeFilter.FILTER_REJECT,
  });
  let node;
  while ((node = walker.nextNode())) {
    let rect = null;
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      rect = range.getBoundingClientRect();
    } catch (_err) { continue; }
    if (!rect || (rect.width === 0 && rect.height === 0)) continue; // hidden/collapsed
    if (rect.bottom > box.top + 1 && rect.top < box.bottom - 1) out.push(node);
  }
  return out;
}

/**
 * Character offset in the cleaned speech text matching the first word visible
 * in the viewport at click time (nearest text-node boundary). Matches are
 * whitespace-insensitive and must move forward through the document; falls
 * back to 0 only when no visible text can be matched at all (e.g. the visible
 * node sits inside a dropped code fence).
 */
function librarySpeechStartOffset(speechText) {
  const nodes = libraryVisibleTextNodes().slice(0, 8);
  for (const node of nodes) {
    const snippet = String(node.nodeValue || '').replace(/\s+/g, ' ').trim();
    if (!snippet) continue;
    let triedLen = -1;
    for (const cap of [80, 40, 20, 10, 6]) {
      const take = Math.min(snippet.length, cap);
      if (take === triedLen || take < 4) continue;
      triedLen = take;
      const idx = libraryLooseFind(speechText, snippet.slice(0, take));
      if (idx >= 0) return idx;
    }
  }
  return 0;
}

async function speakLibraryDocument() {
  if (librarySpeechActive) {
    stopLibrarySpeech();
    return;
  }
  if (!librarySpeechText) return;
  const token = ++librarySpeechToken;
  librarySpeechActive = true;
  setLibraryListenSpeaking(true);
  try {
    // Capture the click-time viewport BEFORE any await: the start position is
    // "first visible word at the moment Listen was clicked".
    const text = libraryMarkdownToSpeechText(librarySpeechText);
    if (!text) { stopLibrarySpeech(); return; }
    const start = librarySpeechStartOffset(text);
    // Lead-in unit: the first two sentences synthesized as ONE clip — seamless
    // by construction (hub work order 2026-11-25). The remainder goes through
    // the normal chunker for the rolling one-ahead queue.
    const split = librarySplitLeadIn(text.slice(start));
    const units = [split.lead, ...libraryChunkSpeechText(split.rest)].filter(Boolean);
    if (!units.length) { stopLibrarySpeech(); return; }

    // Install voice only: service up AND a voice configured, else fail loudly.
    const status = await libraryTtsStatus();
    if (token !== librarySpeechToken) return;
    if (!status.available) {
      throw new Error('TTS service (oddbeaker-tts) is not running');
    }
    if (!status.voice) {
      throw new Error('no TTS voice configured — set BIZAGENT_TTS_VOICE in hub .bizagent/env (scripts/install-oddbeaker-tts.sh --prompt-voice)');
    }

    // Rolling one-ahead queue: fully preload (synthesize + WAV fetch) the
    // next unit while the current one plays, so when the current clip ends
    // the next starts with zero load wait. If the next preload is not ready
    // when the current ends, show a brief buffering note and wait for it —
    // the old load-then-play behavior — rather than stuttering or skipping.
    let index = 0;
    let pendingSettled = true;
    const preloadNext = (unitText) => {
      const p = libraryPreloadChunk(unitText, token);
      pendingSettled = false;
      p.then(() => { pendingSettled = true; }, () => { pendingSettled = true; });
      return p;
    };
    let pending = preloadNext(units[0]);
    let buffering = false;
    while (token === librarySpeechToken && index < units.length) {
      let blob;
      if (index > 0 && !pendingSettled) {
        // Synthesis fell behind playback (not the initial lead-in load, which
        // is plain startup): brief buffer note, then wait — never skip text.
        setLibraryStatus('Listen: buffering…', 'neutral');
        buffering = true;
      }
      try {
        blob = await pending;
      } catch (err) {
        if (token !== librarySpeechToken) {
          if (buffering) setLibraryStatus('');
          return;
        }
        throw err;
      }
      if (token !== librarySpeechToken) {
        if (buffering) setLibraryStatus('');
        return;
      }
      if (buffering) { setLibraryStatus(''); buffering = false; }
      index += 1;
      // Preload the next clip during this one's playback.
      pending = index < units.length ? preloadNext(units[index]) : null;
      await libraryPlayWav(blob, token);
    }
    if (token === librarySpeechToken) stopLibrarySpeech();
  } catch (err) {
    const message = (err && err.message) || 'TTS unavailable';
    stopLibrarySpeech();
    setLibraryStatus(`Listen unavailable: ${message}`, 'warn');
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    showAuthGate(true);
    throw new Error('Login required');
  }
  if (!res.ok) {
    const bodyText = await res.text();
    let message = bodyText || 'Request failed';
    try {
      const body = JSON.parse(bodyText);
      message = body.error || message;
    } catch (_err) {
      /* keep text */
    }
    throw new Error(message);
  }
  return res.json();
}

function showAuthGate(on) {
  const gate = document.getElementById('libraryAuthGate');
  const main = document.getElementById('libraryMain');
  const label = document.getElementById('libraryAuthLabel');
  if (gate) gate.hidden = !on;
  if (main) main.hidden = !!on;
  if (label) {
    label.textContent = on ? 'Login required' : 'Signed in';
    label.dataset.kind = on ? 'warn' : 'ok';
  }
}

function setLibraryStatus(message, kind = 'neutral') {
  const status = document.getElementById('libraryStatus');
  if (!status) return;
  if (!message) {
    status.hidden = true;
    status.textContent = '';
    return;
  }
  status.hidden = false;
  status.textContent = message;
  status.dataset.kind = kind;
}

function setLibraryDownloadEnabled(on) {
  const btn = document.getElementById('libraryDownloadBtn');
  if (btn) btn.disabled = !on;
}

function setLibrarySourceVisible(on) {
  const btn = document.getElementById('librarySourceBtn');
  if (btn) {
    btn.hidden = !on;
    btn.disabled = !on;
  }
}

function libraryFilterQuery() {
  const el = document.getElementById('libraryFilter');
  return ((el && el.value) || '').trim().toLowerCase();
}

function libraryEntryKind(doc) {
  if (!doc) return 'document';
  const k = String(doc.kind || doc.type || '').toLowerCase();
  if (k === 'diagram' || k === 'image') return 'diagram';
  if (k === 'plantuml') return 'plantuml';
  const p = String(doc.path || doc.name || '').toLowerCase();
  if (p.endsWith('.svg') || p.endsWith('.png')) return 'diagram';
  if (p.endsWith('.puml') || p.endsWith('.plantuml')) return 'plantuml';
  return 'document';
}

function librarySourceBlock(doc) {
  const sourceText = doc.source_content
    || ((String(doc.ext || doc.path || '').toLowerCase().match(/\.puml$|\.plantuml$/))
      ? doc.content
      : '');
  if (!sourceText) return '';
  return `<details class="library-diagram-source"><summary>View PlantUML source</summary>`
    + `<pre class="library-source-pre">${escapeHtml(sourceText)}</pre></details>`;
}

function fileApiUrl(repoId, filePath, extra = {}) {
  const qs = new URLSearchParams();
  qs.set('repo', repoId);
  qs.set('path', filePath);
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== '') qs.set(k, String(v));
  }
  return `/api/library/file?${qs.toString()}`;
}

function nodeMatchesFilter(node, q) {
  if (!q) return true;
  if (node.type === 'file') {
    return String(node.name || '').toLowerCase().includes(q)
      || String(node.path || '').toLowerCase().includes(q);
  }
  const kids = Array.isArray(node.children) ? node.children : [];
  return kids.some((c) => nodeMatchesFilter(c, q));
}

function filterTree(nodes, q) {
  if (!q) return nodes || [];
  const out = [];
  for (const n of nodes || []) {
    if (n.type === 'file') {
      if (nodeMatchesFilter(n, q)) out.push(n);
      continue;
    }
    if (!nodeMatchesFilter(n, q)) continue;
    const kids = filterTree(n.children || [], q);
    if (kids.length) out.push({ ...n, children: kids });
  }
  return out;
}

function renderTreeNodes(nodes, repoId, depth) {
  const ul = document.createElement('ul');
  ul.className = depth === 0 ? 'library-tree library-tree-root' : 'library-tree';
  for (const node of nodes || []) {
    const li = document.createElement('li');
    if (node.type === 'dir') {
      li.className = 'library-tree-dir';
      const label = document.createElement('div');
      label.className = 'library-tree-dir-label';
      label.textContent = node.name;
      li.appendChild(label);
      li.appendChild(renderTreeNodes(node.children || [], repoId, depth + 1));
    } else {
      li.className = 'library-tree-file';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'library-tree-file-btn';
      btn.dataset.repo = repoId;
      btn.dataset.path = node.path;
      const kind = libraryEntryKind(node);
      const badge = (kind === 'plantuml' || kind === 'diagram') ? ' · diagram' : '';
      btn.innerHTML = `<span class="library-tree-file-name">${escapeHtml(node.name)}</span>`
        + `<span class="library-tree-file-meta">${escapeHtml(badge.trim())}</span>`;
      if (
        librarySelected
        && librarySelected.repoId === repoId
        && librarySelected.path === node.path
      ) {
        btn.classList.add('is-selected');
      }
      btn.addEventListener('click', () => openLibraryFile(repoId, node.path));
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
  return ul;
}

function isHubRepo(repo) {
  return !!(repo && (repo.kind === 'hub' || repo.kind === 'hub-library'
    || repo.id === 'hub' || repo.id === 'hub-library'));
}

function productKey(repo) {
  if (isHubRepo(repo)) return 'hub';
  return String(repo.product || repo.product_name || 'product');
}

function productLabel(repo) {
  if (isHubRepo(repo)) return 'Hub';
  return String(repo.product_name || repo.product || 'Product');
}

/** Group flat API repos into Hub + products (each with projects). Order preserved from API. */
function groupLibraryRepos(repos) {
  const hub = [];
  const products = [];
  const byKey = Object.create(null);
  for (const repo of repos || []) {
    if (isHubRepo(repo)) {
      hub.push(repo);
      continue;
    }
    const key = productKey(repo);
    if (!byKey[key]) {
      const group = {
        key,
        name: productLabel(repo),
        projects: [],
      };
      byKey[key] = group;
      products.push(group);
    }
    byKey[key].projects.push(repo);
  }
  return { hub, products };
}

/** True when repo has ≥1 file whose name/path matches q. Product/project labels do not match. */
function repoTreeMatchesFilter(repo, q) {
  if (!q) return true;
  const cached = libraryTrees[repo.id];
  if (!cached || cached.error) return false;
  return filterTree(cached.tree || [], q).length > 0;
}

/** Prefetch viewable-file trees so filter can hide empty products/projects. */
async function ensureLibraryTreesLoaded(repoIds) {
  const ids = repoIds || libraryRepos.map((r) => r.id);
  const missing = ids.filter((id) => id && !libraryTrees[id]);
  if (!missing.length) return;
  await Promise.all(missing.map(async (repoId) => {
    try {
      const data = await api(`/api/library/tree?repo=${encodeURIComponent(repoId)}`);
      libraryTrees[repoId] = data;
    } catch (err) {
      libraryTrees[repoId] = { error: err.message || 'Failed to load tree', tree: [] };
    }
  }));
}

/** Debounced filter path: load trees when querying, then re-render (hides non-matches). */
async function applyLibraryFilter() {
  const q = libraryFilterQuery();
  if (q) await ensureLibraryTreesLoaded();
  renderAccordion();
}

function fillRepoBody(body, repo, q) {
  const cached = libraryTrees[repo.id];
  if (!cached) {
    body.innerHTML = '<p class="company-file-empty">Loading…</p>';
    return;
  }
  if (cached.error) {
    body.innerHTML = `<p class="company-file-empty">${escapeHtml(cached.error)}</p>`;
    return;
  }
  const tree = filterTree(cached.tree || [], q);
  if (!tree.length) {
    body.innerHTML = q
      ? '<p class="company-file-empty">No viewable files match this filter.</p>'
      : '<p class="company-file-empty">No viewable files in this repo.</p>';
    return;
  }
  body.appendChild(renderTreeNodes(tree, repo.id, 0));
  if (cached.truncated) {
    const note = document.createElement('p');
    note.className = 'library-tree-truncated';
    note.textContent = 'Tree truncated (too many nodes).';
    body.appendChild(note);
  }
}

function renderProjectItem(repo, q) {
  const item = document.createElement('div');
  item.className = 'library-acc-item library-acc-project';
  item.dataset.repoId = repo.id;
  // While filtering, open every project that still has matching files so hits are reachable.
  const projectOpen = q
    ? repoTreeMatchesFilter(repo, q)
    : libraryExpandedId === repo.id;
  if (projectOpen) item.classList.add('is-expanded');

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'library-acc-head library-acc-project-head';
  head.setAttribute('aria-expanded', projectOpen ? 'true' : 'false');
  const avail = repo.available === false ? ' · offline' : '';
  head.innerHTML = `<span class="library-acc-chevron" aria-hidden="true"></span>`
    + `<span class="library-acc-title">${escapeHtml(repo.label || repo.name)}</span>`
    + `<span class="library-acc-meta">${escapeHtml(avail.trim())}</span>`;
  head.addEventListener('click', () => toggleRepo(repo.id));
  item.appendChild(head);

  const body = document.createElement('div');
  body.className = 'library-acc-body';
  if (projectOpen) fillRepoBody(body, repo, q);
  item.appendChild(body);
  return item;
}

function renderAccordion() {
  const root = document.getElementById('libraryAccordion');
  if (!root) return;
  root.innerHTML = '';
  if (!libraryRepos.length) {
    root.innerHTML = '<p class="company-file-empty">No project repos found in registry.</p>';
    return;
  }
  const q = libraryFilterQuery();
  const { hub, products } = groupLibraryRepos(libraryRepos);

  for (const repo of hub) {
    if (q && !repoTreeMatchesFilter(repo, q)) continue;
    const item = document.createElement('div');
    item.className = 'library-acc-item library-acc-hub';
    item.dataset.repoId = repo.id;
    const hubOpen = q
      ? repoTreeMatchesFilter(repo, q)
      : libraryExpandedId === repo.id;
    if (hubOpen) item.classList.add('is-expanded');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'library-acc-head';
    head.setAttribute('aria-expanded', hubOpen ? 'true' : 'false');
    head.innerHTML = `<span class="library-acc-chevron" aria-hidden="true"></span>`
      + `<span class="library-acc-title">${escapeHtml(repo.label || repo.name || 'Hub')}</span>`
      + `<span class="library-acc-meta">Hub</span>`;
    head.addEventListener('click', () => toggleRepo(repo.id));
    item.appendChild(head);

    const body = document.createElement('div');
    body.className = 'library-acc-body';
    if (hubOpen) fillRepoBody(body, repo, q);
    item.appendChild(body);
    root.appendChild(item);
  }

  for (const product of products) {
    const visibleProjects = product.projects.filter((p) => repoTreeMatchesFilter(p, q));
    if (q && !visibleProjects.length) continue;

    const item = document.createElement('div');
    item.className = 'library-acc-item library-acc-product';
    item.dataset.product = product.key;
    const productOpen = libraryExpandedProduct === product.key
      || (!!q && visibleProjects.length > 0);
    if (productOpen) item.classList.add('is-expanded');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'library-acc-head library-acc-product-head';
    head.setAttribute('aria-expanded', productOpen ? 'true' : 'false');
    const count = visibleProjects.length;
    const meta = count === 1 ? '1 project' : `${count} projects`;
    head.innerHTML = `<span class="library-acc-chevron" aria-hidden="true"></span>`
      + `<span class="library-acc-title">${escapeHtml(product.name)}</span>`
      + `<span class="library-acc-meta">${escapeHtml(meta)}</span>`;
    head.addEventListener('click', () => toggleProduct(product.key));
    item.appendChild(head);

    const body = document.createElement('div');
    body.className = 'library-acc-body library-acc-product-body';
    if (productOpen) {
      const nest = document.createElement('div');
      nest.className = 'library-acc-nested';
      for (const proj of visibleProjects) {
        nest.appendChild(renderProjectItem(proj, q));
      }
      body.appendChild(nest);
    }
    item.appendChild(body);
    root.appendChild(item);
  }
}

function toggleProduct(key) {
  if (libraryExpandedProduct === key) {
    libraryExpandedProduct = '';
    // Collapse nested project if it belonged to this product.
    const open = libraryRepos.find((r) => r.id === libraryExpandedId);
    if (open && !isHubRepo(open) && productKey(open) === key) {
      libraryExpandedId = '';
    }
    renderAccordion();
    return;
  }
  libraryExpandedProduct = key;
  // Closing other products is implicit (single expanded product).
  // Keep hub file pane independent; clear project expand if switching products.
  const open = libraryRepos.find((r) => r.id === libraryExpandedId);
  if (open && !isHubRepo(open) && productKey(open) !== key) {
    libraryExpandedId = '';
  }
  renderAccordion();
}

async function toggleRepo(repoId) {
  if (libraryExpandedId === repoId) {
    libraryExpandedId = '';
    renderAccordion();
    return;
  }
  libraryExpandedId = repoId;
  const repo = libraryRepos.find((r) => r.id === repoId);
  if (repo && !isHubRepo(repo)) {
    libraryExpandedProduct = productKey(repo);
  }
  renderAccordion();
  if (!libraryTrees[repoId]) {
    try {
      const data = await api(`/api/library/tree?repo=${encodeURIComponent(repoId)}`);
      libraryTrees[repoId] = data;
    } catch (err) {
      libraryTrees[repoId] = { error: err.message || 'Failed to load tree', tree: [] };
    }
    if (libraryExpandedId === repoId) renderAccordion();
  }
}

async function openLibraryFile(repoId, filePath) {
  const titleEl = document.getElementById('libraryPreviewTitle');
  const bodyEl = document.getElementById('libraryPreviewBody');
  if (!bodyEl) return;
  librarySelected = { repoId, path: filePath, id: `${repoId}:${filePath}` };
  stopLibrarySpeech();
  librarySpeechText = '';
  setLibraryListenEnabled(false);
  bodyEl.innerHTML = '<p class="company-file-empty">Loading…</p>';
  bodyEl.scrollTop = 0;
  setLibraryDownloadEnabled(false);
  setLibrarySourceVisible(false);
  document.querySelectorAll('.library-tree-file-btn').forEach((el) => {
    el.classList.toggle(
      'is-selected',
      el.dataset.repo === repoId && el.dataset.path === filePath,
    );
  });

  try {
    const kindHint = libraryEntryKind({ path: filePath });
    const qs = kindHint === 'plantuml'
      ? fileApiUrl(repoId, filePath, { render: '1', format: 'svg' })
      : fileApiUrl(repoId, filePath);
    const doc = await api(qs);
    if (titleEl) {
      const repo = libraryRepos.find((r) => r.id === repoId);
      let prefix = '';
      if (repo) {
        if (isHubRepo(repo)) {
          prefix = `${repo.label || repo.name || 'Hub'} / `;
        } else {
          const prod = productLabel(repo);
          const proj = repo.label || repo.name || '';
          prefix = prod && proj ? `${prod} / ${proj} / ` : `${proj} / `;
        }
      }
      titleEl.textContent = `${prefix}${doc.title || doc.path || filePath}`;
    }
    const kind = libraryEntryKind(doc);
    const metaPath = doc.source_path
      ? `${doc.path} (source ${doc.source_path})`
      : (doc.path || filePath);
    const sourceHtml = librarySourceBlock(doc);
    if (kind === 'plantuml' && doc.svg) {
      bodyEl.innerHTML = `<div class="library-diagram">${sanitizeSvg(doc.svg)}</div>`
        + `<p class="library-diagram-meta"><code>${escapeHtml(metaPath)}</code> · rendered SVG</p>`
        + sourceHtml;
    } else if (kind === 'diagram' || kind === 'plantuml') {
      const ext = String(doc.ext || doc.path || '').toLowerCase();
      if (ext.endsWith('.svg') && doc.content && /<svg/i.test(doc.content)) {
        bodyEl.innerHTML = `<div class="library-diagram">${sanitizeSvg(doc.content)}</div>`
          + `<p class="library-diagram-meta"><code>${escapeHtml(metaPath)}</code></p>`
          + sourceHtml;
      } else {
        const rawUrl = fileApiUrl(repoId, filePath, { raw: '1' });
        bodyEl.innerHTML = `<div class="library-diagram"><img class="library-diagram-img" src="${rawUrl}" alt="${escapeHtml(doc.title || doc.path || 'diagram')}"></div>`
          + `<p class="library-diagram-meta"><code>${escapeHtml(metaPath)}</code></p>`
          + sourceHtml;
      }
    } else {
      bodyEl.innerHTML = renderMarkdown(doc.content || '') || '<p class="company-file-empty">(empty)</p>';
      librarySpeechText = String(doc.content || '');
      setLibraryListenEnabled(!!librarySpeechText.trim());
    }
    bodyEl.scrollTop = 0;
    setLibraryDownloadEnabled(true);
    const hasSource = !!(doc.source_path || kind === 'plantuml' || doc.source_content);
    setLibrarySourceVisible(hasSource);
  } catch (err) {
    librarySpeechText = '';
    setLibraryListenEnabled(false);
    bodyEl.innerHTML = `<p class="company-file-empty">${escapeHtml(err.message || 'Failed to load')}</p>`;
    bodyEl.scrollTop = 0;
  }
}

function downloadLibraryDoc() {
  if (!librarySelected) return;
  const a = document.createElement('a');
  a.href = fileApiUrl(librarySelected.repoId, librarySelected.path, { download: '1' });
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadLibrarySource() {
  if (!librarySelected) return;
  const a = document.createElement('a');
  a.href = fileApiUrl(librarySelected.repoId, librarySelected.path, {
    source: '1',
    download: '1',
  });
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function refreshLibraryRepos() {
  setLibraryStatus('');
  const root = document.getElementById('libraryAccordion');
  if (root) root.innerHTML = '<p class="company-file-empty">Loading…</p>';
  try {
    const data = await api('/api/library/repos');
    libraryRepos = Array.isArray(data.repos) ? data.repos : [];
    // Drop cached trees so Refresh re-reads disk.
    libraryTrees = Object.create(null);
    const keep = libraryExpandedId;
    const keepProduct = libraryExpandedProduct;
    libraryExpandedId = '';
    libraryExpandedProduct = '';
    renderAccordion();
    if (keepProduct) libraryExpandedProduct = keepProduct;
    if (keep) await toggleRepo(keep);
    else if (keepProduct) renderAccordion();
  } catch (err) {
    if (root) root.innerHTML = '';
    libraryRepos = [];
    setLibraryStatus(err.message || 'Failed to list repos', 'warn');
  }
}

async function initLibraryPage() {
  document.title = 'BizAgent Library';
  try {
    await api('/api/state');
    showAuthGate(false);
  } catch (_err) {
    showAuthGate(true);
    return;
  }

  const refreshBtn = document.getElementById('libraryRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => refreshLibraryRepos());
  const dlBtn = document.getElementById('libraryDownloadBtn');
  if (dlBtn) dlBtn.addEventListener('click', () => downloadLibraryDoc());
  const srcBtn = document.getElementById('librarySourceBtn');
  if (srcBtn) srcBtn.addEventListener('click', () => downloadLibrarySource());
  const listenBtn = document.getElementById('libraryListenBtn');
  if (listenBtn) listenBtn.addEventListener('click', () => speakLibraryDocument());
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', stopLibrarySpeech);
    window.addEventListener('beforeunload', stopLibrarySpeech);
  }
  const filter = document.getElementById('libraryFilter');
  if (filter) {
    filter.addEventListener('input', () => {
      clearTimeout(libraryFilterTimer);
      libraryFilterTimer = setTimeout(() => {
        applyLibraryFilter().catch(() => renderAccordion());
      }, 120);
    });
  }

  await refreshLibraryRepos();
  // Auto-expand Hub (filtered docs/company/reports) for a useful first view.
  const hubId = libraryRepos.some((r) => r.id === 'hub')
    ? 'hub'
    : (libraryRepos.some((r) => r.id === 'hub-library') ? 'hub-library' : '');
  if (hubId) await toggleRepo(hubId);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initLibraryPage());
  } else {
    initLibraryPage();
  }
}
