// Discord helpers for the web panel — list guilds/channels for a token, validate token.
// All read-only, no bot process spawned.

import { Client, GatewayIntentBits } from 'discord.js';

export interface GuildInfo {
  id: string;
  name: string;
  icon: string | null;
  text_channels: Array<{ id: string; name: string; topic?: string | null }>;
}

// Validates a token by attempting a lightweight login.
// Resolves to true if login succeeds; throws on failure.
export async function validateDiscordToken(token: string): Promise<{ valid: boolean; bot_tag?: string; bot_id?: string; error?: string }> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds], // minimal intent for validation
  });
  try {
    const ready = new Promise<{ tag: string; id: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('login timeout')), 10000);
      client.once('ready', (c) => {
        clearTimeout(t);
        resolve({ tag: c.user.tag, id: c.user.id });
      });
      client.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    await client.login(token);
    const { tag, id } = await ready;
    return { valid: true, bot_tag: tag, bot_id: id };
  } catch (e: unknown) {
    const err = e as Error;
    return { valid: false, error: err.message };
  } finally {
    client.destroy();
  }
}

// Lists guilds the bot is in + their text channels.
// Note: requires bot to be already added to the guild. If bot not in any guild, returns empty.
export async function listGuildsAndChannels(token: string): Promise<GuildInfo[]> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
  try {
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('login timeout')), 10000);
      client.once('ready', () => { clearTimeout(t); resolve(); });
      client.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    await client.login(token);
    await ready;
    // Wait for guilds cache to populate
    await new Promise(r => setTimeout(r, 1500));

    const guilds: GuildInfo[] = [];
    for (const [_, guild] of client.guilds.cache) {
      // Fetch channels (some might not be cached yet)
      let channels: GuildInfo['text_channels'] = [];
      try {
        const fetched = await guild.channels.fetch();
        channels = fetched
          .filter(c => c && c.type === 0) // 0 = GuildText
          .map(c => ({ id: c!.id, name: c!.name, topic: (c as { topic?: string | null }).topic }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) {
        // skip
      }
      guilds.push({
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL(),
        text_channels: channels,
      });
    }
    return guilds;
  } finally {
    client.destroy();
  }
}
