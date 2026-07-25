let currentConversation = null;
let needsSetup = false;
/** Detect conversation changes even when message count is unchanged
 *  (e.g. launch-ack stripped + hub reply appended → same length). */
let lastConversationStamp = '';
let lastAgentsJson = '';
let titleSet = false;
/** Persisted console display name (never Operator/CEO). */
let displayName = '';

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
  if (!isAuthenticated) {
    document.getElementById('namePanel').hidden = true;
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

function renderAgents(agents) {
  const root = document.getElementById('agents');
  root.innerHTML = '';
  agents.forEach((agent) => {
    const row = document.createElement('div');
    row.className = 'agent-row';
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', 'false');
    row.tabIndex = 0;

    const light = document.createElement('span');
    light.className = `status-light ${agent.hasMail ? 'on' : ''}`;

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

    const chevron = document.createElement('span');
    chevron.className = 'expand-chevron';
    chevron.textContent = '▸';
    chevron.setAttribute('aria-hidden', 'true');

    row.appendChild(light);
    row.appendChild(labels);
    row.appendChild(chevron);

    const detail = document.createElement('div');
    detail.className = 'agent-detail';
    detail.dataset.status = agent.hasMail ? 'on' : '';
    detail.appendChild(makeDetailRow('INBOX', 'inbox', false));
    detail.appendChild(makeDetailRow('DISPATCHED', 'lastDispatched', false));
    detail.appendChild(makeDetailRow('JOURNAL', 'journal', true));

    let loaded = false;
    const toggle = () => {
      const expanded = row.getAttribute('aria-expanded') === 'true';
      row.setAttribute('aria-expanded', String(!expanded));
      detail.classList.toggle('expanded', !expanded);
      if (!expanded && !loaded) {
        loaded = true;
        detail.querySelector('[data-field="inbox"]').textContent = 'Loading…';
        api(`/api/agent-detail/${encodeURIComponent(agent.slug)}`).then((data) => {
          detail.querySelector('[data-field="inbox"]').textContent =
            data.inbox > 0 ? String(data.inbox) : '—';
          detail.querySelector('[data-field="lastDispatched"]').textContent =
            data.lastDispatched ? relativeTime(data.lastDispatched) : '—';
          detail.querySelector('[data-field="journal"]').textContent =
            data.journal || '—';
        }).catch(() => {
          detail.querySelector('[data-field="inbox"]').textContent = '—';
        });
      }
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
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
  const conv = await api(`/api/conversations/${encodeURIComponent(id)}`);
  const messages = conv.messages || [];
  lastConversationStamp = conversationPollStamp(conv);
  renderMessages(messages);
}

async function refreshStatus() {
  const state = await api('/api/state');
  if (!titleSet && state.org) {
    document.title = `BizAgent — ${state.org}`;
    titleSet = true;
  }
  const json = JSON.stringify(state.agents);
  if (json === lastAgentsJson) return;
  lastAgentsJson = json;
  renderAgents(state.agents);
}

async function pollConversation() {
  if (!currentConversation) return;
  const conv = await api(`/api/conversations/${encodeURIComponent(currentConversation)}`);
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
    await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    setSetupMode(false);
    setAuthenticated(true, `Signed in as ${username}`);
    await boot();
  } catch (err) {
    setAuthStatus(err.message || 'Setup failed', 'warn');
  }
}

async function boot() {
  let sessionActive = false;
  try {
    setAuthStatus('Checking session...', 'pending');
    await refreshStatus();
    sessionActive = true;
    const named = await ensureDisplayName();
    setAuthenticated(true, displayName ? `Signed in as ${displayName}` : 'Signed in');
    if (!named) return;
    await loadConversations();
  } catch (_err) {
    if (!sessionActive && !needsSetup) {
      setAuthenticated(false, 'Login required');
    }
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
  if (!content || !currentConversation) return;
  input.value = '';
  const conv = await api(`/api/conversations/${encodeURIComponent(currentConversation)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
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

async function refreshObservability() {
  try {
    const data = await api('/api/observability');
    const container = document.getElementById('observabilityContent');
    let html = '<h3>Recent Events (last 50)</h3><table class="observability-table"><tr><th>Time</th><th>Event</th><th>Duration</th><th>Details</th></tr>';

    data.recent_events.forEach(e => {
      const time = e.ts ? e.ts.split('T')[1].slice(0,8) : '—';
      const duration = e.duration_ms ? e.duration_ms + 'ms' : '—';
      const details = e.conversation_id ? `conv=${e.conversation_id}` : 
                     (e.slug ? `slug=${e.slug}` : JSON.stringify(e).slice(0,60));
      html += `<tr><td>${time}</td><td>${e.event || 'event'}</td><td>${duration}</td><td>${details}</td></tr>`;
    });

    html += '</table>';
    container.innerHTML = html;
  } catch (err) {
    document.getElementById('observabilityContent').innerHTML = `<p style="color:red">Error loading observability: ${err.message}</p>`;
  }
}

// Add observability tab to navigation (safe for test environment)
const originalBoot = boot || function() {};
boot = function() {
  if (typeof originalBoot === 'function') originalBoot();

  // Only run DOM code in real browser
  if (typeof document === 'undefined') return;

  // Add observability tab button
  if (!document.getElementById('observabilityTabBtn')) {
    const tabs = document.querySelector('.tabs') || document.createElement('div');
    const btn = document.createElement('button');
    btn.id = 'observabilityTabBtn';
    btn.textContent = 'Observability';
    btn.onclick = () => {
      document.querySelectorAll('.tab-content').forEach(el => el.hidden = true);
      document.getElementById('observabilityTab').hidden = false;
      refreshObservability();
    };
    if (tabs.parentNode) {
      tabs.parentNode.insertBefore(btn, tabs.nextSibling);
    } else {
      document.body.appendChild(btn);
    }
  }
};

setInterval(() => refreshStatus().catch(() => {}), 2000);
setInterval(() => pollConversation().catch(() => {}), 2000);
boot();
