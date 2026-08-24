let currentConversation = null;
let needsSetup = false;
/** Detect conversation changes even when message count is unchanged
 *  (e.g. launch-ack stripped + hub reply appended → same length). */
let lastConversationStamp = '';
let lastAgentsJson = '';
let titleSet = false;
/** Persisted console display name (never Operator/CEO). */
let displayName = '';
/** Event-driven connections. Prefer WebSocket feeds (subscribe model). SSE kept as fallback. */
let stateSource = null;
let convSource = null;
let ws = null;
let wsReady = false;
let subscribedAgents = false;
let subscribedConv = null; // conv id we are currently subscribed to over WS
/** Pending composer attachments (File objects before upload). */
let pendingAttachFiles = [];
/** Last agents snapshot for recipient dropdown. */
let lastAgentsList = [];
/** Live thinking log: streams an in-flight turn's output in place of the launch-ack. */
let thinkingSource = null;
let thinkingConv = null;
let thinkingAck = null; // identity (created_at) of the launch-ack currently streamed

// UI polling gate for push test. Polling for /api/state and conversation history is OFF by default.
// WS subscribe/push is the preferred and only driver when this flag is off (default).
// Enable (re-enable polling): localStorage.setItem('BIZAGENT_UI_POLL','1'); location.reload()
// Or one-shot enable: add ?poll=1 to the URL.
// To force OFF again: localStorage.removeItem('BIZAGENT_UI_POLL'); location.reload()
// Safe accessors for non-browser test environments.
const __loc = (typeof location !== 'undefined' ? location : { search: '', protocol: 'http:' });
const __search = (typeof URLSearchParams !== 'undefined' ? new URLSearchParams(__loc.search || '') : { get: () => null });
const __storage = (typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null });

const UI_POLL_ENABLED =
  __search.get('poll') === '1' ||
  __storage.getItem('BIZAGENT_UI_POLL') === '1';

// Last-resort polling (never bricks chat). Fires only when NO live push channel exists
// (no WS and no SSE). UI_POLL_ENABLED forces polling even alongside push (for verification).
const FORCE_POLL = UI_POLL_ENABLED;

function conversationPollStamp(conv) {
  const messages = conv && Array.isArray(conv.messages) ? conv.messages : [];
  const last = messages[messages.length - 1];
  // updated_at alone is enough for normal saves; last-message fields catch
  // any same-second edge cases and make the stamp self-explanatory in tests.
  const lastPart = last
    ? `${last.role || ''}|${last.kind || ''}|${last.created_at || ''}|${String(last.content || '').length}`
    : '';
  return `${conv && conv.updated_at ? conv.updated_at : ''}\0${messages.length}\0${lastPart}`;
}

function setAuthStatus(message, kind = 'neutral') {
  const status = document.getElementById('authStatus');
  status.textContent = message;
  status.dataset.kind = kind;
}

function setAuthenticated(isAuthenticated, message) {
  document.getElementById('authPanel').hidden = isAuthenticated;
  document.getElementById('logout').hidden = !isAuthenticated;
  document.getElementById('editDisplayName').hidden = !isAuthenticated;
  const companyBtn = document.getElementById('companyFilesBtn');
  if (companyBtn) companyBtn.hidden = !isAuthenticated;
  const libraryBtn = document.getElementById('libraryBtn');
  if (libraryBtn) libraryBtn.hidden = !isAuthenticated;
  const ttsBtn = document.getElementById('ttsToggle');
  if (ttsBtn) ttsBtn.hidden = !isAuthenticated;
  if (!isAuthenticated) {
    document.getElementById('namePanel').hidden = true;
    hideCompanyModal();
    stopTtsSpeech();
  }
  setAuthStatus(message || (isAuthenticated ? 'Signed in' : 'Login required'), isAuthenticated ? 'ok' : 'warn');
}

function setNameStatus(message, kind = 'neutral') {
  const status = document.getElementById('nameStatus');
  if (!message) {
    status.hidden = true;
    status.textContent = '';
    return;
  }
  status.hidden = false;
  status.textContent = message;
  status.dataset.kind = kind;
}

function messageAuthorLabel(msg) {
  if (msg.role === 'user') return displayName || 'You';
  if (msg.role === 'status') return '';
  return 'Hub';
}

function setSetupMode(isSetup) {
  needsSetup = isSetup;
  document.getElementById('setupHint').hidden = !isSetup;
  document.getElementById('login').textContent = isSetup ? 'Create login' : 'Login';
  document.getElementById('password').autocomplete = isSetup ? 'new-password' : 'current-password';
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    const bodyText = await res.text();
    let errorType = 'login required';
    try {
      const body = JSON.parse(bodyText);
      errorType = body.error || errorType;
    } catch (_err) { /* keep default */ }
    if (errorType === 'setup required') {
      setSetupMode(true);
      setAuthenticated(false, 'First run — create your login below');
      throw new Error(errorType);
    }
    const message = path === '/api/login' ? 'Credentials were not accepted' : 'Login required';
    setAuthenticated(false, message);
    throw new Error(message);
  }
  if (!res.ok) {
    const bodyText = await res.text();
    let message = bodyText || 'Request failed';
    try {
      const body = JSON.parse(bodyText);
      message = body.error || message;
    } catch (_err) {
      // Keep the plain response text when the server did not return JSON.
    }
    throw new Error(message);
  }
  return res.json();
}

function relativeTime(ms) {
  const diff = Date.now() - ms;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// --- Agent rail: expand state + LLM provider/model dialog ---
const expandedAgentSlugs = new Set();
let pendingAgentConfig = null; // { slug, agentName, provider, model }
let cliModelsCache = null; // { clis/providers, cliModels, labels, defaultModel }

async function loadCliModels(force = false) {
  if (!force && cliModelsCache) return cliModelsCache;
  const data = await api('/api/cli-models');
  const providers = Array.isArray(data.providers)
    ? data.providers
    : (Array.isArray(data.clis) ? data.clis : []);
  cliModelsCache = {
    clis: providers,
    providers,
    cliModels: data.cliModels && typeof data.cliModels === 'object'
      ? data.cliModels
      : (data.providerModels || {}),
    labels: data.labels && typeof data.labels === 'object' ? data.labels : {},
    defaultModel: data.defaultModel || '',
  };
  return cliModelsCache;
}

function fillSelect(select, options, selected, labels) {
  select.innerHTML = '';
  const values = Array.isArray(options) ? options.slice() : [];
  if (selected && !values.includes(selected)) values.unshift(selected);
  if (values.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(none available)';
    select.appendChild(opt);
    return;
  }
  const labelMap = labels && typeof labels === 'object' ? labels : {};
  for (const value of values) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = labelMap[value] || value;
    if (value === selected) opt.selected = true;
    select.appendChild(opt);
  }
}

function refreshModelOptionsForCli() {
  if (!pendingAgentConfig || !cliModelsCache) return;
  const cliSelect = document.getElementById('modalCliSelect');
  const modelSelect = document.getElementById('modalModelSelect');
  if (!cliSelect || !modelSelect) return;
  const provider = cliSelect.value;
  const models = (cliModelsCache.cliModels && cliModelsCache.cliModels[provider]) || [];
  // Prefer current model if still valid for this provider; otherwise first model.
  const preferred =
    models.includes(pendingAgentConfig.model) ? pendingAgentConfig.model
      : (models[0] || pendingAgentConfig.model || '');
  fillSelect(modelSelect, models, preferred);
}

async function showAgentConfigModal(agent) {
  const provider = agent.provider || agent.cliName || '';
  pendingAgentConfig = {
    slug: agent.slug,
    agentName: agent.agentName || agent.slug,
    provider,
    cliName: provider,
    model: agent.model || '',
  };
  const modal = document.getElementById('configModal');
  const title = document.getElementById('modalTitle');
  const status = document.getElementById('modalStatus');
  const cliSelect = document.getElementById('modalCliSelect');
  const modelSelect = document.getElementById('modalModelSelect');
  if (!modal || !cliSelect || !modelSelect) return;

  title.textContent = `LLM & model — ${pendingAgentConfig.agentName}`;
  if (status) {
    status.hidden = true;
    status.textContent = '';
  }

  try {
    await loadCliModels(true);
  } catch (err) {
    if (status) {
      status.hidden = false;
      status.textContent = err.message || 'Failed to load LLMs';
      status.dataset.kind = 'warn';
    }
  }

  const clis = (cliModelsCache && (cliModelsCache.providers || cliModelsCache.clis)) || [];
  fillSelect(cliSelect, clis, pendingAgentConfig.provider, cliModelsCache && cliModelsCache.labels);
  refreshModelOptionsForCli();
  modal.hidden = false;
  cliSelect.focus();
}

function hideAgentConfigModal() {
  const modal = document.getElementById('configModal');
  if (modal) modal.hidden = true;
  pendingAgentConfig = null;
  const status = document.getElementById('modalStatus');
  if (status) {
    status.hidden = true;
    status.textContent = '';
  }
}

async function saveAgentConfigModal() {
  if (!pendingAgentConfig) return;
  const cliSelect = document.getElementById('modalCliSelect');
  const modelSelect = document.getElementById('modalModelSelect');
  const status = document.getElementById('modalStatus');
  const saveBtn = document.getElementById('modalSave');
  const provider = cliSelect ? cliSelect.value.trim() : '';
  const model = modelSelect ? modelSelect.value.trim() : '';

  if (!provider) {
    if (status) {
      status.hidden = false;
      status.textContent = 'Select an LLM';
      status.dataset.kind = 'warn';
    }
    return;
  }

  if (saveBtn) saveBtn.disabled = true;
  if (status) {
    status.hidden = false;
    status.textContent = 'Saving…';
    status.dataset.kind = 'pending';
  }
  try {
    await api(`/api/agent/${encodeURIComponent(pendingAgentConfig.slug)}/config`, {
      method: 'PUT',
      body: JSON.stringify({ provider, cliName: provider, model }),
    });
    hideAgentConfigModal();
    // Force re-render even if only model/provider changed.
    lastAgentsJson = '';
    await refreshStatus();
  } catch (err) {
    if (status) {
      status.hidden = false;
      status.textContent = err.message || 'Failed to save';
      status.dataset.kind = 'warn';
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function bindAgentConfigModal() {
  const modal = document.getElementById('configModal');
  if (!modal || modal.dataset.bound === '1') return;
  modal.dataset.bound = '1';
  const close = () => hideAgentConfigModal();
  const modalClose = document.getElementById('modalClose');
  const modalCancel = document.getElementById('modalCancel');
  const modalSave = document.getElementById('modalSave');
  const cliSelect = document.getElementById('modalCliSelect');
  if (modalClose) modalClose.addEventListener('click', close);
  if (modalCancel) modalCancel.addEventListener('click', close);
  if (modalSave) modalSave.addEventListener('click', () => { saveAgentConfigModal(); });
  if (cliSelect) {
    cliSelect.addEventListener('change', () => {
      if (pendingAgentConfig) {
        // When CLI changes, pick a model from the new CLI's list.
        pendingAgentConfig.model = '';
      }
      refreshModelOptionsForCli();
    });
  }
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) close();
  });
}

function makeDetailRow(label, field, isJournal) {
  const dr = document.createElement('div');
  dr.className = isJournal ? 'detail-row detail-row--journal' : 'detail-row';
  const lbl = document.createElement('span');
  lbl.className = 'detail-label';
  lbl.textContent = label;
  const val = document.createElement('span');
  val.className = isJournal ? 'detail-value detail-value--journal' : 'detail-value';
  val.dataset.field = field;
  val.textContent = '—';
  dr.appendChild(lbl);
  dr.appendChild(val);
  return dr;
}

function renderAgentProjects(detail, projects) {
  detail.innerHTML = '';
  const list = document.createElement('ul');
  list.className = 'agent-projects';
  const items = Array.isArray(projects) ? projects : [];
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'agent-project agent-project--empty';
    empty.textContent = 'No projects';
    list.appendChild(empty);
  } else {
    for (const project of items) {
      const li = document.createElement('li');
      li.className = 'agent-project';
      li.textContent = project.name || project.path || '—';
      if (project.path) li.title = project.path;
      list.appendChild(li);
    }
  }
  detail.appendChild(list);
}

function renderAgents(agents) {
  const root = document.getElementById('agents');
  root.innerHTML = '';
  lastAgentsList = Array.isArray(agents) ? agents : [];
  updateAttachRecipientOptions();
  // Sort agents alphabetically by agentName, keeping PTL first
  const sorted = [...agents].sort((a, b) => {
    const aIsPTL = a.agentName === 'Agent PTL' || a.slug === 'hub';
    const bIsPTL = b.agentName === 'Agent PTL' || b.slug === 'hub';
    if (aIsPTL && !bIsPTL) return -1;
    if (!aIsPTL && bIsPTL) return 1;
    return (a.agentName || a.slug || '').localeCompare(b.agentName || b.slug || '');
  });
  sorted.forEach((agent) => {
    const isExpanded = expandedAgentSlugs.has(agent.slug);
    const row = document.createElement('div');
    row.className = 'agent-row';
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(isExpanded));
    row.tabIndex = 0;

    const light = document.createElement('span');
    light.className = `status-light ${agent.hasMail ? 'on' : ''} ${agent.active ? 'running' : ''}`;
    light.title = agent.active ? 'Stop agent (running)' : (agent.hasMail ? 'Inbox has mail' : 'Inbox empty');
    light.addEventListener('click', (e) => {
      e.stopPropagation();
      if (agent.active) {
        stopAgent(agent.slug);
      } else if (thinkingActive()) {
        stopThinking();
      }
    });

    const labels = document.createElement('div');
    labels.className = 'agent-labels';

    // Line 1 (top, large): product name.
    const product = document.createElement('span');
    product.className = 'agent-product';
    product.textContent = agent.name || agent.agentName || agent.slug;
    labels.appendChild(product);

    // Line 2 (middle): agent name.
    const name = document.createElement('span');
    name.className = 'agent-name';
    name.textContent = agent.active ? `${agent.agentName} running` : agent.agentName;
    labels.appendChild(name);

    // Line 3 (beneath, small): model (click opens config; does not toggle expand).
    const cliLine = document.createElement('button');
    cliLine.type = 'button';
    cliLine.className = 'agent-cli-line';
    const modelName = agent.model || '—';
    cliLine.textContent = modelName;
    cliLine.title = 'Change LLM and model';
    cliLine.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showAgentConfigModal(agent);
    });
    labels.appendChild(cliLine);

    const chevron = document.createElement('span');
    chevron.className = 'expand-chevron';
    chevron.textContent = '▸';
    chevron.setAttribute('aria-hidden', 'true');

    row.appendChild(light);
    row.appendChild(labels);
    row.appendChild(chevron);

    const detail = document.createElement('div');
    detail.className = 'agent-detail';
    if (isExpanded) detail.classList.add('expanded');
    detail.dataset.status = agent.hasMail ? 'on' : '';
    detail.appendChild(makeDetailRow('INBOX', 'inbox', false));
    detail.appendChild(makeDetailRow('DISPATCHED', 'lastDispatched', false));
    detail.appendChild(makeDetailRow('JOURNAL', 'journal', true));
    if (typeof renderAgentProjects === 'function') {
      renderAgentProjects(detail, agent.projects);
    }

    let loaded = false;
    const toggle = () => {
      const expanded = row.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      row.setAttribute('aria-expanded', String(next));
      detail.classList.toggle('expanded', next);
      if (next) expandedAgentSlugs.add(agent.slug);
      else expandedAgentSlugs.delete(agent.slug);
      if (next && !loaded) {
        loaded = true;
        const inboxEl = detail.querySelector('[data-field="inbox"]');
        if (inboxEl) inboxEl.textContent = 'Loading…';
        api(`/api/agent-detail/${encodeURIComponent(agent.slug)}`).then((data) => {
          const inbox = detail.querySelector('[data-field="inbox"]');
          const disp = detail.querySelector('[data-field="lastDispatched"]');
          const journal = detail.querySelector('[data-field="journal"]');
          if (inbox) inbox.textContent = data.inbox > 0 ? String(data.inbox) : '—';
          if (disp) {
            disp.textContent = data.lastDispatched
              ? relativeTime(data.lastDispatched)
              : '—';
          }
          if (journal) journal.textContent = data.journal || '—';
        }).catch(() => {
          const inbox = detail.querySelector('[data-field="inbox"]');
          if (inbox) inbox.textContent = '—';
        });
      }
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });

    root.appendChild(row);
    root.appendChild(detail);
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isSafeHref(url) {
  return /^(https?:|mailto:|\/|#)/i.test(url);
}

function isSafeImageSrc(url) {
  return /^(https?:|\/)/i.test(url);
}

function parseTableCells(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  const cells = parseTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableRow(line) {
  const t = line.trim();
  return t.includes('|') && !/^```/.test(t);
}

function renderInline(text) {
  const codeSpans = [];
  let s = text.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(escapeHtml(code));
    return `\x00CODESPAN:${codeSpans.length - 1}\x00`;
  });
  s = escapeHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  // Images before links so ![alt](url) is not partially treated as a link.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, url) => (
    isSafeImageSrc(url)
      ? `<img src="${url}" alt="${alt}" loading="lazy">`
      : match
  ));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => (
    isSafeHref(url)
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : match
  ));
  s = s.replace(/\x00CODESPAN:(\d+)\x00/g, (_, i) => `<code>${codeSpans[Number(i)]}</code>`);
  return s;
}

function renderMarkdown(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const htmlParts = [];
  let paragraphBuffer = [];
  let listBuffer = null;

  const flushParagraph = () => {
    if (paragraphBuffer.length) {
      htmlParts.push(`<p>${paragraphBuffer.map(renderInline).join('<br>')}</p>`);
      paragraphBuffer = [];
    }
  };
  const flushList = () => {
    if (listBuffer) {
      const tag = listBuffer.type;
      htmlParts.push(`<${tag}>${listBuffer.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`);
      listBuffer = null;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      htmlParts.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // GFM table: header row + separator row, then zero or more body rows.
    if (i + 1 < lines.length && isTableRow(line) && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      flushList();
      const headers = parseTableCells(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i]) && lines[i].trim() !== '') {
        bodyRows.push(parseTableCells(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headers.map((h) => `<th>${renderInline(h)}</th>`).join('')}</tr></thead>`;
      const tbody = bodyRows.length
        ? `<tbody>${bodyRows.map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
        : '';
      htmlParts.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    const headerMatch = /^(#{1,6})\s+(.*)/.exec(line);
    if (headerMatch) {
      flushParagraph();
      flushList();
      const level = headerMatch[1].length;
      htmlParts.push(`<h${level}>${renderInline(headerMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    const ulMatch = /^[-*]\s+(.*)/.exec(line);
    const olMatch = /^\d+\.\s+(.*)/.exec(line);
    if (ulMatch || olMatch) {
      flushParagraph();
      const type = ulMatch ? 'ul' : 'ol';
      const itemText = ulMatch ? ulMatch[1] : olMatch[1];
      if (!listBuffer || listBuffer.type !== type) {
        flushList();
        listBuffer = { type, items: [] };
      }
      listBuffer.items.push(itemText);
      i++;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      i++;
      continue;
    }

    flushList();
    paragraphBuffer.push(line);
    i++;
  }
  flushParagraph();
  flushList();
  return htmlParts.join('');
}

function messageClassName(msg) {
  if (msg.role === 'user') return 'message user';
  if (msg.role === 'status') {
    const kind = msg.kind === 'error' ? 'error' : (msg.kind === 'launch-ack' ? 'launch-ack' : '');
    return `message status${kind ? ` ${kind}` : ''}`;
  }
  return 'message system';
}

// --- Console TTS (oddbeaker-tts HTTP preferred; browser speechSynthesis fallback) ---
// Patterns adapted from Jobe PWA buildSpokenText / cleanLineForSpeech.
// Server proxy: POST /api/tts/synthesize → local oddbeaker-tts :9201 (Kokoro).
//
// Chrome speechSynthesis pitfalls this module hardens against:
// - Utterances must be retained (GC mid-speak → silence after reply #1).
// - cancel() often leaves synth.paused=true; resume() before every speak.
// - Long idle / multi-utterance sessions need a resume keepalive.
// - speak() right after cancel() can no-op; microtask + retry once.
const TTS_STORAGE_KEY = 'bizagent.tts.enabled';
const TTS_DEBUG = (() => {
  try { return __storage.getItem('bizagent.tts.debug') === '1'; } catch (_) { return false; }
})();
let ttsEnabled = false;
/** After first paint of a conversation, only *new* hub replies are spoken. */
let ttsPrimed = false;
let lastSpokenHubKey = '';
/** One-shot console warn for speak failures (autoplay / missing voices). */
let ttsSpeakErrorLogged = false;
/** UI state when neither server nor browser TTS is usable. */
let ttsUnavailableReason = '';
/** Cached oddbeaker-tts availability (null = not probed yet). */
let ttsServerAvailable = null;
/** Generation token so late async audio is dropped after stop/new speak. */
let ttsPlayGen = 0;
/** Active HTMLAudioElement for server WAV playback (if any). */
let ttsAudioEl = null;
/**
 * MUST retain current utterance(s) — Chrome GC's unreferenced SpeechSynthesisUtterance
 * and speech dies after the first async hub reply.
 */
let ttsCurrentUtterance = null;
let ttsUtteranceQueue = [];
/** Interval that resumes a stuck paused+speaking synth (Chrome ~15s bug). */
let ttsKeepAliveTimer = null;
/** True after toggle-ON gesture unlocked HTMLAudio / synth this tab session. */
let ttsGestureUnlocked = false;

function hubMessageKey(msg) {
  if (!msg || msg.role !== 'hub') return '';
  return `${msg.created_at || ''}|${String(msg.content || '').length}|${String(msg.content || '').slice(0, 80)}`;
}

function getSpeechSynthesis() {
  if (typeof window === 'undefined') return null;
  return window.speechSynthesis || null;
}

function getTtsVoices() {
  const synth = getSpeechSynthesis();
  if (!synth) return [];
  try {
    return synth.getVoices() || [];
  } catch (_) {
    return [];
  }
}

function ttsSynthSnapshot() {
  const synth = getSpeechSynthesis();
  if (!synth) return { synth: false };
  let pending = 0;
  let speaking = false;
  let paused = false;
  try {
    speaking = !!synth.speaking;
    paused = !!synth.paused;
    pending = typeof synth.pending === 'boolean' ? (synth.pending ? 1 : 0) : 0;
  } catch (_) { /* ignore */ }
  return {
    synth: true,
    enabled: ttsEnabled,
    speaking,
    paused,
    pending,
    voices: getTtsVoices().length,
    server: ttsServerAvailable,
    gen: ttsPlayGen,
    gesture: ttsGestureUnlocked,
  };
}

function logTtsDebug(label, extra) {
  if (!TTS_DEBUG) return;
  try {
    console.info('[bizagent TTS]', label, ttsSynthSnapshot(), extra || '');
  } catch (_) { /* ignore */ }
}

function stopTtsKeepAlive() {
  if (ttsKeepAliveTimer) {
    try { clearInterval(ttsKeepAliveTimer); } catch (_) { /* ignore */ }
    ttsKeepAliveTimer = null;
  }
}

function startTtsKeepAlive() {
  stopTtsKeepAlive();
  ttsKeepAliveTimer = setInterval(() => {
    if (!ttsEnabled) return;
    const synth = getSpeechSynthesis();
    if (!synth) return;
    try {
      // Chrome: speaking+paused stuck mid-utterance until resume().
      if (synth.speaking && synth.paused) {
        logTtsDebug('keepalive resume');
        synth.resume();
      }
    } catch (_) { /* ignore */ }
  }, 4000);
}

function stopTtsSpeech() {
  ttsPlayGen += 1;
  stopTtsKeepAlive();
  ttsCurrentUtterance = null;
  ttsUtteranceQueue = [];
  try {
    if (ttsAudioEl) {
      ttsAudioEl.pause();
      ttsAudioEl.removeAttribute('src');
      try { ttsAudioEl.load(); } catch (_) { /* ignore */ }
      ttsAudioEl = null;
    }
  } catch (_) { /* ignore */ }
  try {
    const synth = getSpeechSynthesis();
    if (synth) {
      synth.cancel();
      // cancel() frequently leaves paused=true; clear it so the next speak works.
      try { if (synth.paused) synth.resume(); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
}

/** Resume if cancel()/browser left synth paused (common Chrome gotcha). */
function ensureTtsResumed() {
  const synth = getSpeechSynthesis();
  if (!synth) return;
  try {
    if (synth.paused) synth.resume();
  } catch (_) { /* ignore */ }
}

function loadTtsEnabled() {
  try {
    return __storage.getItem(TTS_STORAGE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function saveTtsEnabled(on) {
  try {
    if (on) __storage.setItem(TTS_STORAGE_KEY, '1');
    else __storage.removeItem(TTS_STORAGE_KEY);
  } catch (_) { /* ignore */ }
}

function updateTtsToggleUi() {
  const btn = document.getElementById('ttsToggle');
  if (!btn) return;
  btn.classList.toggle('active', ttsEnabled);
  btn.setAttribute('aria-pressed', ttsEnabled ? 'true' : 'false');
  if (ttsUnavailableReason) {
    btn.title = ttsUnavailableReason;
    btn.classList.add('tts-unavailable');
  } else {
    btn.classList.remove('tts-unavailable');
    let title = ttsEnabled
      ? 'Text-to-speech ON (click to disable)'
      : 'Text-to-speech OFF (click to enable)';
    if (ttsEnabled && ttsServerAvailable === true) {
      title += ' · oddbeaker-tts';
    } else if (ttsEnabled && ttsServerAvailable === false) {
      title += ' · browser voice fallback';
    }
    btn.title = title;
  }
}

function setTtsUnavailable(reason) {
  ttsUnavailableReason = reason || '';
  updateTtsToggleUi();
}

function logTtsSpeakErrorOnce(err) {
  if (ttsSpeakErrorLogged) return;
  ttsSpeakErrorLogged = true;
  try {
    console.warn(
      '[bizagent TTS] speak failed (service down, autoplay, or no voices):',
      err || '',
      ttsSynthSnapshot(),
    );
  } catch (_) { /* ignore */ }
}

/** Probe control-plane → oddbeaker-tts health (cached briefly). */
async function probeTtsServer(force) {
  if (!force && ttsServerAvailable !== null) return ttsServerAvailable;
  try {
    const res = await fetch('/api/tts/health', { credentials: 'same-origin' });
    if (!res.ok) {
      ttsServerAvailable = false;
      return false;
    }
    const data = await res.json().catch(() => ({}));
    ttsServerAvailable = !!(data && data.available);
    return ttsServerAvailable;
  } catch (_) {
    ttsServerAvailable = false;
    return false;
  }
}

/**
 * Speak via oddbeaker-tts (server proxy). Returns true if playback started.
 * On failure returns false so caller can fall back to speechSynthesis.
 */
async function speakViaServerTts(spokenText, gen) {
  const res = await fetch('/api/tts/synthesize', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: spokenText, raw: true }),
  });
  if (gen !== ttsPlayGen) return false;
  if (!res.ok) {
    ttsServerAvailable = false;
    throw new Error(`synthesize HTTP ${res.status}`);
  }
  const data = await res.json().catch(() => ({}));
  if (gen !== ttsPlayGen) return false;
  // Empty / nothing_to_speak: success with no audio (do not fall back to browser noise).
  if (!data || data.nothing_to_speak || !data.audio_url) {
    logTtsDebug('server nothing to speak');
    return true;
  }
  // Proxy must rewrite /tts/x.wav → /api/tts/audio/x.wav. If rewrite failed, fall back.
  if (typeof data.audio_url !== 'string' || !data.audio_url.startsWith('/api/tts/')) {
    ttsServerAvailable = false;
    throw new Error('synthesize missing proxied audio_url');
  }
  ttsServerAvailable = true;
  const audio = new Audio(data.audio_url);
  // Same-origin /api path sends session cookie automatically (do not set crossOrigin).
  ttsAudioEl = audio;
  logTtsDebug('server audio play', { url: data.audio_url });
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      let watch = null;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (watch) {
          try { clearInterval(watch); } catch (_) { /* ignore */ }
          watch = null;
        }
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      };
      audio.onended = () => finish(null);
      audio.onerror = () => finish(new Error('audio element error'));
      // stopTtsSpeech mid-play bumps gen — resolve quietly (no browser fallback).
      watch = setInterval(() => {
        if (gen !== ttsPlayGen) {
          try { audio.pause(); } catch (_) { /* ignore */ }
          finish(null);
        }
      }, 200);
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => { /* playing; wait for onended */ }).catch((err) => finish(err));
      }
    });
  } finally {
    if (ttsAudioEl === audio) ttsAudioEl = null;
  }
  // Interrupted by newer speak/stop — success for this gen handoff.
  return true;
}

function cleanLineForSpeech(line) {
  return String(line || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s]+/g, 'link')
    .replace(/`[^`]+`/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildSpokenText(text) {
  const blocks = String(text || '').split(/\n{2,}/);
  const spoken = [];
  let inCodeBlock = false;

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split(/\n/);
    const fenceCount = (trimmed.match(/```/g) || []).length;

    if (inCodeBlock) {
      if (fenceCount % 2 === 1) inCodeBlock = false;
      continue;
    }
    if (trimmed.startsWith('```')) {
      if (fenceCount % 2 === 1) inCodeBlock = true;
      spoken.push("Here's a code snippet.");
      continue;
    }

    const tableLines = lines.filter((l) => l.trim().startsWith('|'));
    if (tableLines.length >= 2) {
      const dataRows = tableLines.filter((l) => !/^[\s|:-]+$/.test(l));
      spoken.push(`Here's a table with ${Math.max(dataRows.length - 1, 0)} rows.`);
      continue;
    }

    const listLines = lines.filter((l) => /^\s*(?:[-*]|\d+\.)\s/.test(l));
    if (listLines.length >= 2) {
      if (listLines.length <= 3) {
        const items = listLines.map((l) =>
          cleanLineForSpeech(l.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))
        );
        spoken.push(`${items.join('. ')}.`);
      } else {
        const first = cleanLineForSpeech(listLines[0].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
        const second = cleanLineForSpeech(listLines[1].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
        spoken.push(`Here are ${listLines.length} items, including ${first}, and ${second}.`);
      }
      continue;
    }

    const prose = lines.map((l) => cleanLineForSpeech(l)).join('. ');
    if (prose.length > 800) {
      const cutoff = prose.substring(0, 500);
      const lastPeriod = cutoff.lastIndexOf('.');
      if (lastPeriod > 100) spoken.push(prose.substring(0, lastPeriod + 1));
      else spoken.push(`${cutoff}.`);
      spoken.push('You can read the rest on screen.');
    } else if (prose) {
      spoken.push(prose);
    }
  }

  let result = spoken.join(' ').trim();
  result = result.replace(/\.{2,}/g, '.').replace(/\s{2,}/g, ' ');
  return result || null;
}

/**
 * Chunk long text so Chrome does not silently drop multi-minute utterances.
 * Prefer sentence boundaries under ~180 chars.
 */
function chunkSpokenText(text, maxLen) {
  const limit = maxLen || 180;
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return [];
  if (src.length <= limit) return [src];
  const parts = [];
  let rest = src;
  while (rest.length > limit) {
    let cut = -1;
    const window = rest.slice(0, limit + 1);
    const m = window.match(/.*[.!?][\s]/);
    if (m && m[0].length > 40) cut = m[0].length;
    if (cut < 0) {
      const sp = rest.lastIndexOf(' ', limit);
      cut = sp > 40 ? sp : limit;
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

function clearBrowserUtteranceState() {
  ttsCurrentUtterance = null;
  ttsUtteranceQueue = [];
  stopTtsKeepAlive();
}

/**
 * Queue and speak via speechSynthesis. Retains utterance refs (Chrome GC fix).
 * @param {string} spokenText already-built spoken text
 * @param {number} gen play generation — abort if stopTtsSpeech advanced it
 * @returns {boolean}
 */
function speakViaBrowserTts(spokenText, gen) {
  const playGen = gen == null ? ttsPlayGen : gen;
  const synth = getSpeechSynthesis();
  if (!synth) {
    setTtsUnavailable('No TTS (oddbeaker-tts down; speechSynthesis missing)');
    logTtsSpeakErrorOnce('speechSynthesis missing');
    return false;
  }
  if (playGen !== ttsPlayGen) return false;

  const chunks = chunkSpokenText(spokenText, 180);
  if (!chunks.length) return false;

  ensureTtsResumed();
  const voices = getTtsVoices();
  if (!voices.length) {
    setTtsUnavailable('No TTS (oddbeaker-tts down; empty browser voice list)');
  } else if (ttsUnavailableReason) {
    setTtsUnavailable('');
  }

  let preferred = null;
  try {
    preferred = voices.find((v) =>
      v.name.includes('Google') || v.name.includes('Samantha') || v.name.includes('Daniel')
    ) || null;
  } catch (_) { /* ignore */ }

  const utterances = chunks.map((chunk) => {
    const u = new SpeechSynthesisUtterance(chunk);
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    if (preferred) {
      try { u.voice = preferred; } catch (_) { /* ignore */ }
    }
    return u;
  });

  // Retain ALL chunks so GC cannot kill mid-queue speech.
  ttsUtteranceQueue = utterances;
  ttsCurrentUtterance = utterances[0] || null;
  startTtsKeepAlive();
  logTtsDebug('browser speak start', { chunks: chunks.length, chars: spokenText.length });

  let idx = 0;
  const finishOk = () => {
    if (playGen !== ttsPlayGen) return;
    clearBrowserUtteranceState();
    logTtsDebug('browser speak end');
  };

  const speakNext = () => {
    if (playGen !== ttsPlayGen) return;
    if (idx >= utterances.length) {
      finishOk();
      return;
    }
    const u = utterances[idx];
    ttsCurrentUtterance = u;
    let settled = false;
    const advance = () => {
      if (settled) return;
      settled = true;
      idx += 1;
      // Yield a tick between chunks so cancel/resume state settles.
      setTimeout(speakNext, 0);
    };
    u.onend = () => advance();
    u.onerror = (ev) => {
      const errName = ev && ev.error ? String(ev.error) : 'error';
      // 'interrupted' / 'canceled' are expected when we stop for a newer reply.
      if (errName === 'interrupted' || errName === 'canceled') {
        logTtsDebug('utterance interrupted', errName);
        // Do not advance — stopTtsSpeech owns the gen bump; leave queue.
        return;
      }
      logTtsSpeakErrorOnce(errName);
      logTtsDebug('utterance error', errName);
      advance();
    };

    const doSpeak = (isRetry) => {
      if (playGen !== ttsPlayGen) return;
      try {
        ensureTtsResumed();
        synth.speak(u);
        ensureTtsResumed();
        // If speak() no-op'd (Chrome after cancel), retry once shortly.
        if (!isRetry) {
          setTimeout(() => {
            if (playGen !== ttsPlayGen || settled) return;
            try {
              if (!synth.speaking && !synth.pending) {
                logTtsDebug('browser speak retry (idle after speak)');
                doSpeak(true);
              }
            } catch (err) {
              logTtsSpeakErrorOnce(err);
            }
          }, 50);
        }
      } catch (err) {
        logTtsSpeakErrorOnce(err);
        advance();
      }
    };

    // First chunk: yield after cancel() so Chrome accepts the new utterance.
    if (idx === 0) setTimeout(() => doSpeak(false), 0);
    else doSpeak(false);
  };

  speakNext();
  return true;
}

/**
 * Speak text: prefer oddbeaker-tts via /api/tts/*; fall back to speechSynthesis.
 * @param {string} text raw or already-built spoken text
 * @param {{ raw?: boolean }} [opts] raw=true skips buildSpokenText (confirmation phrases)
 * @returns {boolean} true if a speak attempt was started (may finish async)
 */
function speakTtsText(text, opts) {
  if (!ttsEnabled) return false;
  const spokenText = opts && opts.raw ? String(text || '').trim() : buildSpokenText(text);
  if (!spokenText) return false;

  // Bump gen + stop prior audio/utterance.
  stopTtsSpeech();
  const gen = ttsPlayGen;
  logTtsDebug('speakTtsText', { raw: !!(opts && opts.raw), chars: spokenText.length });

  // Prefer server when known-available or not yet probed; fall back on failure.
  const tryServer = ttsServerAvailable !== false;
  if (tryServer) {
    (async () => {
      try {
        if (ttsServerAvailable === null) await probeTtsServer(false);
        if (gen !== ttsPlayGen) return;
        if (ttsServerAvailable) {
          const ok = await speakViaServerTts(spokenText, gen);
          if (gen !== ttsPlayGen) return;
          if (ok) {
            if (ttsUnavailableReason) setTtsUnavailable('');
            updateTtsToggleUi();
            return;
          }
          // Server path declined without throwing — try browser.
          logTtsDebug('server speak declined → browser');
        }
      } catch (err) {
        // Only mark server down for transport/API failures — not autoplay / element errors.
        const msg = String(err && err.message || err || '');
        if (/synthesize HTTP|missing proxied|fetch|network|TTS unavailable|502|503/i.test(msg)) {
          ttsServerAvailable = false;
        }
        if (gen !== ttsPlayGen) return;
        logTtsSpeakErrorOnce(err);
        logTtsDebug('server speak failed → browser', msg);
      }
      if (gen !== ttsPlayGen) return;
      // Async hub replies are outside the original click gesture; resume synth first.
      softUnlockBrowserSynth();
      speakViaBrowserTts(spokenText, gen);
      updateTtsToggleUi();
    })();
    return true;
  }

  softUnlockBrowserSynth();
  return speakViaBrowserTts(spokenText, gen);
}

function speakHubReply(text) {
  logTtsDebug('speakHubReply', { chars: String(text || '').length });
  speakTtsText(text);
}

/** Tiny silent WAV — play under user gesture to unlock later HTMLAudioElement plays. */
function unlockHtmlAudioGesture() {
  try {
    if (typeof Audio === 'undefined') return;
    // Minimal valid WAV (very short silence).
    const silent = new Audio(
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='
    );
    silent.volume = 0.01;
    const p = silent.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        try { silent.pause(); } catch (_) { /* ignore */ }
      }).catch(() => { /* autoplay still blocked — browser path may still work */ });
    }
  } catch (_) { /* ignore */ }
}

/**
 * Soft browser unlock used when starting a speak outside the original click
 * (hub replies). Does not cancel in-flight speech; only resumes + optional
 * zero-volume ping if synth looks dead.
 */
function softUnlockBrowserSynth() {
  const synth = getSpeechSynthesis();
  if (!synth) return;
  try {
    ensureTtsResumed();
    // If completely idle and previously unlocked this session, a no-op resume is enough.
    // If stuck paused with empty queue, resume again.
    if (synth.paused) synth.resume();
  } catch (_) { /* ignore */ }
}

/** Unlock autoplay + confirm enable inside the user-gesture click chain. */
function primeTtsOnEnable() {
  ttsGestureUnlocked = true;
  // Warm browser synth + unlock HTMLAudio under this click (Kokoro WAV + fallback).
  try {
    const synth = getSpeechSynthesis();
    if (synth) {
      synth.cancel();
      ensureTtsResumed();
      getTtsVoices();
    }
  } catch (err) {
    logTtsSpeakErrorOnce(err);
  }
  unlockHtmlAudioGesture();
  // Re-probe so toggle-ON picks up a newly started oddbeaker-tts daemon.
  ttsServerAvailable = null;
  const ok = speakTtsText('Text to speech on.', { raw: true });
  if (ok) setTtsUnavailable('');
  updateTtsToggleUi();
  logTtsDebug('primed on enable');
}

function maybeSpeakNewHubReplies(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let latestHub = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || m.role !== 'hub') continue;
    if (!String(m.content || '').trim()) continue;
    latestHub = m;
    break;
  }
  const key = hubMessageKey(latestHub);
  if (!ttsPrimed) {
    ttsPrimed = true;
    lastSpokenHubKey = key;
    logTtsDebug('prime baseline hub key', key ? key.slice(0, 60) : '');
    return;
  }
  if (!key || key === lastSpokenHubKey) return;
  lastSpokenHubKey = key;
  if (ttsEnabled && latestHub) {
    softUnlockBrowserSynth();
    speakHubReply(latestHub.content);
  }
}

function setTtsEnabled(on, opts) {
  const next = !!on;
  const wasOn = ttsEnabled;
  ttsEnabled = next;
  saveTtsEnabled(ttsEnabled);
  updateTtsToggleUi();
  if (!ttsEnabled) {
    stopTtsSpeech();
    return;
  }
  // Prime only on user toggle ON (click gesture unlocks later async speaks).
  if (opts && opts.prime && !wasOn) {
    primeTtsOnEnable();
  }
}

function bindTtsToggle() {
  ttsEnabled = loadTtsEnabled();
  updateTtsToggleUi();
  const btn = document.getElementById('ttsToggle');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    // Toggle OFF: stop. Toggle ON: enable + speak confirmation in this gesture.
    setTtsEnabled(!ttsEnabled, { prime: true });
  });
  // Background probe for oddbeaker-tts; browser voices remain fallback.
  probeTtsServer(true).then(() => updateTtsToggleUi()).catch(() => {});
  try {
    const synth = getSpeechSynthesis();
    if (synth) {
      getTtsVoices();
      synth.onvoiceschanged = () => {
        try {
          const voices = getTtsVoices();
          // Only surface browser-voice warnings when server TTS is known down.
          if (ttsServerAvailable) {
            if (ttsUnavailableReason) setTtsUnavailable('');
            return;
          }
          if (voices.length && ttsUnavailableReason) setTtsUnavailable('');
          else if (!voices.length && ttsEnabled && ttsServerAvailable === false) {
            setTtsUnavailable('No TTS (oddbeaker-tts down; empty browser voice list)');
          }
        } catch (_) { /* ignore */ }
      };
    }
  } catch (_) { /* ignore */ }
}

function renderMessages(messages) {
  const root = document.getElementById('messages');
  root.innerHTML = '';
  messages.forEach((msg) => {
    const el = document.createElement('div');
    el.className = messageClassName(msg);
    const author = messageAuthorLabel(msg);
    if (author) {
      const label = document.createElement('div');
      label.className = 'message-author';
      label.textContent = author;
      el.appendChild(label);
    }
    const body = document.createElement('div');
    body.className = 'message-body';
    // Live thinking: a launch-ack becomes a streaming "thinking" block instead
    // of the static "Working. Stand by..." text. Replaced by the real reply
    // when the conversation updates (the launch-ack is stripped on reply).
    if (msg.role === 'status' && msg.kind === 'launch-ack') {
      body.innerHTML = '';
      const label = document.createElement('div');
      label.className = 'thinking-label';
      label.textContent = 'Thinking…';
      const log = document.createElement('pre');
      log.className = 'thinking-log';
      log.setAttribute('data-thinking-log', '1');
      log.setAttribute('data-thinking-ack', String(msg.created_at || ''));
      body.appendChild(label);
      body.appendChild(log);
    } else {
      body.innerHTML = renderMarkdown(msg.content);
    }
    el.appendChild(body);
    if (Array.isArray(msg.attachments) && msg.attachments.length) {
      const row = document.createElement('div');
      row.className = 'message-attachments';
      msg.attachments.forEach((a) => {
        const chip = document.createElement('span');
        chip.className = 'message-attach-chip';
        const name = a.name || (a.path && a.path.split('/').pop()) || 'file';
        const to = a.to ? ` → ${a.to}` : '';
        chip.textContent = `${name}${to}`;
        chip.title = a.path || name;
        row.appendChild(chip);
      });
      el.appendChild(row);
    }
    root.appendChild(el);
  });
  root.scrollTop = root.scrollHeight;
  syncThinking();
  maybeSpeakNewHubReplies(messages);
}

// --- Live thinking log (streams in-flight turn output) ---
function closeThinkingStream() {
  try { if (thinkingSource) thinkingSource.close(); } catch (_) {}
  thinkingSource = null;
  thinkingConv = null;
  thinkingAck = null;
}

function thinkingLogEl() {
  return document.querySelector('[data-thinking-log="1"]');
}

function thinkingActive() {
  return !!thinkingSource && !!thinkingConv;
}

function openThinkingStream(convId) {
  if (!convId) return;
  const log = thinkingLogEl();
  if (!log) { closeThinkingStream(); return; }
  // Reopen whenever the conversation OR the launch-ack (turn) changes, so the
  // stream always starts at the new turn's log offset — never old thinking.
  const ack = log.getAttribute('data-thinking-ack') || '';
  if (thinkingConv === convId && thinkingAck === ack) return;
  closeThinkingStream();
  thinkingConv = convId;
  thinkingAck = ack;
  thinkingSource = new EventSource(`/api/thinking/stream?conv=${encodeURIComponent(convId)}`);
  thinkingSource.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg && msg.done) {
      closeThinkingStream();
      // Turn ended server-side — soft-refresh messages so a stripped launch-ack /
      // real reply replaces Thinking… if the push was missed.
      // MUST NOT call loadConversation(): that resets ttsPrimed + stopTtsSpeech(),
      // which cancels Kokoro/browser speech for the hub reply and marks it as the
      // baseline (toggle speaks, subsequent hub replies stay silent).
      if (currentConversation === convId) {
        softReloadConversation(convId).catch(() => {});
      }
      return;
    }
    if (msg && msg.text) {
      const el = thinkingLogEl();
      if (!el) { closeThinkingStream(); return; }
      el.textContent += msg.text;
      // Auto-scroll the thinking log itself (it has its own overflow area).
      el.scrollTop = el.scrollHeight;
      const root = document.getElementById('messages');
      if (root) root.scrollTop = root.scrollHeight;
    }
  };
  thinkingSource.onerror = () => { /* SSE will retry; close on done */ };
}

/** Open the thinking stream when a launch-ack is visible; close it otherwise. */
function syncThinking() {
  const hasAck = !!document.querySelector('[data-thinking-log="1"]');
  if (hasAck && currentConversation) {
    openThinkingStream(currentConversation);
  } else if (!hasAck) {
    closeThinkingStream();
  }
}

/** Hard-stop the in-flight turn (operator pressed Escape). */
async function stopThinking() {
  const convId = thinkingConv || currentConversation;
  if (!convId) return;
  closeThinkingStream();
  try {
    await api('/api/thinking/stop', {
      method: 'POST',
      body: JSON.stringify({ conversationId: convId }),
    });
  } catch (_err) { /* best-effort */ }
  // Soft reload: keep TTS priming/in-flight speech rules intact.
  if (currentConversation) await softReloadConversation(currentConversation);
}

async function stopAgent(slug) {
  try {
    await api(`/api/agent/${encodeURIComponent(slug)}/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    // Refresh agent state after a short delay
    setTimeout(() => refreshStatus(), 500);
  } catch (err) {
    console.error('Failed to stop agent', err);
  }
}

async function loadProfile() {
  const profile = await api('/api/profile');
  displayName = (profile && profile.display_name) || '';
  return profile;
}

function showNamePanel(required) {
  const panel = document.getElementById('namePanel');
  panel.hidden = false;
  panel.dataset.required = required ? '1' : '0';
  const input = document.getElementById('displayNameInput');
  input.value = displayName || '';
  setNameStatus(required ? 'Required before chatting' : '', required ? 'warn' : 'neutral');
  input.focus();
}

function hideNamePanel() {
  document.getElementById('namePanel').hidden = true;
  setNameStatus('');
}

async function ensureDisplayName() {
  await loadProfile();
  if (displayName) {
    hideNamePanel();
    return true;
  }
  showNamePanel(true);
  return false;
}

async function saveDisplayName() {
  const input = document.getElementById('displayNameInput');
  const name = (input.value || '').trim();
  if (!name) {
    setNameStatus('Name is required', 'warn');
    return false;
  }
  setNameStatus('Saving...', 'pending');
  try {
    const profile = await api('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({ display_name: name }),
    });
    displayName = profile.display_name || name;
    hideNamePanel();
    setAuthStatus(`Signed in as ${displayName}`, 'ok');
    if (currentConversation) await loadConversation(currentConversation);
    return true;
  } catch (err) {
    setNameStatus(err.message || 'Could not save name', 'warn');
    return false;
  }
}

async function loadConversations() {
  let convs = await api('/api/conversations');
  if (convs.length === 0) {
    const created = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ name: 'Main' }) });
    convs = [{ id: created.id, name: created.name }];
  }
  const select = document.getElementById('conversationSelect');
  select.innerHTML = '';
  convs.forEach((conv) => {
    const option = document.createElement('option');
    option.value = conv.id;
    option.textContent = conv.name;
    select.appendChild(option);
  });
  currentConversation = currentConversation || convs[0].id;
  select.value = currentConversation;
  await loadConversation(currentConversation);
}

/**
 * Soft refresh of the open conversation (thinking done, stop, missed push).
 * Applies new messages via applyConversation — does NOT reset TTS priming or
 * cancel in-flight speech. New hub replies still speak via maybeSpeakNewHubReplies.
 */
async function softReloadConversation(id) {
  if (!id || id !== currentConversation) return;
  try {
    const conv = await api(`/api/conversations/${encodeURIComponent(id)}`);
    applyConversation(id, conv);
  } catch (err) {
    logTtsDebug('softReloadConversation failed', String(err && err.message || err));
  }
}

async function loadConversation(id) {
  const switching = id !== currentConversation;
  currentConversation = id;
  // Prefer WS subscribe for conversation feed; falls back to SSE inside subscribeConversation.
  subscribeConversation(id);
  const conv = await api(`/api/conversations/${encodeURIComponent(id)}`);
  const messages = conv.messages || [];
  lastConversationStamp = conversationPollStamp(conv);
  // Only reset TTS baseline when opening/switching conversations (not soft reloads).
  // Hard load always re-baselines so history is not read aloud.
  ttsPrimed = false;
  lastSpokenHubKey = '';
  stopTtsSpeech();
  if (switching) {
    logTtsDebug('loadConversation switch', id);
  }
  renderMessages(messages);
}

async function refreshStatus() {
  const state = await api('/api/state');
  applyState(state);
}

function applyState(state) {
  if (!titleSet && state && state.org) {
    document.title = `BizAgent — ${state.org}`;
    titleSet = true;
  }
  const json = state ? JSON.stringify(state.agents) : '';
  if (json === lastAgentsJson) return;
  lastAgentsJson = json;
  if (state) renderAgents(state.agents);
}

async function pollConversation() {
  if (!currentConversation) return;
  const conv = await api(`/api/conversations/${encodeURIComponent(currentConversation)}`);
  applyConversation(currentConversation, conv);
}

function applyConversation(id, conv) {
  if (!id || !conv || id !== currentConversation) return;
  const stamp = conversationPollStamp(conv);
  // Same length is not "unchanged": superseding launch-ack with a hub reply
  // keeps messages.length stable while content changes (stuck interim bug).
  if (stamp === lastConversationStamp) return;
  lastConversationStamp = stamp;
  renderMessages(conv.messages || []);
}

async function login() {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  setAuthStatus('Checking credentials...', 'pending');
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    setAuthenticated(true, `Signed in as ${username}`);
    await boot();
  } catch (err) {
    if (!needsSetup) setAuthenticated(false, err.message || 'Login failed');
  }
}

async function setup() {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  if (!username || !password) {
    setAuthStatus('Username and password required', 'warn');
    return;
  }
  setAuthStatus('Creating login...', 'pending');
  try {
    await api('/api/setup', { method: 'POST', body: JSON.stringify({ username, password }) });
    // Auth exists now — always leave setup mode so a login failure is recoverable.
    setSetupMode(false);
    await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    setAuthenticated(true, `Signed in as ${username}`);
    await boot();
  } catch (err) {
    const msg = err.message || 'Setup failed';
    // If credentials were already created (e.g. prior attempt), switch to login.
    if (/auth already initialized/i.test(msg)) {
      setSetupMode(false);
      setAuthStatus('Login already exists — sign in with your username and password', 'warn');
      return;
    }
    setAuthStatus(msg, 'warn');
  }
}

async function boot() {
  let sessionActive = false;
  try {
    setAuthStatus('Checking session...', 'pending');
    bindAgentConfigModal();
    await refreshStatus();
    sessionActive = true;
    const named = await ensureDisplayName();
    setAuthenticated(true, displayName ? `Signed in as ${displayName}` : 'Signed in');
    if (!named) return;
    // Prefetch CLI/model catalog for the agent config dialog (non-blocking).
    loadCliModels().catch(() => {});
    // Primary: open WS first. Wait for ready (or short timeout) before subscribing.
    // This prevents the race that opens SSE fallbacks while WS is still connecting.
    openWebSocket();
    await waitForWsReadyOrTimeout(1200);
    await loadConversations();
    // Subscribe after WS has had a chance; subscribe* will close SSE if WS is live.
    subscribeAgents();
    try { loadEnterprisePanel(); } catch (_) {}
  } catch (_err) {
    if (!sessionActive && !needsSetup) {
      setAuthenticated(false, 'Login required');
    }
  }
}

// --- Library (named browser tab; full-page repo accordion) ---
const LIBRARY_WINDOW_NAME = 'bizagent-library';

function openLibraryTab() {
  const url = '/library.html';
  try {
    const w = window.open(url, LIBRARY_WINDOW_NAME);
    if (w) {
      try { w.focus(); } catch (_err) { /* ignore */ }
      return w;
    }
  } catch (_err) {
    /* popup blocked — fall through */
  }
  // Popup blocked: navigate this tab.
  if (typeof location !== 'undefined') location.assign(url);
  return null;
}

function bindLibraryPage() {
  const openBtn = document.getElementById('libraryBtn');
  if (openBtn && openBtn.dataset.bound !== '1') {
    openBtn.dataset.bound = '1';
    openBtn.addEventListener('click', () => openLibraryTab());
  }
  // Deep-link: #/library still opens the named Library tab once.
  if (typeof window !== 'undefined' && !window.__bizagentLibraryHashBound) {
    window.__bizagentLibraryHashBound = true;
    const maybeOpenFromHash = () => {
      const h = String((__loc.hash || '').replace(/^#/, '')).replace(/^\/+/, '');
      if (h === 'library' || h.startsWith('library/')) {
        openLibraryTab();
        try {
          if (typeof history !== 'undefined') history.replaceState(null, '', '#/chat');
        } catch (_err) {
          /* ignore */
        }
      }
    };
    window.addEventListener('hashchange', maybeOpenFromHash);
    maybeOpenFromHash();
  }
}

// --- Composer attachments ---
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function updateAttachRecipientOptions() {
  const sel = document.getElementById('attachRecipient');
  if (!sel) return;
  const prev = sel.value || 'hub';
  const agents = (lastAgentsList || []).filter((a) => a && a.slug && a.slug !== 'hub');
  sel.innerHTML = '';
  const opts = [
    { value: 'hub', label: 'This chat (Hub)' },
    ...agents.map((a) => ({
      value: a.slug,
      label: a.agentName || a.agent_name || a.name || a.slug,
    })),
    { value: 'company', label: 'Company / KS' },
  ];
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.value = opts.some((o) => o.value === prev) ? prev : 'hub';
}

function renderAttachChips() {
  const row = document.getElementById('attachChips');
  const sel = document.getElementById('attachRecipient');
  if (!row) return;
  row.innerHTML = '';
  if (!pendingAttachFiles.length) {
    row.hidden = true;
    if (sel) sel.hidden = true;
    return;
  }
  row.hidden = false;
  if (sel) sel.hidden = false;
  pendingAttachFiles.forEach((file, idx) => {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    const name = document.createElement('span');
    name.className = 'attach-chip-name';
    name.textContent = `${file.name} (${formatBytes(file.size || 0)})`;
    name.title = file.name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-chip-remove';
    rm.setAttribute('aria-label', 'Remove');
    rm.textContent = '×';
    rm.addEventListener('click', () => {
      pendingAttachFiles.splice(idx, 1);
      renderAttachChips();
    });
    chip.appendChild(name);
    chip.appendChild(rm);
    row.appendChild(chip);
  });
}

async function uploadOneAttachment(file, to, conversationId) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  fd.append('to', to || 'hub');
  if (conversationId) fd.append('conversation_id', conversationId);
  if (to === 'company') fd.append('subdir', 'uploads');
  const res = await fetch('/api/uploads', {
    method: 'POST',
    body: fd,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch (_e) { body = { error: text }; }
  if (!res.ok) throw new Error(body.error || `Upload failed (${res.status})`);
  return {
    name: body.name || file.name,
    path: body.path,
    to: body.to || to,
    size: body.size || file.size,
  };
}

function bindComposerAttachments() {
  const input = document.getElementById('attachInput');
  if (!input || input.dataset.bound === '1') return;
  input.dataset.bound = '1';
  input.addEventListener('change', () => {
    const files = input.files ? Array.from(input.files) : [];
    for (const f of files) {
      if (pendingAttachFiles.length >= 8) break;
      pendingAttachFiles.push(f);
    }
    input.value = '';
    renderAttachChips();
  });
}

// --- Company files (Knowledge Stack inputs on remote hubs) ---
function setCompanyStatus(message, kind = 'neutral') {
  const status = document.getElementById('companyStatus');
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

function hideCompanyModal() {
  const modal = document.getElementById('companyModal');
  if (modal) modal.hidden = true;
  setCompanyStatus('');
  const input = document.getElementById('companyFileInput');
  if (input) input.value = '';
}

async function refreshCompanyFileList() {
  const list = document.getElementById('companyFileList');
  if (!list) return;
  list.innerHTML = '<li class="company-file-empty">Loading…</li>';
  try {
    const data = await api('/api/company/files');
    const files = Array.isArray(data.files) ? data.files : [];
    list.innerHTML = '';
    if (files.length === 0) {
      list.innerHTML = '<li class="company-file-empty">No files in company/ yet.</li>';
      return;
    }
    for (const f of files.slice(0, 100)) {
      const li = document.createElement('li');
      li.className = 'company-file-item';
      const when = f.mtime ? new Date(f.mtime).toLocaleString() : '';
      li.innerHTML = `<span class="company-file-path">${escapeHtml(f.path || f.name || '')}</span>`
        + `<span class="company-file-meta">${formatBytes(f.size || 0)} · ${escapeHtml(when)}</span>`;
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = '';
    setCompanyStatus(err.message || 'Failed to list files', 'warn');
  }
}

async function showCompanyModal() {
  const modal = document.getElementById('companyModal');
  if (!modal) return;
  modal.hidden = false;
  setCompanyStatus('');
  await refreshCompanyFileList();
}

async function uploadCompanyFile(file) {
  if (!file) return;
  const subdirEl = document.getElementById('companySubdir');
  const overwriteEl = document.getElementById('companyOverwrite');
  const subdir = subdirEl ? subdirEl.value : '';
  const overwrite = overwriteEl ? overwriteEl.checked : false;
  setCompanyStatus(`Uploading ${file.name}…`, 'pending');
  try {
    const fd = new FormData();
    fd.append('file', file, file.name);
    if (subdir) fd.append('subdir', subdir);
    if (overwrite) fd.append('overwrite', 'true');
    // Don't set Content-Type — browser sets multipart boundary.
    const res = await fetch('/api/company/files', {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
    });
    const text = await res.text();
    let body = {};
    try { body = JSON.parse(text); } catch (_e) { body = { error: text }; }
    if (!res.ok) throw new Error(body.error || `Upload failed (${res.status})`);
    setCompanyStatus(`Saved company/${body.path} (${formatBytes(body.size || file.size)})`, 'ok');
    await refreshCompanyFileList();
  } catch (err) {
    setCompanyStatus(err.message || 'Upload failed', 'warn');
  }
}

function bindCompanyModal() {
  const modal = document.getElementById('companyModal');
  if (!modal || modal.dataset.bound === '1') return;
  modal.dataset.bound = '1';
  const openBtn = document.getElementById('companyFilesBtn');
  if (openBtn) openBtn.addEventListener('click', () => showCompanyModal());
  const close = () => hideCompanyModal();
  const closeBtn = document.getElementById('companyModalClose');
  const doneBtn = document.getElementById('companyModalDone');
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (doneBtn) doneBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  const refreshBtn = document.getElementById('companyRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => refreshCompanyFileList());
  const fileInput = document.getElementById('companyFileInput');
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) await uploadCompanyFile(file);
      fileInput.value = '';
    });
  }
}

document.getElementById('login').addEventListener('click', () => {
  if (needsSetup) setup();
  else login();
});
document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  setAuthenticated(false, 'Signed out');
});
bindCompanyModal();
bindLibraryPage();
bindTtsToggle();
bindComposerAttachments();
document.getElementById('newConversation').addEventListener('click', async () => {
  if (!displayName) {
    showNamePanel(true);
    return;
  }
  const name = window.prompt('Conversation name', 'New conversation');
  if (!name) return;
  const conv = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ name }) });
  currentConversation = conv.id;
  await loadConversations();
});
document.getElementById('deleteConversation').addEventListener('click', async () => {
  if (!currentConversation) return;
  const select = document.getElementById('conversationSelect');
  const label = select.options[select.selectedIndex]
    ? select.options[select.selectedIndex].textContent
    : 'this conversation';
  if (!window.confirm(`Delete conversation “${label}”? This cannot be undone.`)) return;
  const deletedId = currentConversation;
  await api(`/api/conversations/${encodeURIComponent(deletedId)}`, { method: 'DELETE' });
  currentConversation = null;
  lastConversationStamp = '';
  await loadConversations();
});
document.getElementById('conversationSelect').addEventListener('change', (event) => loadConversation(event.target.value));
document.getElementById('editDisplayName').addEventListener('click', () => showNamePanel(false));
document.getElementById('saveDisplayName').addEventListener('click', async () => {
  const ok = await saveDisplayName();
  if (ok && !currentConversation) await loadConversations();
});
document.getElementById('displayNameInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    document.getElementById('saveDisplayName').click();
  }
});
document.getElementById('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!displayName) {
    showNamePanel(true);
    return;
  }
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  const hasFiles = pendingAttachFiles.length > 0;
  if ((!content && !hasFiles) || !currentConversation) return;
  // Stop prior hub speech when the operator sends a new message.
  stopTtsSpeech();
  const text = content || (hasFiles ? '(attachments)' : '');
  input.value = '';
  let attachments = [];
  if (hasFiles) {
    const sel = document.getElementById('attachRecipient');
    const to = (sel && sel.value) || 'hub';
    const files = pendingAttachFiles.slice();
    pendingAttachFiles = [];
    renderAttachChips();
    try {
      for (const file of files) {
        const uploaded = await uploadOneAttachment(file, to, currentConversation);
        attachments.push(uploaded);
      }
    } catch (err) {
      setAuthStatus(err.message || 'Attachment upload failed', 'warn');
      // restore unsent files
      pendingAttachFiles = files;
      renderAttachChips();
      input.value = content;
      return;
    }
  }
  const conv = await api(`/api/conversations/${encodeURIComponent(currentConversation)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: text, attachments }),
  });
  currentConversation = conv.id;
  await loadConversations();
});
document.getElementById('messageInput').addEventListener('keydown', (event) => {
  // Shift+Enter remains the native textarea newline; Enter sends the message.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    document.getElementById('composer').requestSubmit();
  }
});

// --- Single-channel helpers ---
function closeAllSse() {
  try { if (stateSource) { stateSource.close(); } } catch (_) {}
  try { if (convSource) { convSource.close(); } } catch (_) {}
  stateSource = null;
  convSource = null;
}

function isWsLive() {
  return !!(ws && wsReady && (ws.readyState === 1));
}

// Wait up to ms for WS to become ready. Resolves true if ready, false on timeout.
function waitForWsReadyOrTimeout(ms) {
  return new Promise((resolve) => {
    if (isWsLive()) { resolve(true); return; }
    const t = setTimeout(() => {
      resolve(isWsLive());
    }, Math.max(200, Number(ms) || 1200));
    const check = () => {
      if (isWsLive()) { clearTimeout(t); resolve(true); }
    };
    // Poll readiness briefly; onopen will also set wsReady.
    const iv = setInterval(() => {
      if (isWsLive()) { clearInterval(iv); clearTimeout(t); resolve(true); }
    }, 50);
    // Safety: if WS never opens we resolve false after timeout above.
    setTimeout(() => { clearInterval(iv); }, Math.max(300, ms + 100));
  });
}

function subscribeOverWs() {
  if (!isWsLive()) return;
  try {
    if (subscribedAgents) {
      ws.send(JSON.stringify({ action: 'subscribe', feed: 'agents' }));
    }
    if (subscribedConv) {
      ws.send(JSON.stringify({ action: 'subscribe', feed: `conversation:${subscribedConv}` }));
    }
  } catch (_) {}
}

// --- WebSocket feeds (preferred subscribe model). Snapshots on subscribe + deltas.
function openWebSocket() {
  try { if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; } catch (_) {}
  const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws`;
  try { ws = new WebSocket(url); } catch (_) { ws = null; return; }
  ws.onopen = () => {
    wsReady = true;
    // WS is live: enforce single channel — close any SSE and stay on WS.
    closeAllSse();
    subscribeOverWs();
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
    const { feed, snapshot, id, conv } = msg || {};
    if (feed === 'agents' && snapshot) applyState(snapshot);
    else if (feed && feed.startsWith('conversation:') && id && conv) applyConversation(id, conv);
  };
  ws.onclose = () => {
    wsReady = false;
    // On reconnect attempt, fall back to SSE only if WS never recovers.
    setTimeout(() => {
      if (!wsReady) {
        // Only open SSE if still no WS; subscribe* paths will prefer WS.
        if (subscribedAgents && !stateSource) openStateStream();
        if (subscribedConv && !convSource) openConvStream(subscribedConv);
        openWebSocket();
      }
    }, 1500);
  };
  ws.onerror = () => {};
}

function subscribeAgents() {
  subscribedAgents = true;
  if (isWsLive()) {
    closeAllSse();
    try { ws.send(JSON.stringify({ action: 'subscribe', feed: 'agents' })); } catch (_) {}
  } else {
    // WS not ready yet — defer; boot waits briefly and will close SSE on WS ready.
    openStateStream();
  }
}

function subscribeConversation(id) {
  if (!id || subscribedConv === id) return;
  if (subscribedConv && isWsLive()) {
    try { ws.send(JSON.stringify({ action: 'unsubscribe', feed: `conversation:${subscribedConv}` })); } catch (_) {}
  }
  subscribedConv = id;
  if (isWsLive()) {
    closeAllSse();
    try { ws.send(JSON.stringify({ action: 'subscribe', feed: `conversation:${id}` })); } catch (_) {}
  } else {
    openConvStream(id);
  }
}

// --- SSE fallbacks (only if WS unavailable) ---
function openStateStream() {
  // Never open SSE if a live WS is present.
  if (isWsLive()) { closeAllSse(); return; }
  try { if (stateSource) stateSource.close(); } catch (_) {}
  stateSource = new EventSource('/api/state/stream');
  stateSource.onmessage = (ev) => { try { applyState(JSON.parse(ev.data)); } catch (_) {} };
  stateSource.onerror = () => {};
}

function openConvStream(id) {
  if (!id) return;
  if (isWsLive()) { closeAllSse(); return; }
  try { if (convSource) convSource.close(); } catch (_) {}
  convSource = new EventSource(`/api/conversations/${encodeURIComponent(id)}/stream`);
  convSource.onmessage = (ev) => { try { const p = JSON.parse(ev.data); if (p && p.id && p.conv) applyConversation(p.id, p.conv); } catch (_) {} };
  convSource.onerror = () => {};
}

// Last-resort REST poll: ONLY when no live push channel exists (WS or SSE).
// When FORCE_POLL (UI_POLL_ENABLED or ?poll=1), polling runs regardless (operator verification).
// Default: poll only as true last resort so a partial push path never bricks chat.
setInterval(() => {
  const noPush = !wsReady && !stateSource && !convSource;
  if (FORCE_POLL || noPush) refreshStatus().catch(() => {});
}, 2000);
setInterval(() => {
  const noPush = !wsReady && !convSource && currentConversation;
  if (FORCE_POLL || noPush) pollConversation().catch(() => {});
}, 2000);
// Optional Enterprise additive UI (served when plugin active).
function loadEnterprisePanel() {
  if (document.getElementById("enterprise-panel-script")) return;
  const s = document.createElement("script");
  s.id = "enterprise-panel-script";
  s.src = "/enterprise/enterprise-panel.js";
  s.onerror = function () { try { s.remove(); } catch (_) {} };
  document.head.appendChild(s);
}

// Escape = hard-stop the in-flight thinking (also: click running status light).
// Modal Escape handlers take precedence when a modal is open.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('configModal');
  const companyModal = document.getElementById('companyModal');
  const modalOpen = (modal && !modal.hidden) || (companyModal && !companyModal.hidden);
  if (modalOpen) return;
  if (thinkingActive()) {
    e.preventDefault();
    stopThinking();
  }
});


boot();
