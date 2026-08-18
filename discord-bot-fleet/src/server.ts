// Express server — serves the web panel, the JSON API, and WebSocket for live logs.
// Binds to PORT (default 7860 for HF Space compatibility).

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { createHmac } from 'crypto';

import { listBots, getBot, createBot, updateBot, deleteBot, setBotStatus } from './store.js';
import { encryptString, decryptString, maskToken } from './crypto.js';
import { getBotManager } from './manager.js';
import { getLogBus, getBotLogger, readRecentLogs } from './logger.js';
import { makeDefaultBotConfig, DEFAULT_LLM, DEFAULT_GATING, DEFAULT_TOOLS, type BotConfig } from './types.js';
import { validateDiscordToken, listGuildsAndChannels } from './discord_helpers.js';
import { LLMClient } from './llm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const PORT = parseInt(process.env.PORT || '7860', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD || 'dev-fallback-change-me';

if (!ADMIN_PASSWORD) {
  console.warn('\n[server] WARNING: ADMIN_PASSWORD env var not set.');
  console.warn('[server] The web panel is insecure. Set ADMIN_PASSWORD via HF Secret.');
  console.warn('[server] Using a dev-only password for now. Login with: admin / dev\n');
}
const EFFECTIVE_PASSWORD = ADMIN_PASSWORD || 'dev';

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

// Session store (in-memory, simple)
const sessions = new Map<string, { expires: number }>();

app.use(express.json({ limit: '1mb' }));

// --- Auth middleware ---
function authCheck(req: express.Request, res: express.Response, next: express.NextFunction) {
  // Skip auth for static panel assets + login API
  if (req.path === '/' || req.path.startsWith('/login') || req.path.startsWith('/auth/')) {
    return next();
  }
  if (req.path.startsWith('/static/') || req.path.match(/\.(html|js|css|ico|png|svg)$/)) {
    return next();
  }
  const token = req.headers['x-session-token'] as string | undefined;
  if (!token || !sessions.has(token)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const session = sessions.get(token)!;
  if (Date.now() > session.expires) {
    sessions.delete(token);
    res.status(401).json({ error: 'session expired' });
    return;
  }
  // Extend session
  session.expires = Date.now() + 1000 * 60 * 60 * 24; // 24h
  next();
}

app.use(authCheck);

// --- Auth endpoints ---
app.post('/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== EFFECTIVE_PASSWORD) {
    return res.status(401).json({ error: 'invalid password' });
  }
  const token = createHash('sha256').update(SESSION_SECRET + Date.now() + Math.random()).digest('hex');
  sessions.set(token, { expires: Date.now() + 1000 * 60 * 60 * 24 });
  res.json({ token, expires_in: 86400 });
});

app.post('/auth/logout', (req, res) => {
  const token = req.headers['x-session-token'] as string;
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// --- Bot CRUD ---
app.get('/api/bots', (req, res) => {
  const bots = listBots().map(b => ({
    ...b,
    token_enc: undefined, // never expose encrypted blob
    token_masked: maskTokenSafe(b.token_enc),
    llm: { ...b.llm, api_key_enc: undefined },
  }));
  res.json({ bots });
});

app.post('/api/bots', (req, res) => {
  const {
    name, persona, token, guild_id, channel_ids, delegated_bots,
    llm, gating, tools,
  } = req.body || {};

  if (!name || !persona || !token) {
    return res.status(400).json({ error: 'name, persona, and token are required' });
  }

  const botConfig = createBot({
    ...makeDefaultBotConfig({ name, persona, guild_id: guild_id || '', channel_ids: channel_ids || [], delegated_bots: delegated_bots || [] }),
    token_enc: encryptString(token),
    llm: { ...DEFAULT_LLM, ...llm, api_key_enc: llm?.api_key ? encryptString(llm.api_key) : '' },
    gating: { ...DEFAULT_GATING, ...gating },
    tools: { ...DEFAULT_TOOLS, ...tools },
    status: 'stopped',
  } as Omit<BotConfig, 'id' | 'created_at' | 'updated_at' | 'status'>);

  getBotLogger(botConfig.id).info('Bot created via panel');
  res.json({ ok: true, bot: botConfig });
});

app.get('/api/bots/:id', (req, res) => {
  const bot = getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'not found' });
  res.json({
    ...bot,
    token_enc: undefined,
    token_masked: maskTokenSafe(bot.token_enc),
    llm: { ...bot.llm, api_key_enc: undefined },
  });
});

app.put('/api/bots/:id', (req, res) => {
  const id = req.params.id;
  const bot = getBot(id);
  if (!bot) return res.status(404).json({ error: 'not found' });
  const patch: Partial<BotConfig> & { token?: string } = { ...req.body };

  // Handle token rotation
  if (typeof patch.token === 'string') {
    patch.token_enc = encryptString(patch.token);
    delete patch.token;
  }
  // Handle LLM API key rotation
  if (patch.llm && typeof (patch.llm as { api_key?: string }).api_key === 'string') {
    const apiKey = (patch.llm as { api_key?: string }).api_key;
    patch.llm = { ...bot.llm, ...patch.llm };
    if (apiKey) patch.llm.api_key_enc = encryptString(apiKey);
    delete (patch.llm as { api_key?: string }).api_key;
  }
  // Never allow status updates through this endpoint (use start/stop)
  delete patch.status;
  delete patch.id;
  delete patch.created_at;

  const updated = updateBot(id, patch);
  getBotLogger(id).info('Bot config updated via panel');
  res.json({
    ...updated,
    token_enc: undefined,
    token_masked: maskTokenSafe(updated.token_enc),
    llm: { ...updated.llm, api_key_enc: undefined },
  });
});

app.delete('/api/bots/:id', async (req, res) => {
  const id = req.params.id;
  await getBotManager().stop(id);
  deleteBot(id);
  getBotLogger(id).info('Bot deleted via panel');
  res.json({ ok: true });
});

// --- Bot lifecycle ---
app.post('/api/bots/:id/start', async (req, res) => {
  try {
    await getBotManager().start(req.params.id);
    res.json({ ok: true });
  } catch (e: unknown) {
    const err = e as Error;
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/bots/:id/stop', async (req, res) => {
  try {
    await getBotManager().stop(req.params.id);
    res.json({ ok: true });
  } catch (e: unknown) {
    const err = e as Error;
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/bots/:id/restart', async (req, res) => {
  try {
    await getBotManager().restart(req.params.id);
    res.json({ ok: true });
  } catch (e: unknown) {
    const err = e as Error;
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/bots/:id/status', (req, res) => {
  res.json(getBotManager().getStatus(req.params.id));
});

// --- Logs ---
app.get('/api/bots/:id/logs', async (req, res) => {
  const lines = parseInt((req.query.lines as string) || '200', 10);
  const logs = await readRecentLogs(req.params.id, lines);
  res.json({ logs });
});

// --- Discord helpers ---
app.post('/api/discord/validate', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  const result = await validateDiscordToken(token);
  res.json(result);
});

app.post('/api/discord/guilds', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const guilds = await listGuildsAndChannels(token);
    res.json({ guilds });
  } catch (e: unknown) {
    const err = e as Error;
    res.status(400).json({ error: err.message });
  }
});

// --- LLM proxy test ---
app.post('/api/llm/ping', async (req, res) => {
  const { proxy_url, api_key, model } = req.body || {};
  if (!proxy_url) return res.status(400).json({ error: 'proxy_url required' });
  const result = await LLMClient.ping(proxy_url, api_key || process.env.LLM_API_KEY || 'FAP!', model);
  res.json(result);
});

// --- Memory view/clear ---
app.get('/api/bots/:id/memory', (req, res) => {
  const bot = getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'not found' });
  try {
    const memFile = join(process.env.DATA_DIR || join(ROOT, 'data'), 'memory', `${bot.id}.json`);
    if (!existsSync(memFile)) return res.json({ memory: {} });
    const mem = JSON.parse(readFileSync(memFile, 'utf8'));
    res.json({ memory: mem });
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- WebSocket for live logs ---
wss.on('connection', (ws: WebSocket, req) => {
  // Authenticate via query param
  const url = new URL(req.url || '', 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token || !sessions.has(token)) {
    ws.close(1008, 'unauthorized');
    return;
  }

  let botFilter: string | null = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe' && msg.bot_id) {
        botFilter = msg.bot_id;
      } else if (msg.type === 'subscribe_all') {
        botFilter = null;
      }
    } catch { /* ignore */ }
  });

  const handler = (log: { bot_id: string; level: string; msg: string; ts: string }) => {
    if (botFilter && log.bot_id !== botFilter) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(log));
    }
  };
  getLogBus().on('log', handler);
  ws.on('close', () => getLogBus().off('log', handler));
});

// --- Static file serving (web panel) ---
const WEB_DIR = join(ROOT, 'web');
app.use(express.static(WEB_DIR));
// SPA fallback: serve index.html for unknown routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/ws')) {
    return next();
  }
  res.sendFile(join(WEB_DIR, 'index.html'));
});

// --- Start ---
function maskTokenSafe(tokenEnc: string): string {
  if (!tokenEnc) return '';
  try {
    return maskToken(decryptString(tokenEnc));
  } catch {
    return '???';
  }
}

async function start() {
  // Autostart bots that were running before restart
  await getBotManager().autostart();

  httpServer.listen(PORT, () => {
    console.log(`\n╔════════════════════════════════════════════╗`);
    console.log(`║  Discord Bot Fleet Control Panel           ║`);
    console.log(`║  Listening on http://0.0.0.0:${PORT}            ║`);
    console.log(`║  Admin password: ${ADMIN_PASSWORD ? '(set via env)' : 'dev (set ADMIN_PASSWORD!)'}${' '.repeat(Math.max(0, 18 - (ADMIN_PASSWORD ? '(set via env)'.length : 'dev (set ADMIN_PASSWORD!)'.length)))}║`);
        console.log(`╚════════════════════════════════════════════╝\n`);
  });
}

start().catch((e) => {
  console.error('Failed to start server:', e);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[server] SIGTERM received, shutting down');
  await getBotManager().stopAll();
  httpServer.close();
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('[server] SIGINT received, shutting down');
  await getBotManager().stopAll();
  httpServer.close();
  process.exit(0);
});
