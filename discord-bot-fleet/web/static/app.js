// Frontend logic — single-page vanilla JS.

const API = '';
let sessionToken = localStorage.getItem('session_token');
let bots = [];
let logSocket = null;
let logFilter = '';
const logBuffer = [];
const LOG_BUFFER_MAX = 500;

// ─── Helpers ──────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-session-token': sessionToken || '',
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showLogin() {
  document.getElementById('login').classList.remove('hidden');
  document.getElementById('main').classList.add('hidden');
  localStorage.removeItem('session_token');
  sessionToken = null;
}
function showMain() {
  document.getElementById('login').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec/60) + 'm ago';
  if (sec < 86400) return Math.floor(sec/3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

// ─── Auth ─────────────────────────────────────────────────────────────────
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  try {
    const r = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'login failed');
    sessionToken = data.token;
    localStorage.setItem('session_token', sessionToken);
    await init();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  showLogin();
}

// ─── Init ─────────────────────────────────────────────────────────────────
async function init() {
  if (!sessionToken) { showLogin(); return; }
  showMain();
  await refreshBots();
  connectLogSocket();
  switchTab('bots');
}

// ─── Bots list ────────────────────────────────────────────────────────────
async function refreshBots() {
  try {
    const data = await api('/api/bots');
    bots = data.bots || [];
    renderBots();
    updateLogFilter();
  } catch (e) {
    if (e.message === 'unauthorized') return;
    console.error(e);
  }
}

function renderBots() {
  const list = document.getElementById('bots-list');
  const empty = document.getElementById('bots-empty');
  if (bots.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = bots.map(b => `
    <div class="bg-surface border border-border rounded-2xl p-5 hover:border-primary/50 transition">
      <div class="flex items-start justify-between mb-3">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/30 to-primary/5 flex items-center justify-center text-lg">${getEmoji(b.name)}</div>
          <div>
            <div class="font-semibold text-sm">${escapeHtml(b.name)}</div>
            <div class="text-xs text-gray-500 mono">${b.id}</div>
          </div>
        </div>
        <span class="flex items-center gap-2 text-xs">
          <span class="pulse-dot ${b.status === 'running' ? 'pulse-running' : b.status === 'error' ? 'pulse-error' : 'pulse-stopped'}"></span>
          ${b.status}
        </span>
      </div>
      <div class="space-y-1 text-xs text-gray-400 mb-3">
        <div>Model: <span class="mono text-gray-300">${escapeHtml(b.llm.model || '—')}</span></div>
        <div>Token: <span class="mono text-gray-300">${escapeHtml(b.token_masked || 'not set')}</span></div>
        <div>Updated: ${timeAgo(b.updated_at)}</div>
      </div>
      <div class="flex gap-1 pt-3 border-t border-border">
        ${b.status === 'running'
          ? `<button onclick="stopBot('${b.id}')" class="flex-1 text-xs bg-surface2 hover:bg-warn/20 hover:text-warn border border-border rounded-lg py-1.5 transition">Stop</button>`
          : `<button onclick="startBot('${b.id}')" class="flex-1 text-xs bg-surface2 hover:bg-success/20 hover:text-success border border-border rounded-lg py-1.5 transition">Start</button>`
        }
        <button onclick="editBot('${b.id}')" class="flex-1 text-xs bg-surface2 hover:bg-primary/20 hover:text-primary border border-border rounded-lg py-1.5 transition">Edit</button>
        <button onclick="deleteBot('${b.id}')" class="text-xs bg-surface2 hover:bg-danger/20 hover:text-danger border border-border rounded-lg px-3 py-1.5 transition">Delete</button>
      </div>
    </div>
  `).join('');

  // Status summary
  const running = bots.filter(b => b.status === 'running').length;
  document.getElementById('status-summary').textContent = `${running}/${bots.length} bots running`;
}

function getEmoji(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('mama') || n.includes('yuki') || n.includes('sakura')) return '🌸';
  if (n.includes('cod') || n.includes('dev')) return '💻';
  if (n.includes('admin') || n.includes('mod')) return '🛡️';
  if (n.includes('music')) return '🎵';
  return '🤖';
}

async function startBot(id) {
  try {
    await api(`/api/bots/${id}/start`, { method: 'POST' });
    await refreshBots();
  } catch (e) { alert('Failed: ' + e.message); }
}
async function stopBot(id) {
  try {
    await api(`/api/bots/${id}/stop`, { method: 'POST' });
    await refreshBots();
  } catch (e) { alert('Failed: ' + e.message); }
}
async function deleteBot(id) {
  if (!confirm('Delete this bot? Token, config, and memory will be removed. This cannot be undone.')) return;
  try {
    await api(`/api/bots/${id}`, { method: 'DELETE' });
    await refreshBots();
  } catch (e) { alert('Failed: ' + e.message); }
}

// ─── Bot editor ───────────────────────────────────────────────────────────
let editingBot = null;
let guildChannels = [];

function openCreate() {
  editingBot = null;
  guildChannels = [];
  document.getElementById('editor-title').textContent = 'New Bot';
  renderEditor({
    name: '', persona: '', token: '', guild_id: '', channel_ids: [],
    llm: { proxy_url: 'https://lolmaobruhhh-fap.hf.space/v1', api_key: 'FAP!', model: 'gemini-3.6-flash-high-search', temperature: 0.8, max_tokens: 500 },
    gating: { response_probability: 0.7, skip_patterns: ['^lol$', '^\\+$', '^-$', '^lmao$', '^(ok|okay|k)$'], ignore_bots: true, ignore_own_messages: true, max_context_messages: 30, cooldown_ms: 2000 },
    tools: { web_search: true, ping_proxy: true, fetch_url: true, github_lookup: true, memory: true, schedule_reminder: true, react_to_message: true },
  }, true);
}

function editBot(id) {
  const b = bots.find(x => x.id === id);
  if (!b) return;
  editingBot = b;
  document.getElementById('editor-title').textContent = `Edit: ${b.name}`;
  guildChannels = [];
  renderEditor({
    ...b,
    token: '',
    llm: { ...b.llm, api_key: '' },
  }, false);
}

function renderEditor(b, isNew) {
  const toolsHtml = Object.entries(b.tools).map(([k, v]) => `
    <label class="flex items-center justify-between bg-surface2 border border-border rounded-lg px-3 py-2">
      <span class="text-sm">${k.replace(/_/g, ' ')}</span>
      <span class="switch">
        <input type="checkbox" id="tool-${k}" ${v ? 'checked' : ''} />
        <span class="slider"></span>
      </span>
    </label>
  `).join('');

  document.getElementById('editor-body').innerHTML = `
    <div class="grid grid-cols-2 gap-4">
      <div>
        <label class="block text-xs text-gray-400 mb-1">Display name *</label>
        <input id="f-name" type="text" value="${escapeHtml(b.name)}" placeholder="Mama"
          class="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm" />
      </div>
      <div>
        <label class="block text-xs text-gray-400 mb-1">Guild ID</label>
        <input id="f-guild" type="text" value="${escapeHtml(b.guild_id)}" placeholder="1511640846435356794"
          class="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm mono" />
      </div>
    </div>

    <div>
      <label class="block text-xs text-gray-400 mb-1">Persona (system prompt) *</label>
      <textarea id="f-persona" rows="8" placeholder="You are 'Mama', a warm maternal figure..."
        class="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm">${escapeHtml(b.persona)}</textarea>
    </div>

    <div class="border-t border-border pt-5">
      <div class="flex items-center justify-between mb-2">
        <label class="block text-xs text-gray-400">Discord bot token ${isNew ? '*' : '(leave blank to keep existing)'}</label>
        <button onclick="loadGuilds()" class="text-xs text-primary hover:underline">→ Load channels</button>
      </div>
      <input id="f-token" type="password" value="${escapeHtml(b.token)}" placeholder="MTUzOTE5..."
        class="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm mono" />
      <div id="guild-list" class="mt-3 space-y-2"></div>
      <div>
        <label class="block text-xs text-gray-400 mt-3 mb-1">Active channels (empty = all visible text channels in guild)</label>
        <div id="channel-list" class="space-y-1 max-h-40 overflow-y-auto bg-surface2 border border-border rounded-lg p-2">
          <span class="text-xs text-gray-500">Load channels to select specific ones, or leave empty for all.</span>
        </div>
      </div>
    </div>

    <div class="border-t border-border pt-5">
      <h3 class="text-sm font-semibold mb-3">LLM</h3>
      <div class="space-y-3">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Proxy URL</label>
          <input id="f-proxy" type="text" value="${escapeHtml(b.llm.proxy_url)}"
            class="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm mono" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs text-gray-400 mb-1">API key ${isNew ? '' : '(blank = keep existing)'}</label>
            <input id="f-apikey" type="text" value="${escapeHtml(b.llm.api_key || '')}" placeholder="FAP!"
              class="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm mono" />
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">Model</label>
            <input id="f-model" type="text" value="${escapeHtml(b.llm.model)}"
              class="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm mono" />
          </div>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div>
            <label class="block text-xs text-gray-400 mb-1">Temperature</label>
            <input id="f-temp" type="number" step="0.1" min="0" max="2" value="${b.llm.temperature}"
              class="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">Max tokens</label>
            <input id="f-maxtok" type="number" min="50" max="4000" value="${b.llm.max_tokens}"
              class="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div class="flex items-end">
            <button onclick="testLLM()" class="w-full text-xs bg-surface2 hover:bg-primary/20 hover:text-primary border border-border rounded-lg py-2 transition">Test</button>
          </div>
        </div>
      </div>
    </div>

    <div class="border-t border-border pt-5">
      <h3 class="text-sm font-semibold mb-3">Behavior</h3>
      <div class="space-y-3">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Response probability (0..1): <span id="prob-val" class="text-primary">${b.gating.response_probability}</span></label>
          <input id="f-prob" type="range" min="0" max="1" step="0.1" value="${b.gating.response_probability}" oninput="document.getElementById('prob-val').textContent=this.value"
            class="w-full accent-primary" />
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Skip patterns (one regex per line)</label>
          <textarea id="f-skip" rows="4" class="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm mono">${escapeHtml((b.gating.skip_patterns || []).join('\n'))}</textarea>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div>
            <label class="block text-xs text-gray-400 mb-1">Max context msgs</label>
            <input id="f-maxctx" type="number" min="5" max="200" value="${b.gating.max_context_messages}"
              class="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">Cooldown (ms)</label>
            <input id="f-cooldown" type="number" min="0" step="500" value="${b.gating.cooldown_ms}"
              class="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div class="flex items-end gap-4 pb-1">
            <label class="flex items-center gap-2 text-xs"><input type="checkbox" id="f-ignorebots" ${b.gating.ignore_bots ? 'checked' : ''} class="accent-primary" /> Ignore bots</label>
          </div>
        </div>
      </div>
    </div>

    <div class="border-t border-border pt-5">
      <h3 class="text-sm font-semibold mb-3">Tools</h3>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-2">${toolsHtml}</div>
    </div>

    <div class="flex gap-2 pt-5 border-t border-border">
      <button onclick="saveBot()" class="flex-1 bg-primary hover:bg-primary_hover text-white rounded-lg py-2 text-sm font-medium transition">Save</button>
      ${!isNew && editingBot ? `<button onclick="saveBot(true)" class="bg-surface2 hover:bg-primary/20 hover:text-primary border border-border rounded-lg px-4 py-2 text-sm transition">Save & Restart</button>` : ''}
      <button onclick="closeEditor()" class="bg-surface2 hover:bg-surface2 border border-border rounded-lg px-4 py-2 text-sm">Cancel</button>
    </div>
  `;
  document.getElementById('bot-editor').classList.remove('hidden');
}

function closeEditor() {
  document.getElementById('bot-editor').classList.add('hidden');
  editingBot = null;
  guildChannels = [];
}

async function loadGuilds() {
  const token = document.getElementById('f-token').value.trim();
  if (!token) { alert('Enter a token first'); return; }
  const btn = event.target;
  btn.textContent = 'Loading...'; btn.disabled = true;
  try {
    const data = await api('/api/discord/guilds', { method: 'POST', body: JSON.stringify({ token }) });
    guildChannels = data.guilds || [];
    renderGuildPicker();
  } catch (e) {
    alert('Failed: ' + e.message);
  } finally {
    btn.textContent = '→ Load channels'; btn.disabled = false;
  }
}

function renderGuildPicker() {
  const container = document.getElementById('guild-list');
  const channelList = document.getElementById('channel-list');
  if (guildChannels.length === 0) {
    container.innerHTML = '<span class="text-xs text-warn">Bot is not in any guild yet. Add it to your server first.</span>';
    channelList.innerHTML = '<span class="text-xs text-gray-500">No channels available.</span>';
    return;
  }
  container.innerHTML = guildChannels.map(g => `
    <label class="flex items-center gap-2 text-sm cursor-pointer hover:bg-surface2 px-2 py-1 rounded">
      <input type="radio" name="guild" value="${g.id}" ${g.id === document.getElementById('f-guild').value ? 'checked' : ''} onchange="selectGuild('${g.id}')" class="accent-primary" />
      <span>${g.icon ? `<img src="${g.icon}" class="w-5 h-5 rounded" />` : '🏠'} ${escapeHtml(g.name)}</span>
      <span class="text-xs text-gray-500">(${g.text_channels.length} channels)</span>
    </label>
  `).join('');
  if (guildChannels.length === 1) selectGuild(guildChannels[0].id);
}

function selectGuild(guildId) {
  document.getElementById('f-guild').value = guildId;
  const g = guildChannels.find(x => x.id === guildId);
  if (!g) return;
  const existing = (editingBot?.channel_ids) || [];
  const channelList = document.getElementById('channel-list');
  if (g.text_channels.length === 0) {
    channelList.innerHTML = '<span class="text-xs text-warn">No text channels found. Make sure the bot has "View Channels" permission.</span>';
    return;
  }
  channelList.innerHTML = g.text_channels.map(c => `
    <label class="flex items-center gap-2 text-xs cursor-pointer hover:bg-surface px-2 py-1 rounded">
      <input type="checkbox" class="channel-cb accent-primary" value="${c.id}" ${existing.includes(c.id) ? 'checked' : ''} />
      <span class="text-gray-300">#${escapeHtml(c.name)}</span>
      <span class="text-gray-600 mono ml-auto">${c.id}</span>
    </label>
  `).join('');
}

async function testLLM() {
  const proxy = document.getElementById('f-proxy').value.trim();
  const key = document.getElementById('f-apikey').value.trim() || 'FAP!';
  const model = document.getElementById('f-model').value.trim();
  const btn = event.target;
  btn.textContent = 'Pinging...'; btn.disabled = true;
  try {
    const r = await api('/api/llm/ping', { method: 'POST', body: JSON.stringify({ proxy_url: proxy, api_key: key, model }) });
    alert(JSON.stringify(r, null, 2));
  } catch (e) {
    alert('Failed: ' + e.message);
  } finally {
    btn.textContent = 'Test'; btn.disabled = false;
  }
}

async function saveBot(restart) {
  const name = document.getElementById('f-name').value.trim();
  const persona = document.getElementById('f-persona').value.trim();
  const token = document.getElementById('f-token').value.trim();
  const guild_id = document.getElementById('f-guild').value.trim();
  const channel_ids = Array.from(document.querySelectorAll('.channel-cb:checked')).map(cb => cb.value);
  const proxy = document.getElementById('f-proxy').value.trim();
  const api_key = document.getElementById('f-apikey').value.trim();
  const model = document.getElementById('f-model').value.trim();
  const temperature = parseFloat(document.getElementById('f-temp').value);
  const max_tokens = parseInt(document.getElementById('f-maxtok').value, 10);
  const response_probability = parseFloat(document.getElementById('f-prob').value);
  const skip_patterns = document.getElementById('f-skip').value.split('\n').map(s => s.trim()).filter(Boolean);
  const max_context_messages = parseInt(document.getElementById('f-maxctx').value, 10);
  const cooldown_ms = parseInt(document.getElementById('f-cooldown').value, 10);
  const ignore_bots = document.getElementById('f-ignorebots').checked;
  const tools = {};
  ['web_search','ping_proxy','fetch_url','github_lookup','memory','schedule_reminder','react_to_message'].forEach(k => {
    tools[k] = document.getElementById('tool-' + k)?.checked ?? true;
  });

  if (!name || !persona) { alert('Name and persona are required'); return; }
  if (!editingBot && !token) { alert('Token is required for new bots'); return; }

  const body = {
    name, persona, guild_id, channel_ids,
    llm: { proxy_url: proxy, model, temperature, max_tokens, ...(api_key ? { api_key } : {}) },
    gating: { response_probability, skip_patterns, ignore_bots, ignore_own_messages: true, max_context_messages, cooldown_ms },
    tools,
  };
  if (token) body.token = token;

  try {
    if (editingBot) {
      await api(`/api/bots/${editingBot.id}`, { method: 'PUT', body: JSON.stringify(body) });
      if (restart) await api(`/api/bots/${editingBot.id}/restart`, { method: 'POST' });
    } else {
      await api('/api/bots', { method: 'POST', body: JSON.stringify(body) });
    }
    closeEditor();
    await refreshBots();
  } catch (e) {
    alert('Save failed: ' + e.message);
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────
function switchTab(name) {
  ['bots', 'tools', 'logs'].forEach(t => {
    document.getElementById('tab-' + t).classList.remove('border-primary', 'text-white');
    document.getElementById('tab-' + t).classList.add('border-transparent', 'text-gray-400');
    document.getElementById('tab-content-' + t).classList.add('hidden');
  });
  document.getElementById('tab-' + name).classList.add('border-primary', 'text-white');
  document.getElementById('tab-' + name).classList.remove('border-transparent', 'text-gray-400');
  document.getElementById('tab-content-' + name).classList.remove('hidden');
}

// ─── LLM proxy tester ─────────────────────────────────────────────────────
async function pingProxy() {
  const url = document.getElementById('ping-url').value.trim();
  const key = document.getElementById('ping-key').value.trim();
  const model = document.getElementById('ping-model').value.trim();
  const out = document.getElementById('ping-result');
  out.textContent = 'Pinging...';
  try {
    const r = await api('/api/llm/ping', { method: 'POST', body: JSON.stringify({ proxy_url: url, api_key: key, model }) });
    out.textContent = JSON.stringify(r, null, 2);
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
}

// ─── Logs ─────────────────────────────────────────────────────────────────
function connectLogSocket() {
  if (logSocket) logSocket.close();
  logSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(sessionToken)}`);
  logSocket.onopen = () => { document.getElementById('logs-status').textContent = 'connected'; };
  logSocket.onclose = () => {
    document.getElementById('logs-status').textContent = 'disconnected (reconnecting...)';
    setTimeout(connectLogSocket, 2000);
  };
  logSocket.onmessage = (ev) => {
    try {
      const log = JSON.parse(ev.data);
      if (logFilter && log.bot_id !== logFilter) return;
      logBuffer.push(log);
      if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
      appendLog(log);
    } catch {}
  };
  logSocket.onerror = () => {};
}

function appendLog(log) {
  const out = document.getElementById('logs-output');
  if (!out) return;
  const line = document.createElement('div');
  line.className = `log-line log-${log.level}`;
  line.innerHTML = `<span class="text-gray-600">[${new Date(log.ts).toLocaleTimeString()}]</span> <span class="text-primary/70">[${log.bot_id}]</span> ${escapeHtml(log.msg)}`;
  out.appendChild(line);
  if (out.children.length > 1000) out.removeChild(out.firstChild);
  out.scrollTop = out.scrollHeight;
}

function updateLogFilter() {
  const sel = document.getElementById('logs-bot-filter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All bots</option>' + bots.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  if (cur) sel.value = cur;
}

function setLogFilter() {
  logFilter = document.getElementById('logs-bot-filter').value;
  const out = document.getElementById('logs-output');
  out.innerHTML = '';
  if (logFilter && logSocket) {
    logSocket.send(JSON.stringify({ type: 'subscribe', bot_id: logFilter }));
  } else if (logSocket) {
    logSocket.send(JSON.stringify({ type: 'subscribe_all' }));
  }
}

function clearLogs() {
  document.getElementById('logs-output').innerHTML = '';
  logBuffer.length = 0;
}

// ─── Boot ─────────────────────────────────────────────────────────────────
init();
