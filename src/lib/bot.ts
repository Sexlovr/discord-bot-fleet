// Bot runtime — discord.js WebSocket gateway + multi-provider LLM + tools.
// Runs as a singleton inside the Next.js process (not a separate child process
// like the HF Space version — Next.js keeps the process alive between requests).

import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { LLMClient, type LLMMessage } from './llm';
import { getEnabledTools, dispatchTool, type ToolContext } from './tools';
import { decryptString } from './crypto';
import { db } from './db';
import { prismaBotToConfig, type BotConfig } from './types';
import { writeLog } from './logger';

// In-process state — persists between requests but not across restarts
const runningBots = new Map<string, { client: Client; llm: LLMClient; config: BotConfig }>();
const pendingSummons = new Map<string, { resolve: (s: string) => void; timeout: NodeJS.Timeout }>();

// Per-channel history (in-memory, resets on restart)
const channelHistory = new Map<string, LLMMessage[]>();
const lastReplyAt = new Map<string, number>();

export async function startBot(botId: string): Promise<void> {
  if (runningBots.has(botId)) {
    throw new Error(`bot ${botId} is already running`);
  }
  const bot = await db.bot.findUnique({ where: { id: botId } });
  if (!bot) throw new Error(`bot ${botId} not found`);
  if (!bot.tokenEnc) throw new Error(`bot ${botId} has no token configured`);

  const config = prismaBotToConfig(bot);
  const token = decryptString(bot.tokenEnc);
  const log = (level: string, msg: string, meta?: Record<string, unknown>) => writeLog(botId, level, msg, meta);

  log('info', 'Bot starting', { name: config.name });

  // Discord client — z.ai has no outbound WS restrictions, so direct connection works
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  // LLM client (multi-provider with failover)
  const llm = new LLMClient(config.providers, config.llm);

  // Cache discord_user_id after login
  client.once(Events.ClientReady, async (c) => {
    log('info', `Discord client ready — logged in as ${c.user.tag}`, { username: c.user.username });
    if (c.user.id !== config.discord_user_id) {
      await db.bot.update({ where: { id: botId }, data: { discordUserId: c.user.id } });
      config.discord_user_id = c.user.id;
      log('info', 'Cached Discord user ID', { user_id: c.user.id });
    }
    await db.bot.update({ where: { id: botId }, data: { status: 'running' } }).catch(() => {});
  });

  // Tool context
  const ctx: ToolContext = {
    botConfig: config,
    sendChannelMessage: async (channelId, content) => {
      try {
        const ch = client.channels.cache.get(channelId);
        if (ch && ch.isTextBased && ch.isTextBased()) {
          await (ch as { send: (s: string) => Promise<unknown> }).send(content);
        }
      } catch (e) {
        log('error', 'sendChannelMessage failed', { channelId, error: (e as Error).message });
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
        log('warn', 'Failed to add reaction', { emoji, error: (e as Error).message });
      }
    },
    summonBot: async (targetBotId, message, timeoutSec, channelId) => {
      const target = await db.bot.findUnique({ where: { id: targetBotId } });
      if (!target) return JSON.stringify({ error: `unknown bot: ${targetBotId}` });
      if (!target.discordUserId) {
        return JSON.stringify({ error: `target bot "${target.name}" has no Discord user ID cached` });
      }
      const summonKey = `${targetBotId}:${channelId}`;
      if (pendingSummons.has(summonKey)) {
        return JSON.stringify({ error: 'summon already in flight' });
      }
      const ch = client.channels.cache.get(channelId);
      if (!ch || !ch.isTextBased || !ch.isTextBased()) {
        return JSON.stringify({ error: `channel ${channelId} not found` });
      }
      const textChannel = ch as { send: (s: string) => Promise<{ id: string }> };
      const mention = `<@${target.discordUserId}> ${message}`;
      log('info', 'Summoning bot', { target: target.name, message_preview: message.slice(0, 80) });
      await textChannel.send(mention);
      return new Promise((resolve) => {
        const targetUserId = target.discordUserId!;
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          pendingSummons.delete(summonKey);
          client.off(Events.MessageCreate, handler);
          resolve(JSON.stringify({ ok: false, error: 'timeout', timeout_sec: timeoutSec }));
        }, timeoutSec * 1000);
        pendingSummons.set(summonKey, { resolve, timeout: timer });
        const handler = (msg: { author: { id: string }; channelId: string; content: string }) => {
          if (settled) return;
          if (msg.author.id !== targetUserId) return;
          if (msg.channelId !== channelId) return;
          settled = true;
          pendingSummons.delete(summonKey);
          clearTimeout(timer);
          client.off(Events.MessageCreate, handler);
          resolve(JSON.stringify({ ok: true, target_bot: target.name, response: msg.content }));
        };
        client.on(Events.MessageCreate, handler);
      });
    },
  };

  // Message handler
  client.on(Events.MessageCreate, async (message) => {
    try {
      // Skip messages outside configured guild
      if (config.guild_id && message.guildId !== config.guild_id) return;
      // Skip messages outside configured channels (if any)
      if (config.channel_ids.length > 0 && !config.channel_ids.includes(message.channelId)) return;
      // Skip own messages
      if (message.author.id === client.user?.id) return;
      // Skip messages from delegated bots (they're handled by summon flow)
      if (message.author.bot && config.delegated_bots.length > 0) {
        for (const targetId of config.delegated_bots) {
          const target = await db.bot.findUnique({ where: { id: targetId } });
          if (target?.discordUserId === message.author.id) {
            const summonKey = `${targetId}:${message.channelId}`;
            const pending = pendingSummons.get(summonKey);
            if (pending && !('resolved' in pending)) {
              clearTimeout(pending.timeout);
              pendingSummons.delete(summonKey);
              pending.resolve(JSON.stringify({
                ok: true,
                target_bot: target.name,
                response: message.content,
              }));
            }
            return;
          }
        }
      }

      const content = message.content || '';
      if (!content && !message.embeds?.length && !message.attachments?.size) return;

      // Push to history
      const hist = channelHistory.get(message.channelId) || [];
      hist.push({ role: 'user', content: `${message.author.username}: ${content}` });
      while (hist.length > config.gating.max_context_messages) hist.shift();
      channelHistory.set(message.channelId, hist);

      // shouldRespond?
      if (config.gating.ignore_bots && message.author.bot) return;
      for (const pat of config.gating.skip_patterns) {
        try {
          if (new RegExp(pat, 'i').test(content.trim())) return;
        } catch { /* ignore */ }
      }
      const last = lastReplyAt.get(message.channelId) || 0;
      if (Date.now() - last < config.gating.cooldown_ms) return;
      if (Math.random() > config.gating.response_probability) return;

      log('info', 'Responding to message', {
        author: message.author.username,
        channel: message.channelId,
        content_preview: content.slice(0, 80),
      });

      // Build LLM messages
      const llmMessages: LLMMessage[] = [
        { role: 'system', content: config.persona },
        ...(channelHistory.get(message.channelId) || []),
      ];

      // Tool calling loop
      const enabledTools = getEnabledTools(config);
      const MAX_TOOL_ROUNDS = 5;
      let rounds = 0;

      while (rounds < MAX_TOOL_ROUNDS) {
        const resp = await llm.chat(llmMessages, enabledTools);
        rounds++;

        if (resp.tool_calls && resp.tool_calls.length > 0) {
          llmMessages.push({
            role: 'assistant',
            content: resp.content || '',
            tool_calls: resp.tool_calls,
          });
          hist.push({ role: 'assistant', content: resp.content || '(calling tools...)' });

          for (const tc of resp.tool_calls) {
            log('info', 'Tool call', { name: tc.function.name, args: tc.function.arguments.slice(0, 200) });
            let parsedArgs: Record<string, unknown> = {};
            try { parsedArgs = JSON.parse(tc.function.arguments || '{}'); } catch {}
            parsedArgs._channel_id = message.channelId;
            const result = await dispatchTool(tc.function.name, parsedArgs, ctx);
            log('info', 'Tool result', { name: tc.function.name, result_preview: result.slice(0, 200) });
            llmMessages.push({ role: 'tool', content: result, tool_call_id: tc.id, name: tc.function.name });
          }
          continue;
        }

        const reply = (resp.content || '').trim();
        if (!reply) {
          log('warn', 'LLM returned empty content, skipping reply');
          return;
        }

        // Send to Discord (chunk if >2000 chars)
        const chunks = chunkString(reply, 2000);
        try {
          for (const chunk of chunks) await message.channel.send(chunk);
        } catch (e) {
          log('error', 'Failed to send reply', { error: (e as Error).message });
          return;
        }

        hist.push({ role: 'assistant', content: reply });
        lastReplyAt.set(message.channelId, Date.now());

        // Random emoji reaction
        if (config.tools.react_to_message && Math.random() < 0.1) {
          const emojis = ['🌸', '✨', '💫', '💜', '🌙', '🍯'];
          try { await message.react(emojis[Math.floor(Math.random() * emojis.length)]); } catch { /* ignore */ }
        }

        log('info', 'Sent reply', {
          preview: reply.slice(0, 80),
          tokens: resp.usage?.total_tokens,
          provider: resp.provider_used,
          fallback: resp.used_fallback,
        });
        return;
      }
      log('warn', 'Hit MAX_TOOL_ROUNDS');
    } catch (e) {
      log('error', 'Error in message handler', { error: (e as Error).message, stack: (e as Error).stack?.slice(-400) });
    }
  });

  client.on(Events.Error, (e) => log('error', 'Discord client error', { message: e.message }));

  // Login with retry
  const MAX_LOGIN_ATTEMPTS = 5;
  let loginOk = false;
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    try {
      log('info', `Discord login attempt ${attempt}/${MAX_LOGIN_ATTEMPTS}`);
      await client.login(token);
      loginOk = true;
      break;
    } catch (e) {
      log('error', `Login attempt ${attempt} failed`, { error: (e as Error).message });
      if (attempt < MAX_LOGIN_ATTEMPTS) {
        const backoffMs = Math.min(30000, 2000 * Math.pow(2, attempt - 1));
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }
  if (!loginOk) {
    await db.bot.update({ where: { id: botId }, data: { status: 'error' } }).catch(() => {});
    throw new Error('All login attempts failed');
  }

  runningBots.set(botId, { client, llm, config });
}

export async function stopBot(botId: string): Promise<void> {
  const bot = runningBots.get(botId);
  if (!bot) {
    await db.bot.update({ where: { id: botId }, data: { status: 'stopped' } }).catch(() => {});
    return;
  }
  bot.client.destroy();
  runningBots.delete(botId);
  await db.bot.update({ where: { id: botId }, data: { status: 'stopped' } }).catch(() => {});
  writeLog(botId, 'info', 'Bot stopped');
}

export async function restartBot(botId: string): Promise<void> {
  await stopBot(botId);
  await startBot(botId);
}

export function isBotRunning(botId: string): boolean {
  return runningBots.has(botId);
}

export function listRunningBots(): string[] {
  return Array.from(runningBots.keys());
}

// Auto-restart bots on Next.js process restart (in case of crash/deploy)
export async function autostartBots(): Promise<void> {
  const bots = await db.bot.findMany({ where: { status: 'running' } });
  for (const bot of bots) {
    try { await startBot(bot.id); }
    catch (e) { writeLog(bot.id, 'error', 'Autostart failed', { error: (e as Error).message }); }
  }
}

function chunkString(s: string, size: number): string[] {
  if (s.length <= size) return [s];
  const chunks: string[] = [];
  let i = 0;
  while (i < s.length) {
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
