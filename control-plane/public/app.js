let currentConversation = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    document.getElementById('authPanel').hidden = false;
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function renderAgents(agents) {
  const root = document.getElementById('agents');
  root.innerHTML = '';
  agents.forEach((agent) => {
    const row = document.createElement('div');
    row.className = 'agent-row';
    const light = document.createElement('span');
    light.className = `status-light ${agent.hasMail ? 'on' : ''}`;
    const name = document.createElement('span');
    name.textContent = agent.active ? `${agent.agentName} running` : agent.agentName;
    row.appendChild(light);
    row.appendChild(name);
    root.appendChild(row);
  });
}

function renderMessages(messages) {
  const root = document.getElementById('messages');
  root.innerHTML = '';
  messages.forEach((msg) => {
    const el = document.createElement('div');
    el.className = `message ${msg.role === 'user' ? 'user' : 'system'}`;
    el.textContent = msg.content;
    root.appendChild(el);
  });
  root.scrollTop = root.scrollHeight;
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
  renderMessages(conv.messages || []);
}

async function refreshStatus() {
  const state = await api('/api/state');
  renderAgents(state.agents);
}

async function login() {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  document.getElementById('authPanel').hidden = true;
  await boot();
}

async function boot() {
  try {
    await refreshStatus();
    await loadConversations();
  } catch (_err) {
    document.getElementById('authPanel').hidden = false;
  }
}

document.getElementById('login').addEventListener('click', login);
document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  document.getElementById('authPanel').hidden = false;
});
document.getElementById('newConversation').addEventListener('click', async () => {
  const name = window.prompt('Conversation name', 'New conversation');
  if (!name) return;
  const conv = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ name }) });
  currentConversation = conv.id;
  await loadConversations();
});
document.getElementById('conversationSelect').addEventListener('change', (event) => loadConversation(event.target.value));
document.getElementById('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
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
  renderMessages(conv.messages || []);
});

setInterval(() => refreshStatus().catch(() => {}), 6000);
boot();
