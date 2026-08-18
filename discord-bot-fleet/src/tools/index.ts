// Tool registry — defines the OpenAI tool schemas and dispatches calls.
// Each tool: { schema (OpenAI function spec), handler (impl) }

import type { LLMTool } from '../llm.js';
import { pingProxyTool, pingProxyHandler } from './ping_proxy.js';
import { fetchUrlTool, fetchUrlHandler } from './fetch_url.js';
import { githubLookupTool, githubLookupHandler } from './github.js';
import { memoryReadTool, memoryReadHandler, memoryWriteTool, memoryWriteHandler } from './memory.js';
import { scheduleReminderTool, scheduleReminderHandler } from './schedule.js';
import { webSearchTool, webSearchHandler } from './web_search.js';
import { summonBotTool, summonBotHandler } from './summon_bot.js';
import type { BotConfig } from '../types.js';

export interface ToolContext {
  botConfig: BotConfig;
  botUserMention: (userId?: string) => string;
  sendChannelMessage: (channelId: string, content: string) => Promise<void>;
  addReaction: (channelId: string, messageId: string, emoji: string) => Promise<void>;
  // Bot-to-bot delegation. Sends an @mention in the current channel, waits for reply.
  summonBot?: (targetBotId: string, message: string, timeoutSec: number, channelId: string) => Promise<string>;
}

export interface ToolDef {
  schema: LLMTool;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any, ctx: ToolContext) => Promise<string>;
}

// Master registry keyed by tool name.
const ALL_TOOLS: Record<string, ToolDef> = {
  ping_ai_proxy: { schema: pingProxyTool, handler: pingProxyHandler },
  fetch_url:     { schema: fetchUrlTool,     handler: fetchUrlHandler },
  github_lookup: { schema: githubLookupTool, handler: githubLookupHandler },
  memory_read:   { schema: memoryReadTool,   handler: memoryReadHandler },
  memory_write:  { schema: memoryWriteTool,   handler: memoryWriteHandler },
  schedule_reminder: { schema: scheduleReminderTool, handler: scheduleReminderHandler },
  web_search:    { schema: webSearchTool,    handler: webSearchHandler },
  summon_bot:    { schema: summonBotTool,    handler: summonBotHandler },
};

// Build the tool list for a bot based on its config toggles.
export function getEnabledTools(config: BotConfig): LLMTool[] {
  const enabled: LLMTool[] = [];
  if (config.tools.ping_proxy)        enabled.push(ALL_TOOLS.ping_ai_proxy.schema);
  if (config.tools.fetch_url)          enabled.push(ALL_TOOLS.fetch_url.schema);
  if (config.tools.github_lookup)      enabled.push(ALL_TOOLS.github_lookup.schema);
  if (config.tools.memory) {
    enabled.push(ALL_TOOLS.memory_read.schema);
    enabled.push(ALL_TOOLS.memory_write.schema);
  }
  if (config.tools.schedule_reminder)  enabled.push(ALL_TOOLS.schedule_reminder.schema);
  if (config.tools.web_search)         enabled.push(ALL_TOOLS.web_search.schema);
  if (config.tools.summon_bot && config.delegated_bots.length > 0) {
    enabled.push(ALL_TOOLS.summon_bot.schema);
  }
  return enabled;
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const def = ALL_TOOLS[name];
  if (!def) return JSON.stringify({ error: `unknown tool: ${name}` });
  try {
    return await def.handler(args, ctx);
  } catch (e: unknown) {
    const err = e as Error;
    return JSON.stringify({ error: err.message || String(e) });
  }
}
