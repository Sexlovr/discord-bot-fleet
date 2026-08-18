// List guilds + text channels for a token.
// Used by the panel's bot editor channel picker.

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { Client, GatewayIntentBits } from 'discord.js';

interface GuildInfo {
  id: string;
  name: string;
  icon: string | null;
  text_channels: Array<{ id: string; name: string; topic?: string | null }>;
}

export async function POST(req: NextRequest) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { token } = await req.json();
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
  try {
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('login timeout')), 15000);
      client.once('ready', () => { clearTimeout(t); resolve(); });
      client.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    await client.login(token);
    await ready;
    await new Promise(r => setTimeout(r, 1500));
    const guilds: GuildInfo[] = [];
    for (const [, guild] of client.guilds.cache) {
      let channels: GuildInfo['text_channels'] = [];
      try {
        const fetched = await guild.channels.fetch();
        channels = fetched
          .filter(c => c && c.type === 0)
          .map(c => ({ id: c!.id, name: c!.name, topic: (c as { topic?: string | null }).topic }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch { /* skip */ }
      guilds.push({
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL(),
        text_channels: channels,
      });
    }
    return NextResponse.json({ guilds });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  } finally {
    client.destroy();
  }
}
