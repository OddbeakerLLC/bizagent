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
/** SPA route: 'chat' | 'library' */
let currentRoute = 'chat';
/** Library list cache + selection */
let libraryEntriesCache = [];
let librarySelectedId = '';
/** Pending composer attachments (File objects before upload). */
let pendingAttachFiles = [];
/** Last agents snapshot for recipient dropdown. */
let lastAgentsList = [];

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
  if (!isAuthenticated) {
    document.getElementById('namePanel').hidden = true;
    hideCompanyModal();
    if (currentRoute === 'library') navigateRoute('chat');
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
    light.className = `status-light ${agent.hasMail ? 'on' : ''}`;
    light.title = agent.hasMail ? 'Inbox has mail' : 'Inbox empty';

    const labels = document.createElement('div');
    labels.className = 'agent-labels';

    const name = document.createElement('span');
    name.className = 'agent-name';
    name.textContent = agent.active ? `${agent.agentName} running` : agent.agentName;
    labels.appendChild(name);

    if (agent.name && agent.name !== agent.agentName) {
      const product = document.createElement('span');
      product.className = 'agent-product';
      product.textContent = agent.name;
      labels.appendChild(product);
    }

    // LLM provider >> model (click opens config; does not toggle expand)
    const cliLine = document.createElement('button');
    cliLine.type = 'button';
    cliLine.className = 'agent-cli-line';
    const providerName = agent.provider || agent.cliName || '—';
    const modelName = agent.model || '—';
    cliLine.textContent = `${providerName} >> ${modelName}`;
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
    body.innerHTML = renderMarkdown(msg.content);
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

async function loadConversation(id) {
  currentConversation = id;
  // Prefer WS subscribe for conversation feed; falls back to SSE inside subscribeConversation.
  subscribeConversation(id);
  const conv = await api(`/api/conversations/${encodeURIComponent(id)}`);
  const messages = conv.messages || [];
  lastConversationStamp = conversationPollStamp(conv);
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

// --- SPA routing (chat | library) ---
function parseRoute() {
  const h = String((__loc.hash || '').replace(/^#/, '')).replace(/^\/+/, '');
  if (h === 'library' || h.startsWith('library/')) return 'library';
  return 'chat';
}

function navigateRoute(route, { push = true } = {}) {
  const next = route === 'library' ? 'library' : 'chat';
  if (push) {
    const want = next === 'library' ? '#/library' : '#/chat';
    if ((__loc.hash || '') !== want && typeof history !== 'undefined') {
      history.pushState(null, '', want);
    } else if (typeof location !== 'undefined') {
      location.hash = want;
    }
  }
  applyRoute(next);
}

function applyRoute(route) {
  currentRoute = route === 'library' ? 'library' : 'chat';
  const chat = document.getElementById('chatShell');
  const lib = document.getElementById('libraryShell');
  if (chat) chat.hidden = currentRoute !== 'chat';
  if (lib) lib.hidden = currentRoute !== 'library';
  if (currentRoute === 'library') {
    refreshLibraryList(librarySelectedId).catch(() => {});
  }
}

// --- Library page (operator-facing plans/specs) ---
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

function libraryFilterQuery() {
  const el = document.getElementById('libraryFilter');
  return ((el && el.value) || '').trim().toLowerCase();
}

function entryMatchesFilter(e, q) {
  if (!q) return true;
  const title = String(e.title || '').toLowerCase();
  const p = String(e.path || '').toLowerCase();
  const tags = Array.isArray(e.tags) ? e.tags.join(' ').toLowerCase() : '';
  return title.includes(q) || p.includes(q) || tags.includes(q);
}

function renderLibraryList(selectId) {
  const list = document.getElementById('libraryList');
  if (!list) return;
  const q = libraryFilterQuery();
  const entries = libraryEntriesCache.filter((e) => entryMatchesFilter(e, q));
  list.innerHTML = '';
  if (libraryEntriesCache.length === 0) {
    list.innerHTML = '<li class="company-file-empty">Library is empty. Ask the hub or an agent to save a plan under library/.</li>';
    setLibraryDownloadEnabled(false);
    return;
  }
  if (entries.length === 0) {
    list.innerHTML = '<li class="company-file-empty">No documents match this filter.</li>';
    setLibraryDownloadEnabled(false);
    return;
  }
  for (const e of entries) {
    const li = document.createElement('li');
    li.className = 'company-file-item library-list-item';
    li.dataset.id = e.id;
    const when = e.created_at ? new Date(e.created_at).toLocaleString() : '';
    li.innerHTML = `<span class="company-file-path">${escapeHtml(e.title || e.path || e.id)}</span>`
      + `<span class="company-file-meta">${escapeHtml(when)}</span>`;
    li.addEventListener('click', () => openLibraryDoc(e.id));
    list.appendChild(li);
  }
  const pick = selectId && entries.some((e) => e.id === selectId)
    ? selectId
    : (entries[0] && entries[0].id);
  if (pick) openLibraryDoc(pick);
}

function setLibraryDownloadEnabled(on) {
  const btn = document.getElementById('libraryDownloadBtn');
  if (btn) btn.disabled = !on;
}

async function openLibraryDoc(id) {
  const titleEl = document.getElementById('libraryPreviewTitle');
  const bodyEl = document.getElementById('libraryPreviewBody');
  if (!bodyEl) return;
  librarySelectedId = id;
  bodyEl.innerHTML = '<p class="company-file-empty">Loading…</p>';
  setLibraryDownloadEnabled(false);
  try {
    const doc = await api(`/api/library/file?id=${encodeURIComponent(id)}`);
    if (titleEl) {
      titleEl.textContent = doc.title || doc.path || id;
    }
    bodyEl.innerHTML = renderMarkdown(doc.content || '');
    document.querySelectorAll('.library-list-item').forEach((el) => {
      el.classList.toggle('is-selected', el.dataset.id === id);
    });
    setLibraryDownloadEnabled(true);
  } catch (err) {
    bodyEl.innerHTML = `<p class="company-file-empty">${escapeHtml(err.message || 'Failed to load')}</p>`;
  }
}

async function refreshLibraryList(selectId) {
  const list = document.getElementById('libraryList');
  if (!list) return;
  list.innerHTML = '<li class="company-file-empty">Loading…</li>';
  setLibraryStatus('');
  try {
    const data = await api('/api/library');
    libraryEntriesCache = Array.isArray(data.entries) ? data.entries : [];
    renderLibraryList(selectId || librarySelectedId);
  } catch (err) {
    list.innerHTML = '';
    libraryEntriesCache = [];
    setLibraryStatus(err.message || 'Failed to list library', 'warn');
  }
}

function downloadLibraryDoc() {
  if (!librarySelectedId) return;
  const a = document.createElement('a');
  a.href = `/api/library/file?id=${encodeURIComponent(librarySelectedId)}&download=1`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function bindLibraryPage() {
  const openBtn = document.getElementById('libraryBtn');
  if (openBtn && openBtn.dataset.bound !== '1') {
    openBtn.dataset.bound = '1';
    openBtn.addEventListener('click', () => navigateRoute('library'));
  }
  const backBtn = document.getElementById('libraryBackBtn');
  if (backBtn && backBtn.dataset.bound !== '1') {
    backBtn.dataset.bound = '1';
    backBtn.addEventListener('click', () => navigateRoute('chat'));
  }
  const refreshBtn = document.getElementById('libraryRefresh');
  if (refreshBtn && refreshBtn.dataset.bound !== '1') {
    refreshBtn.dataset.bound = '1';
    refreshBtn.addEventListener('click', () => refreshLibraryList(librarySelectedId));
  }
  const dlBtn = document.getElementById('libraryDownloadBtn');
  if (dlBtn && dlBtn.dataset.bound !== '1') {
    dlBtn.dataset.bound = '1';
    dlBtn.addEventListener('click', () => downloadLibraryDoc());
  }
  const filter = document.getElementById('libraryFilter');
  if (filter && filter.dataset.bound !== '1') {
    filter.dataset.bound = '1';
    let t = null;
    filter.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => renderLibraryList(librarySelectedId), 120);
    });
  }
  if (typeof window !== 'undefined' && !window.__bizagentHashBound) {
    window.__bizagentHashBound = true;
    window.addEventListener('hashchange', () => applyRoute(parseRoute()));
    window.addEventListener('popstate', () => applyRoute(parseRoute()));
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
bindComposerAttachments();
applyRoute(parseRoute());
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


boot();
