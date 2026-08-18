// memory — persistent per-bot memory store. Each bot has its own JSON file.
// Safe: path is scoped, no traversal possible. Size-capped to prevent disk abuse.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { LLMTool } from '../llm.js';
import type { ToolContext } from './index.js';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const MEMORY_DIR = join(DATA_DIR, 'memory');
if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

// Caps: prevent disk abuse from runaway bots
const MAX_KEYS = 500;
const MAX_VALUE_BYTES = 16 * 1024; // 16KB per value
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB total per bot

function memoryFile(botId: string): string {
  // Sanitize: only alphanumerics allowed (bot IDs are nanoid)
  const safe = botId.replace(/[^a-zA-Z0-9_-]/g, '');
  return join(MEMORY_DIR, `${safe}.json`);
}

function loadMemory(botId: string): Record<string, string> {
  const f = memoryFile(botId);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

function saveMemory(botId: string, mem: Record<string, string>) {
  const f = memoryFile(botId);
  // Hard cap: don't let a single bot's memory file exceed 5MB
  const serialized = JSON.stringify(mem);
  if (serialized.length > MAX_FILE_BYTES) {
    throw new Error(`memory file would exceed ${MAX_FILE_BYTES} bytes — too many keys/values`);
  }
  writeFileSync(f, serialized);
}

export const memoryReadTool: LLMTool = {
  type: 'function',
  function: {
    name: 'memory_read',
    description: 'Read a value from your persistent memory by key, or list all keys if no key is given. Use this to recall things about users, ongoing topics, or anything you decided to remember.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key to read. If omitted, returns a list of all keys.' },
      },
    },
  },
};

export async function memoryReadHandler(
  args: { key?: string },
  ctx: ToolContext
): Promise<string> {
  const mem = loadMemory(ctx.botConfig.id);
  if (!args.key) {
    return JSON.stringify({ keys: Object.keys(mem), count: Object.keys(mem).length });
  }
  if (args.key in mem) {
    return JSON.stringify({ key: args.key, value: mem[args.key] });
  }
  return JSON.stringify({ key: args.key, value: null, note: 'key not found' });
}

export const memoryWriteTool: LLMTool = {
  type: 'function',
  function: {
    name: 'memory_write',
    description: 'Write a key/value pair to your persistent memory. Use this to remember facts about users, ongoing conversations, decisions, or anything you want to recall later. Values are limited to 16KB; max 500 keys per bot.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key (use snake_case, e.g. "user_bob_favorite_lang"). Max 100 chars.' },
        value: { type: 'string', description: 'Value to store. Max 16KB.' },
      },
      required: ['key', 'value'],
    },
  },
};

export async function memoryWriteHandler(
  args: { key: string; value: string },
  ctx: ToolContext
): Promise<string> {
  // Validate key
  if (typeof args.key !== 'string' || args.key.length === 0) {
    return JSON.stringify({ error: 'key must be a non-empty string' });
  }
  if (args.key.length > 100) {
    return JSON.stringify({ error: `key too long (${args.key.length} > 100 chars)` });
  }
  // Validate value size
  if (typeof args.value !== 'string') {
    return JSON.stringify({ error: 'value must be a string' });
  }
  const valueBytes = Buffer.byteLength(args.value, 'utf8');
  if (valueBytes > MAX_VALUE_BYTES) {
    return JSON.stringify({ error: `value too large (${valueBytes} bytes > ${MAX_VALUE_BYTES}). Truncate or split into multiple keys.` });
  }

  const mem = loadMemory(ctx.botConfig.id);

  // Enforce max keys (only when adding a new key)
  if (!(args.key in mem) && Object.keys(mem).length >= MAX_KEYS) {
    return JSON.stringify({ error: `memory full: ${MAX_KEYS} keys max. Delete some keys first.` });
  }

  mem[args.key] = args.value;
  try {
    saveMemory(ctx.botConfig.id, mem);
  } catch (e: unknown) {
    return JSON.stringify({ error: (e as Error).message });
  }
  return JSON.stringify({ ok: true, key: args.key, size_bytes: valueBytes });
}
