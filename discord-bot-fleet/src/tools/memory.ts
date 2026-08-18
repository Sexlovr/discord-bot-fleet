// memory — persistent per-bot memory store. Each bot has its own JSON file.
// Safe: path is scoped, no traversal possible.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { LLMTool } from '../llm.js';
import type { ToolContext } from './index.js';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const MEMORY_DIR = join(DATA_DIR, 'memory');
if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

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
  writeFileSync(memoryFile(botId), JSON.stringify(mem, null, 2));
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
    return JSON.stringify({ keys: Object.keys(mem) });
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
    description: 'Write a key/value pair to your persistent memory. Use this to remember facts about users, ongoing conversations, decisions, or anything you want to recall later.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key (use snake_case, e.g. "user_bob_favorite_lang")' },
        value: { type: 'string', description: 'Value to store' },
      },
      required: ['key', 'value'],
    },
  },
};

export async function memoryWriteHandler(
  args: { key: string; value: string },
  ctx: ToolContext
): Promise<string> {
  const mem = loadMemory(ctx.botConfig.id);
  mem[args.key] = args.value;
  saveMemory(ctx.botConfig.id, mem);
  return JSON.stringify({ ok: true, key: args.key });
}
