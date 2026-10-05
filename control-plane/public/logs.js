/* BizAgent Thinking — live-tail of dispatch-*.log (agent stdout only) */
'use strict';

const FILTER_ALL = 'all';

let logsSource = null;
let logsFilter = FILTER_ALL;
let logsFiles = [];
let logsAgents = [];
let logsFollow = true;
let logsUserPaused = false;
let lastSpeaker = '';

function showAuthGate(on) {
  const gate = document.getElementById('logsAuthGate');
  const main = document.getElementById('logsMain');
  const label = document.getElementById('logsAuthLabel');
  if (gate) gate.hidden = !on;
  if (main) main.hidden = !!on;
  if (label) {
    label.textContent = on ? 'Login required' : 'Signed in';
    label.dataset.kind = on ? 'warn' : 'ok';
  }
}

function setLogsStatus(message, kind) {
  const status = document.getElementById('logsStatus');
  if (!status) return;
  if (!message) {
    status.hidden = true;
    status.textContent = '';
    return;
  }
  status.hidden = false;
  status.textContent = message;
  status.dataset.kind = kind || 'neutral';
}

function paneEl() {
  return document.getElementById('logsPane');
}

function isNearBottom(el) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

function scrollLogsToBottom() {
  const pane = paneEl();
  if (!pane) return;
  pane.scrollTop = pane.scrollHeight;
  logsFollow = true;
  logsUserPaused = false;
  const follow = document.getElementById('logsFollow');
  if (follow) follow.checked = true;
}

function maybeAutoscroll() {
  if (!logsFollow || logsUserPaused) return;
  const pane = paneEl();
  if (!pane) return;
  pane.scrollTop = pane.scrollHeight;
}

function agentRecord(slug) {
  return (logsAgents || []).find((a) => a && a.slug === slug) || null;
}

function speakerLabel(slug, name) {
  const rec = agentRecord(slug);
  if (rec) {
    const agentName = rec.agentName || rec.agent_name || rec.name || slug;
    const productName = rec.name || (slug === 'hub' ? 'BizAgent' : slug);
    if (agentName && productName) return `${agentName}: ${productName}`;
    return agentName || productName || slug;
  }
  if (slug === 'hub') return 'Agent PTL: BizAgent';
  return slug || name || 'agent';
}

const MAX_PANE_CHARS = 256 * 1024;

function trimPane() {
  const pane = paneEl();
  if (!pane) return;
  let extra = pane.textContent.length - MAX_PANE_CHARS;
  while (extra > 0 && pane.firstChild) {
    const first = pane.firstChild;
    const firstLen = (first.textContent || '').length;
    if (firstLen <= extra) {
      pane.removeChild(first);
      extra -= firstLen;
      continue;
    }
    if (first.nodeType === Node.TEXT_NODE) {
      first.textContent = first.textContent.slice(extra);
    } else {
      pane.removeChild(first);
    }
    extra = 0;
  }
}

function appendText(text) {
  const pane = paneEl();
  if (!pane || !text) return;
  pane.appendChild(document.createTextNode(text));
  trimPane();
  maybeAutoscroll();
}

function appendSpeakerHeader(slug, name) {
  const pane = paneEl();
  if (!pane) return;
  const span = document.createElement('span');
  span.className = 'logs-header';
  const label = speakerLabel(slug, name);
  span.textContent = `\n—— ${label} ——\n`;
  pane.appendChild(span);
  maybeAutoscroll();
}

function ingestChunk(msg) {
  const text = msg && msg.text;
  if (!text) return;
  const slug = String(msg.slug || '');
  const name = String(msg.file || msg.header || '');
  if (logsFilter === FILTER_ALL) {
    const speaker = slug || name;
    if (speaker && speaker !== lastSpeaker) {
      appendSpeakerHeader(slug, name);
      lastSpeaker = speaker;
    }
  }
  appendText(text);
}

function closeLogsStream() {
  try { if (logsSource) logsSource.close(); } catch (_err) { /* ignore */ }
  logsSource = null;
}

function fileLabel(file) {
  if (!file) return '';
  return speakerLabel(file.slug, file.name);
}

function uniqueSlugs(files) {
  const seen = new Set();
  const out = [];
  for (const f of files || []) {
    const slug = f && f.slug;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(f);
  }
  out.sort((a, b) => {
    if (a.slug === 'hub') return -1;
    if (b.slug === 'hub') return 1;
    return String(a.slug).localeCompare(String(b.slug));
  });
  return out;
}

function renderFilters() {
  const sel = document.getElementById('logsFilterSelect');
  if (!sel) return;
  const options = [{ id: FILTER_ALL, label: 'All' }].concat(
    uniqueSlugs(logsFiles).map((f) => ({ id: f.slug, label: fileLabel(f) })),
  );
  if (logsFilter !== FILTER_ALL && !options.some((c) => c.id === logsFilter)) {
    options.push({ id: logsFilter, label: speakerLabel(logsFilter, logsFilter) });
  }
  const prev = sel.value;
  sel.textContent = '';
  for (const item of options) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.label;
    sel.appendChild(opt);
  }
  const next = options.some((c) => c.id === logsFilter)
    ? logsFilter
    : (options.some((c) => c.id === prev) ? prev : FILTER_ALL);
  sel.value = next;
}

function setLogsFilter(next) {
  const id = String(next || FILTER_ALL);
  if (id === logsFilter && logsSource) return;
  logsFilter = id;
  renderFilters();
  openLogsStream();
}

function openLogsStream() {
  closeLogsStream();
  lastSpeaker = '';
  const pane = paneEl();
  if (pane) pane.textContent = '';
  if (!pane) return;
  const qs = logsFilter && logsFilter !== FILTER_ALL
    ? `?filter=${encodeURIComponent(logsFilter)}`
    : '?filter=all';
  logsSource = new EventSource(`/api/logs/stream${qs}`);
  logsSource.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_err) { return; }
    if (msg.error) {
      setLogsStatus(String(msg.error), 'warn');
      return;
    }
    if (Array.isArray(msg.files)) {
      logsFiles = msg.files;
      renderFilters();
      return;
    }
    if (msg.text) {
      ingestChunk(msg);
      return;
    }
  };
  logsSource.onerror = () => { /* EventSource retries */ };
  logsSource.onopen = () => {
    setLogsStatus('');
    showAuthGate(false);
  };
}

function bindLogsPage() {
  const sel = document.getElementById('logsFilterSelect');
  if (sel && !sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => setLogsFilter(sel.value));
  }
  const follow = document.getElementById('logsFollow');
  if (follow) {
    follow.checked = true;
    follow.addEventListener('change', () => {
      logsFollow = !!follow.checked;
      logsUserPaused = !logsFollow;
      if (logsFollow) maybeAutoscroll();
    });
  }
  const pane = paneEl();
  if (pane) {
    pane.addEventListener('scroll', () => {
      if (!follow) return;
      if (isNearBottom(pane)) {
        logsUserPaused = false;
        logsFollow = true;
        follow.checked = true;
      } else {
        logsUserPaused = true;
        logsFollow = false;
        follow.checked = false;
      }
    });
  }
  const clearBtn = document.getElementById('logsClear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const el = paneEl();
      if (el) el.textContent = '';
      lastSpeaker = '';
    });
  }
  window.addEventListener('beforeunload', closeLogsStream);
  openLogsStream();
}

async function boot() {
  try {
    const res = await fetch('/api/state');
    if (res.status === 401) {
      showAuthGate(true);
      return;
    }
    let state = null;
    try { state = await res.json(); } catch (_err) { state = null; }
    logsAgents = Array.isArray(state && state.agents) ? state.agents : [];
    showAuthGate(false);
    bindLogsPage();
  } catch (_err) {
    showAuthGate(true);
  }
}

boot();
