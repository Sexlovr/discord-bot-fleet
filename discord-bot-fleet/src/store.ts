// Persistent config store. Single source of truth: data/bots.json
// All writes go through this module so we can encrypt/validate atomically.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { nanoid } from 'nanoid';
import type { BotConfig } from './types.js';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const BOTS_FILE = join(DATA_DIR, 'bots.json');

interface StoreShape {
  bots: BotConfig[];
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function load(): StoreShape {
  ensureDataDir();
  if (!existsSync(BOTS_FILE)) {
    writeFileSync(BOTS_FILE, JSON.stringify({ bots: [] }, null, 2));
    return { bots: [] };
  }
  try {
    const raw = readFileSync(BOTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.bots || !Array.isArray(parsed.bots)) throw new Error('invalid bots.json');
    return parsed as StoreShape;
  } catch (e) {
    console.error('[store] failed to parse bots.json, backing up and starting fresh:', e);
    renameSync(BOTS_FILE, BOTS_FILE + '.bak.' + Date.now());
    writeFileSync(BOTS_FILE, JSON.stringify({ bots: [] }, null, 2));
    return { bots: [] };
  }
}

function save(store: StoreShape) {
  ensureDataDir();
  const tmp = BOTS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, BOTS_FILE); // atomic rename
}

export function listBots(): BotConfig[] {
  return load().bots;
}

export function getBot(id: string): BotConfig | undefined {
  return load().bots.find(b => b.id === id);
}

export function createBot(input: Partial<BotConfig> & { name: string; persona: string; token_enc: string; llm: BotConfig['llm']; gating: BotConfig['gating']; tools: BotConfig['tools'] }): BotConfig {
  const store = load();
  const now = Date.now();
  const bot: BotConfig = {
    id: input.id || nanoid(10),
    name: input.name,
    persona: input.persona,
    token_enc: input.token_enc,
    guild_id: input.guild_id || '',
    channel_ids: input.channel_ids || [],
    delegated_bots: input.delegated_bots || [],
    discord_user_id: input.discord_user_id,
    llm: input.llm,
    gating: input.gating,
    tools: input.tools,
    status: input.status || 'stopped',
    created_at: now,
    updated_at: now,
  };
  store.bots.push(bot);
  save(store);
  return bot;
}

export function updateBot(id: string, patch: Partial<BotConfig>): BotConfig {
  const store = load();
  const idx = store.bots.findIndex(b => b.id === id);
  if (idx === -1) throw new Error(`bot ${id} not found`);
  const updated: BotConfig = {
    ...store.bots[idx],
    ...patch,
    id, // can't change id
    updated_at: Date.now(),
  };
  store.bots[idx] = updated;
  save(store);
  return updated;
}

export function deleteBot(id: string): void {
  const store = load();
  store.bots = store.bots.filter(b => b.id !== id);
  save(store);
}

export function setBotStatus(id: string, status: BotConfig['status']) {
  return updateBot(id, { status });
}
