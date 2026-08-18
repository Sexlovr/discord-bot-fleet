// summon_bot — bot-to-bot delegation within the fleet.
// The current bot @mentions another bot in the same channel, waits for its reply,
// and returns the reply text to the LLM for further processing.

import type { LLMTool } from '../llm.js';
import type { ToolContext } from './index.js';

export const summonBotTool: LLMTool = {
  type: 'function',
  function: {
    name: 'summon_bot',
    description: 'Summon another bot in this fleet to help with a task. Sends an @mention in the current channel asking the target bot to do something, then waits for its reply (up to 60s). Use this to delegate specialized work — e.g. ask a coder bot to run code, ask a research bot to fetch info. The target bot must be authorized in your config (delegated_bots) and must be currently running.',
    parameters: {
      type: 'object',
      properties: {
        bot_id: {
          type: 'string',
          description: 'The ID of the bot to summon. Must be one of your authorized delegated_bots.',
        },
        message: {
          type: 'string',
          description: 'The message to send to the other bot. Will be prefixed with an @mention.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'How long to wait for a reply. Default 60, max 120.',
        },
      },
      required: ['bot_id', 'message'],
    },
  },
};

export async function summonBotHandler(
  args: { bot_id: string; message: string; timeout_seconds?: number; _channel_id?: string },
  ctx: ToolContext
): Promise<string> {
  const targetId = args.bot_id;
  const timeoutSec = Math.min(args.timeout_seconds || 60, 120);

  // Authorization check
  if (!ctx.botConfig.delegated_bots?.includes(targetId)) {
    return JSON.stringify({
      error: 'not authorized',
      hint: `bot_id "${targetId}" is not in your delegated_bots list. Ask the admin to add it via the web panel.`,
    });
  }

  if (!ctx.summonBot) {
    return JSON.stringify({ error: 'summon not available in this context (no channel context)' });
  }

  if (!args._channel_id) {
    return JSON.stringify({ error: 'no channel context available' });
  }

  return await ctx.summonBot(targetId, args.message, timeoutSec, args._channel_id);
}
