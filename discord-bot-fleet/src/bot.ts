// Universal bot runtime. Run as: node dist/bot.js --id=<bot_id>
// Reads its config from the store, connects to Discord, runs the main loop.

import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getBotLogger, getLogBus } from './logger.js';
import { LLMClient, type LLMMessage } from './llm.js';
import { getEnabledTools, dispatchTool, type ToolContext } from './tools/index.js';
import { decryptString } from './crypto.js';
import { getBot, updateBot } from './store.js';
import type { BotConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse --id arg
function getBotIdFromArgs(): string | null {
  const arg = process.argv.find(a => a.startsWith('--id='));
  if (!arg) return null;
  return arg.slice('--id='.length);
}

async function main() {
  const botId = getBotIdFromArgs();
  if (!botId) {
    console.error('Usage: node dist/bot.js --id=<bot_id>');
    process.exit(1);
  }

  const config = getBot(botId);
  if (!config) {
    console.error(`Bot config not found: ${botId}`);
    process.exit(2);
  }
  const configSafe: BotConfig = config;

  const log = getBotLogger(botId);
  log.info('Bot process starting', { bot_id: botId, name: configSafe.name });

  // Decrypt token
  if (!configSafe.token_enc) {
    log.error('No token configured for this bot. Set it via the web panel.');
    process.exit(3);
  }
  const token = decryptString(configSafe.token_enc);

  // Init Discord client with required intents
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,   // PRIVILEGED — must be enabled in Dev Portal
      GatewayIntentBits.GuildMembers,    // PRIVILEGED — must be enabled in Dev Portal
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  // LLM client + tool context
  const llm = new LLMClient(configSafe);
  const ctx: ToolContext = {
    botConfig: configSafe,
    botUserMention: (userId?: string) => userId ? `<@${userId}>` : '',
    sendChannelMessage: async (channelId, content) => {
      const ch = client.channels.cache.get(channelId);
      if (ch && ch.isTextBased && ch.isTextBased()) {
        await (ch as { send: (s: string) => Promise<unknown> }).send(content);
      }
    },
    addReaction: async (channelId, messageId, emoji) => {
      try {
        const ch = client.channels.cache.get(channelId);
        if (ch && ch.isTextBased && ch.isTextBased()) {
          const msg = await (ch as { messages: { fetch: (id: string) => Promise<{ react: (e: string) => Promise<unknown> }> } }).messages.fetch(messageId);
          await msg.react(emoji);
        }
      } catch (e) {
        log.warn('Failed to add reaction', { emoji, error: (e as Error).message });
      }
    },
    // Bot-to-bot delegation: @mention target bot, wait for its reply
    summonBot: async (targetBotId: string, message: string, timeoutSec: number, channelId: string): Promise<string> => {
      const target = getBot(targetBotId);
      if (!target) return JSON.stringify({ error: `unknown bot: ${targetBotId}` });
      if (!target.discord_user_id) {
        return JSON.stringify({
          error: `target bot "${target.name}" has no Discord user ID cached`,
          hint: 'start the target bot at least once so we learn its user ID',
        });
      }

      const ch = client.channels.cache.get(channelId);
      if (!ch || !ch.isTextBased || !ch.isTextBased()) {
        return JSON.stringify({ error: `channel ${channelId} not found or not text-based` });
      }
      const textChannel = ch as { send: (s: string) => Promise<{ id: string }> };

      // Send the @mention message
      const mention = `<@${target.discord_user_id}> ${message}`;
      log.info('Summoning bot', { target: target.name, target_id: targetBotId, message_preview: message.slice(0, 80) });
      await textChannel.send(mention);

      // Wait for the target bot's reply in the same channel
      return new Promise((resolve) => {
        const targetUserId = target.discord_user_id!;
        let settled = false;

        const cleanup = () => {
          client.off(Events.MessageCreate, handler);
          clearTimeout(timer);
        };

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          log.warn('Summon timed out', { target: target.name, timeout_sec: timeoutSec });
          resolve(JSON.stringify({
            ok: false,
            error: 'timeout',
            timeout_sec: timeoutSec,
            hint: `bot "${target.name}" did not reply within ${timeoutSec}s. Is it running? Does it respond to @mentions?`,
          }));
        }, timeoutSec * 1000);

        const handler = (msg: { author: { id: string }; channelId: string; content: string }) => {
          if (settled) return;
          if (msg.author.id !== targetUserId) return;
          if (msg.channelId !== channelId) return;
          settled = true;
          cleanup();
          log.info('Summon received reply', { target: target.name, reply_preview: msg.content.slice(0, 200) });
          resolve(JSON.stringify({
            ok: true,
            target_bot: target.name,
            response: msg.content,
          }));
        };

        client.on(Events.MessageCreate, handler);
      });
    },
  };

  // Per-channel rolling message history (in-process; resets on restart).
  // Could be persisted to disk if we want cross-restart context.
  const channelHistory = new Map<string, LLMMessage[]>();
  const lastReplyAt = new Map<string, number>();

  function getHistory(channelId: string): LLMMessage[] {
    if (!channelHistory.has(channelId)) {
      channelHistory.set(channelId, []);
    }
    return channelHistory.get(channelId)!;
  }

  function pushHistory(channelId: string, msg: LLMMessage) {
    const h = getHistory(channelId);
    h.push(msg);
    // Trim
    const max = configSafe.gating.max_context_messages;
    while (h.length > max) h.shift();
  }

  function shouldRespond(authorBot: boolean, content: string, channelId: string): boolean {
    if (configSafe.gating.ignore_own_messages && authorBot) return false; // never talk to self
    if (configSafe.gating.ignore_bots && authorBot) return false;
    // Skip patterns
    for (const pat of configSafe.gating.skip_patterns) {
      try {
        const re = new RegExp(pat, 'i');
        if (re.test(content.trim())) return false;
      } catch { /* ignore bad regex */ }
    }
    // Cooldown
    const last = lastReplyAt.get(channelId) || 0;
    if (Date.now() - last < configSafe.gating.cooldown_ms) return false;
    // Probability gate
    if (Math.random() > configSafe.gating.response_probability) return false;
    return true;
  }

  client.once(Events.ClientReady, (c) => {
    log.info(`Discord client ready — logged in as ${c.user.tag}`, { username: c.user.username });
    // Cache our own Discord user ID so other bots in the fleet can summon us
    if (c.user.id !== configSafe.discord_user_id) {
      updateBot(botId, { discord_user_id: c.user.id });
      configSafe.discord_user_id = c.user.id;
      log.info('Cached Discord user ID', { user_id: c.user.id });
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      // Ignore messages outside the configured guild
      if (configSafe.guild_id && message.guildId !== configSafe.guild_id) return;

      // Ignore messages outside the configured channels (if any)
      if (configSafe.channel_ids.length > 0 && !configSafe.channel_ids.includes(message.channelId)) return;

      // Ignore own messages (always)
      if (message.author.id === client.user?.id) return;

      // Skip messages from delegated bots — they are handled by the summon_bot
      // tool internally (we are awaiting their reply). Prevents double-responding.
      if (message.author.bot && configSafe.delegated_bots?.length > 0) {
        for (const targetId of configSafe.delegated_bots) {
          const target = getBot(targetId);
          if (target?.discord_user_id === message.author.id) {
            return; // summon flow handles this message
          }
        }
      }

      const content = message.content || '';
      const isBot = message.author.bot;

      // Push to history regardless of whether we respond (so context is maintained)
      pushHistory(message.channelId, {
        role: 'user',
        content: `${message.author.username}: ${content}`,
      });

      if (!shouldRespond(isBot, content, message.channelId)) return;

      log.info('Responding to message', {
        author: message.author.username,
        channel: message.channelId,
        content_preview: content.slice(0, 80),
      });

      // Build LLM messages: system + history
      const llmMessages: LLMMessage[] = [
        { role: 'system', content: configSafe.persona },
        ...getHistory(message.channelId),
      ];

      // Tool calling loop
      const enabledTools = getEnabledTools(configSafe);
      const MAX_TOOL_ROUNDS = 5;
      let rounds = 0;

      while (rounds < MAX_TOOL_ROUNDS) {
        const resp = await llm.chat(llmMessages, enabledTools);
        rounds++;

        if (resp.tool_calls && resp.tool_calls.length > 0) {
          // Push the assistant message with tool_calls
          llmMessages.push({
            role: 'assistant',
            content: resp.content || '',
            tool_calls: resp.tool_calls,
          });
          pushHistory(message.channelId, {
            role: 'assistant',
            content: resp.content || '(calling tools...)',
          });

          // Dispatch each tool call
          for (const tc of resp.tool_calls) {
            log.info('Tool call', { name: tc.function.name, args: tc.function.arguments });
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments || '{}');
            } catch {
              log.warn('Tool call args parse failed', { raw: tc.function.arguments });
            }
            // Inject current channel context for tools that need it (e.g. summon_bot)
            parsedArgs._channel_id = message.channelId;
            const result = await dispatchTool(tc.function.name, parsedArgs, ctx);
            log.info('Tool result', { name: tc.function.name, result_preview: result.slice(0, 200) });
            llmMessages.push({
              role: 'tool',
              content: result,
              tool_call_id: tc.id,
              name: tc.function.name,
            });
          }
          continue;
        }

        // No more tool calls — final response
        const reply = resp.content?.trim();
        if (!reply) {
          log.warn('LLM returned empty content, skipping reply');
          return;
        }

        // Send to Discord (handle >2000 char by splitting)
        const chunks = chunkString(reply, 2000);
        for (const chunk of chunks) {
          await message.channel.send(chunk);
        }

        // Update history
        pushHistory(message.channelId, { role: 'assistant', content: reply });
        lastReplyAt.set(message.channelId, Date.now());

        // Optional reaction (10% chance to add a random emoji for flavor)
        if (configSafe.tools.react_to_message && Math.random() < 0.1) {
          const emojis = ['🌸', '✨', '💫', '🌸', '💜', '🌙', '🍯'];
          const emoji = emojis[Math.floor(Math.random() * emojis.length)];
          try { await message.react(emoji); } catch { /* ignore */ }
        }

        log.info('Sent reply', {
          preview: reply.slice(0, 80),
          tokens: resp.usage?.total_tokens,
        });
        return;
      }

      log.warn('Hit MAX_TOOL_ROUNDS, giving up without final reply');
    } catch (e) {
      log.error('Error in message handler', { error: (e as Error).message, stack: (e as Error).stack });
    }
  });

  client.on(Events.Error, (e) => {
    log.error('Discord client error', { message: e.message });
  });

  client.on(Events.Warn, (msg) => {
    log.warn(msg);
  });

  // Disconnect signal from parent (manager sends SIGTERM to stop bot)
  process.on('SIGTERM', async () => {
    log.info('Received SIGTERM, shutting down');
    client.destroy();
    setTimeout(() => process.exit(0), 500);
  });

  process.on('SIGINT', async () => {
    log.info('Received SIGINT, shutting down');
    client.destroy();
    setTimeout(() => process.exit(0), 500);
  });

  // Login
  try {
    await client.login(token);
  } catch (e) {
    log.error('Failed to login to Discord', { error: (e as Error).message });
    process.exit(4);
  }
}

function chunkString(s: string, size: number): string[] {
  if (s.length <= size) return [s];
  const chunks: string[] = [];
  let i = 0;
  while (i < s.length) {
    // Try to split at last newline before size
    let end = i + size;
    if (end < s.length) {
      const lastNl = s.lastIndexOf('\n', end);
      if (lastNl > i + 200) end = lastNl;
    }
    chunks.push(s.slice(i, end));
    i = end;
  }
  return chunks;
}

main().catch((e) => {
  console.error('Fatal error in bot runtime:', e);
  process.exit(99);
});
