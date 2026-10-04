/* BizAgent fleet thinking viewer — agent stdout only (dispatch-*.log). */
'use strict';

const MAX_PANE_CHARS = 400000;

let filter = 'all';
let source = null;
let stickToBottom = true;
let paneText = '';

function showAuthGate(on) {
  const gate = document.getElementById('thinkingAuthGate');
  const main = document.getElementById('thinkingMain');
  const label = document.getElementById('thinkingAuthLabel');
  if (gate) gate.hidden = !on;
  if (main) main.hidden = !!on;
  if (label) {
    label.textContent = on ? 'Login required' : 'Signed in';
    label.dataset.kind = on ? 'warn' : 'ok';
  }
}

function setStatus(message) {
  const el = document.getElementById('thinkingStatus');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderFilters(agents) {
  const root = document.getElementById('thinkingFilters');
  if (!root) return;
  const chips = [{ id: 'all', label: 'All' }, { id: 'hub', label: 'Hub' }];
  const seen = new Set(['all', 'hub']);
  const list = Array.isArray(agents) ? agents.slice() : [];
  list.sort((a, b) => String(a).localeCompare(String(b)));
  for (const slug of list) {
    if (!slug || seen.has(slug) || slug === 'hub') continue;
    seen.add(slug);
    chips.push({ id: slug, label: slug });
  }
  if (filter !== 'all' && filter !== 'hub' && !seen.has(filter)) {
    chips.push({ id: filter, label: filter });
  }
  root.innerHTML = chips.map((c) => {
    const on = c.id === filter ? ' thinking-chip-on' : '';
    return `<button type="button" class="thinking-chip${on}" data-filter="${escapeHtml(c.id)}">${escapeHtml(c.label)}</button>`;
  }).join('');
}

function appendChunk(text, reset) {
  const pane = document.getElementById('thinkingPane');
  if (!pane) return;
  if (reset) paneText = '';
  if (text) paneText += text;
  if (paneText.length > MAX_PANE_CHARS) {
    paneText = paneText.slice(paneText.length - MAX_PANE_CHARS);
  }
  pane.textContent = paneText;
  if (stickToBottom) pane.scrollTop = pane.scrollHeight;
}

function closeStream() {
  if (source) {
    try { source.close(); } catch (_err) { /* ignore */ }
    source = null;
  }
}

function openStream() {
  closeStream();
  paneText = '';
  const pane = document.getElementById('thinkingPane');
  if (pane) pane.textContent = '';
  stickToBottom = true;
  setStatus('Connecting…');
  const q = filter && filter !== 'all' ? `?agent=${encodeURIComponent(filter)}` : '';
  const es = new EventSource(`/api/fleet-thinking/stream${q}`);
  source = es;
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_err) { return; }
    if (msg.agents) renderFilters(msg.agents);
    if (msg.reset) appendChunk('', true);
    if (msg.text) {
      appendChunk(msg.text, false);
      setStatus('');
    }
    if (msg.error) setStatus(msg.error);
    if (msg.hello && !paneText) setStatus('Waiting for agent thinking…');
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      setStatus('Stream closed. Reload to reconnect.');
    }
  };
}

function bindFilters() {
  const root = document.getElementById('thinkingFilters');
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  root.addEventListener('click', (event) => {
    const btn = event.target && event.target.closest ? event.target.closest('[data-filter]') : null;
    if (!btn) return;
    const next = btn.getAttribute('data-filter') || 'all';
    if (next === filter) return;
    filter = next;
    renderFilters([]);
    openStream();
  });
}

function bindScrollPause() {
  const pane = document.getElementById('thinkingPane');
  if (!pane || pane.dataset.bound === '1') return;
  pane.dataset.bound = '1';
  pane.addEventListener('scroll', () => {
    const gap = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
    stickToBottom = gap < 48;
  });
}

async function initThinkingPage() {
  document.title = 'BizAgent Thinking';
  renderFilters([]);
  bindFilters();
  bindScrollPause();
  try {
    const res = await fetch('/api/state', { headers: { Accept: 'application/json' } });
    if (res.status === 401) {
      showAuthGate(true);
      return;
    }
    if (!res.ok) throw new Error('session check failed');
    showAuthGate(false);
  } catch (_err) {
    showAuthGate(true);
    return;
  }
  openStream();
}

if (typeof document !== 'undefined' && document.getElementById('thinkingPane')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initThinkingPage());
  } else {
    initThinkingPage();
  }
}
