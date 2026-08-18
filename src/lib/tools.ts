// Tool registry — all 8 tools, with rate-limit-aware handlers.
// Each tool returns a JSON string result.

import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import cron from 'node-cron';
import type { LLMTool } from './llm';
import type { BotConfig, ToolContext as TCtx } from './types';
import { decryptString } from './crypto';

// ─── fetch_url with SSRF protection ───────────────────────────────────────
const FETCH_URL_TOOL: LLMTool = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description: 'Fetch a URL and return the text content (HTML stripped). Useful for reading articles, docs, or API responses. Limited to 5000 chars. Cannot access private/internal IP ranges.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        max_chars: { type: 'number', description: 'Max chars to return (default 5000, max 10000)' },
      },
      required: ['url'],
    },
  },
};

async function fetchUrlHandler(args: { url: string; max_chars?: number }): Promise<string> {
  const maxChars = Math.min(args.max_chars || 5000, 10000);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(args.url);
  } catch {
    return JSON.stringify({ error: `invalid URL: ${args.url}` });
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return JSON.stringify({ error: `only http/https allowed, got: ${parsedUrl.protocol}` });
  }
  if (await isPrivateResolvableHost(parsedUrl.hostname)) {
    return JSON.stringify({ error: `blocked: ${parsedUrl.hostname} resolves to a private IP` });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(args.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)' },
    });
    if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status} ${res.statusText}`, url: args.url });
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    let text: string;
    if (ct.includes('application/json')) {
      text = body;
    } else if (ct.includes('text/html')) {
      text = body
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim();
    } else {
      text = body;
    }
    return text.slice(0, maxChars);
  } catch (e: unknown) {
    const err = e as Error;
    return JSON.stringify({ error: err.message || String(e), url: args.url });
  } finally {
    clearTimeout(timeout);
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'metadata.google.internal' || host === '169.254.169.254' || host === 'metadata.azure.com') return true;
  if (host.endsWith('.internal') || host.endsWith('.local') || host === 'localhost') return true;
  const ip = isIP(host);
  if (ip === 4) {
    const parts = host.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (ip === 6) {
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
  }
  return false;
}

async function isPrivateResolvableHost(hostname: string): Promise<boolean> {
  if (isIP(hostname) !== 0) return isPrivateHost(hostname);
  try {
    const result = await lookup(hostname, { all: true });
    if (result.length === 0) return false;
    return result.some(r => isPrivateHost(r.address));
  } catch {
    return false;
  }
}

// ─── ping_ai_proxy ────────────────────────────────────────────────────────
const PING_PROXY_TOOL: LLMTool = {
  type: 'function',
  function: {
    name: 'ping_ai_proxy',
    description: "Health-check an OpenAI-compatible LLM proxy. Returns status, latency, available models, and optionally a test response.",
    parameters: {
      type: 'object',
      properties: {
        proxy_url: { type: 'string', description: 'Base URL of the OpenAI-compatible proxy, e.g. https://example.com/v1' },
        api_key: { type: 'string', description: "API key for the proxy. Optional — falls back to the bot's configured key." },
        model: { type: 'string', description: 'If provided, also sends a test "hello" message to this model and returns the response.' },
      },
      required: ['proxy_url'],
    },
  },
};

async function pingProxyHandler(args: { proxy_url: string; api_key?: string; model?: string }, ctx: TCtx): Promise<string> {
  const openaiProvider = ctx.botConfig.providers.find(p => p.type === 'openai');
  const apiKey = args.api_key || (openaiProvider?.api_key_enc
    ? decryptString(openaiProvider.api_key_enc)
    : process.env.LLM_API_KEY || 'FAP!');
  const result = await (await import('./llm')).LLMClient.ping(args.proxy_url, apiKey, args.model);
  return JSON.stringify(result);
}

// ─── github_lookup ─────────────────────────────────────────────────────────
const GITHUB_TOOL: LLMTool = {
  type: 'function',
  function: {
    name: 'github_lookup',
    description: "Look up a GitHub repo's metadata, README, or recent commits. Read-only.",
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repo owner (e.g. "facebook")' },
        repo: { type: 'string', description: 'Repo name (e.g. "react")' },
        kind: { type: 'string', enum: ['info', 'readme', 'commits'], description: 'What to fetch' },
      },
      required: ['owner', 'repo', 'kind'],
    },
  },
};

async function githubHandler(args: { owner: string; repo: string; kind: 'info' | 'readme' | 'commits' }): Promise<string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'discord-bot-fleet',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const base = `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`;
  try {
    if (args.kind === 'info') {
      const r = await fetch(base, { headers });
      if (!r.ok) return JSON.stringify({ error: `HTTP ${r.status}` });
      const j: Record<string, unknown> = await r.json();
      return JSON.stringify({
        name: j.full_name,
        description: j.description,
        stars: j.stargazers_count,
        forks: j.forks_count,
        open_issues: j.open_issues_count,
        language: j.language,
        license: (j.license as { name?: string } | null)?.name,
        default_branch: j.default_branch,
        created: j.created_at,
        updated: j.updated_at,
        homepage: j.homepage,
        topics: j.topics,
      });
    } else if (args.kind === 'readme') {
      const r = await fetch(`${base}/readme`, { headers: { ...headers, 'Accept': 'application/vnd.github.raw' } });
      if (!r.ok) return JSON.stringify({ error: `HTTP ${r.status}` });
      return (await r.text()).slice(0, 5000);
    } else {
      const r = await fetch(`${base}/commits?per_page=10`, { headers });
      if (!r.ok) return JSON.stringify({ error: `HTTP ${r.status}` });
      const j: Array<Record<string, unknown>> = await r.json();
      return JSON.stringify(j.map(c => ({
        sha: String(c.sha || '').slice(0, 7),
        message: String((c.commit as { message?: string })?.message || '').split('\n')[0],
        author: (c.author as { login?: string } | undefined)?.login || 'unknown',
        date: (c.commit as { author?: { date?: string } })?.author?.date,
      })));
    }
  } catch (e: unknown) {
    const err = e as Error;
    return JSON.stringify({ error: err.message || String(e) });
  }
}

// ─── web_search ───────────────────────────────────────────────────────────
const WEB_SEARCH_TOOL: LLMTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information. Returns up to 5 results with title, URL, and a short snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
};

async function webSearchHandler(args: { query: string }): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)' },
    });
    if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status}` });
    const html = await res.text();
    const linkRe = /<a class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const links: Array<{ url: string; title: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) && links.length < 5) {
      const u = m[1].match(/uddg=([^&]+)/);
      const actualUrl = u ? decodeURIComponent(u[1]) : m[1];
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      links.push({ url: actualUrl, title });
    }
    const snippets: string[] = [];
    while ((m = snippetRe.exec(html)) && snippets.length < 5) {
      snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
    }
    const results = links.map((l, i) => ({ ...l, snippet: snippets[i] || '' }));
    if (results.length === 0) return JSON.stringify({ error: 'no results found', query: args.query });
    return JSON.stringify({ query: args.query, results });
  } catch (e: unknown) {
    const err = e as Error;
    return JSON.stringify({ error: err.message || String(e) });
  } finally {
    clearTimeout(timeout);
  }
}

// ─── memory_read / memory_write ────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'db');
const MEMORY_DIR = join(DATA_DIR, 'memory');
if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

const MAX_KEYS = 500;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function memoryFile(botId: string): string {
  const safe = botId.replace(/[^a-zA-Z0-9_-]/g, '');
  return join(MEMORY_DIR, `${safe}.json`);
}

function loadMemory(botId: string): Record<string, string> {
  const f = memoryFile(botId);
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
}

function saveMemory(botId: string, mem: Record<string, string>): void {
  const serialized = JSON.stringify(mem);
  if (serialized.length > MAX_FILE_BYTES) {
    throw new Error(`memory file would exceed ${MAX_FILE_BYTES} bytes`);
  }
  writeFileSync(memoryFile(botId), serialized);
}

const MEMORY_READ_TOOL: LLMTool = {
  type: 'function',
  function: {
    name: 'memory_read',
    description: 'Read a value from your persistent memory by key, or list all keys if no key is given.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key to read. If omitted, returns a list of all keys.' },
      },
    },
  },
};

async function memoryReadHandler(args: { key?: string }, ctx: TCtx): Promise<string> {
  const mem = loadMemory(ctx.botConfig.id);
  if (!args.key) return JSON.stringify({ keys: Object.keys(mem), count: Object.keys(mem).length });
  if (args.key in mem) return JSON.stringify({ key: args.key, value: mem[args.key] });
  return JSON.stringify({ key: args.key, value: null, note: 'key not found' });
}

const MEMORY_WRITE_TOOL: LLMTool = {
  type: 'function',
  function: {
    name: 'memory_write',
    description: 'Write a key/value pair to your persistent memory. Values limited to 16KB; max 500 keys per bot.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key (snake_case). Max 100 chars.' },
        value: { type: 'string', description: 'Value to store. Max 16KB.' },
      },
      required: ['key', 'value'],
    },
  },
};

async function memoryWriteHandler(args: { key: string; value: string }, ctx: TCtx): Promise<string> {
  if (!args.key || args.key.length > 100) return JSON.stringify({ error: 'invalid key' });
  const valueBytes = Buffer.byteLength(args.value, 'utf8');
  if (valueBytes > MAX_VALUE_BYTES) return JSON.stringify({ error: `value too large (${valueBytes} > ${MAX_VALUE_BYTES})` });
  const mem = loadMemory(ctx.botConfig.id);
  if (!(args.key in mem) && Object.keys(mem).length >= MAX_KEYS) return JSON.stringify({ error: 'memory full' });
  mem[args.key] = args.value;
  try { saveMemory(ctx.botConfig.id, mem); } catch (e) { return JSON.stringify({ error: (e as Error).message }); }
  return JSON.stringify({ ok: true, key: args.key, size_bytes: valueBytes });
}

// ─── schedule_reminder ─────────────────────────────────────────────────────
const scheduledJobs = new Map<string, cron.ScheduledTask>();

const SCHEDULE_TOOL: LLMTool = {
  type: 'function',
  function: {
    name: 'schedule_reminder',
    description: 'Schedule a future reminder that posts a message to a channel. Delay can be "30m", "1h", "2h", "1d", or a cron expression.',
    parameters: {
      type: 'object',
      properties: {
        delay: { type: 'string', description: 'Time until reminder fires. Format: "30m" / "1h" / "2h" / "1d", or a cron expression.' },
        message: { type: 'string', description: 'Message content to post when the reminder fires.' },
        channel_id: { type: 'string', description: 'Discord channel ID to post in.' },
      },
      required: ['delay', 'message'],
    },
  },
};

function parseDelayToCron(delay: string): { cron: string; oneShot: boolean } | null {
  const m = delay.match(/^(\d+)([smhd])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === 'm') return { cron: `*/${n} * * * *`, oneShot: true };
    if (unit === 'h') return { cron: `0 */${n} * * *`, oneShot: true };
    if (unit === 'd') return { cron: `0 0 */${n} * *`, oneShot: true };
  }
  if (cron.validate(delay)) return { cron: delay, oneShot: false };
  return null;
}

async function scheduleHandler(args: { delay: string; message: string; channel_id?: string }, ctx: TCtx): Promise<string> {
  const parsed = parseDelayToCron(args.delay);
  if (!parsed) return JSON.stringify({ error: `invalid delay "${args.delay}"` });
  const channelId = args.channel_id || ctx.botConfig.channel_ids[0];
  if (!channelId) return JSON.stringify({ error: 'no channel_id' });
  const jobId = `reminder_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const task = cron.schedule(parsed.cron, async () => {
    try { await ctx.sendChannelMessage(channelId, args.message); } catch (e) { console.error('[schedule] failed:', e); }
    if (parsed.oneShot) { task.stop(); scheduledJobs.delete(jobId); }
  });
  scheduledJobs.set(jobId, task);
  return JSON.stringify({ ok: true, job_id: jobId, fires_at_cron: parsed.cron });
}

// ─── summon_bot ─────────────────────────────────────────────────────────────
const SUMMON_BOT_TOOL: LLMTool = {
  type: 'function',
  function: {
    name: 'summon_bot',
    description: "Summon another bot in this fleet to help with a task. Sends an @mention and waits for reply (up to 60s).",
    parameters: {
      type: 'object',
      properties: {
        bot_id: { type: 'string', description: 'The ID of the bot to summon. Must be one of your authorized delegated_bots.' },
        message: { type: 'string', description: 'The message to send to the other bot.' },
        timeout_seconds: { type: 'number', description: 'How long to wait for a reply. Default 60, max 120.' },
      },
      required: ['bot_id', 'message'],
    },
  },
};

// ─── Tool context ─────────────────────────────────────────────────────────
export interface ToolContext {
  botConfig: BotConfig;
  sendChannelMessage: (channelId: string, content: string) => Promise<void>;
  addReaction: (channelId: string, messageId: string, emoji: string) => Promise<void>;
  summonBot?: (targetBotId: string, message: string, timeoutSec: number, channelId: string) => Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (args: any, ctx: ToolContext) => Promise<string>;

const ALL_TOOLS: Record<string, { schema: LLMTool; handler: ToolHandler }> = {
  ping_ai_proxy: { schema: PING_PROXY_TOOL, handler: pingProxyHandler as ToolHandler },
  fetch_url: { schema: FETCH_URL_TOOL, handler: fetchUrlHandler as ToolHandler },
  github_lookup: { schema: GITHUB_TOOL, handler: githubHandler as ToolHandler },
  memory_read: { schema: MEMORY_READ_TOOL, handler: memoryReadHandler as ToolHandler },
  memory_write: { schema: MEMORY_WRITE_TOOL, handler: memoryWriteHandler as ToolHandler },
  schedule_reminder: { schema: SCHEDULE_TOOL, handler: scheduleHandler as ToolHandler },
  web_search: { schema: WEB_SEARCH_TOOL, handler: webSearchHandler as ToolHandler },
  summon_bot: {
    schema: SUMMON_BOT_TOOL,
    handler: (async (args: any, ctx: ToolContext) => {
      if (!ctx.summonBot) return JSON.stringify({ error: 'summon not available' });
      return ctx.summonBot(args.bot_id, args.message, args.timeout_seconds || 60, args._channel_id);
    }) as ToolHandler,
  },
};

export function getEnabledTools(config: BotConfig): LLMTool[] {
  const enabled: LLMTool[] = [];
  if (config.tools.ping_proxy)        enabled.push(ALL_TOOLS.ping_ai_proxy.schema);
  if (config.tools.fetch_url)         enabled.push(ALL_TOOLS.fetch_url.schema);
  if (config.tools.github_lookup)     enabled.push(ALL_TOOLS.github_lookup.schema);
  if (config.tools.memory) {
    enabled.push(ALL_TOOLS.memory_read.schema);
    enabled.push(ALL_TOOLS.memory_write.schema);
  }
  if (config.tools.schedule_reminder) enabled.push(ALL_TOOLS.schedule_reminder.schema);
  if (config.tools.web_search)        enabled.push(ALL_TOOLS.web_search.schema);
  if (config.tools.summon_bot && config.delegated_bots.length > 0) {
    enabled.push(ALL_TOOLS.summon_bot.schema);
  }
  return enabled;
}

export async function dispatchTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
  ctx: ToolContext
): Promise<string> {
  const def = ALL_TOOLS[name];
  if (!def) return JSON.stringify({ error: `unknown tool: ${name}` });
  try { return await def.handler(args, ctx); }
  catch (e) { return JSON.stringify({ error: (e as Error).message }); }
}
